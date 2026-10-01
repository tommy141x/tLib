import { describe, expect, test } from "bun:test";
import { pageSizeFromFlags, parseRsc7, parseRsc7Header, Rsc7Error } from "./rsc7";

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Build a syntactically valid RSC7 file. No Rockstar data involved. */
async function makeRsc7(opts: {
	version: number;
	systemFlags: number;
	graphicsFlags: number;
	body: Uint8Array;
}): Promise<Uint8Array> {
	const compressed = await deflateRaw(opts.body);
	const out = new Uint8Array(16 + compressed.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, 0x37435352, true); // 'RSC7'
	view.setInt32(4, opts.version, true);
	view.setUint32(8, opts.systemFlags, true);
	view.setUint32(12, opts.graphicsFlags, true);
	out.set(compressed, 16);
	return out;
}

describe("pageSizeFromFlags", () => {
	test("zero page counts give zero bytes", () => {
		expect(pageSizeFromFlags(0)).toBe(0);
		// Only the base-size shift set, no page counts: still zero.
		expect(pageSizeFromFlags(0x0000000f)).toBe(0);
	});

	// Observed on real files by gtatool: molly@megaphone.ycd reports
	// systemFlags 0x20040000 -> 16,384 and gfxFlags 0xE0000000 -> 0.
	test("matches gtatool on a real ycd's flags", () => {
		expect(pageSizeFromFlags(0x20040000)).toBe(16384);
		expect(pageSizeFromFlags(0xe0000000)).toBe(0);
	});

	test("the smallest single page is 0x2000 at shift 0", () => {
		// bit 4 is the x256 page-count field; one such page at base 0x200 = 0x20000.
		expect(pageSizeFromFlags(0x00000010)).toBe(0x200 * 256);
	});

	test("the base-size shift scales the whole result", () => {
		const base = pageSizeFromFlags(0x00040000); // one unit in the (>>17)&0x7F field
		expect(pageSizeFromFlags(0x00040001)).toBe(base * 2);
		expect(pageSizeFromFlags(0x00040002)).toBe(base * 4);
	});

	test("does not wrap past 2^31", () => {
		// A large page count with a large base shift exceeds int32; `<<` would wrap
		// negative here, multiplication must not.
		const size = pageSizeFromFlags(0x00fe000f);
		expect(size).toBeGreaterThan(2 ** 31);
		expect(Number.isFinite(size)).toBe(true);
	});

	test("treats the flags word as unsigned", () => {
		expect(pageSizeFromFlags(0x80000000)).toBe(pageSizeFromFlags(-2147483648));
	});
});

describe("parseRsc7Header", () => {
	test("reads version and both flag words", async () => {
		const file = await makeRsc7({
			version: 46,
			systemFlags: 0x20040000,
			graphicsFlags: 0xe0000000,
			body: new Uint8Array(16384),
		});
		const h = parseRsc7Header(file);
		expect(h.version).toBe(46);
		expect(h.systemFlags).toBe(0x20040000);
		expect(h.graphicsFlags).toBe(0xe0000000);
		expect(h.systemSize).toBe(16384);
		expect(h.graphicsSize).toBe(0);
	});

	test("rejects a non-RSC7 file with the offending magic in the message", () => {
		const notRsc7 = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		expect(() => parseRsc7Header(notRsc7)).toThrow(Rsc7Error);
		expect(() => parseRsc7Header(notRsc7)).toThrow(/not an RSC7 container/);
	});

	test("rejects a file too short to hold a header", () => {
		expect(() => parseRsc7Header(new Uint8Array(8))).toThrow(/too short/);
	});
});

describe("parseRsc7", () => {
	test("splits the body at systemSize", async () => {
		const body = new Uint8Array(0x200 * 256 * 2);
		body.fill(0xaa, 0, 0x200 * 256); // system half
		body.fill(0xbb, 0x200 * 256); // graphics half
		const file = await makeRsc7({
			version: 46,
			systemFlags: 0x00000010, // one 256-unit page  -> 0x20000
			graphicsFlags: 0x00000010,
			body,
		});

		const res = await parseRsc7(file);
		expect(res.system.length).toBe(0x200 * 256);
		expect(res.graphics.length).toBe(0x200 * 256);
		expect(res.system.every((b) => b === 0xaa)).toBe(true);
		expect(res.graphics.every((b) => b === 0xbb)).toBe(true);
	});

	test("a zero graphics segment yields an empty graphics view", async () => {
		const file = await makeRsc7({
			version: 46,
			systemFlags: 0x00000010,
			graphicsFlags: 0,
			body: new Uint8Array(0x200 * 256),
		});
		const res = await parseRsc7(file);
		expect(res.graphics.length).toBe(0);
	});

	test("rejects a body shorter than the page flags declare", async () => {
		const file = await makeRsc7({
			version: 46,
			systemFlags: 0x00000010, // declares 0x20000 bytes
			graphicsFlags: 0,
			body: new Uint8Array(64), // but only 64 are present
		});
		await expect(parseRsc7(file)).rejects.toThrow(/did not produce the 131072 bytes/);
	});

	test("tolerates trailing bytes after the deflate stream", async () => {
		// Real files commonly carry 4 bytes of padding after the compressed data.
		// DecompressionStream errors on those AND discards output it has already
		// buffered, so a naive read loses most of the file while still looking like a
		// clean parse failure. Measured: 20 of 156 real resource files in this corpus.
		const body = new Uint8Array(0x200 * 256).fill(0x5a);
		const clean = await makeRsc7({
			version: 46,
			systemFlags: 0x00000010,
			graphicsFlags: 0,
			body,
		});
		const padded = new Uint8Array(clean.length + 4);
		padded.set(clean);
		padded.set([0xde, 0xad, 0xbe, 0xef], clean.length);

		const res = await parseRsc7(padded);
		expect(res.system.length).toBe(body.length);
		expect(res.system.every((b) => b === 0x5a)).toBe(true);
	});
});
