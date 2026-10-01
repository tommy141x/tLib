// Drawables: LOD groups, models, geometries, vertex/index buffers and skeletons.
//
// Ported from CodeWalker.Core (MIT, dexyfex/Neodymium):
//   Resources/Drawable.cs:1353-2054   Skeleton
//   Resources/Drawable.cs:2055-2189   SkeletonBonesBlock / SkeletonBoneTag
//   Resources/Drawable.cs:2574-2789   Bone
//   Resources/Drawable.cs:3062-3289   DrawableModelsBlock
//   Resources/Drawable.cs:3290-3664   DrawableModel
//   Resources/Drawable.cs:3665-3970   DrawableGeometry
//   Resources/Drawable.cs:3971-4391   VertexBuffer (gen8 128 bytes / gen9 64)
//   Resources/Drawable.cs:4392-4929   VertexData
//   Resources/Drawable.cs:5446-5668   IndexBuffer  (gen8 96 bytes  / gen9 64)
//   Resources/Drawable.cs:5953-6679   DrawableBase
//   Resources/Drawable.cs:6680-6825   Drawable
//   Resources/Drawable.cs:7027-7189   DrawableDictionary
//   Resources/Frag.cs:41-400          FragType (main drawable only)
//
// Block layouts are field-for-field, padding included: every `skip` is a real gap in
// the file. Offsets are kept even where the field is unused, because they are what
// makes the next read land.
//
// Only four blocks differ between generations - ShaderFX, ShaderParametersBlock,
// VertexBuffer and IndexBuffer. The skeleton, models and geometries are identical, so
// they have one code path.

import { joaat } from "../jenk";
import { type ResourceReader, ResourceReadError } from "../reader";
import { SYSTEM_BASE } from "../rsc7";
import { float32sAt, int16sAt, readVector3, readVector4, uint16sAt, uint32sAt, uint64sAt } from "./arrays";
import { readShaderGroup, type ShaderGroup, type ShaderParseOptions } from "./shaders";
import {
	legacyDeclarationFromG9,
	repackGen9Vertices,
	type VertexDeclaration,
	type VertexDeclarationG9,
	vertexTypeName,
} from "./vertex";

export type Generation = "gen8" | "gen9";

/** The four LOD levels a drawable can carry, in decreasing detail. */
export const LOD_NAMES = ["High", "Med", "Low", "VLow"] as const;
export type LodName = (typeof LOD_NAMES)[number];

export interface DrawableParseContext {
	generation: Generation;
	warnings: string[];
	shaderOptions: ShaderParseOptions;
	/**
	 * Optional hash -> name lookup, used to label a `.ydd` entry whose embedded name
	 * does not hash to the dictionary's key.
	 *
	 * CodeWalker resolves those through its bundled `MetaNames` table plus a JenkIndex
	 * built from a full game scan - neither of which ships here. Without a resolver the
	 * key falls back to `hash_XXXXXXXX`, which is exactly what CodeWalker prints when
	 * its own tables miss.
	 */
	resolveHash?: (hash: number) => string | null;
}

// --- skeleton -------------------------------------------------------------------

/** `EBoneFlags`. CodeWalker Drawable.cs:2190-2210. */
export enum BoneFlags {
	None = 0,
	RotX = 0x1,
	RotY = 0x2,
	RotZ = 0x4,
	LimitRotation = 0x8,
	TransX = 0x10,
	TransY = 0x20,
	TransZ = 0x40,
	LimitTranslation = 0x80,
	ScaleX = 0x100,
	ScaleY = 0x200,
	ScaleZ = 0x400,
	LimitScale = 0x800,
	Unk0 = 0x1000,
	Unk1 = 0x2000,
	Unk2 = 0x4000,
	Unk3 = 0x8000,
}

export interface Bone {
	name: string | null;
	/** joaat-adjacent 16-bit tag; animation tracks address bones by this, not by index. */
	tag: number;
	index: number;
	parentIndex: number;
	nextSiblingIndex: number;
	flags: number;
	/** Local rest pose, relative to the parent. */
	rotation: [number, number, number, number];
	translation: [number, number, number];
	scale: [number, number, number];
}

export interface Skeleton {
	bones: Bone[];
	/** `parentIndices[i]` is the parent of bone `i`, or -1. */
	parentIndices: Int16Array;
	childIndices: Int16Array;
	/** Row-major 4x4 world transforms, 16 floats each, as stored. */
	transformations: Float32Array;
	transformationsInverted: Float32Array;
	/** Bone tag -> bone index. Built from the bones, not from the file's hash table. */
	byTag: Map<number, number>;
}

