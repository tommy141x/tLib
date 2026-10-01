// The two things in `drawable-mesh.ts` that fail SILENTLY when they are wrong:
//
//   1. the per-geometry `boneIds` remap — wrong indices are still in range, so a
//      mis-skinned character renders with no error at all;
//   2. the diffuse-parameter lookup across two generations of name hash — a miss
//      renders flat grey, which is indistinguishable from a lighting problem.
//
// Both are driven here from hand-built structures rather than from a game file,
// because the game files are Rockstar-derived and this repository is public MIT.

import { describe, expect, test } from "bun:test";
import type * as THREE from "three";
import { LinearMipmapLinearFilter } from "three";

import type { Drawable, DrawableGeometry, Shader } from "../rage/drawable";
import { VertexComponentType, VertexSemantics } from "../rage/drawable";
import type { Texture, TextureDictionary } from "../rage/ytd";
import { buildDrawableMeshes, createRageTexture, DIFFUSE_PARAM_HASHES, resolveDiffuse } from "./drawable-mesh";
import { buildSkeleton, type SkeletonJson } from "./skeleton";

// ── fixtures ────────────────────────────────────────────────────────────────

/** Position (Float3) + BlendWeights (Colour) + BlendIndices (Colour) = 20 bytes. */
const DECLARATION = {
	flags:
		(1 << VertexSemantics.Position) |
		(1 << VertexSemantics.BlendWeights) |
		(1 << VertexSemantics.BlendIndices),
	stride: 20,
	count: 3,
	types:
		(BigInt(VertexComponentType.Float3) << BigInt(VertexSemantics.Position * 4)) |
		(BigInt(VertexComponentType.Colour) << BigInt(VertexSemantics.BlendWeights * 4)) |
		(BigInt(VertexComponentType.Colour) << BigInt(VertexSemantics.BlendIndices * 4)),
	unknown6: 0,
};

/** One triangle, with per-vertex blend indices and weights given as raw bytes. */
function geometry(
	blendIndices: number[][],
	blendWeights: number[][],
	boneIds: number[],
): DrawableGeometry {
	const count = blendIndices.length;
	const bytes = new Uint8Array(count * DECLARATION.stride);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < count; i++) {
		const at = i * DECLARATION.stride;
		view.setFloat32(at, i, true);
		view.setFloat32(at + 4, 0, true);
		view.setFloat32(at + 8, 0, true);
		for (let k = 0; k < 4; k++) bytes[at + 12 + k] = blendWeights[i][k] ?? 0;
		for (let k = 0; k < 4; k++) bytes[at + 16 + k] = blendIndices[i][k] ?? 0;
	}
	return {
		verticesCount: count,
		indicesCount: 3,
		trianglesCount: 1,
		vertexStride: DECLARATION.stride,
		shaderIndex: 0,
		aabbMin: [0, 0, 0, 0],
		aabbMax: [1, 1, 1, 0],
		boneIds: Uint16Array.from(boneIds),
		declaration: DECLARATION,
		declarationG9: null,
		vertexTypeName: "test",
		vertexBytes: bytes,
		indices: Uint16Array.from([0, 1, 2]),
	};
}

function drawable(geom: DrawableGeometry, extra: Partial<Drawable> = {}): Drawable {
	return {
		name: "test",
		boundingCenter: [0, 0, 0],
		boundingSphereRadius: 1,
		boundingBoxMin: [0, 0, 0],
		boundingBoxMax: [1, 1, 1],
		lodDistHigh: 100,
		lodDistMed: 200,
		lodDistLow: 300,
		lodDistVlow: 400,
		shaderGroup: null,
		skeleton: null,
		lods: [
			{
				lod: "High",
				lodDist: 100,
				renderMaskFlags: 0,
				models: [
					{
						geometries: [geom],
						shaderMapping: Uint16Array.from([0]),
						boneIndex: 0,
						hasSkin: 1,
						renderMask: 255,
						flags: 0,
					},
				],
			},
		],
		extraModels: [],
		lightAttributeCount: 0,
		hasBounds: false,
		...extra,
	};
}

