// Shader groups, shaders and shader parameters.
//
// Ported from CodeWalker.Core (MIT, dexyfex/Neodymium):
//   Resources/Drawable.cs:14-176      ShaderGroup
//   Resources/Drawable.cs:178-536     ShaderFX (gen8 48 bytes / gen9 64 bytes)
//   Resources/Drawable.cs:537-568     ShaderParameter
//   Resources/Drawable.cs:570-1277    ShaderParametersBlock (both generations)
//   Resources/Drawable.cs:1278-1351   ShaderParamInfosG9 / ShaderParamInfoG9
//   Resources/Texture.cs:201-530      TextureBase (name only is used here)
//
// The two generations store parameters completely differently. Gen8 is an array of
// 16-byte parameter records followed by the Vector4 payload and then a parallel array
// of name hashes. Gen9 has no per-parameter record at all: a separate
// `ShaderParamInfosG9` block describes each parameter as (name hash, packed
// type/index/offset/length), and the values live in constant buffers that are stored
// **twelve times over** - one copy per worker thread - which is why every gen9 count
// below is multiplied by `copies`.
//
// One gen9 detail is deliberately NOT implemented: CodeWalker renames gen9 parameters
// back to their legacy names using a 522 KB `ShadersGen9Conversion.xml`. That file is
// Rockstar-derived and is not shipped here, so a gen9 parameter keeps its *gen9* name
// hash unless the caller supplies `gen9ParamNames`. Hashes are still stable and
// comparable; only the human-readable legacy name is lost.

import { joaat } from "../jenk";
import type { ResourceReader } from "../reader";
import { uint64sAt } from "./arrays";

/** What a gen9 parameter slot holds. CodeWalker Drawable.cs:1343-1350. */
export enum ShaderParamTypeG9 {
	Texture = 0,
	Unknown = 1,
	Sampler = 2,
	CBuffer = 3,
}

/** A texture reference from a shader parameter. Pixel data is not read. */
export interface TextureRef {
	name: string | null;
	nameHash: number;
	width: number;
	height: number;
	levels: number;
	/** Raw format byte/word as stored; gen8 and gen9 use different enumerations. */
	format: number;
}

/**
 * One shader parameter.
 *
 * `dataType` is 0 for a texture and otherwise the number of Vector4s the parameter
 * occupies (1 for a plain vector, more for an array). That encoding is the file's, not
 * a convenience: the gen8 block uses it to walk the embedded payload.
 */
export interface ShaderParameter {
	nameHash: number;
	dataType: number;
	texture: TextureRef | null;
	/** `dataType * 4` floats for a vector parameter, `null` for a texture. */
	vectors: Float32Array | null;
}

export interface Shader {
	nameHash: number;
	/** `<name>.sps`. Derived from `nameHash` on gen9, where it is not stored. */
	fileNameHash: number;
	renderBucket: number;
	renderBucketMask: number;
	/** As stored. Gen9 does not store it and reports 0; use `parameters.length`. */
	parameterCount: number;
	/** As stored. Gen9 does not store it and reports 0. */
	textureParameterCount: number;
	parameters: ShaderParameter[];
}

export interface ShaderGroup {
	shaders: (Shader | null)[];
	/** Embedded `.ytd`. Its pixel data is out of scope for this reader. */
	hasEmbeddedTextureDictionary: boolean;
}

/**
 * Optional resolver from a gen9 parameter name hash back to its legacy name hash.
 *
 * Signature matches CodeWalker's `ShadersGen9ConversionData[shader].ParamsMapGen9ToLegacy`.
 * Return 0 or the input hash to leave it alone.
 */
export type Gen9ParamNameResolver = (shaderNameHash: number, gen9ParamHash: number) => number;

export interface ShaderParseOptions {
	gen9: boolean;
	gen9ParamNames?: Gen9ParamNameResolver;
	warnings: string[];
}

// --- textures -------------------------------------------------------------------

/**
 * A `TextureBase` header. 80 bytes in both generations, but only the name pointer
 * (0x28) is at the same offset in each - everything else moves.
 */
function readTexture(r: ResourceReader, gen9: boolean): TextureRef {
	if (gen9) {
		r.skip(4); // VFT
		r.skip(4); // Unknown_4h
		r.skip(4); // G9_BlockCount
		r.skip(4); // G9_BlockStride
		r.skip(4); // G9_Flags
		r.skip(4); // Unknown_14h
		const width = r.uint16();
		const height = r.uint16();
		r.skip(2); // Depth
		r.skip(1); // G9_Dimension
		const format = r.byte(); // G9_Format
		r.skip(1); // G9_TileMode
		r.skip(1); // G9_AntiAliasType
		const levels = r.byte();
		r.skip(1); // G9_Unknown_23h
		r.skip(1); // Unknown_24h
		r.skip(1); // G9_Unknown_25h
		r.skip(2); // G9_UsageCount
		const namePointer = r.pointer();
		const name = r.stringAt(namePointer);
		return { name, nameHash: name ? joaat(name) : 0, width, height, levels, format };
	}

	// Gen8 keeps width/height/format on the Texture subclass, past this 80-byte base;
	// a shader parameter points at a bare TextureBase, so those fields are not here.
	r.skip(40); // VFT .. Unknown_24h
	const namePointer = r.pointer();
	const name = r.stringAt(namePointer);
	return { name, nameHash: name ? joaat(name) : 0, width: 0, height: 0, levels: 0, format: 0 };
}