/** A `Bone`: 80 bytes. */
function readBone(r: ResourceReader): Bone {
	const rotation = readVector4(r);
	const translation = readVector3(r);
	r.skip(4); // Unknown_1Ch, the translation's w
	const scale = readVector3(r);
	r.skip(4); // Unknown_2Ch, the scale's w, always 1.0
	const nextSiblingIndex = r.int16();
	const parentIndex = r.int16();
	r.skip(4); // Unknown_34h
	const namePointer = r.pointer();
	const flags = r.uint16();
	const index = r.int16();
	const tag = r.uint16();
	r.skip(2); // Index2, always equal to Index
	r.skip(8); // Unknown_48h

	return {
		name: r.stringAt(namePointer),
		tag,
		index,
		parentIndex,
		nextSiblingIndex,
		flags,
		rotation,
		translation,
		scale,
	};
}

/**
 * A `Skeleton`: 112 bytes.
 *
 * `BonesPointer` already points *past* a 16-byte `SkeletonBonesBlock` header, so the
 * bones start exactly there.
 */
function readSkeleton(r: ResourceReader, ctx: DrawableParseContext): Skeleton {
	r.skip(4); // VFT
	r.skip(4); // Unknown_4h
	r.skip(8); // Unknown_8h
	r.skip(8); // BoneTagsPointer - a hash table we rebuild from the bones instead
	r.skip(2); // BoneTagsCapacity
	r.skip(2); // BoneTagsCount
	r.skip(4); // Unknown_1Ch
	const bonesPointer = r.pointer();
	const transformationsInvertedPointer = r.pointer();
	const transformationsPointer = r.pointer();
	const parentIndicesPointer = r.pointer();
	const childIndicesPointer = r.pointer();
	r.skip(8); // Unknown_48h
	r.skip(4); // Unknown_50h
	r.skip(4); // Unknown_54h
	r.skip(4); // Unknown_58h
	r.skip(2); // Unknown_5Ch
	const bonesCount = r.uint16();
	const childIndicesCount = r.uint16();
	r.skip(2); // Unknown_62h
	r.skip(4); // Unknown_64h
	r.skip(8); // Unknown_68h

	// CodeWalker reads a `SkeletonBonesBlock` at `bonesPointer - 16` and then consumes
	// that block's own 16-byte header, so the bones themselves begin exactly at
	// `bonesPointer`. Reading from `bonesPointer - 16` without the header skip yields a
	// plausible-looking first bone made of the header's zeroes.
	const bones: Bone[] = bonesPointer ? r.simpleArray(bonesPointer, bonesCount, readBone) : [];
	if (bones.length !== bonesCount) {
		ctx.warnings.push(`skeleton declares ${bonesCount} bones but ${bones.length} were read`);
	}

	const byTag = new Map<number, number>();
	for (let i = 0; i < bones.length; i++) byTag.set(bones[i].tag, i);

	return {
		bones,
		parentIndices: int16sAt(r, parentIndicesPointer, bonesCount),
		childIndices: int16sAt(r, childIndicesPointer, childIndicesCount),
		transformations: float32sAt(r, transformationsPointer, bonesCount * 16),
		transformationsInverted: float32sAt(r, transformationsInvertedPointer, bonesCount * 16),
		byTag,
	};
}

// --- vertex and index buffers ---------------------------------------------------

/** A legacy `VertexDeclaration`: 16 bytes. */
function readVertexDeclaration(r: ResourceReader): VertexDeclaration {
	const flags = r.uint32();
	const stride = r.uint16();
	const unknown6 = r.byte();
	const count = r.byte();
	// `types` is 16 nibbles and genuinely exceeds 2^53 (GTAV1 is 0x7755555555996996),
	// so it cannot go through the reader's uint64 - that one throws above MAX_SAFE_INTEGER.
	const lo = BigInt(r.uint32() >>> 0);
	const hi = BigInt(r.uint32() >>> 0);
	return { flags, stride, count, types: (hi << 32n) | lo, unknown6 };
}

