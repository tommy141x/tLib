// CPU decoders: block-compressed and uncompressed pixel formats to RGBA8.
//
// Every export here is a pure `(bytes, width, height) => Uint8Array` with no DOM and no
// WebGL import, so this module can be posted to a worker as-is. The GPU path lives in
// `upload.ts` and never the other way round.
//
// Ported from CodeWalker.Core `Utils/DDSIO.cs` (MIT, dexyfex/Neodymium) - BC1 at :2152,
// BC2 at :2267, BC3 at :2416, BC4 at :2565, BC5 at :2651 - with four deliberate
// divergences, each marked at its site:
//
//   1. Output is RGBA, R first. CodeWalker's `GetPixels` returns its decoders' output
//      and then swaps R and B for most formats because it feeds a BGRA surface.
//   2. `DecompressBC5Block` is broken upstream: its green branch assigns to `r` and uses
//      the red endpoints, so green is always 255 and red is overwritten. Decoded here
//      the way the format defines.
//   3. `ConvertBGR5A1ToRGBA8` is broken upstream three ways - it builds the u16 as
//      `hi * 255 + lo`, advances the output pointer by 4 per *byte* rather than per
//      pixel, and reads an RGBA5551 bit layout out of a BGRA5551 format.
//   4. BC7 has no upstream implementation at all (`DDSIO.cs:167` is `//BC7 TODO!!`), so
//      it is written from the Direct3D 11 specification rather than ported.
//
// A BCn block always covers a full 4x4 area even when the mip is 2x2 or 1x1; the
// decoders write only the pixels that exist and discard the rest of the block.

import {
	BC7_MODES,
	BC7_WEIGHTS_2,
	BC7_WEIGHTS_3,
	BC7_WEIGHTS_4,
	bc7Anchor,
	bc7Subsets,
} from "./bc7-tables";
import { DxgiFormat } from "./formats";

/** Raised when a decoder is handed a buffer that cannot hold the image it describes. */
export class DecodeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DecodeError";
	}
}

function requireBlocks(
	bytes: Uint8Array,
	width: number,
	height: number,
	blockSize: number,
	what: string,
): { bw: number; bh: number } {
	const bw = Math.max(1, Math.ceil(width / 4));
	const bh = Math.max(1, Math.ceil(height / 4));
	const need = bw * bh * blockSize;
	if (bytes.length < need) {
		throw new DecodeError(
			`${what}: ${width}x${height} needs ${need} bytes (${bw}x${bh} blocks) but got ${bytes.length}`,
		);
	}
	return { bw, bh };
}

function rgb565(color: number): [number, number, number] {
	// CodeWalker's exact rounding (`ConvertRgb565ToRgb888`), not the usual bit-replicate.
	// The two differ by one on some inputs, and the oracle is CodeWalker.
	let t = (color >> 11) * 255 + 16;
	const r = Math.floor((Math.floor(t / 32) + t) / 32);
	t = ((color & 0x07e0) >> 5) * 255 + 32;
	const g = Math.floor((Math.floor(t / 64) + t) / 64);
	t = (color & 0x001f) * 255 + 16;
	const b = Math.floor((Math.floor(t / 32) + t) / 32);
	return [r & 0xff, g & 0xff, b & 0xff];
}

/**
 * The eight-entry palette a BC3 alpha / BC4 / BC5 channel block interpolates over.
 *
 * Writes into a caller-owned scratch array: a 2048x512 BC3 mip is 32,768 blocks and
 * allocating two small arrays per block dominates the decode.
 */
function alphaPalette(a0: number, a1: number, p: Uint8Array): Uint8Array {
	p[0] = a0;
	p[1] = a1;
	if (a0 > a1) {
		for (let i = 2; i < 8; i++) p[i] = Math.floor(((8 - i) * a0 + (i - 1) * a1) / 7);
	} else {
		for (let i = 2; i < 6; i++) p[i] = Math.floor(((6 - i) * a0 + (i - 1) * a1) / 5);
		p[6] = 0;
		p[7] = 0xff;
	}
	return p;
}

/**
 * Read the 48-bit index mask of a BC3/BC4/BC5 channel block as two 24-bit halves.
 *
 * Doing it in one Number would need a 48-bit shift, which JS bitwise ops truncate to 32.
 */
