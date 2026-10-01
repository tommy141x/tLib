import { describe, expect, test } from "bun:test";
import { joaat } from "../jenk";
import { ResourceReadError } from "../reader";
import { computeMipLevels, DxgiFormat, TextureFormat, TextureFormatG9 } from "./formats";
import {
	findTexture,
	mipBytes,
	type Texture,
	type TextureDictionary,
	TextureDimension,
	TextureTileMode,
	TextureUsage,
	YTD_VERSION_GEN8,
	YTD_VERSION_GEN9,
} from "./ytd";

/**
 * A texture with a synthetic data block whose every mip is filled with its own level
 * number, so a wrong offset shows up as the wrong byte value rather than as a crash.
 */
function fixture(width: number, height: number, levels: number, name = "test"): Texture {
	const mips = computeMipLevels(DxgiFormat.BC3_UNORM, width, height, levels);
	const total = mips.reduce((n, m) => n + m.slicePitch, 0);
	const data = new Uint8Array(total);
	for (const m of mips) data.fill(m.level + 1, m.offset, m.offset + m.slicePitch);
	return {
		name,
		nameHash: joaat(name),
		width,
		height,
		depth: 1,
		levels,
		stride: mips[0].rowPitch,
		format: TextureFormat.D3DFMT_DXT5,
		formatG9: TextureFormatG9.BC3_UNORM,
		dxgi: DxgiFormat.BC3_UNORM,
		usage: TextureUsage.DIFFUSE,
		usageFlags: 0,
		dimension: TextureDimension.Texture2D,
		tileMode: TextureTileMode.Auto,
		mips,
		data,
	};
}

describe("mipBytes", () => {
	test("each level is sliced at its own offset and length", () => {
		const tex = fixture(64, 64, 5);
		for (let i = 0; i < 5; i++) {
			const bytes = mipBytes(tex, i);
			expect(bytes.length).toBe(tex.mips[i].slicePitch);
			expect(bytes.every((b) => b === i + 1)).toBe(true);
		}
	});

	test("the mip tail never falls below one 4x4 block", () => {
		const tex = fixture(4, 4, 3); // 4x4, 2x2, 1x1 - all one BC3 block
		expect(tex.mips.map((m) => m.slicePitch)).toEqual([16, 16, 16]);
		expect(mipBytes(tex, 2).length).toBe(16);
	});

	test("it returns a view, not a copy", () => {
		const tex = fixture(16, 16, 2);
		mipBytes(tex, 1)[0] = 0xab;
		expect(tex.data[tex.mips[1].offset]).toBe(0xab);
	});

	test("an out-of-range level is an error, not an empty slice", () => {
		expect(() => mipBytes(fixture(8, 8, 2), 5)).toThrow(ResourceReadError);
	});

	test("a truncated data block yields a short slice rather than throwing", () => {
		const tex = fixture(16, 16, 3);
		tex.data = tex.data.subarray(0, tex.mips[1].offset + 4);
		expect(mipBytes(tex, 1).length).toBe(4);
		expect(mipBytes(tex, 2).length).toBe(0);
	});
});

describe("findTexture", () => {
	const dict: TextureDictionary = {
		version: YTD_VERSION_GEN9,
		gen9: true,
		textures: [fixture(8, 8, 1, "Body_Diffuse"), fixture(8, 8, 1, "body_normal")],
		nameHashes: [],
		warnings: [],
	};

	test("lookup is case-insensitive, because joaat folds case", () => {
		expect(findTexture(dict, "BODY_DIFFUSE")?.name).toBe("Body_Diffuse");
		expect(findTexture(dict, "body_diffuse")?.name).toBe("Body_Diffuse");
	});

	test("a miss is undefined, not the first texture", () => {
		expect(findTexture(dict, "nope")).toBeUndefined();
	});
});

describe("container versions", () => {
	// The inversion relative to .yft is the single most expensive fact about this format:
	// here 13 is Legacy and 5 is Enhanced, the opposite way round from 162/171.
	test("gen8 is the higher number", () => {
		expect(YTD_VERSION_GEN8).toBeGreaterThan(YTD_VERSION_GEN9);
		expect(YTD_VERSION_GEN8).toBe(13);
		expect(YTD_VERSION_GEN9).toBe(5);
	});
});