/** A gen9 `VertexDeclarationG9`: 320 bytes of 52 parallel slots plus a packed word. */
function readVertexDeclarationG9(r: ResourceReader): VertexDeclarationG9 {
	const offsets = new Uint32Array(52);
	for (let i = 0; i < 52; i++) offsets[i] = r.uint32();
	const sizes = new Uint8Array(52);
	for (let i = 0; i < 52; i++) sizes[i] = r.byte();
	const types = new Uint8Array(52);
	for (let i = 0; i < 52; i++) types[i] = r.byte();
	const lo = BigInt(r.uint32() >>> 0);
	const hi = BigInt(r.uint32() >>> 0);
	const data = (hi << 32n) | lo;

	let elementCount = 0;
	for (const t of types) if (t !== 0) elementCount++;

	return {
		offsets,
		sizes,
		types,
		data,
		hasSOA: (data & 1n) > 0n,
		vertexSize: Number((data >> 2n) & 0xffn),
		vertexCount: Number((data >> 10n) & 0x3fffffn),
		elementCount,
	};
}

interface VertexBufferResult {
	declaration: VertexDeclaration | null;
	declarationG9: VertexDeclarationG9 | null;
	vertexCount: number;
	stride: number;
	/** Always in *legacy* component order, even for gen9. */
	bytes: Uint8Array;
}

/**
 * A `VertexBuffer`. Gen8 is 128 bytes, gen9 64, and the field order is different.
 *
 * Vertex data lives in the **graphics** segment. On gen9 it is also stored in RAGE
 * semantic order rather than legacy slot order, so it is repacked here and every
 * consumer downstream sees one layout.
 */
function readVertexBuffer(r: ResourceReader, ctx: DrawableParseContext): VertexBufferResult {
	r.skip(4); // VFT
	r.skip(4); // Unknown_4h

	if (ctx.generation === "gen9") {
		const vertexCount = r.uint32();
		const stride = r.uint16();
		r.skip(2); // G9_Unknown_Eh
		r.skip(4); // G9_BindFlags
		r.skip(4); // G9_Unknown_14h
		const dataPointer = r.pointer(); // m_vertexData
		r.skip(8); // G9_Unknown_20h (m_pad)
		r.skip(8); // Unknown_28h (m_pad2)
		r.skip(8); // G9_SRVPointer
		const infoPointer = r.pointer(); // m_vertexFormat (rage::grcFvf)

		const declarationG9 = infoPointer ? r.atPointer(infoPointer, readVertexDeclarationG9) : null;
		if (!declarationG9) {
			ctx.warnings.push("gen9 vertex buffer has no vertex format block");
			return { declaration: null, declarationG9: null, vertexCount, stride, bytes: new Uint8Array(0) };
		}

		const declaration = legacyDeclarationFromG9(declarationG9);
		if (declaration.stride !== declarationG9.vertexSize) {
			ctx.warnings.push(
				`gen9 declaration converts to stride ${declaration.stride} but the block says ` +
					`${declarationG9.vertexSize}`,
			);
		}
		if (declaration.count !== declarationG9.elementCount) {
			ctx.warnings.push(
				`gen9 declaration converts to ${declaration.count} components but the block has ` +
					`${declarationG9.elementCount}`,
			);
		}

		let bytes: Uint8Array = new Uint8Array(0);
		if (dataPointer && vertexCount > 0 && stride > 0) {
			const raw = r.bytesAt(dataPointer, vertexCount * stride);
			bytes = repackGen9Vertices(declarationG9, declaration, raw, vertexCount, stride);
		}
		return { declaration, declarationG9, vertexCount, stride, bytes };
	}

	const stride = r.uint16();
	r.skip(2); // Flags, only ever 0 or 1024
	r.skip(4); // Unknown_Ch
	const dataPointer1 = r.pointer();
	const vertexCount = r.uint32();
	r.skip(4); // Unknown_1Ch
	const dataPointer2 = r.pointer();
	r.skip(8); // Unknown_28h
	const infoPointer = r.pointer();
	r.skip(8); // Unknown_38h
	r.skip(8); // Unknown_40h
	r.skip(8); // Unknown_48h
	r.skip(8); // Unknown_50h
	r.skip(8); // Unknown_58h
	r.skip(8); // Unknown_60h
	r.skip(8); // Unknown_68h
	r.skip(8); // Unknown_70h
	r.skip(8); // Unknown_78h

	const declaration = infoPointer ? r.atPointer(infoPointer, readVertexDeclaration) : null;
	// Data1 and Data2 are the same block in every vanilla file; CodeWalker falls back
	// from one to the other, so this does too.
	const dataPointer = dataPointer1 || dataPointer2;
	let bytes: Uint8Array = new Uint8Array(0);
	if (dataPointer && vertexCount > 0 && stride > 0) {
		bytes = r.bytesAt(dataPointer, vertexCount * stride);
	}
	return { declaration, declarationG9: null, vertexCount, stride, bytes };
}