function channelIndices(bytes: Uint8Array, at: number, out: Uint8Array): Uint8Array {
	const lo = bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
	const hi = bytes[at + 3] | (bytes[at + 4] << 8) | (bytes[at + 5] << 16);
	for (let i = 0; i < 8; i++) out[i] = (lo >>> (3 * i)) & 7;
	for (let i = 0; i < 8; i++) out[8 + i] = (hi >>> (3 * i)) & 7;
	return out;
}

/** BC1 / DXT1. Opaque unless `c0 <= c1`, in which case index 3 is transparent black. */
export function decodeBc1(bytes: Uint8Array, width: number, height: number): Uint8Array {
	const { bw, bh } = requireBlocks(bytes, width, height, 8, "BC1");
	const out = new Uint8Array(width * height * 4);
	let at = 0;
	for (let by = 0; by < bh; by++) {
		for (let bx = 0; bx < bw; bx++, at += 8) {
			const c0 = bytes[at] | (bytes[at + 1] << 8);
			const c1 = bytes[at + 2] | (bytes[at + 3] << 8);
			const [r0, g0, b0] = rgb565(c0);
			const [r1, g1, b1] = rgb565(c1);
			const lut =
				(bytes[at + 4] | (bytes[at + 5] << 8) | (bytes[at + 6] << 16) | (bytes[at + 7] << 24)) >>> 0;
			for (let py = 0; py < 4; py++) {
				const y = (by << 2) + py;
				if (y >= height) break;
				for (let px = 0; px < 4; px++) {
					const x = (bx << 2) + px;
					if (x >= width) continue;
					const index = (lut >>> (2 * (4 * py + px))) & 3;
					let r = 0;
					let g = 0;
					let b = 0;
					let a = 255;
					if (index === 0) {
						r = r0;
						g = g0;
						b = b0;
					} else if (index === 1) {
						r = r1;
						g = g1;
						b = b1;
					} else if (c0 > c1) {
						if (index === 2) {
							r = Math.floor((2 * r0 + r1) / 3);
							g = Math.floor((2 * g0 + g1) / 3);
							b = Math.floor((2 * b0 + b1) / 3);
						} else {
							r = Math.floor((r0 + 2 * r1) / 3);
							g = Math.floor((g0 + 2 * g1) / 3);
							b = Math.floor((b0 + 2 * b1) / 3);
						}
					} else if (index === 2) {
						r = Math.floor((r0 + r1) / 2);
						g = Math.floor((g0 + g1) / 2);
						b = Math.floor((b0 + b1) / 2);
					} else {
						a = 0;
					}
					const o = ((y * width + x) << 2) >>> 0;
					out[o] = r;
					out[o + 1] = g;
					out[o + 2] = b;
					out[o + 3] = a;
				}
			}
		}
	}
	return out;
}

/** BC2 / DXT3. Four-bit explicit alpha, then a BC1 colour block with no 1-bit mode. */
export function decodeBc2(bytes: Uint8Array, width: number, height: number): Uint8Array {
	const { bw, bh } = requireBlocks(bytes, width, height, 16, "BC2");
	const out = new Uint8Array(width * height * 4);
	let at = 0;
	for (let by = 0; by < bh; by++) {
		for (let bx = 0; bx < bw; bx++, at += 16) {
			const c0 = bytes[at + 8] | (bytes[at + 9] << 8);
			const c1 = bytes[at + 10] | (bytes[at + 11] << 8);
			const [r0, g0, b0] = rgb565(c0);
			const [r1, g1, b1] = rgb565(c1);
			const lut =
				(bytes[at + 12] |
					(bytes[at + 13] << 8) |
					(bytes[at + 14] << 16) |
					(bytes[at + 15] << 24)) >>>
				0;
			for (let py = 0; py < 4; py++) {
				const y = (by << 2) + py;
				for (let px = 0; px < 4; px++) {
					const x = (bx << 2) + px;
					const i = 4 * py + px;
					// The alpha nibbles run in pixel order regardless of which pixels exist,
					// so the counter advances even for pixels outside the image.
					const nib = bytes[at + (i >> 1)];
					const a4 = i & 1 ? (nib & 0xf0) >> 4 : nib & 0x0f;
					if (y >= height || x >= width) continue;
					const index = (lut >>> (2 * i)) & 3;
					let r: number;
					let g: number;
					let b: number;
					if (index === 0) {
						r = r0;
						g = g0;
						b = b0;
					} else if (index === 1) {
						r = r1;
						g = g1;
						b = b1;
					} else if (index === 2) {
						r = Math.floor((2 * r0 + r1) / 3);
						g = Math.floor((2 * g0 + g1) / 3);
						b = Math.floor((2 * b0 + b1) / 3);
					} else {
						r = Math.floor((r0 + 2 * r1) / 3);
						g = Math.floor((g0 + 2 * g1) / 3);
						b = Math.floor((b0 + 2 * b1) / 3);
					}
					const o = ((y * width + x) << 2) >>> 0;
					out[o] = r;
					out[o + 1] = g;
					out[o + 2] = b;
					out[o + 3] = (a4 << 4) | a4;
				}
			}
		}
	}
	return out;
}