/** A four-bone chain, tags deliberately not equal to indices. */
function skeletonJson(tags = [100, 200, 300, 400]): SkeletonJson {
	return {
		boneCount: tags.length,
		bones: tags.map((tag, index) => ({
			tag,
			name: `bone_${tag}`,
			index,
			parentIndex: index === 0 ? -1 : index - 1,
			translation: [0, index === 0 ? 0 : 0.5, 0] as [number, number, number],
			rotation: [0, 0, 0, 1] as [number, number, number, number],
			scale: [1, 1, 1] as [number, number, number],
		})),
	};
}

function shader(params: { nameHash: number; textureName: string }[]): Shader {
	return {
		nameHash: 0x34d90761,
		fileNameHash: 0,
		renderBucket: 0,
		renderBucketMask: 0,
		parameterCount: params.length,
		textureParameterCount: params.length,
		parameters: params.map((p) => ({
			nameHash: p.nameHash,
			dataType: 0,
			texture: {
				name: p.textureName,
				nameHash: hash(p.textureName),
				width: 4,
				height: 4,
				levels: 1,
				format: 0,
			},
			vectors: null,
		})),
	};
}

/** Any stable string -> number; these tests only need the two sides to agree. */
function hash(name: string): number {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return h;
}

function dictionary(names: string[]): TextureDictionary {
	const textures = names.map<Texture>((name) => ({
		name,
		nameHash: hash(name),
		width: 4,
		height: 4,
		depth: 1,
		levels: 1,
		stride: 16,
		format: 0,
		formatG9: 0 as Texture["formatG9"],
		// 71 is BC1_UNORM. A 4x4 BC1 image is one 8-byte block.
		dxgi: 71 as Texture["dxgi"],
		usage: 0 as Texture["usage"],
		usageFlags: 0,
		dimension: 0 as Texture["dimension"],
		tileMode: 0 as Texture["tileMode"],
		mips: [{ level: 0, width: 4, height: 4, offset: 0, rowPitch: 8, slicePitch: 8 }],
		data: new Uint8Array(8),
	}));
	return {
		version: 5,
		gen9: true,
		textures,
		nameHashes: textures.map((t) => t.nameHash),
		warnings: [],
	};
}

// ── the remap ───────────────────────────────────────────────────────────────