/** An `IndexBuffer`. Gen8 96 bytes, gen9 64. Indices are 16-bit triangle lists. */
function readIndexBuffer(r: ResourceReader, ctx: DrawableParseContext): Uint16Array {
	r.skip(4); // VFT
	r.skip(4); // Unknown_4h
	const indicesCount = r.uint32();

	if (ctx.generation === "gen9") {
		const indexSize = r.uint16();
		r.skip(2); // G9_Unknown_Eh
		r.skip(4); // G9_BindFlags
		r.skip(4); // G9_Unknown_14h
		const indicesPointer = r.pointer();
		r.skip(8); // Unknown_20h
		r.skip(8); // Unknown_28h
		r.skip(8); // G9_SRVPointer
		r.skip(8); // Unknown_38h
		if (indexSize !== 2) {
			ctx.warnings.push(`gen9 index buffer declares ${indexSize}-byte indices; only 2 is supported`);
			return new Uint16Array(0);
		}
		return uint16sAt(r, indicesPointer, indicesCount);
	}

	r.skip(4); // Unknown_Ch
	const indicesPointer = r.pointer();
	r.skip(8); // Unknown_18h
	r.skip(8); // Unknown_20h
	r.skip(8); // Unknown_28h
	r.skip(8); // Unknown_30h
	r.skip(8); // Unknown_38h
	r.skip(8); // Unknown_40h
	r.skip(8); // Unknown_48h
	r.skip(8); // Unknown_50h
	r.skip(8); // Unknown_58h
	return uint16sAt(r, indicesPointer, indicesCount);
}

// --- geometries and models ------------------------------------------------------

export interface DrawableGeometry {
	verticesCount: number;
	indicesCount: number;
	trianglesCount: number;
	vertexStride: number;
	/** Index into the drawable's shader group. Assigned by the parent model. */
	shaderIndex: number;
	/** Per-geometry AABB from the parent model's bounds array; two Vector4s. */
	aabbMin: [number, number, number, number];
	aabbMax: [number, number, number, number];
	/** Skin palette: which skeleton bones this geometry's blend indices address. */
	boneIds: Uint16Array;
	declaration: VertexDeclaration | null;
	/** Gen9 only; `null` on gen8. Kept so callers can see the untranslated format. */
	declarationG9: VertexDeclarationG9 | null;
	/** CodeWalker's name for this layout, e.g. "Default", "DefaultEx". */
	vertexTypeName: string;
	/** Raw vertex bytes in legacy component order, `verticesCount * vertexStride`. */
	vertexBytes: Uint8Array;
	indices: Uint16Array;
}

/**
 * A `DrawableGeometry`: 152 bytes, plus an inline bone-id array.
 *
 * The bone ids are packed straight after the struct, 8-byte aligned when there are
 * more than four of them - which is why the pointer is followed rather than the
 * position assumed.
 */
function readGeometry(r: ResourceReader, ctx: DrawableParseContext): DrawableGeometry {
	r.skip(4); // VFT
	r.skip(4); // Unknown_4h
	r.skip(8); // Unknown_8h
	r.skip(8); // Unknown_10h
	const vertexBufferPointer = r.pointer();
	r.skip(8); // Unknown_20h
	r.skip(8); // Unknown_28h
	r.skip(8); // Unknown_30h
	const indexBufferPointer = r.pointer();
	r.skip(8); // Unknown_40h
	r.skip(8); // Unknown_48h
	r.skip(8); // Unknown_50h
	const indicesCount = r.uint32();
	const trianglesCount = r.uint32();
	let verticesCount = r.uint16();
	r.skip(2); // Unknown_62h, indices per primitive (3)
	r.skip(4); // Unknown_64h
	const boneIdsPointer = r.pointer();
	const vertexStride = r.uint16();
	const boneIdsCount = r.uint16();
	r.skip(4); // Unknown_74h
	r.skip(8); // VertexDataPointer - always equals the vertex buffer's own data pointer
	r.skip(8); // Unknown_80h
	r.skip(8); // Unknown_88h
	r.skip(8); // Unknown_90h

	const vb = vertexBufferPointer ? r.atPointer(vertexBufferPointer, (rr) => readVertexBuffer(rr, ctx)) : null;
	const indices = indexBufferPointer ? (r.atPointer(indexBufferPointer, (rr) => readIndexBuffer(rr, ctx)) ?? new Uint16Array(0)) : new Uint16Array(0);

	// A geometry may store 0 vertices and defer to the buffer; CodeWalker back-fills
	// the same way (Drawable.cs:3772-3776).
	if (verticesCount === 0 && vb) verticesCount = vb.vertexCount;

	const declaration = vb?.declaration ?? null;
	return {
		verticesCount,
		indicesCount,
		trianglesCount,
		vertexStride,
		shaderIndex: 0,
		aabbMin: [0, 0, 0, 0],
		aabbMax: [0, 0, 0, 0],
		boneIds: uint16sAt(r, boneIdsPointer, boneIdsCount),
		declaration,
		declarationG9: vb?.declarationG9 ?? null,
		vertexTypeName: declaration ? vertexTypeName(declaration) : "",
		vertexBytes: vb?.bytes ?? new Uint8Array(0),
		indices,
	};
}