/** BC3 / DXT5. Interpolated alpha, then a BC1 colour block with no 1-bit mode. */
export function decodeBc3(bytes: Uint8Array, width: number, height: number): Uint8Array {
	const { bw, bh } = requireBlocks(bytes, width, height, 16, "BC3");
	const out = new Uint8Array(width * height * 4);
	const alphas = new Uint8Array(8);
	const ai = new Uint8Array(16);
	let at = 0;
	for (let by = 0; by < bh; by++) {
		for (let bx = 0; bx < bw; bx++, at += 16) {
			alphaPalette(bytes[at], bytes[at + 1], alphas);
			channelIndices(bytes, at + 2, ai);
			const c0 = bytes[at + 8] | (bytes[at + 9] << 8);
			const c1 = bytes[at + 10] | (bytes[at + 11] << 8);
			const [r0, g0, b0] = rgb565(c0);
			const [r1, g1, b1] = rgb565(c1);
			const lut =
				(bytes[at + 12] |
					(bytes[at + 13] << 8) |
					(bytes[at + 14] << 16) |
					(bytes[at + 15] << 24)) >>>
				0;
			for (let py = 0; py < 4; py++) {
				const y = (by << 2) + py;
				if (y >= height) break;
				for (let px = 0; px < 4; px++) {
					const x = (bx << 2) + px;
					if (x >= width) continue;
					const i = 4 * py + px;
					const index = (lut >>> (2 * i)) & 3;
					let r: number;
					let g: number;
					let b: number;
					if (index === 0) {
						r = r0;
						g = g0;
						b = b0;
					} else if (index === 1) {
						r = r1;
						g = g1;
						b = b1;
					} else if (index === 2) {
						r = Math.floor((2 * r0 + r1) / 3);
						g = Math.floor((2 * g0 + g1) / 3);
						b = Math.floor((2 * b0 + b1) / 3);
					} else {
						r = Math.floor((r0 + 2 * r1) / 3);
						g = Math.floor((g0 + 2 * g1) / 3);
						b = Math.floor((b0 + 2 * b1) / 3);
					}
					const o = ((y * width + x) << 2) >>> 0;
					out[o] = r;
					out[o + 1] = g;
					out[o + 2] = b;
					out[o + 3] = alphas[ai[i]];
				}
			}
		}
	}
	return out;
}

/** BC4 / ATI1: one interpolated channel. Written to red; green and blue are 0. */
export function decodeBc4(bytes: Uint8Array, width: number, height: number): Uint8Array {
	const { bw, bh } = requireBlocks(bytes, width, height, 8, "BC4");
	const out = new Uint8Array(width * height * 4);
	const pal = new Uint8Array(8);
	const idx = new Uint8Array(16);
	let at = 0;
	for (let by = 0; by < bh; by++) {
		for (let bx = 0; bx < bw; bx++, at += 8) {
			alphaPalette(bytes[at], bytes[at + 1], pal);
			channelIndices(bytes, at + 2, idx);
			for (let py = 0; py < 4; py++) {
				const y = (by << 2) + py;
				if (y >= height) break;
				for (let px = 0; px < 4; px++) {
					const x = (bx << 2) + px;
					if (x >= width) continue;
					const o = ((y * width + x) << 2) >>> 0;
					out[o] = pal[idx[4 * py + px]];
					out[o + 3] = 255;
				}
			}
		}
	}
	return out;
}