describe("boneIds remap", () => {
	test("BlendIndices are indices INTO boneIds, not into the skeleton", () => {
		const skeleton = buildSkeleton(skeletonJson());
		// Palette says: blend index 0 -> bone 3, 1 -> bone 1, 2 -> bone 0.
		const geom = geometry(
			[
				[0, 0, 0, 0],
				[1, 0, 0, 0],
				[2, 0, 0, 0],
			],
			[
				[255, 0, 0, 0],
				[255, 0, 0, 0],
				[255, 0, 0, 0],
			],
			[3, 1, 0],
		);
		const result = buildDrawableMeshes(drawable(geom), { skeleton });
		const skinIndex = result.meshes[0].geometry.getAttribute("skinIndex");

		expect(skinIndex.getX(0)).toBe(3);
		expect(skinIndex.getX(1)).toBe(1);
		expect(skinIndex.getX(2)).toBe(0);
		// Not the un-remapped values, which is the bug this guards.
		expect([skinIndex.getX(0), skinIndex.getX(1), skinIndex.getX(2)]).not.toEqual([0, 1, 2]);
		result.dispose();
	});

	test("an embedded skeleton is matched by TAG, not by index", () => {
		const skeleton = buildSkeleton(skeletonJson([100, 200, 300, 400]));
		// The drawable's own skeleton lists the same four bones in reverse, so index 0
		// there is tag 400, which is index 3 on the rig.
		const embedded = {
			bones: [400, 300, 200, 100].map((tag, index) => ({
				name: `bone_${tag}`,
				tag,
				index,
				parentIndex: -1,
				nextSiblingIndex: -1,
				flags: 0,
				rotation: [0, 0, 0, 1] as [number, number, number, number],
				translation: [0, 0, 0] as [number, number, number],
				scale: [1, 1, 1] as [number, number, number],
			})),
			parentIndices: Int16Array.from([-1, -1, -1, -1]),
			childIndices: Int16Array.from([]),
			transformations: new Float32Array(0),
			transformationsInverted: new Float32Array(0),
			byTag: new Map([
				[400, 0],
				[300, 1],
				[200, 2],
				[100, 3],
			]),
		};
		const geom = geometry(
			[
				[0, 0, 0, 0],
				[1, 0, 0, 0],
				[3, 0, 0, 0],
			],
			[
				[255, 0, 0, 0],
				[255, 0, 0, 0],
				[255, 0, 0, 0],
			],
			[0, 1, 2, 3],
		);
		const result = buildDrawableMeshes(drawable(geom, { skeleton: embedded }), { skeleton });
		const skinIndex = result.meshes[0].geometry.getAttribute("skinIndex");

		expect(skinIndex.getX(0)).toBe(3); // tag 400
		expect(skinIndex.getX(1)).toBe(2); // tag 300
		expect(skinIndex.getX(2)).toBe(0); // tag 100
		expect(result.warnings.some((w) => w.includes("matched by tag"))).toBe(true);
		result.dispose();
	});

	test("a tag the rig does not have is reported, not silently bound", () => {
		const skeleton = buildSkeleton(skeletonJson([100, 200, 300, 400]));
		const embedded = {
			bones: [
				{
					name: "stranger",
					tag: 999,
					index: 0,
					parentIndex: -1,
					nextSiblingIndex: -1,
					flags: 0,
					rotation: [0, 0, 0, 1] as [number, number, number, number],
					translation: [0, 0, 0] as [number, number, number],
					scale: [1, 1, 1] as [number, number, number],
				},
			],
			parentIndices: Int16Array.from([-1]),
			childIndices: Int16Array.from([]),
			transformations: new Float32Array(0),
			transformationsInverted: new Float32Array(0),
			byTag: new Map([[999, 0]]),
		};
		const geom = geometry(
			[
				[0, 0, 0, 0],
				[0, 0, 0, 0],
				[0, 0, 0, 0],
			],
			[
				[255, 0, 0, 0],
				[255, 0, 0, 0],
				[255, 0, 0, 0],
			],
			[0],
		);
		const result = buildDrawableMeshes(drawable(geom, { skeleton: embedded }), { skeleton });
		expect(result.warnings.some((w) => w.includes("tag this skeleton does not have"))).toBe(true);
		result.dispose();
	});
});

describe("skin weights", () => {
	test("are normalised to sum to 1", () => {
		const skeleton = buildSkeleton(skeletonJson());
		const geom = geometry(
			[
				[0, 1, 0, 0],
				[0, 1, 0, 0],
				[0, 1, 0, 0],
			],
			// 100 + 100 out of 255 is 0.784, not 1.
			[
				[100, 100, 0, 0],
				[100, 100, 0, 0],
				[100, 100, 0, 0],
			],
			[0, 1, 2, 3],
		);
		const result = buildDrawableMeshes(drawable(geom), { skeleton });
		const sw = result.meshes[0].geometry.getAttribute("skinWeight");
		const sum = sw.getX(0) + sw.getY(0) + sw.getZ(0) + sw.getW(0);
		expect(sum).toBeCloseTo(1, 6);
		expect(sw.getX(0)).toBeCloseTo(0.5, 6);
		result.dispose();
	});

	test("a zero-weight vertex is pinned to its first influence, not collapsed", () => {
		const skeleton = buildSkeleton(skeletonJson());
		const geom = geometry(
			[
				[2, 0, 0, 0],
				[2, 0, 0, 0],
				[2, 0, 0, 0],
			],
			[
				[0, 0, 0, 0],
				[0, 0, 0, 0],
				[0, 0, 0, 0],
			],
			[0, 1, 2, 3],
		);
		const result = buildDrawableMeshes(drawable(geom), { skeleton });
		const sw = result.meshes[0].geometry.getAttribute("skinWeight");
		expect(sw.getX(0)).toBe(1);
		expect(sw.getY(0)).toBe(0);
		result.dispose();
	});
});