export interface DrawableModel {
	geometries: DrawableGeometry[];
	/** Geometry index -> shader index. */
	shaderMapping: Uint16Array;
	/** Skeleton bone this whole model hangs off. */
	boneIndex: number;
	/** 1 when the model's geometries carry blend weights/indices. */
	hasSkin: number;
	renderMask: number;
	flags: number;
}

/** A `DrawableModel`: 48 bytes plus inline shader-mapping, pointer and bounds arrays. */
function readModel(r: ResourceReader, ctx: DrawableParseContext): DrawableModel {
	r.skip(4); // VFT
	r.skip(4); // Unknown_4h
	const geometriesPointer = r.pointer();
	const geometriesCount = r.uint16();
	r.skip(2); // GeometriesCount2, always equal
	r.skip(4); // Unknown_14h
	const boundsPointer = r.pointer();
	const shaderMappingPointer = r.pointer();
	const skeletonBinding = r.uint32();
	const renderMaskFlags = r.uint16();
	r.skip(2); // GeometriesCount3, always equal

	const shaderMapping = uint16sAt(r, shaderMappingPointer, geometriesCount);
	const geometryPointers = uint64sAt(r, geometriesPointer, geometriesCount);
	// With more than one geometry the bounds array carries a leading whole-model AABB,
	// so per-geometry bounds start at index 1.
	const boundsCount = geometriesCount > 1 ? geometriesCount + 1 : geometriesCount;
	const bounds = float32sAt(r, boundsPointer, boundsCount * 8);

	const geometries: DrawableGeometry[] = [];
	for (let i = 0; i < geometryPointers.length; i++) {
		const geom = r.atPointer(geometryPointers[i], (rr) => readGeometry(rr, ctx));
		if (!geom) {
			ctx.warnings.push(`model geometry ${i} has a null pointer`);
			continue;
		}
		geom.shaderIndex = i < shaderMapping.length ? shaderMapping[i] : 0;
		const b = boundsCount > 1 && i + 1 < boundsCount ? i + 1 : 0;
		if (bounds.length >= (b + 1) * 8) {
			geom.aabbMin = [bounds[b * 8], bounds[b * 8 + 1], bounds[b * 8 + 2], bounds[b * 8 + 3]];
			geom.aabbMax = [bounds[b * 8 + 4], bounds[b * 8 + 5], bounds[b * 8 + 6], bounds[b * 8 + 7]];
		}
		geometries.push(geom);
	}

	return {
		geometries,
		shaderMapping,
		boneIndex: (skeletonBinding >>> 24) & 0xff,
		hasSkin: (skeletonBinding >>> 8) & 0xff,
		renderMask: renderMaskFlags & 0xff,
		flags: (renderMaskFlags >>> 8) & 0xff,
	};
}

/** `ResourcePointerListHeader`: pointer, count, capacity, pad. */
function readPointerListHeader(r: ResourceReader): { pointer: number; count: number; capacity: number } {
	const pointer = r.pointer();
	const count = r.uint16();
	const capacity = r.uint16();
	r.skip(4);
	return { pointer, count, capacity };
}

function readModelList(r: ResourceReader, listPointer: number, ctx: DrawableParseContext): DrawableModel[] {
	if (!listPointer) return [];
	const header = r.atPointer(listPointer, readPointerListHeader);
	if (!header) return [];
	// CodeWalker walks `Capacity`, not `Count`: the two are equal in every shipped file
	// and capacity is what the pointer array is sized by.
	const pointers = uint64sAt(r, header.pointer, header.capacity);
	const out: DrawableModel[] = [];
	for (const p of pointers) {
		const m = r.atPointer(p, (rr) => readModel(rr, ctx));
		if (m) out.push(m);
	}
	return out;
}