/**
 * BC5 / ATI2: two interpolated channels, red then green. Blue is 0, alpha 255.
 *
 * This is where CodeWalker is simply wrong - see divergence 2 at the top of this file -
 * so there is no upstream oracle for BC5 pixels, only for the compressed bytes.
 *
 * For a normal map, red and green are X and Y; Z is not stored. Call
 * `reconstructNormalZ` on the result to fill blue.
 */
export function decodeBc5(bytes: Uint8Array, width: number, height: number): Uint8Array {
	const { bw, bh } = requireBlocks(bytes, width, height, 16, "BC5");
	const out = new Uint8Array(width * height * 4);
	const rPal = new Uint8Array(8);
	const rIdx = new Uint8Array(16);
	const gPal = new Uint8Array(8);
	const gIdx = new Uint8Array(16);
	let at = 0;
	for (let by = 0; by < bh; by++) {
		for (let bx = 0; bx < bw; bx++, at += 16) {
			alphaPalette(bytes[at], bytes[at + 1], rPal);
			channelIndices(bytes, at + 2, rIdx);
			alphaPalette(bytes[at + 8], bytes[at + 9], gPal);
			channelIndices(bytes, at + 10, gIdx);
			for (let py = 0; py < 4; py++) {
				const y = (by << 2) + py;
				if (y >= height) break;
				for (let px = 0; px < 4; px++) {
					const x = (bx << 2) + px;
					if (x >= width) continue;
					const i = 4 * py + px;
					const o = ((y * width + x) << 2) >>> 0;
					out[o] = rPal[rIdx[i]];
					out[o + 1] = gPal[gIdx[i]];
					out[o + 3] = 255;
				}
			}
		}
	}
	return out;
}

/**
 * Fill blue with the normal's reconstructed Z, in place.
 *
 * A two-channel normal map stores only X and Y; Z is `sqrt(1 - x^2 - y^2)` on the unit
 * sphere. GTA authors normal maps in the DirectX convention, where +Y points *down* in
 * texture space - so a consumer that expects the OpenGL convention (three.js, glTF) must
 * flip green. That is `flipGreen`, and it is off by default because the flip belongs to
 * the consumer, not to the file.
 */
export function reconstructNormalZ(rgba: Uint8Array, flipGreen = false): Uint8Array {
	for (let i = 0; i < rgba.length; i += 4) {
		const x = (rgba[i] / 255) * 2 - 1;
		let y = (rgba[i + 1] / 255) * 2 - 1;
		if (flipGreen) {
			y = -y;
			rgba[i + 1] = 255 - rgba[i + 1];
		}
		const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
		rgba[i + 2] = Math.round(((z + 1) / 2) * 255);
	}
	return rgba;
}

// --- uncompressed ---------------------------------------------------------------

/** `A8_UNORM`: alpha only. RGB is 0 - the data carries no colour to put there. */
export function decodeA8(bytes: Uint8Array, width: number, height: number): Uint8Array {
	const out = new Uint8Array(width * height * 4);
	const n = Math.min(width * height, bytes.length);
	for (let i = 0; i < n; i++) out[(i << 2) + 3] = bytes[i];
	return out;
}

/** `R8_UNORM` (legacy `L8`): one channel in red. */
export function decodeR8(bytes: Uint8Array, width: number, height: number): Uint8Array {
	const out = new Uint8Array(width * height * 4);
	const n = Math.min(width * height, bytes.length);
	for (let i = 0; i < n; i++) {
		out[i << 2] = bytes[i];
		out[(i << 2) + 3] = 255;
	}
	return out;
}

/** `R8G8B8A8_UNORM` (legacy `A8B8G8R8`): already RGBA, so this is a copy. */
export function decodeRgba8(bytes: Uint8Array, width: number, height: number): Uint8Array {
	const out = new Uint8Array(width * height * 4);
	out.set(bytes.subarray(0, Math.min(out.length, bytes.length)));
	return out;
}

