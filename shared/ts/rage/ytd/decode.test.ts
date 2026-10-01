import { describe, expect, test } from "bun:test";
import {
	DecodeError,
	decodeA8,
	decodeBc1,
	decodeBc2,
	decodeBc3,
	decodeBc4,
	decodeBc5,
	decodeBc7,
	decodeBgr5a1,
	decodeBgra8,
	decodeBgrx8,
	decodeR8,
	decodeRgba8,
	decodeToRgba,
	decoderFor,
	reconstructNormalZ,
} from "./decode";
import { DxgiFormat } from "./formats";

// --- helpers --------------------------------------------------------------------

/** The RGBA quad at (x, y) of a decoded image. */
function px(rgba: Uint8Array, width: number, x: number, y: number): number[] {
	const o = (y * width + x) * 4;
	return [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]];
}

/** Little-endian byte pair. */
function u16(v: number): number[] {
	return [v & 0xff, (v >> 8) & 0xff];
}

/** Little-endian four bytes. */
function u32(v: number): number[] {
	return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

const WHITE_565 = 0xffff;
const BLACK_565 = 0x0000;
const RED_565 = 0xf800;

/** Pack `[value, bitCount]` pairs LSB-first into a 16-byte BC7 block. */
function packBlock(fields: readonly (readonly [number, number])[]): Uint8Array {
	const out = new Uint8Array(16);
	let bit = 0;
	for (const [value, count] of fields) {
		for (let i = 0; i < count; i++) {
			if ((value >>> i) & 1) out[(bit + i) >> 3] |= 1 << ((bit + i) & 7);
		}
		bit += count;
	}
	if (bit !== 128) throw new Error(`packed ${bit} bits, a BC7 block is 128`);
	return out;
}

// --- BC1 ------------------------------------------------------------------------

describe("decodeBc1", () => {
	test("index 0 and 1 select the two stored colours", () => {
		// c0 > c1, so this is the four-colour opaque mode.
		const block = new Uint8Array([
			...u16(WHITE_565),
			...u16(BLACK_565),
			// every pixel index 0 except the first row, which is 1
			...u32(0b00000000_00000000_00000000_01010101),
		]);
		const out = decodeBc1(block, 4, 4);
		expect(px(out, 4, 0, 0)).toEqual([0, 0, 0, 255]);
		expect(px(out, 4, 0, 1)).toEqual([255, 255, 255, 255]);
	});

	test("the 1/3 and 2/3 interpolants land where CodeWalker puts them", () => {
		const block = new Uint8Array([
			...u16(WHITE_565),
			...u16(BLACK_565),
			...u32(0b00000000_00000000_00000000_11100100), // indices 0,1,2,3 on row 0
		]);
		const out = decodeBc1(block, 4, 1);
		expect(px(out, 4, 0, 0)).toEqual([255, 255, 255, 255]);
		expect(px(out, 4, 1, 0)).toEqual([0, 0, 0, 255]);
		expect(px(out, 4, 2, 0)).toEqual([170, 170, 170, 255]);
		expect(px(out, 4, 3, 0)).toEqual([85, 85, 85, 255]);
	});

	test("c0 <= c1 switches to three colours plus transparent black", () => {
		const block = new Uint8Array([
			...u16(BLACK_565),
			...u16(WHITE_565),
			...u32(0b00000000_00000000_00000000_11100100),
		]);
		const out = decodeBc1(block, 4, 1);
		// Integer division truncates: (0 + 255) / 2 is 127, not 128.
		expect(px(out, 4, 2, 0)).toEqual([127, 127, 127, 255]); // the 1/2 blend
		expect(px(out, 4, 3, 0)).toEqual([0, 0, 0, 0]); // punch-through
	});

	test("a 1x1 mip reads one whole 8-byte block and yields one pixel", () => {
		const block = new Uint8Array([...u16(RED_565), ...u16(BLACK_565), ...u32(0)]);
		const out = decodeBc1(block, 1, 1);
		expect(out.length).toBe(4);
		expect(px(out, 1, 0, 0)).toEqual([255, 0, 0, 255]);
	});

	test("a short buffer is an error, not a partial image", () => {
		expect(() => decodeBc1(new Uint8Array(7), 4, 4)).toThrow(DecodeError);
	});
});

// --- BC2 ------------------------------------------------------------------------

describe("decodeBc2", () => {
	test("four-bit alpha expands by nibble replication", () => {
		const alpha = new Uint8Array(8);
		alpha[0] = 0xf0; // pixel 0 -> 0x0, pixel 1 -> 0xF
		const block = new Uint8Array([
			...alpha,
			...u16(WHITE_565),
			...u16(BLACK_565),
			...u32(0),
		]);
		const out = decodeBc2(block, 4, 4);
		expect(px(out, 4, 0, 0)[3]).toBe(0x00);
		expect(px(out, 4, 1, 0)[3]).toBe(0xff);
		expect(px(out, 4, 2, 0)[3]).toBe(0x00);
	});

	test("colour always uses the four-colour mode, even when c0 <= c1", () => {
		const block = new Uint8Array([
			...new Uint8Array(8).fill(0xff),
			...u16(BLACK_565),
			...u16(WHITE_565),
			...u32(0b00000000_00000000_00000000_11100100),
		]);
		const out = decodeBc2(block, 4, 1);
		// index 3 is the 1/3-2/3 blend here, not punch-through as it would be in BC1.
		expect(px(out, 4, 3, 0)).toEqual([170, 170, 170, 255]);
	});
});

// --- BC3 ------------------------------------------------------------------------

describe("decodeBc3", () => {
	test("a0 > a1 gives the eight-value interpolated alpha ramp", () => {
		const block = new Uint8Array([
			255,
			0, // a0 > a1
			...[0b10001000, 0b01000110, 0b00111010, 0, 0, 0], // indices 0..? see below
			...u16(WHITE_565),
			...u16(BLACK_565),
			...u32(0),
		]);
		const out = decodeBc3(block, 4, 4);
		// Index 0 is a0, index 1 is a1; both are exact, which is what pins the palette.
		expect(px(out, 4, 0, 0)[3]).toBe(255);
		const alphas = [...Array(16).keys()].map((i) => px(out, 4, i % 4, (i / 4) | 0)[3]);
		expect(alphas.every((a) => a >= 0 && a <= 255)).toBe(true);
	});

	test("a0 <= a1 puts 0 and 255 at indices 6 and 7", () => {
		// Every pixel index 7 -> 0xFF; every pixel index 6 -> 0x00.
		const sevens = new Uint8Array(6).fill(0xff); // 16 x 0b111
		const block7 = new Uint8Array([
			10,
			200,
			...sevens,
			...u16(WHITE_565),
			...u16(BLACK_565),
			...u32(0),
		]);
		expect(px(decodeBc3(block7, 4, 4), 4, 2, 2)[3]).toBe(255);

		// 0b110 repeated: bytes are 0b10110110, 0b01101101, 0b11011011 ...
		const sixes = new Uint8Array([0b10110110, 0b01101101, 0b11011011, 0b10110110, 0b01101101, 0b11011011]);
		const block6 = new Uint8Array([
			10,
			200,
			...sixes,
			...u16(WHITE_565),
			...u16(BLACK_565),
			...u32(0),
		]);
		expect(px(decodeBc3(block6, 4, 4), 4, 0, 0)[3]).toBe(0);
	});

	test("colour decodes as BC1's four-colour mode regardless of c0 vs c1", () => {
		const block = new Uint8Array([
			255,
			255,
			...new Uint8Array(6),
			...u16(BLACK_565),
			...u16(WHITE_565),
			...u32(0b00000000_00000000_00000000_11100100),
		]);
		const out = decodeBc3(block, 4, 1);
		expect(px(out, 4, 3, 0).slice(0, 3)).toEqual([170, 170, 170]);
	});
});

// --- BC4 / BC5 ------------------------------------------------------------------

describe("decodeBc4", () => {
	test("the single channel lands in red, with green and blue zero", () => {
		const block = new Uint8Array([200, 40, ...new Uint8Array(6)]); // all indices 0
		const out = decodeBc4(block, 4, 4);
		expect(px(out, 4, 0, 0)).toEqual([200, 0, 0, 255]);
	});

	test("index 1 selects the second endpoint", () => {
		const ones = new Uint8Array([0b01001001, 0b10010010, 0b00100100, 0b01001001, 0b10010010, 0b00100100]);
		const block = new Uint8Array([200, 40, ...ones]);
		expect(px(decodeBc4(block, 4, 4), 4, 0, 0)).toEqual([40, 0, 0, 255]);
	});
});

describe("decodeBc5", () => {
	// CodeWalker's DecompressBC5Block is broken - its green branch assigns to `r` using
	// the red endpoints, so upstream green is always 255. These assertions are the
	// format's behaviour, deliberately not CodeWalker's.
	test("red and green come from their own independent blocks", () => {
		const block = new Uint8Array([
			200,
			40,
			...new Uint8Array(6), // red indices all 0 -> 200
			10,
			90,
			...new Uint8Array(6).fill(0xff), // green indices all 7
		]);
		const out = decodeBc5(block, 4, 4);
		// Green endpoints are a0 <= a1, so index 7 is the literal 255, not an interpolant.
		expect(px(out, 4, 0, 0)).toEqual([200, 255, 0, 255]);
	});

	test("blue is left at zero for the normal reconstruction to fill", () => {
		const block = new Uint8Array(16);
		block[0] = 255;
		block[8] = 255;
		expect(px(decodeBc5(block, 4, 4), 4, 1, 1)[2]).toBe(0);
	});
});

describe("reconstructNormalZ", () => {
	test("a flat normal (128, 128) reconstructs to full Z", () => {
		const rgba = new Uint8Array([128, 128, 0, 255]);
		reconstructNormalZ(rgba);
		expect(rgba[2]).toBeGreaterThan(250);
	});

	test("a fully tilted normal reconstructs to zero Z, clamped not NaN", () => {
		const rgba = new Uint8Array([255, 255, 0, 255]);
		reconstructNormalZ(rgba);
		expect(rgba[2]).toBe(128); // sqrt clamped to 0 -> encoded midpoint
	});

	test("flipGreen inverts the green channel as well as the maths", () => {
		const rgba = new Uint8Array([128, 200, 0, 255]);
		reconstructNormalZ(rgba, true);
		expect(rgba[1]).toBe(55);
	});
});

// --- uncompressed ---------------------------------------------------------------

describe("uncompressed decoders", () => {
	test("A8 is alpha-only; RGB stays zero", () => {
		// CodeWalker's viewer splats A8 to luminance instead. That is display, not data.
		expect([...decodeA8(new Uint8Array([7, 255]), 2, 1)]).toEqual([0, 0, 0, 7, 0, 0, 0, 255]);
	});

	test("R8 puts the single channel in red", () => {
		expect([...decodeR8(new Uint8Array([7, 255]), 2, 1)]).toEqual([7, 0, 0, 255, 255, 0, 0, 255]);
	});

	test("R8G8B8A8 is a straight copy", () => {
		const src = new Uint8Array([1, 2, 3, 4]);
		expect([...decodeRgba8(src, 1, 1)]).toEqual([1, 2, 3, 4]);
	});

	test("B8G8R8A8 swaps red and blue", () => {
		expect([...decodeBgra8(new Uint8Array([1, 2, 3, 4]), 1, 1)]).toEqual([3, 2, 1, 4]);
	});

	test("B8G8R8X8 ignores the stored fourth byte", () => {
		expect([...decodeBgrx8(new Uint8Array([1, 2, 3, 0]), 1, 1)]).toEqual([3, 2, 1, 255]);
	});

	test("B5G5R5A1 reads A in bit 15 and expands each 5-bit channel by replication", () => {
		// 0x8000 | (31 << 10) -> opaque, red full, green and blue zero.
		expect([...decodeBgr5a1(new Uint8Array(u16(0x8000 | (31 << 10))), 1, 1)]).toEqual([
			255, 0, 0, 255,
		]);
		// Alpha bit clear.
		expect([...decodeBgr5a1(new Uint8Array(u16(31)), 1, 1)]).toEqual([0, 0, 255, 0]);
		// A half-scale green: 16 -> (16<<3)|(16>>2) = 132.
		expect([...decodeBgr5a1(new Uint8Array(u16(0x8000 | (16 << 5))), 1, 1)]).toEqual([
			0, 132, 0, 255,
		]);
	});

	test("a short buffer produces the declared size, zero-filled", () => {
		const out = decodeR8(new Uint8Array([9]), 4, 1);
		expect(out.length).toBe(16);
		expect([...out.slice(4)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
	});
});

// --- BC7 ------------------------------------------------------------------------
//
// CodeWalker has no BC7 decoder (`DDSIO.cs:167` is `//BC7 TODO!!`), so these blocks are
// built by hand from the Direct3D 11 specification's bit layout and the expected pixels
// are derived from the same document. They are assertions against the spec, NOT a
// differential comparison against a reference implementation - there is none available
// here.

describe("decodeBc7", () => {
	test("mode 6 with both endpoints at maximum is opaque white everywhere", () => {
		// mode prefix (6 zeros + a 1), R0 R1 G0 G1 B0 B1 A0 A1 at 7 bits, two P-bits,
		// then 63 index bits (pixel 0 has 3, the other 15 have 4).
		const block = packBlock([
			[0b1000000, 7],
			...Array(8).fill([0x7f, 7] as const),
			[1, 1],
			[1, 1],
			[0, 63],
		]);
		const out = decodeBc7(block, 4, 4);
		for (let i = 0; i < 16; i++) {
			expect(px(out, 4, i % 4, (i / 4) | 0)).toEqual([255, 255, 255, 255]);
		}
	});

	test("mode 6 P-bits are the new low bit of every component", () => {
		// Endpoints 0 with a P-bit of 1 quantize to 0b00000001 at 8-bit precision = 1.
		const block = packBlock([
			[0b1000000, 7],
			...Array(8).fill([0, 7] as const),
			[1, 1],
			[1, 1],
			[0, 63],
		]);
		expect(px(decodeBc7(block, 4, 4), 4, 0, 0)).toEqual([1, 1, 1, 1]);
	});

	test("mode 6 interpolates between the endpoints along the 4-bit weight table", () => {
		// e0 = 0 (P=0), e1 = 255 (0x7F with P=1). Anchor pixel 0 gets 3 index bits.
		const indices: (readonly [number, number])[] = [[0, 3]];
		for (let i = 1; i < 16; i++) indices.push([i === 1 ? 8 : 15, 4] as const);
		const block = packBlock([
			[0b1000000, 7],
			[0, 7],
			[0x7f, 7],
			[0, 7],
			[0x7f, 7],
			[0, 7],
			[0x7f, 7],
			[0, 7],
			[0x7f, 7],
			[0, 1],
			[1, 1],
			...indices,
		]);
		const out = decodeBc7(block, 4, 4);
		expect(px(out, 4, 0, 0)).toEqual([0, 0, 0, 0]); // index 0 -> weight 0
		// index 8 -> weight 34: ((64-34)*0 + 34*255 + 32) >> 6 = 135
		expect(px(out, 4, 1, 0)).toEqual([135, 135, 135, 135]);
		expect(px(out, 4, 2, 0)).toEqual([255, 255, 255, 255]); // index 15 -> weight 64
	});

	test("mode 5 keeps colour and alpha on separate index sets", () => {
		// mode 5: prefix 000001, rotation(2), R0 R1 G0 G1 B0 B1 at 7 bits, A0 A1 at 8,
		// then 31 colour index bits and 31 alpha index bits.
		const colorIdx: (readonly [number, number])[] = [[0, 1]];
		for (let i = 1; i < 16; i++) colorIdx.push([0, 2] as const);
		const alphaIdx: (readonly [number, number])[] = [[0, 1]];
		for (let i = 1; i < 16; i++) alphaIdx.push([3, 2] as const);
		const block = packBlock([
			[0b100000, 6],
			[0, 2], // no rotation
			[0x7f, 7],
			[0x7f, 7], // R
			[0, 7],
			[0, 7], // G
			[0, 7],
			[0, 7], // B
			[0, 8],
			[255, 8], // A endpoints 0 and 255
			...colorIdx,
			...alphaIdx,
		]);
		const out = decodeBc7(block, 4, 4);
		expect(px(out, 4, 0, 0)).toEqual([255, 0, 0, 0]); // alpha index 0 -> A0
		expect(px(out, 4, 1, 0)).toEqual([255, 0, 0, 255]); // alpha index 3 -> A1
	});

	test("mode 5 rotation 1 swaps the alpha channel back into red", () => {
		const colorIdx: (readonly [number, number])[] = [[0, 1]];
		for (let i = 1; i < 16; i++) colorIdx.push([0, 2] as const);
		const alphaIdx: (readonly [number, number])[] = [[0, 1]];
		for (let i = 1; i < 16; i++) alphaIdx.push([0, 2] as const);
		const block = packBlock([
			[0b100000, 6],
			[1, 2], // rotation 1: swap A and R
			[0x7f, 7],
			[0x7f, 7],
			[0, 7],
			[0, 7],
			[0, 7],
			[0, 7],
			[0, 8],
			[0, 8],
			...colorIdx,
			...alphaIdx,
		]);
		// Before the swap this is (255, 0, 0, 0); after it, (0, 0, 0, 255).
		expect(px(decodeBc7(block, 4, 4), 4, 0, 0)).toEqual([0, 0, 0, 255]);
	});

	test("mode 1 shares one P-bit between the two endpoints of a subset", () => {
		// mode 1: prefix 01, partition(6), 4 endpoints x 6 bits per channel, 2 shared
		// P-bits, 46 index bits. Partition 0 splits the block into two 2x2-ish halves.
		const block = packBlock([
			[0b10, 2],
			[0, 6], // partition 0
			[0x3f, 6],
			[0x3f, 6],
			[0, 6],
			[0, 6], // R: subset 0 max, subset 1 zero
			[0, 6],
			[0, 6],
			[0, 6],
			[0, 6], // G
			[0, 6],
			[0, 6],
			[0, 6],
			[0, 6], // B
			[1, 1],
			[0, 1], // shared P-bits
			[0, 46],
		]);
		const out = decodeBc7(block, 4, 4);
		// Partition 0 is 0,0,1,1 / 0,0,1,1 / ... so x<2 is subset 0 and x>=2 subset 1.
		// Subset 0's shared P-bit is 1, and a P-bit becomes the low bit of EVERY channel:
		// green and blue are stored as 0 but decode to unquantize(0b0000001, 7) = 2.
		expect(px(out, 4, 0, 0)).toEqual([255, 2, 2, 255]);
		expect(px(out, 4, 3, 0)).toEqual([0, 0, 0, 255]);
	});

	test("a reserved mode (first byte zero) decodes to opaque black", () => {
		const out = decodeBc7(new Uint8Array(16), 4, 4);
		expect(px(out, 4, 0, 0)).toEqual([0, 0, 0, 255]);
	});

	test("a 2x2 mip still consumes one whole 16-byte block", () => {
		const block = packBlock([
			[0b1000000, 7],
			...Array(8).fill([0x7f, 7] as const),
			[1, 1],
			[1, 1],
			[0, 63],
		]);
		const out = decodeBc7(block, 2, 2);
		expect(out.length).toBe(16);
		expect(px(out, 2, 1, 1)).toEqual([255, 255, 255, 255]);
	});
});

// --- dispatch -------------------------------------------------------------------

describe("decoderFor", () => {
	test("every format CodeWalker decodes has a decoder here, plus BC7", () => {
		for (const f of [
			DxgiFormat.BC1_UNORM,
			DxgiFormat.BC2_UNORM,
			DxgiFormat.BC3_UNORM,
			DxgiFormat.BC4_UNORM,
			DxgiFormat.BC5_UNORM,
			DxgiFormat.BC7_UNORM,
			DxgiFormat.B5G5R5A1_UNORM,
			DxgiFormat.A8_UNORM,
			DxgiFormat.R8G8B8A8_UNORM,
			DxgiFormat.R8_UNORM,
			DxgiFormat.B8G8R8A8_UNORM,
			DxgiFormat.B8G8R8X8_UNORM,
		]) {
			expect(decoderFor(f)).not.toBeNull();
		}
	});

	test("an unsupported format throws rather than returning a blank image", () => {
		expect(decoderFor(DxgiFormat.BC6H_UF16)).toBeNull();
		expect(() => decodeToRgba(DxgiFormat.BC6H_UF16, new Uint8Array(16), 4, 4)).toThrow(DecodeError);
	});
});