// --- drawables ------------------------------------------------------------------

export interface DrawableLod {
	lod: LodName;
	models: DrawableModel[];
	lodDist: number;
	renderMaskFlags: number;
}

export interface Drawable {
	name: string | null;
	boundingCenter: [number, number, number];
	boundingSphereRadius: number;
	boundingBoxMin: [number, number, number];
	boundingBoxMax: [number, number, number];
	lodDistHigh: number;
	lodDistMed: number;
	lodDistLow: number;
	lodDistVlow: number;
	shaderGroup: ShaderGroup | null;
	skeleton: Skeleton | null;
	/** Only the populated LOD levels, in High..VLow order. */
	lods: DrawableLod[];
	/**
	 * Models found at the `DrawableModelsPointer` block when it differs from the High
	 * pointer. CodeWalker calls these "Extra" and notes they shouldn't be used.
	 */
	extraModels: DrawableModel[];
	/** Light attributes are counted but not decoded. */
	lightAttributeCount: number;
	/** True when the drawable carries a collision `Bounds` block (not decoded). */
	hasBounds: boolean;
}

interface DrawableBaseFields {
	drawable: Drawable;
	/** Byte length of the `DrawableBase` header, so subclasses know where they start. */
	headerBytes: number;
}

/** A `DrawableBase`: 168 bytes, generation-independent. */
function readDrawableBase(r: ResourceReader, ctx: DrawableParseContext): DrawableBaseFields {
	r.skip(4); // FileVFT
	r.skip(4); // FileUnknown
	r.skip(8); // FilePagesInfoPointer

	const shaderGroupPointer = r.pointer();
	const skeletonPointer = r.pointer();
	const boundingCenter = readVector3(r);
	const boundingSphereRadius = r.float32();
	const boundingBoxMin = readVector3(r);
	r.skip(4); // Unknown_3Ch, the min's w (0x7f800001)
	const boundingBoxMax = readVector3(r);
	r.skip(4); // Unknown_4Ch, the max's w
	const highPointer = r.pointer();
	const medPointer = r.pointer();
	const lowPointer = r.pointer();
	const vlowPointer = r.pointer();
	const lodDistHigh = r.float32();
	const lodDistMed = r.float32();
	const lodDistLow = r.float32();
	const lodDistVlow = r.float32();
	const renderMaskHigh = r.uint32();
	const renderMaskMed = r.uint32();
	const renderMaskLow = r.uint32();
	const renderMaskVlow = r.uint32();
	r.skip(8); // JointsPointer - rotation/translation limits, not decoded
	r.skip(2); // Unknown_98h
	r.skip(2); // DrawableModelsBlocksSize
	r.skip(4); // Unknown_9Ch
	const modelsPointer = r.pointer();

	const shaderGroup = shaderGroupPointer
		? r.atPointer(shaderGroupPointer, (rr) => readShaderGroup(rr, ctx.shaderOptions))
		: null;
	const skeleton = skeletonPointer ? r.atPointer(skeletonPointer, (rr) => readSkeleton(rr, ctx)) : null;

	const lodPointers: Record<LodName, number> = {
		High: highPointer,
		Med: medPointer,
		Low: lowPointer,
		VLow: vlowPointer,
	};
	const lodDists: Record<LodName, number> = {
		High: lodDistHigh,
		Med: lodDistMed,
		Low: lodDistLow,
		VLow: lodDistVlow,
	};
	const lodMasks: Record<LodName, number> = {
		High: renderMaskHigh,
		Med: renderMaskMed,
		Low: renderMaskLow,
		VLow: renderMaskVlow,
	};

	const lods: DrawableLod[] = [];
	for (const lod of LOD_NAMES) {
		const models = readModelList(r, lodPointers[lod], ctx);
		if (models.length === 0) continue;
		lods.push({ lod, models, lodDist: lodDists[lod], renderMaskFlags: lodMasks[lod] });
	}

	// CodeWalker's "Extra" list: when the models block does not start at the High
	// pointer, the block's own address holds a further list. Kept separate rather than
	// folded into High, and reported so it cannot vanish silently.
	let extraModels: DrawableModel[] = [];
	const blockPointer = modelsPointer || highPointer;
	if (blockPointer && blockPointer !== highPointer) {
		extraModels = readModelList(r, blockPointer, ctx);
		if (extraModels.length > 0) {
			ctx.warnings.push(`drawable has ${extraModels.length} extra model(s) outside the four LOD lists`);
		}
	}

	return {
		headerBytes: 168,
		drawable: {
			name: null,
			boundingCenter,
			boundingSphereRadius,
			boundingBoxMin,
			boundingBoxMax,
			lodDistHigh,
			lodDistMed,
			lodDistLow,
			lodDistVlow,
			shaderGroup,
			skeleton,
			lods,
			extraModels,
			lightAttributeCount: 0,
			hasBounds: false,
		},
	};
}