/** `B8G8R8A8_UNORM` (legacy `A8R8G8B8`): BGRA in the file, swapped to RGBA here. */
export function decodeBgra8(bytes: Uint8Array, width: number, height: number): Uint8Array {
	const out = new Uint8Array(width * height * 4);
	const n = Math.min(out.length, bytes.length - (bytes.length % 4));
	for (let i = 0; i < n; i += 4) {
		out[i] = bytes[i + 2];
		out[i + 1] = bytes[i + 1];
		out[i + 2] = bytes[i];
		out[i + 3] = bytes[i + 3];
	}
	return out;
}

/** `B8G8R8X8_UNORM` (legacy `X8R8G8B8`): as BGRA but the fourth byte is padding. */
export function decodeBgrx8(bytes: Uint8Array, width: number, height: number): Uint8Array {
	const out = decodeBgra8(bytes, width, height);
	for (let i = 3; i < out.length; i += 4) out[i] = 255;
	return out;
}

/**
 * `B5G5R5A1_UNORM` (legacy `A1R5G5B5`): 16 bits little-endian, A in bit 15, then R, G, B
 * five bits each down to bit 0.
 *
 * CodeWalker's version of this is broken three separate ways - see divergence 3 at the
 * top of the file - so it cannot serve as an oracle for these pixels either.
 */
export function decodeBgr5a1(bytes: Uint8Array, width: number, height: number): Uint8Array {
	const out = new Uint8Array(width * height * 4);
	const n = Math.min(width * height, bytes.length >> 1);
	for (let i = 0; i < n; i++) {
		const v = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
		const r5 = (v >> 10) & 0x1f;
		const g5 = (v >> 5) & 0x1f;
		const b5 = v & 0x1f;
		const o = i << 2;
		out[o] = (r5 << 3) | (r5 >> 2);
		out[o + 1] = (g5 << 3) | (g5 >> 2);
		out[o + 2] = (b5 << 3) | (b5 >> 2);
		out[o + 3] = v & 0x8000 ? 255 : 0;
	}
	return out;
}

// --- BC7 ------------------------------------------------------------------------

/** LSB-first bit cursor over one 16-byte BC7 block. */
class BlockBits {
	private bit = 0;
	constructor(
		private readonly bytes: Uint8Array,
		private readonly base: number,
	) {}

	read(count: number): number {
		let value = 0;
		for (let i = 0; i < count; i++) {
			const b = this.bit + i;
			const set = (this.bytes[this.base + (b >> 3)] >> (b & 7)) & 1;
			value |= set << i;
		}
		this.bit += count;
		return value >>> 0;
	}
}

/** Expand a `bits`-precision value to 8 bits by replicating its high bits. */
function unquantize(value: number, bits: number): number {
	if (bits >= 8) return value & 0xff;
	const v = (value << (8 - bits)) & 0xff;
	return v | (v >> bits);
}

function interpolate(e0: number, e1: number, weight: number): number {
	return ((64 - weight) * e0 + weight * e1 + 32) >> 6;
}

function weightsFor(bits: number): readonly number[] {
	if (bits === 2) return BC7_WEIGHTS_2;
	if (bits === 3) return BC7_WEIGHTS_3;
	return BC7_WEIGHTS_4;
}

/**
 * BC7 / `BC7_UNORM`. Written from the Direct3D 11 BC7 specification.
 *
 * CodeWalker cannot be used as an oracle here: it has no BC7 decoder. Gen9 `.ytd`s use
 * BC7 heavily, so the CPU path exists anyway - it is just not differentially verified
 * against CodeWalker the way BC1-BC5 are.
 *
 * A block whose first byte is zero encodes no valid mode (modes 8-15 are reserved); the
 * specification says the result is undefined and hardware returns opaque black, which is
 * what happens here.
 */