// --- gen8 parameters ------------------------------------------------------------

/**
 * The legacy parameter block.
 *
 * `count` 16-byte records, then the Vector4 payload they point into, then `count`
 * name hashes. The payload is walked by *size* rather than followed by pointer,
 * because the hash array's position depends on how long it is.
 */
function readParametersGen8(
	r: ResourceReader,
	address: number,
	count: number,
	options: ShaderParseOptions,
): ShaderParameter[] {
	if (!address || count <= 0) return [];
	const out: ShaderParameter[] = [];

	const saved = r.position;
	try {
		r.seek(address);
		const raw: { dataType: number; dataPointer: number }[] = [];
		for (let i = 0; i < count; i++) {
			const dataType = r.byte();
			r.skip(1); // Unknown_1h
			r.skip(2); // Unknown_2h
			r.skip(4); // Unknown_4h
			const dataPointer = r.pointer();
			raw.push({ dataType, dataPointer });
		}

		let payloadBytes = 0;
		for (const p of raw) {
			let texture: TextureRef | null = null;
			let vectors: Float32Array | null = null;
			if (p.dataType === 0) {
				texture = p.dataPointer ? r.atPointer(p.dataPointer, (rr) => readTexture(rr, options.gen9)) : null;
			} else {
				payloadBytes += 16 * p.dataType;
				if (p.dataPointer) {
					vectors = new Float32Array(p.dataType * 4);
					const bytes = r.bytesAt(p.dataPointer, p.dataType * 16);
					const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
					for (let i = 0; i < vectors.length; i++) vectors[i] = view.getFloat32(i * 4, true);
				}
			}
			out.push({ nameHash: 0, dataType: p.dataType, texture, vectors });
		}

		// The Vector4 payload is embedded here, between the records and the hashes.
		r.skip(payloadBytes);
		for (let i = 0; i < count; i++) out[i].nameHash = r.uint32();
	} finally {
		r.position = saved;
	}
	return out;
}

// --- gen9 parameters ------------------------------------------------------------

interface ParamInfoG9 {
	nameHash: number;
	type: ShaderParamTypeG9;
	textureIndex: number;
	cbufferIndex: number;
	paramOffset: number;
	paramLength: number;
}

interface ParamInfosG9 {
	numBuffers: number;
	numTextures: number;
	numUnknowns: number;
	numSamplers: number;
	/** Copies of every buffer/texture/unknown array. 12 in every file seen. */
	copies: number;
	params: ParamInfoG9[];
}

/** `ShaderParamInfosG9`: an 8-byte header then `numParams` 8-byte entries. */
function readParamInfosG9(r: ResourceReader): ParamInfosG9 {
	const numBuffers = r.byte();
	const numTextures = r.byte();
	const numUnknowns = r.byte();
	const numSamplers = r.byte();
	const numParams = r.byte();
	r.skip(1); // Unknown0
	r.skip(1); // Unknown1
	const copies = r.byte(); // Unknown2, 0xC in every shipped file

	const params: ParamInfoG9[] = [];
	for (let i = 0; i < numParams; i++) {
		const nameHash = r.uint32();
		const data = r.uint32() >>> 0;
		params.push({
			nameHash,
			type: (data & 0x3) as ShaderParamTypeG9,
			textureIndex: (data >>> 2) & 0xff,
			cbufferIndex: (data >>> 2) & 0x3f,
			paramOffset: (data >>> 8) & 0xfff,
			paramLength: (data >>> 20) & 0xfff,
		});
	}
	return { numBuffers, numTextures, numUnknowns, numSamplers, copies, params };
}