/** A `Drawable`: `DrawableBase` plus name, light attributes and a bounds pointer. 208 bytes. */
export function readDrawable(r: ResourceReader, ctx: DrawableParseContext): Drawable {
	const base = readDrawableBase(r, ctx);
	const namePointer = r.pointer();
	// ResourceSimpleList64<LightAttributes>: pointer, count, capacity, pad.
	r.skip(8); // light attributes pointer
	const lightAttributeCount = r.uint16();
	r.skip(2); // capacity
	r.skip(4); // pad
	r.skip(8); // UnkPointer
	const boundPointer = r.pointer();

	base.drawable.name = r.stringAt(namePointer);
	base.drawable.lightAttributeCount = lightAttributeCount;
	base.drawable.hasBounds = boundPointer !== 0;
	return base.drawable;
}

/**
 * A `FragDrawable`: `DrawableBase` plus fragment matrices and its own name.
 *
 * Only the name is taken; the fragment matrices belong to the physics side.
 */
function readFragDrawable(r: ResourceReader, ctx: DrawableParseContext): Drawable {
	const base = readDrawableBase(r, ctx);
	r.skip(8); // Unknown_0A8h
	r.skip(64); // FragMatrix
	const boundPointer = r.pointer();
	r.skip(8); // FragMatricesIndsPointer
	r.skip(2); // FragMatricesIndsCount
	r.skip(2); // FragMatricesCapacity
	r.skip(4); // Unknown_104h
	r.skip(8); // FragMatricesPointer
	r.skip(2); // FragMatricesCount
	r.skip(2); // Unknown_112h
	r.skip(4); // Unknown_114h
	r.skip(8); // Unknown_118h
	r.skip(8); // Unknown_120h
	r.skip(8); // Unknown_128h
	const namePointer = r.pointer();

	base.drawable.name = r.stringAt(namePointer);
	base.drawable.hasBounds = boundPointer !== 0;
	return base.drawable;
}

// --- file-level entry points ----------------------------------------------------

export interface DrawableFile {
	kind: "ydr" | "ydd" | "yft";
	version: number;
	generation: Generation;
	drawables: NamedDrawable[];
	warnings: string[];
}

export interface NamedDrawable {
	/** "drawable" for a .ydr, "fragment" for a .yft, the dictionary name for a .ydd. */
	key: string;
	/** `.ydd` only: the dictionary's own hash key for this entry. */
	dictionaryHash?: number;
	drawable: Drawable;
}

/** Parse a `.ydr`: the file is one `Drawable` at the system base. */
export function parseSingleDrawable(r: ResourceReader, ctx: DrawableParseContext): NamedDrawable[] {
	return [{ key: "drawable", drawable: readDrawable(r.seek(SYSTEM_BASE), ctx) }];
}

/**
 * Parse a `.ydd`: a `DrawableDictionary`, 64 bytes, then a hash array and a pointer
 * array of the same length.
 */
export function parseDrawableDictionary(r: ResourceReader, ctx: DrawableParseContext): NamedDrawable[] {
	r.seek(SYSTEM_BASE);
	r.skip(16); // ResourceFileBase
	r.skip(8); // Unknown_10h
	r.skip(8); // Unknown_18h
	const hashesPointer = r.pointer();
	const hashesCount = r.uint16();
	r.skip(2); // HashesCount2
	r.skip(4); // Unknown_2Ch
	const drawablesPointer = r.pointer();
	const drawablesCount = r.uint16();
	r.skip(2); // DrawablesCount2
	r.skip(4); // Unknown_3Ch

	const hashes = uint32sAt(r, hashesPointer, hashesCount);
	const drawables = r.pointerArray(drawablesPointer, drawablesCount, (rr) => readDrawable(rr, ctx));

	const out: NamedDrawable[] = [];
	for (let i = 0; i < drawables.length; i++) {
		const d = drawables[i];
		if (!d) {
			ctx.warnings.push(`dictionary entry ${i} has a null drawable pointer`);
			continue;
		}
		const hash = i < hashes.length ? hashes[i] >>> 0 : 0;
		// CodeWalker YddFile.cs:88-96 distrusts the embedded name: when it is absent or
		// does not hash to the dictionary's own key, the key wins and the name is
		// re-derived from the hash. Real files hit this constantly - ped component
		// dictionaries store names like "lowr_000_r.#dd" and "p_head_001" that hash to
		// something else entirely. `drawable.name` keeps what the file actually stored;
		// `key` is the reconciled label.
		let key: string;
		if (d.name && joaat(d.name) === hash) {
			key = d.name;
		} else {
			key = ctx.resolveHash?.(hash) ?? `hash_${hash.toString(16).toUpperCase().padStart(8, "0")}`;
		}
		out.push({ key, dictionaryHash: hash, drawable: d });
	}
	return out;
}