describe("mesh building", () => {
	test("no skeleton means a plain Mesh, not a SkinnedMesh", () => {
		const geom = geometry(
			[
				[0, 0, 0, 0],
				[0, 0, 0, 0],
				[0, 0, 0, 0],
			],
			[
				[255, 0, 0, 0],
				[255, 0, 0, 0],
				[255, 0, 0, 0],
			],
			[0],
		);
		const result = buildDrawableMeshes(drawable(geom));
		expect(result.skinned).toBe(false);
		expect((result.meshes[0] as THREE.SkinnedMesh).isSkinnedMesh).toBeFalsy();
		expect(result.meshes[0].geometry.getAttribute("skinIndex")).toBeUndefined();
		result.dispose();
	});

	test("the depth bias is UNITS only — a slope-scaled factor fights across one mesh", () => {
		// `polygonOffsetFactor` multiplies the triangle's DEPTH SLOPE, so a
		// near-silhouette triangle gets an unbounded offset while the flat one beside it
		// gets almost none, and the two z-fight inside a SINGLE garment. On the freemode
		// t-shirt that drew a hard diagonal line across the waist that read as a second
		// garment cutting through it — visible only at a distance, because the slope
		// changes with the camera, which is why no unit test could have found it. A fixed
		// bias is all the layering ever needed: these surfaces are near-coincident, not
		// coplanar.
		const geom = geometry([[0]], [[255]], [0]);
		const sh = shader([{ nameHash: DIFFUSE_PARAM_HASHES[0], textureName: "diffuse" }]);
		const result = buildDrawableMeshes(
			drawable({ ...geom, shaderIndex: 0 }, {
				shaderGroup: { shaders: [sh], hasEmbeddedTextureDictionary: false },
			}),
			{ textures: [dictionary(["diffuse"])], depthLayer: 4 },
		);
		const material = result.meshes[0].material as THREE.MeshStandardMaterial;
		expect(material.polygonOffset).toBe(true);
		expect(material.polygonOffsetFactor).toBe(0);
		expect(material.polygonOffsetUnits).toBe(-4);
		result.dispose();
	});

	test("layer 0 takes no bias at all", () => {
		const geom = geometry([[0]], [[255]], [0]);
		const sh = shader([{ nameHash: DIFFUSE_PARAM_HASHES[0], textureName: "diffuse" }]);
		const result = buildDrawableMeshes(
			drawable({ ...geom, shaderIndex: 0 }, {
				shaderGroup: { shaders: [sh], hasEmbeddedTextureDictionary: false },
			}),
			{ textures: [dictionary(["diffuse"])] },
		);
		expect((result.meshes[0].material as THREE.MeshStandardMaterial).polygonOffset).toBe(false);
		result.dispose();
	});

	test("a drawable with no LOD says so rather than throwing", () => {
		const geom = geometry([[0]], [[255]], [0]);
		const result = buildDrawableMeshes(drawable(geom, { lods: [] }));
		expect(result.meshes).toHaveLength(0);
		expect(result.warnings).toContain("the drawable has no LOD to render");
		result.dispose();
	});
});

// ── textures ────────────────────────────────────────────────────────────────