function readParametersGen9(
	r: ResourceReader,
	shaderNameHash: number,
	parametersPointer: number,
	textureRefsPointer: number,
	infos: ParamInfosG9 | null,
	options: ShaderParseOptions,
): ShaderParameter[] {
	if (!infos || !parametersPointer) return [];
	const copies = infos.copies || 1;

	// The constant-buffer pointer array is `numBuffers * copies` long; entry [i+1] is
	// what bounds buffer i, so the extra copies are what make the sizes derivable.
	const bufferPointers = uint64sAt(r, parametersPointer, infos.numBuffers * copies);
	const texturePointers = textureRefsPointer ? uint64sAt(r, textureRefsPointer, infos.numTextures * copies) : [];

	const out: ShaderParameter[] = [];
	for (const info of infos.params) {
		let nameHash = info.nameHash;
		if (options.gen9ParamNames) {
			const mapped = options.gen9ParamNames(shaderNameHash, nameHash);
			if (mapped) nameHash = mapped;
		}

		if (info.type === ShaderParamTypeG9.Texture) {
			const pointer = texturePointers[info.textureIndex] ?? 0;
			const texture = pointer ? r.atPointer(pointer, (rr) => readTexture(rr, true)) : null;
			out.push({ nameHash, dataType: 0, texture, vectors: null });
			continue;
		}

		if (info.type !== ShaderParamTypeG9.CBuffer) {
			// Sampler and Unknown slots carry no value CodeWalker exposes either.
			continue;
		}

		const floatCount = Math.floor(info.paramLength / 4);
		const vectorCount = Math.floor(info.paramLength / 16);
		const dataType = Math.max(vectorCount, 1);
		const base = bufferPointers[info.cbufferIndex] ?? 0;
		let vectors: Float32Array | null = null;
		if (base && floatCount > 0) {
			// A sub-Vector4 parameter is padded out to a full Vector4, as CodeWalker does.
			const slots = floatCount <= 4 ? 4 : vectorCount * 4;
			vectors = new Float32Array(slots);
			const address = base + info.paramOffset;
			const want = floatCount <= 4 ? floatCount : vectorCount * 4;
			try {
				const bytes = r.bytesAt(address, want * 4);
				const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
				for (let i = 0; i < want; i++) vectors[i] = view.getFloat32(i * 4, true);
			} catch (e) {
				options.warnings.push(
					`gen9 cbuffer parameter 0x${nameHash.toString(16)} at 0x${address.toString(16)} could not be read: ` +
						(e instanceof Error ? e.message : String(e)),
				);
				vectors = null;
			}
		} else if (!base) {
			options.warnings.push(`gen9 cbuffer parameter 0x${nameHash.toString(16)} has no buffer ${info.cbufferIndex}`);
		}
		out.push({ nameHash, dataType, texture: null, vectors });
	}
	return out;
}

// --- shaders --------------------------------------------------------------------

/** One `ShaderFX`. Gen8 is 48 bytes, gen9 64, with no field in common but the name. */
export function readShader(r: ResourceReader, options: ShaderParseOptions): Shader {
	if (options.gen9) {
		const nameHash = r.uint32();
		r.skip(4); // G9_Preset, 0x6D657461 ("meta") in every shipped file
		const parametersPointer = r.pointer();
		const textureRefsPointer = r.pointer();
		r.skip(8); // G9_UnknownParamsPointer - grass_batch instance data
		const paramInfosPointer = r.pointer();
		r.skip(8); // G9_Unknown_28h
		r.skip(8); // G9_Unknown_30h
		r.skip(1); // G9_Unknown_38h
		const renderBucket = r.byte();
		r.skip(2); // ParameterDataSize
		const renderBucketMask = r.uint32();

		const infos = paramInfosPointer ? r.atPointer(paramInfosPointer, readParamInfosG9) : null;
		const parameters = readParametersGen9(
			r,
			nameHash,
			parametersPointer,
			textureRefsPointer,
			infos,
			options,
		);

		return {
			nameHash,
			// Gen9 drops FileName. CodeWalker rebuilds it as joaat(name + ".sps"), which
			// needs the *string* behind `nameHash`; with no shader-name table here, 0 is
			// honest. Callers that know the name can hash it themselves.
			fileNameHash: 0,
			renderBucket,
			renderBucketMask,
			parameterCount: 0,
			textureParameterCount: 0,
			parameters,
		};
	}

	const parametersPointer = r.pointer();
	const nameHash = r.uint32();
	r.skip(4); // Unknown_Ch
	const parameterCount = r.byte();
	const renderBucket = r.byte();
	r.skip(2); // Unknown_12h, 32768
	r.skip(2); // ParameterSize
	r.skip(2); // ParameterDataSize
	const fileNameHash = r.uint32();
	r.skip(4); // Unknown_1Ch
	const renderBucketMask = r.uint32();
	r.skip(2); // Unknown_24h
	r.skip(1); // Unknown_26h
	const textureParameterCount = r.byte();
	r.skip(8); // Unknown_28h

	const parameters = readParametersGen8(r, parametersPointer, parameterCount, options);

	return {
		nameHash,
		fileNameHash,
		renderBucket,
		renderBucketMask,
		parameterCount,
		textureParameterCount,
		parameters,
	};
}

/** A `ShaderGroup`: 64 bytes, identical in both generations. */
export function readShaderGroup(r: ResourceReader, options: ShaderParseOptions): ShaderGroup {
	r.skip(4); // VFT
	r.skip(4); // Unknown_4h
	const textureDictionaryPointer = r.pointer();
	const shadersPointer = r.pointer();
	const shadersCount = r.uint16();
	r.skip(2); // ShadersCount2, always equal to ShadersCount1
	r.skip(4); // Unknown_1Ch
	r.skip(8); // Unknown_20h
	r.skip(8); // Unknown_28h
	r.skip(4); // ShaderGroupBlocksSize
	r.skip(4); // Unknown_34h
	r.skip(8); // Unknown_38h

	const shaders = r.pointerArray(shadersPointer, shadersCount, (rr) => readShader(rr, options));

	return { shaders, hasEmbeddedTextureDictionary: textureDictionaryPointer !== 0 };
}
