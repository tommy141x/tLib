import { describe, expect, test } from "bun:test";
import {
	bitsPerPixel,
	blockBytes,
	computeDataSize,
	computeLegacyDataSize,
	computeMipLevels,
	computePitch,
	computeScanlines,
	DxgiFormat,
	dxgiFromG9,
	dxgiFromLegacy,
	isCompressedFormat,
	legacyFormatFromG9,
	TextureFormat,
	TextureFormatG9,
} from "./formats";

describe("computePitch", () => {
	test("BC1 is 8 bytes per 4x4 block", () => {
		expect(computePitch(DxgiFormat.BC1_UNORM, 256, 256)).toEqual({
			rowPitch: 64 * 8,
			slicePitch: 64 * 8 * 64,
		});
	});

	test("BC3 is 16 bytes per 4x4 block", () => {
		expect(computePitch(DxgiFormat.BC3_UNORM, 8, 8)).toEqual({ rowPitch: 32, slicePitch: 64 });
	});

	// The mip tail is where a missing max(1, ...) shows up: a 2x2 or 1x1 BCn mip still
	// occupies one whole block, so the sizes below must not fall below one block.
	test.each([
		[4, 4, 16],
		[2, 2, 16],
		[1, 1, 16],
		[2, 1, 16],
		[1, 8, 32],
	])("BC3 %ix%i occupies %i bytes", (w, h, bytes) => {
		expect(computePitch(DxgiFormat.BC3_UNORM, w, h).slicePitch).toBe(bytes);
	});

	test("BC1 1x1 still occupies a whole 8-byte block", () => {
		expect(computePitch(DxgiFormat.BC1_UNORM, 1, 1).slicePitch).toBe(8);
	});

	test("uncompressed is byte-aligned, not DWORD-aligned", () => {
		// CodeWalker passes flags = 0, which is the default byte alignment branch.
		expect(computePitch(DxgiFormat.B8G8R8A8_UNORM, 3, 2)).toEqual({ rowPitch: 12, slicePitch: 24 });
		expect(computePitch(DxgiFormat.R8_UNORM, 5, 3)).toEqual({ rowPitch: 5, slicePitch: 15 });
		expect(computePitch(DxgiFormat.B5G5R5A1_UNORM, 5, 3)).toEqual({ rowPitch: 10, slicePitch: 30 });
	});
});

describe("computeMipLevels", () => {
	// Measured against `gtatool ytd`: wires_diffuse in 18chast.ytd is 2048x512 BC3 with
	// 10 levels and CodeWalker reports exactly 1,398,128 bytes for it.
	test("matches CodeWalker's reported size for a real 10-mip BC3 texture", () => {
		expect(computeDataSize(DxgiFormat.BC3_UNORM, 2048, 512, 10)).toBe(1_398_128);
	});

	test("levels come from dividing the base dimensions, not halving the previous level", () => {
		const mips = computeMipLevels(DxgiFormat.BC1_UNORM, 12, 12, 3);
		expect(mips.map((m) => [m.width, m.height])).toEqual([
			[12, 12],
			[6, 6],
			[3, 3],
		]);
	});

	test("offsets are the running sum of the slice pitches", () => {
		const mips = computeMipLevels(DxgiFormat.BC3_UNORM, 16, 16, 3);
		expect(mips.map((m) => m.offset)).toEqual([0, 256, 320]);
		expect(mips.map((m) => m.slicePitch)).toEqual([256, 64, 16]);
	});

	test("a dimension can reach zero, and for an uncompressed format that is a zero mip", () => {
		const mips = computeMipLevels(DxgiFormat.B8G8R8A8_UNORM, 4, 4, 4);
		expect(mips[3]).toMatchObject({ width: 0, height: 0, slicePitch: 0 });
	});
});

describe("computeLegacyDataSize", () => {
	// gen8 sizes its data block from the stored stride and quarters it per level; that is
	// a different formula from the gen9 one and must not be unified with it.
	test("quarters the base length per level", () => {
		expect(computeLegacyDataSize(512, 256, 3)).toBe(131072 + 32768 + 8192);
	});

	test("agrees with computeDataSize for a power-of-two BC3 texture", () => {
		const stride = computePitch(DxgiFormat.BC3_UNORM, 256, 256).rowPitch;
		// gen8's stride is a row of blocks, so its "height" term is the block row count.
		expect(computeLegacyDataSize(stride, 64, 5)).toBe(
			computeDataSize(DxgiFormat.BC3_UNORM, 256, 256, 5),
		);
	});
});