describe("resolveDiffuse", () => {
	test("prefers the diffuse parameter hash over declaration order", () => {
		const sh = shader([
			{ nameHash: 0x11111111, textureName: "some_bump" },
			{ nameHash: DIFFUSE_PARAM_HASHES[1], textureName: "the_diffuse" },
		]);
		const found = resolveDiffuse(sh, [dictionary(["some_bump", "the_diffuse"])]);
		expect(found.name).toBe("the_diffuse");
		expect(found.texture?.name).toBe("the_diffuse");
	});

	test("both generations' hashes resolve", () => {
		for (const nameHash of DIFFUSE_PARAM_HASHES) {
			const sh = shader([{ nameHash, textureName: "d" }]);
			expect(resolveDiffuse(sh, [dictionary(["d"])]).texture?.name).toBe("d");
		}
	});

	test("falls back to any texture parameter a dictionary can satisfy", () => {
		// An unknown diffuse hash: a real texture beats a confident nothing.
		const sh = shader([{ nameHash: 0xdeadbeef, textureName: "only_one" }]);
		expect(resolveDiffuse(sh, [dictionary(["only_one"])]).texture?.name).toBe("only_one");
	});

	test("reports the name it wanted when no dictionary has it", () => {
		const sh = shader([{ nameHash: DIFFUSE_PARAM_HASHES[0], textureName: "absent" }]);
		const found = resolveDiffuse(sh, [dictionary(["something_else"])]);
		expect(found.texture).toBeNull();
		expect(found.name).toBe("absent");
	});

	test("a missing texture is surfaced on the result, not rendered grey in silence", () => {
		const geom = geometry([[0]], [[255]], [0]);
		const sh = shader([{ nameHash: DIFFUSE_PARAM_HASHES[0], textureName: "absent" }]);
		const result = buildDrawableMeshes(
			drawable({ ...geom, shaderIndex: 0 }, {
				shaderGroup: { shaders: [sh], hasEmbeddedTextureDictionary: false },
			}),
			{ textures: [dictionary([])] },
		);
		expect(result.missingTextures).toContain("absent");
		result.dispose();
	});
});

describe("createRageTexture", () => {
	/**
	 * A regression guard for a defect that was invisible in every automated signal.
	 *
	 * `flipY` used to be `true` here, with the comment "GTA texture space has V
	 * running the other way". It does not, for these files, and the result was that
	 * every diffuse sampled vertically mirrored — for as long as the code existed.
	 *
	 * Nothing caught it because nothing could: no exception, no missing texture, no
	 * failing assertion. A face is near-symmetric top to bottom in silhouette, so it
	 * still rendered as a face, with the eyes sampling cheek skin and no irises. It
	 * took rendering the ped to a PNG and looking at it.
	 *
	 * Measured in the browser: with the flip the eye-island UVs resolved to
	 * rgb(168,128,113) (cheek); without it, rgb(92,70,62) (iris).
	 */
	/**
	 * The second defect that was invisible to every automated signal, found the same
	 * way — by rendering the ped and looking at it.
	 *
	 * A diffuse here is MINIFIED: a ped head is ~200 px tall in the preview against a
	 * 512x512 `head_diff` / `hair_diff`. Sampled from one level that aliases, and on an
	 * alpha CUTOUT mask the aliasing is not a shimmer — `hair_diff_001_a_uni`'s alpha
	 * is 54.6% below 0.1 and 28.1% above 0.9, so the test kept or dropped whole texels
	 * at random and a haircut rendered as a scatter of dots on a bald scalp.
	 *
	 * `generateMipmaps`, not the file's own chain: a RAGE chain stops at the 4x4 block,
	 * and a `mipmaps` array that does not reach 1x1 leaves the texture mipmap-INCOMPLETE
	 * in WebGL, which samples black with no error anywhere.
	 */
	test("mipmaps, because every diffuse here is minified", () => {
		const texture = dictionary(["diffuse"]).textures[0];
		expect(texture).toBeDefined();
		const map = createRageTexture(texture as Texture);
		expect(map).not.toBeNull();
		expect((map as THREE.DataTexture).generateMipmaps).toBe(true);
		expect((map as THREE.DataTexture).minFilter).toBe(LinearMipmapLinearFilter);
		(map as THREE.DataTexture).dispose();
	});

	test("does not flip V — the drawables' UVs are already in GL's convention", () => {
		const texture = dictionary(["diffuse"]).textures[0];
		expect(texture).toBeDefined();
		const map = createRageTexture(texture as Texture);
		expect(map).not.toBeNull();
		expect((map as THREE.DataTexture).flipY).toBe(false);
		(map as THREE.DataTexture).dispose();
	});
});