/**
 * Parse a `.yft`: take the fragment's main drawable.
 *
 * Damaged drawables (`DrawableArray`), cloth (`DrawableCloth`), glass windows and the
 * physics LOD group are **not** decoded in v1. They are counted and reported in
 * `warnings` so their presence is visible rather than silently dropped.
 */
export function parseFragment(r: ResourceReader, ctx: DrawableParseContext): NamedDrawable[] {
	r.seek(SYSTEM_BASE);
	r.skip(16); // ResourceFileBase
	r.skip(8); // Unknown_10h
	r.skip(8); // Unknown_18h
	r.skip(12); // BoundingSphereCenter
	r.skip(4); // BoundingSphereRadius
	const drawablePointer = r.pointer();
	const drawableArrayPointer = r.pointer();
	r.skip(8); // DrawableArrayNamesPointer
	const drawableArrayCount = r.uint32();
	r.skip(4); // DrawableArrayFlag
	r.skip(8); // Unknown_50h
	const namePointer = r.pointer();
	// ResourcePointerList64<EnvironmentCloth>
	r.skip(8); // cloths pointer
	const clothCount = r.uint16();
	r.skip(2); // capacity
	r.skip(4); // pad
	r.skip(8); // Unknown_70h
	r.skip(8); // Unknown_78h
	r.skip(8); // Unknown_80h
	r.skip(8); // Unknown_88h
	r.skip(8); // Unknown_90h
	r.skip(8); // Unknown_98h
	r.skip(8); // Unknown_A0h
	r.skip(8); // BoneTransformsPointer
	r.skip(4); // Unknown_B0h
	r.skip(4); // Unknown_B4h
	r.skip(4); // Unknown_B8h
	r.skip(4); // Unknown_BCh
	r.skip(4); // Unknown_C0h
	r.skip(4); // Unknown_C4h
	r.skip(4); // Unknown_C8h
	r.skip(4); // Unknown_CCh
	r.skip(4); // GravityFactor
	r.skip(4); // BuoyancyFactor
	r.skip(1); // Unknown_D8h
	const glassWindowsCount = r.byte();
	r.skip(2); // Unknown_DAh
	r.skip(4); // Unknown_DCh
	r.skip(8); // GlassWindowsPointer
	r.skip(8); // Unknown_E8h
	const physicsLodGroupPointer = r.pointer();
	const drawableClothPointer = r.pointer();

	const name = r.stringAt(namePointer);

	if (drawableArrayCount > 0) {
		ctx.warnings.push(`fragment carries ${drawableArrayCount} damaged/child drawable(s); not decoded in v1`);
	}
	if (clothCount > 0) ctx.warnings.push(`fragment carries ${clothCount} environment cloth(s); not decoded in v1`);
	if (drawableClothPointer) ctx.warnings.push("fragment carries a cloth drawable; not decoded in v1");
	if (glassWindowsCount > 0) {
		ctx.warnings.push(`fragment carries ${glassWindowsCount} glass window(s); not decoded in v1`);
	}
	if (physicsLodGroupPointer) ctx.warnings.push("fragment carries a physics LOD group; not decoded in v1");

	if (!drawablePointer) {
		ctx.warnings.push("fragment has no main drawable");
		return [];
	}
	const drawable = r.atPointer(drawablePointer, (rr) => readFragDrawable(rr, ctx));
	if (!drawable) return [];
	if (!drawable.name) drawable.name = name;
	if (drawableArrayPointer && drawableArrayCount === 0) {
		ctx.warnings.push("fragment has a drawable array pointer with a zero count");
	}
	return [{ key: "fragment", drawable }];
}

export { ResourceReadError };