export function decodeBc7(bytes: Uint8Array, width: number, height: number): Uint8Array {
	const { bw, bh } = requireBlocks(bytes, width, height, 16, "BC7");
	const out = new Uint8Array(width * height * 4);
	const pixels = new Uint8Array(64);
	for (let by = 0; by < bh; by++) {
		for (let bx = 0; bx < bw; bx++) {
			decodeBc7Block(bytes, (by * bw + bx) * 16, pixels);
			for (let py = 0; py < 4; py++) {
				const y = (by << 2) + py;
				if (y >= height) break;
				for (let px = 0; px < 4; px++) {
					const x = (bx << 2) + px;
					if (x >= width) continue;
					const s = (4 * py + px) << 2;
					const o = ((y * width + x) << 2) >>> 0;
					out[o] = pixels[s];
					out[o + 1] = pixels[s + 1];
					out[o + 2] = pixels[s + 2];
					out[o + 3] = pixels[s + 3];
				}
			}
		}
	}
	return out;
}

/** Decode one 16-byte BC7 block into 16 RGBA pixels. `out` must hold 64 bytes. */
export function decodeBc7Block(bytes: Uint8Array, at: number, out: Uint8Array): void {
	out.fill(0);

	let mode = 0;
	while (mode < 8 && ((bytes[at] >> mode) & 1) === 0) mode++;
	if (mode >= 8) {
		// Reserved mode: opaque black, which is what the hardware returns.
		for (let i = 3; i < 64; i += 4) out[i] = 255;
		return;
	}

	const m = BC7_MODES[mode];
	const bits = new BlockBits(bytes, at);
	bits.read(mode + 1); // the mode's unary prefix

	const partition = m.partitionBits > 0 ? bits.read(m.partitionBits) : 0;
	const rotation = m.rotationBits > 0 ? bits.read(m.rotationBits) : 0;
	const indexSelection = m.indexSelectionBits > 0 ? bits.read(m.indexSelectionBits) : 0;

	const endpointCount = m.subsets * 2;
	// [endpoint][channel] with channel 3 = alpha.
	const ep: number[][] = [];
	for (let i = 0; i < endpointCount; i++) ep.push([0, 0, 0, 0]);

	// Colour endpoints are stored channel-major: all R, then all G, then all B.
	for (let c = 0; c < 3; c++) {
		for (let e = 0; e < endpointCount; e++) ep[e][c] = bits.read(m.colorBits);
	}
	if (m.alphaBits > 0) {
		for (let e = 0; e < endpointCount; e++) ep[e][3] = bits.read(m.alphaBits);
	}

	// P-bits become the new low bit of every component, raising precision by one.
	let colorBits = m.colorBits;
	let alphaBits = m.alphaBits;
	if (m.endpointPBits > 0) {
		for (let e = 0; e < endpointCount; e++) {
			const p = bits.read(1);
			for (let c = 0; c < 4; c++) ep[e][c] = (ep[e][c] << 1) | p;
		}
		colorBits += 1;
		if (alphaBits > 0) alphaBits += 1;
	} else if (m.sharedPBits > 0) {
		for (let s = 0; s < m.subsets; s++) {
			const p = bits.read(1);
			for (const e of [s * 2, s * 2 + 1]) {
				for (let c = 0; c < 4; c++) ep[e][c] = (ep[e][c] << 1) | p;
			}
		}
		colorBits += 1;
		if (alphaBits > 0) alphaBits += 1;
	}

	for (let e = 0; e < endpointCount; e++) {
		for (let c = 0; c < 3; c++) ep[e][c] = unquantize(ep[e][c], colorBits);
		ep[e][3] = m.alphaBits > 0 ? unquantize(ep[e][3], alphaBits) : 255;
	}

	const subsets = bc7Subsets(m.subsets, partition);
	const anchors = [0, 0, 0];
	for (let s = 0; s < m.subsets; s++) anchors[s] = bc7Anchor(m.subsets, partition, s);

	// The anchor pixel of each subset drops its top index bit; the bit is implied 0.
	const index1 = new Uint8Array(16);
	for (let i = 0; i < 16; i++) {
		const isAnchor = i === anchors[subsets[i]];
		index1[i] = bits.read(m.indexBits - (isAnchor ? 1 : 0));
	}
	const index2 = new Uint8Array(16);
	if (m.indexBits2 > 0) {
		// The second index set is always single-subset, so only pixel 0 is an anchor.
		for (let i = 0; i < 16; i++) index2[i] = bits.read(m.indexBits2 - (i === 0 ? 1 : 0));
	}

	const w1 = weightsFor(m.indexBits);
	const w2 = m.indexBits2 > 0 ? weightsFor(m.indexBits2) : w1;

	for (let i = 0; i < 16; i++) {
		const s = subsets[i];
		const e0 = ep[s * 2];
		const e1 = ep[s * 2 + 1];

		// Mode 4's index-selection bit swaps which index set drives colour and which
		// drives alpha; every other mode uses set 1 for colour and set 2 for alpha.
		let colorWeight: number;
		let alphaWeight: number;
		if (m.indexBits2 === 0) {
			colorWeight = w1[index1[i]];
			alphaWeight = colorWeight;
		} else if (indexSelection === 1) {
			colorWeight = w2[index2[i]];
			alphaWeight = w1[index1[i]];
		} else {
			colorWeight = w1[index1[i]];
			alphaWeight = w2[index2[i]];
		}

		let r = interpolate(e0[0], e1[0], colorWeight);
		let g = interpolate(e0[1], e1[1], colorWeight);
		let b = interpolate(e0[2], e1[2], colorWeight);
		let a = m.alphaBits > 0 ? interpolate(e0[3], e1[3], alphaWeight) : 255;

		// Rotation moves the separately-indexed channel back where it belongs.
		if (rotation === 1) [r, a] = [a, r];
		else if (rotation === 2) [g, a] = [a, g];
		else if (rotation === 3) [b, a] = [a, b];

		const o = i << 2;
		out[o] = r;
		out[o + 1] = g;
		out[o + 2] = b;
		out[o + 3] = a;
	}
}