describe("format mapping", () => {
	test("gen9 -> legacy follows GetLegacyFormat, sRGB collapse included", () => {
		expect(legacyFormatFromG9(TextureFormatG9.BC1_UNORM)).toBe(TextureFormat.D3DFMT_DXT1);
		expect(legacyFormatFromG9(TextureFormatG9.BC7_UNORM_SRGB)).toBe(TextureFormat.D3DFMT_BC7);
		expect(legacyFormatFromG9(TextureFormatG9.BC3_UNORM_SRGB)).toBe(TextureFormat.D3DFMT_DXT5);
		expect(legacyFormatFromG9(TextureFormatG9.UNKNOWN)).toBe(0);
	});

	test("gen9 -> DXGI keeps sRGB, which the legacy detour loses", () => {
		expect(dxgiFromG9(TextureFormatG9.BC7_UNORM_SRGB)).toBe(DxgiFormat.BC7_UNORM_SRGB);
		expect(dxgiFromLegacy(legacyFormatFromG9(TextureFormatG9.BC7_UNORM_SRGB))).toBe(
			DxgiFormat.BC7_UNORM,
		);
	});

	test("legacy FourCCs decode to the right DXGI values", () => {
		expect(dxgiFromLegacy(TextureFormat.D3DFMT_DXT1)).toBe(DxgiFormat.BC1_UNORM);
		expect(dxgiFromLegacy(TextureFormat.D3DFMT_DXT3)).toBe(DxgiFormat.BC2_UNORM);
		expect(dxgiFromLegacy(TextureFormat.D3DFMT_DXT5)).toBe(DxgiFormat.BC3_UNORM);
		expect(dxgiFromLegacy(TextureFormat.D3DFMT_ATI1)).toBe(DxgiFormat.BC4_UNORM);
		expect(dxgiFromLegacy(TextureFormat.D3DFMT_ATI2)).toBe(DxgiFormat.BC5_UNORM);
		expect(dxgiFromLegacy(TextureFormat.D3DFMT_BC7)).toBe(DxgiFormat.BC7_UNORM);
	});

	test("an unmapped format is UNKNOWN rather than a plausible default", () => {
		expect(dxgiFromG9(TextureFormatG9.ETC1)).toBe(DxgiFormat.UNKNOWN);
		expect(dxgiFromLegacy(0)).toBe(DxgiFormat.UNKNOWN);
	});
});

describe("format properties", () => {
	test("isCompressedFormat covers BC1-BC7 and nothing else", () => {
		expect(isCompressedFormat(DxgiFormat.BC1_UNORM)).toBe(true);
		expect(isCompressedFormat(DxgiFormat.BC5_SNORM)).toBe(true);
		expect(isCompressedFormat(DxgiFormat.BC7_UNORM_SRGB)).toBe(true);
		expect(isCompressedFormat(DxgiFormat.B8G8R8A8_UNORM)).toBe(false);
		expect(isCompressedFormat(DxgiFormat.B5G5R5A1_UNORM)).toBe(false);
	});

	test("blockBytes is 8 for BC1/BC4 and 16 for the rest", () => {
		expect(blockBytes(DxgiFormat.BC1_UNORM)).toBe(8);
		expect(blockBytes(DxgiFormat.BC4_UNORM)).toBe(8);
		expect(blockBytes(DxgiFormat.BC3_UNORM)).toBe(16);
		expect(blockBytes(DxgiFormat.BC7_UNORM)).toBe(16);
		expect(blockBytes(DxgiFormat.A8_UNORM)).toBe(0);
	});

	test("bitsPerPixel", () => {
		expect(bitsPerPixel(DxgiFormat.B8G8R8A8_UNORM)).toBe(32);
		expect(bitsPerPixel(DxgiFormat.B5G5R5A1_UNORM)).toBe(16);
		expect(bitsPerPixel(DxgiFormat.A8_UNORM)).toBe(8);
		expect(bitsPerPixel(DxgiFormat.BC1_UNORM)).toBe(4);
		expect(bitsPerPixel(DxgiFormat.BC7_UNORM)).toBe(8);
	});

	test("computeScanlines counts block rows for compressed formats", () => {
		expect(computeScanlines(DxgiFormat.BC3_UNORM, 17)).toBe(5);
		expect(computeScanlines(DxgiFormat.BC3_UNORM, 1)).toBe(1);
		expect(computeScanlines(DxgiFormat.B8G8R8A8_UNORM, 17)).toBe(17);
	});
});