// --- dispatch -------------------------------------------------------------------

/** A pure decoder: compressed or packed bytes for one mip in, RGBA8 out. */
export type Decoder = (bytes: Uint8Array, width: number, height: number) => Uint8Array;

/** The CPU decoder for a format, or `null` if none exists. */
export function decoderFor(format: DxgiFormat): Decoder | null {
	switch (format) {
		case DxgiFormat.BC1_UNORM:
		case DxgiFormat.BC1_UNORM_SRGB:
		case DxgiFormat.BC1_TYPELESS:
			return decodeBc1;
		case DxgiFormat.BC2_UNORM:
		case DxgiFormat.BC2_UNORM_SRGB:
		case DxgiFormat.BC2_TYPELESS:
			return decodeBc2;
		case DxgiFormat.BC3_UNORM:
		case DxgiFormat.BC3_UNORM_SRGB:
		case DxgiFormat.BC3_TYPELESS:
			return decodeBc3;
		case DxgiFormat.BC4_UNORM:
		case DxgiFormat.BC4_TYPELESS:
			return decodeBc4;
		case DxgiFormat.BC5_UNORM:
		case DxgiFormat.BC5_TYPELESS:
			return decodeBc5;
		case DxgiFormat.BC7_UNORM:
		case DxgiFormat.BC7_UNORM_SRGB:
		case DxgiFormat.BC7_TYPELESS:
			return decodeBc7;
		case DxgiFormat.A8_UNORM:
			return decodeA8;
		case DxgiFormat.R8_UNORM:
			return decodeR8;
		case DxgiFormat.R8G8B8A8_UNORM:
		case DxgiFormat.R8G8B8A8_UNORM_SRGB:
			return decodeRgba8;
		case DxgiFormat.B8G8R8A8_UNORM:
			return decodeBgra8;
		case DxgiFormat.B8G8R8X8_UNORM:
			return decodeBgrx8;
		case DxgiFormat.B5G5R5A1_UNORM:
			return decodeBgr5a1;
		default:
			return null;
	}
}

/**
 * Decode one mip to RGBA8.
 *
 * Throws for a format with no CPU decoder rather than returning a plausible-looking
 * blank image - BC6H and the signed BCn variants land here, and a silent black texture
 * is far harder to diagnose than an exception.
 */
export function decodeToRgba(
	format: DxgiFormat,
	bytes: Uint8Array,
	width: number,
	height: number,
): Uint8Array {
	const decode = decoderFor(format);
	if (!decode) {
		throw new DecodeError(`no CPU decoder for DXGI format ${DxgiFormat[format] ?? format}`);
	}
	return decode(bytes, width, height);
}
