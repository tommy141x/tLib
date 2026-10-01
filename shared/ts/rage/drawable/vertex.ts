// Vertex declarations and vertex-component decoding.
//
// Ported from CodeWalker.Core (MIT, dexyfex/Neodymium):
//   Resources/VertexType.cs:9-70      VertexComponentType, sizes and counts
//   Resources/VertexType.cs:72-141    VertexDeclarationTypes, VertexSemantics, VertexType
//   Resources/Drawable.cs:4930-5068   VertexDeclaration
//   Resources/Drawable.cs:5069-5443   VertexDeclarationG9
//
// A declaration is two words plus a 64-bit nibble map:
//
//   flags  - bitmask over the 16 semantic slots; bit k set means slot k is present
//   types  - 16 nibbles, one per slot, each a VertexComponentType
//
// Component *order in memory* is slot order, and a component's byte offset is the sum
// of the sizes of the present slots below it. Nothing about that is fixed per file:
// **declarations vary per geometry**, so decode per geometry and never cache a layout
// across two of them.
//
// `types` genuinely needs 64 bits (GTAV1 is 0x7755555555996996, far past 2^53), so it
// is carried as a bigint. Everything in the hot decode path stays in numbers.

/** One component's storage format. `Nothing`/`FloatUnk` occupy no bytes. */
export enum VertexComponentType {
	Nothing = 0,
	Half2 = 1,
	Float = 2,
	Half4 = 3,
	FloatUnk = 4,
	Float2 = 5,
	Float3 = 6,
	Float4 = 7,
	UByte4 = 8,
	Colour = 9,
	RGBA8SNorm = 10,
	Unk1 = 11,
	Unk2 = 12,
	Unk3 = 13,
	Unk4 = 14,
	Unk5 = 15,
}

/** Bytes this component occupies in a vertex. CodeWalker VertexType.cs:31-48. */
export function vertexComponentSize(type: VertexComponentType): number {
	switch (type) {
		case VertexComponentType.Nothing:
			return 0;
		case VertexComponentType.Half2:
			return 4;
		case VertexComponentType.Float:
			return 4;
		case VertexComponentType.Half4:
			return 8;
		case VertexComponentType.FloatUnk:
			return 0;
		case VertexComponentType.Float2:
			return 8;
		case VertexComponentType.Float3:
			return 12;
		case VertexComponentType.Float4:
			return 16;
		case VertexComponentType.UByte4:
			return 4;
		case VertexComponentType.Colour:
			return 4;
		case VertexComponentType.RGBA8SNorm:
			return 4;
		default:
			return 0;
	}
}

/** Scalars this component decodes to. CodeWalker VertexType.cs:51-68. */
export function vertexComponentCount(type: VertexComponentType): number {
	switch (type) {
		case VertexComponentType.Nothing:
			return 0;
		case VertexComponentType.Half2:
			return 2;
		case VertexComponentType.Float:
			return 1;
		case VertexComponentType.Half4:
			return 4;
		case VertexComponentType.FloatUnk:
			return 0;
		case VertexComponentType.Float2:
			return 2;
		case VertexComponentType.Float3:
			return 3;
		case VertexComponentType.Float4:
			return 4;
		case VertexComponentType.UByte4:
			return 4;
		case VertexComponentType.Colour:
			return 4;
		case VertexComponentType.RGBA8SNorm:
			return 4;
		default:
			return 0;
	}
}

/** The 16 semantic slots, in memory order. CodeWalker VertexType.cs:86-103. */
export enum VertexSemantics {
	Position = 0,
	BlendWeights = 1,
	BlendIndices = 2,
	Normal = 3,
	Colour0 = 4,
	Colour1 = 5,
	TexCoord0 = 6,
	TexCoord1 = 7,
	TexCoord2 = 8,
	TexCoord3 = 9,
	TexCoord4 = 10,
	TexCoord5 = 11,
	TexCoord6 = 12,
	TexCoord7 = 13,
	Tangent = 14,
	Binormal = 15,
}

export const VERTEX_SEMANTIC_NAMES: readonly string[] = [
	"Position",
	"BlendWeights",
	"BlendIndices",
	"Normal",
	"Colour0",
	"Colour1",
	"TexCoord0",
	"TexCoord1",
	"TexCoord2",
	"TexCoord3",
	"TexCoord4",
	"TexCoord5",
	"TexCoord6",
	"TexCoord7",
	"Tangent",
	"Binormal",
];

/** Known `types` nibble maps. CodeWalker VertexType.cs:72-84. */
export const VertexDeclarationTypes = {
	/** Used by most drawables. */
	GTAV1: 0x7755555555996996n,
	/** Cloth. */
	GTAV2: 0x030000000199a006n,
	/** Cloth. */
	GTAV3: 0x0300000001996006n,
	/** FragGlassWindow. */
	GTAV4: 0x7655555555996996n,
} as const;

/**
 * Named vertex layouts, keyed by the declaration's `flags`.
 *
 * CodeWalker VertexType.cs:105-141. The name is descriptive only (P=position,
 * N=normal, C=colour, T=texcoord, X=tangent, BB=blend weights+indices); nothing reads
 * it to decode. Two entries carry a 0x80000000 bit that is not a semantic flag - they
 * are the cloth variants, disambiguated by `types` rather than by `flags` alone.
 */
export const VERTEX_TYPE_NAMES: ReadonlyMap<number, string> = new Map<number, string>([
	[89, "Default"],
	[16473, "DefaultEx"],
	[121, "PNCCT"],
	[1017, "PNCCTTTT"],
	[16639, "PBBNCCTTX"],
	[127, "PBBNCCT"],
	[16857, "PNCTTTX"],
	[16601, "PNCTTX"],
	[19545, "PNCTTTX_2"],
	[17113, "PNCTTTX_3"],
	[16633, "PNCCTTX"],
	[17017, "PNCCTTX_2"],
	[17145, "PNCCTTTX"],
	[16511, "PBBNCCTX"],
	[16479, "PBBNCTX"],
	[95, "PBBNCT"],
	[249, "PNCCTT"],
	[16505, "PNCCTX"],
	[81, "PCT"],
	[65, "PT"],
	[193, "PTT"],
	[25, "PNC"],
	[17, "PC"],
	[7, "PCC"],
	[2147500121, "PCCH2H4"],
	[2147483737, "PNCH2"],
	[19673, "PNCTTTTX"],
	[985, "PNCTTTT"],
	[255, "PBBNCCTT"],
	[209, "PCTT"],
	[119, "PBBCCT"],
	[31, "PBBNC"],
	[223, "PBBNCTT"],
	[16607, "PBBNCTTX"],
	[479, "PBBNCTTT"],
	[217, "PNCTT"],
	[473, "PNCTTT"],
	[16863, "PBBNCTTTX"],
]);

/** A geometry's vertex layout. 16 bytes on disk. */
export interface VertexDeclaration {
	/** Bitmask of present semantic slots. */
	flags: number;
	/** Bytes per vertex, as stored. */
	stride: number;
	/** Number of present slots, as stored. */
	count: number;
	/** 16 nibbles, one `VertexComponentType` per slot. */
	types: bigint;
	/** Byte at offset 6. Always 0 in shipped files. */
	unknown6: number;
}

/** The component type in slot `index` (a *flags bit index*, not an ordinal). */
export function componentTypeAt(declaration: VertexDeclaration, index: number): VertexComponentType {
	return Number((declaration.types >> BigInt(index * 4)) & 0xfn) as VertexComponentType;
}

/**
 * Byte offset of slot `index` within a vertex.
 *
 * CodeWalker Drawable.cs:5023-5036. Offsets are derived, never stored, which is why a
 * declaration alone is enough to decode a buffer.
 */
export function componentOffset(declaration: VertexDeclaration, index: number): number {
	let offset = 0;
	for (let k = 0; k < index; k++) {
		if ((declaration.flags >>> k) & 1) {
			offset += vertexComponentSize(componentTypeAt(declaration, k));
		}
	}
	return offset;
}

/**
 * Recompute `count` and `stride` from `flags` and `types`.
 *
 * CodeWalker Drawable.cs:5038-5060 asserts these match the stored values on every
 * vanilla file. Exposed so callers can check a file rather than trust it.
 */
export function derivedCountAndStride(declaration: VertexDeclaration): { count: number; stride: number } {
	let count = 0;
	let stride = 0;
	for (let k = 0; k < 16; k++) {
		if ((declaration.flags >>> k) & 1) {
			stride += vertexComponentSize(componentTypeAt(declaration, k));
			count++;
		}
	}
	return { count, stride };
}

/** Indices of the present slots, low bit first - i.e. memory order. */
export function presentSemantics(declaration: VertexDeclaration): number[] {
	const out: number[] = [];
	for (let k = 0; k < 16; k++) if ((declaration.flags >>> k) & 1) out.push(k);
	return out;
}

/**
 * CodeWalker's name for this layout.
 *
 * Drawable.cs:4433-4452: the two cloth layouts share a `flags` value with a non-cloth
 * layout and are told apart by `types`, so this needs both. Unknown layouts return the
 * decimal `flags`, which is what CodeWalker prints for an unnamed enum value.
 */
export function vertexTypeName(declaration: VertexDeclaration): string {
	const { flags, types } = declaration;
	if (types === VertexDeclarationTypes.GTAV2 && flags === 16473) return "PCCH2H4";
	if (types === VertexDeclarationTypes.GTAV3 && flags === 89) return "PNCH2";
	return VERTEX_TYPE_NAMES.get(flags) ?? String(flags >>> 0);
}

// --- component decoding ---------------------------------------------------------

/**
 * IEEE 754 binary16 -> float.
 *
 * Written out rather than routed through a Float16Array because CEF 103 has no
 * Float16Array, and `DataView.getFloat16` is newer still.
 */
export function halfToFloat(bits: number): number {
	const sign = (bits & 0x8000) !== 0 ? -1 : 1;
	const exponent = (bits >> 10) & 0x1f;
	const mantissa = bits & 0x3ff;
	if (exponent === 0) {
		// Subnormal (and zero): no implicit leading 1.
		return sign * mantissa * 2 ** -24;
	}
	if (exponent === 0x1f) {
		return mantissa === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
	}
	return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/** float -> IEEE 754 binary16 bits. Round-to-nearest-even, as the hardware does. */
export function floatToHalf(value: number): number {
	if (Number.isNaN(value)) return 0x7e00;
	const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0;
	const v = Math.abs(value);
	if (v === Number.POSITIVE_INFINITY) return sign | 0x7c00;
	if (v === 0) return sign;
	if (v >= 65520) return sign | 0x7c00; // rounds up to infinity
	if (v < 2 ** -24) return sign; // rounds to zero
	if (v < 2 ** -14) {
		// Subnormal.
		const scaled = v / 2 ** -24;
		let m = Math.round(scaled);
		// Round-half-to-even.
		if (Math.abs(scaled - Math.trunc(scaled)) === 0.5 && m % 2 !== 0) m -= 1;
		return sign | m;
	}
	let exponent = Math.floor(Math.log2(v));
	let mantissa = v / 2 ** exponent - 1;
	if (mantissa >= 1) {
		exponent += 1;
		mantissa = v / 2 ** exponent - 1;
	}
	let m = Math.round(mantissa * 1024);
	if (Math.abs(mantissa * 1024 - Math.trunc(mantissa * 1024)) === 0.5 && m % 2 !== 0) m -= 1;
	if (m === 1024) {
		exponent += 1;
		m = 0;
	}
	if (exponent > 15) return sign | 0x7c00;
	return sign | ((exponent + 15) << 10) | m;
}

/**
 * Decode one component into `out` at `outOffset`, returning how many scalars it wrote.
 *
 * Conventions, chosen so every attribute lands in a Float32Array without a second
 * lookup table:
 *
 * - `Colour` is UNORM: four bytes scaled to 0..1, RGBA in file order.
 * - `UByte4` is raw: four bytes 0..255, left unscaled because it carries bone *indices*
 *   where 3 and 3/255 are very different things.
 * - `RGBA8SNorm` is D3D SNORM: int8/127, clamped at -1 so -128 and -127 both give -1.
 *
 * `Nothing`, `FloatUnk` and the five unnamed types occupy no bytes and write nothing.
 */
export function decodeVertexComponent(
	type: VertexComponentType,
	view: DataView,
	offset: number,
	out: Float32Array,
	outOffset: number,
): number {
	switch (type) {
		case VertexComponentType.Half2:
			out[outOffset] = halfToFloat(view.getUint16(offset, true));
			out[outOffset + 1] = halfToFloat(view.getUint16(offset + 2, true));
			return 2;
		case VertexComponentType.Float:
			out[outOffset] = view.getFloat32(offset, true);
			return 1;
		case VertexComponentType.Half4:
			out[outOffset] = halfToFloat(view.getUint16(offset, true));
			out[outOffset + 1] = halfToFloat(view.getUint16(offset + 2, true));
			out[outOffset + 2] = halfToFloat(view.getUint16(offset + 4, true));
			out[outOffset + 3] = halfToFloat(view.getUint16(offset + 6, true));
			return 4;
		case VertexComponentType.Float2:
			out[outOffset] = view.getFloat32(offset, true);
			out[outOffset + 1] = view.getFloat32(offset + 4, true);
			return 2;
		case VertexComponentType.Float3:
			out[outOffset] = view.getFloat32(offset, true);
			out[outOffset + 1] = view.getFloat32(offset + 4, true);
			out[outOffset + 2] = view.getFloat32(offset + 8, true);
			return 3;
		case VertexComponentType.Float4:
			out[outOffset] = view.getFloat32(offset, true);
			out[outOffset + 1] = view.getFloat32(offset + 4, true);
			out[outOffset + 2] = view.getFloat32(offset + 8, true);
			out[outOffset + 3] = view.getFloat32(offset + 12, true);
			return 4;
		case VertexComponentType.UByte4:
			out[outOffset] = view.getUint8(offset);
			out[outOffset + 1] = view.getUint8(offset + 1);
			out[outOffset + 2] = view.getUint8(offset + 2);
			out[outOffset + 3] = view.getUint8(offset + 3);
			return 4;
		case VertexComponentType.Colour:
			out[outOffset] = view.getUint8(offset) / 255;
			out[outOffset + 1] = view.getUint8(offset + 1) / 255;
			out[outOffset + 2] = view.getUint8(offset + 2) / 255;
			out[outOffset + 3] = view.getUint8(offset + 3) / 255;
			return 4;
		case VertexComponentType.RGBA8SNorm:
			for (let i = 0; i < 4; i++) {
				out[outOffset + i] = Math.max(view.getInt8(offset + i) / 127, -1);
			}
			return 4;
		default:
			// Nothing, FloatUnk, Unk1..Unk5: zero bytes, zero scalars.
			return 0;
	}
}

/** One decoded semantic slot. `data` is `count * componentCount` scalars. */
export interface VertexAttribute {
	semantic: VertexSemantics;
	name: string;
	type: VertexComponentType;
	componentCount: number;
	/** Byte offset within a vertex. */
	offset: number;
	data: Float32Array;
	/**
	 * The unmodified bytes for a byte-packed component (`Colour`, `UByte4`,
	 * `RGBA8SNorm`), four per vertex; `null` for everything else.
	 *
	 * This exists because GTAV1 declares **BlendIndices as `Colour`**, so the scaled
	 * `data` for that slot is bone index / 255 - correct per the declared type and
	 * useless as an index. Read `raw` for blend indices; read `data` for colours.
	 */
	raw: Uint8Array | null;
}

export interface DecodedVertices {
	count: number;
	stride: number;
	declaration: VertexDeclaration;
	/** Present attributes, in memory order. */
	attributes: VertexAttribute[];
	/** Indexed by `VertexSemantics`; `null` where the slot is absent. */
	bySemantic: (VertexAttribute | null)[];
	/** Non-fatal problems: a declared stride that disagrees with the buffer, etc. */
	warnings: string[];
}

/** Convenience accessor: the raw scalars for a semantic, or `null` if absent. */
export function attributeData(decoded: DecodedVertices, semantic: VertexSemantics): Float32Array | null {
	return decoded.bySemantic[semantic]?.data ?? null;
}

/**
 * Decode a whole vertex buffer into per-semantic typed arrays.
 *
 * `stride` comes from the geometry, not from the declaration: the two agree on every
 * vanilla file, but a mod can disagree and the geometry is what indexes the buffer.
 * A mismatch is reported in `warnings` rather than thrown.
 */
export function decodeVertices(
	declaration: VertexDeclaration,
	bytes: Uint8Array,
	count: number,
	stride = declaration.stride,
): DecodedVertices {
	const warnings: string[] = [];
	const derived = derivedCountAndStride(declaration);
	if (derived.stride !== declaration.stride) {
		warnings.push(
			`declaration stride ${declaration.stride} disagrees with the ${derived.stride} its ` +
				"flags and types imply",
		);
	}
	if (derived.count !== declaration.count) {
		warnings.push(`declaration count ${declaration.count} disagrees with the ${derived.count} its flags imply`);
	}

	const attributes: VertexAttribute[] = [];
	const bySemantic: (VertexAttribute | null)[] = new Array(16).fill(null);

	if (stride <= 0) {
		warnings.push(`vertex stride is ${stride}; nothing decoded`);
		return { count: 0, stride, declaration, attributes, bySemantic, warnings };
	}

	const available = Math.floor(bytes.byteLength / stride);
	let n = count;
	if (available < count) {
		warnings.push(`buffer holds ${available} vertices of stride ${stride} but ${count} were declared`);
		n = available;
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	for (const slot of presentSemantics(declaration)) {
		const type = componentTypeAt(declaration, slot);
		const componentCount = vertexComponentCount(type);
		if (componentCount === 0) {
			warnings.push(`slot ${VERTEX_SEMANTIC_NAMES[slot]} has zero-width component type ${VertexComponentType[type]}`);
			continue;
		}
		const offset = componentOffset(declaration, slot);
		const packed =
			type === VertexComponentType.Colour ||
			type === VertexComponentType.UByte4 ||
			type === VertexComponentType.RGBA8SNorm;
		const attr: VertexAttribute = {
			semantic: slot as VertexSemantics,
			name: VERTEX_SEMANTIC_NAMES[slot] ?? String(slot),
			type,
			componentCount,
			offset,
			data: new Float32Array(n * componentCount),
			raw: packed ? new Uint8Array(n * 4) : null,
		};
		for (let v = 0; v < n; v++) {
			const at = v * stride + offset;
			decodeVertexComponent(type, view, at, attr.data, v * componentCount);
			if (attr.raw) attr.raw.set(bytes.subarray(at, at + 4), v * 4);
		}
		attributes.push(attr);
		bySemantic[slot] = attr;
	}

	return { count: n, stride, declaration, attributes, bySemantic, warnings };
}

// --- gen9 declarations ----------------------------------------------------------

/** Gen9 element formats. CodeWalker Drawable.cs:5432-5443. */
export enum VertexDeclarationG9ElementFormat {
	NONE = 0,
	R32G32B32A32_FLOAT = 2,
	R32G32B32_FLOAT = 6,
	R16G16B16A16_FLOAT = 10,
	R32G32_TYPELESS = 16,
	D3DX_R10G10B10A2 = 24,
	R8G8B8A8_UNORM = 28,
	R8G8B8A8_UINT = 30,
	R16G16_FLOAT = 34,
}

/**
 * The gen9 vertex format block: 52 parallel slots, one per RAGE semantic name.
 *
 * 320 bytes: 52 uint32 offsets, 52 byte "sizes", 52 byte formats, one uint64 of packed
 * fields. Despite the name, `sizes[i]` holds the *vertex stride*, not an element size -
 * it is the step between consecutive values of that element.
 */
export interface VertexDeclarationG9 {
	offsets: Uint32Array;
	sizes: Uint8Array;
	types: Uint8Array;
	data: bigint;
	/** `data` bit 0. False on every GTA V gen9 file seen; true on RDR2. */
	hasSOA: boolean;
	vertexSize: number;
	vertexCount: number;
	/** Number of non-zero entries in `types`. */
	elementCount: number;
}

/**
 * Gen9 slot index -> legacy semantic slot.
 *
 * CodeWalker Drawable.cs:5290-5310. The gen9 array is indexed by RAGE's 52 semantic
 * names (POSITION0..3, NORMAL0..3, TANGENT0..3, BINORMAL0..3, BLENDWEIGHT0..3,
 * BLENDINDICES0..3, COLOR0..3, TEXCOORD0..23); only 12 of them map onto a legacy
 * declaration slot, and the rest return -1 and are dropped.
 */
export function legacyComponentIndex(gen9Index: number): number {
	switch (gen9Index) {
		case 0:
			return 0; // POSITION0
		case 4:
			return 3; // NORMAL0
		case 8:
			return 14; // TANGENT0
		case 16:
			return 1; // BLENDWEIGHTS0
		case 20:
			return 2; // BLENDINDICES0
		case 24:
			return 4; // COLOR0
		case 25:
			return 5; // COLOR1
		case 28:
			return 6; // TEXCOORD0
		case 29:
			return 7; // TEXCOORD1
		case 30:
			return 8; // TEXCOORD2
		case 31:
			return 9; // TEXCOORD3
		case 32:
			return 10; // TEXCOORD4
		case 33:
			return 11; // TEXCOORD5
		default:
			return -1;
	}
}

/**
 * Build the equivalent legacy declaration for a gen9 format block.
 *
 * CodeWalker Drawable.cs:5170-5243. `types` is assumed GTAV1: that is what
 * CodeWalker defaults to, and the per-slot component types are then implied rather
 * than read, because gen9 stores a DXGI-style format per slot instead of a nibble map.
 */
export function legacyDeclarationFromG9(
	g9: VertexDeclarationG9,
	types: bigint = VertexDeclarationTypes.GTAV1,
): VertexDeclaration {
	let flags = 0;
	for (let i = 0; i < g9.types.length; i++) {
		if (g9.types[i] === 0) continue;
		const lci = legacyComponentIndex(i);
		if (lci < 0) continue;
		flags = (flags | (1 << lci)) >>> 0;
	}
	const declaration: VertexDeclaration = { flags, stride: 0, count: 0, types, unknown6: 0 };
	const derived = derivedCountAndStride(declaration);
	declaration.count = derived.count;
	declaration.stride = derived.stride;
	return declaration;
}

/**
 * Re-pack gen9 vertex bytes into the legacy component order.
 *
 * CodeWalker Drawable.cs:4242-4277. Gen9 stores the same components with the same
 * widths but in RAGE-semantic order, not legacy-slot order, so every buffer has to be
 * shuffled before a legacy declaration describes it. There is no shortcut: the source
 * offset comes from the gen9 block, the destination offset from the legacy
 * declaration, and only the legacy component's size is copied.
 */
export function repackGen9Vertices(
	g9: VertexDeclarationG9,
	legacy: VertexDeclaration,
	gen9Bytes: Uint8Array,
	vertexCount: number,
	stride: number,
): Uint8Array {
	const out = new Uint8Array(gen9Bytes.length);
	for (let i = 0; i < g9.types.length; i++) {
		if (g9.types[i] === 0) continue;
		const lci = legacyComponentIndex(i);
		if (lci < 0) continue;
		const srcStep = g9.sizes[i];
		const srcBase = g9.offsets[i];
		const dstBase = componentOffset(legacy, lci);
		const size = vertexComponentSize(componentTypeAt(legacy, lci));
		if (size === 0) continue;
		for (let v = 0; v < vertexCount; v++) {
			const src = srcBase + srcStep * v;
			const dst = dstBase + stride * v;
			if (src + size > gen9Bytes.length || dst + size > out.length) break;
			out.set(gen9Bytes.subarray(src, src + size), dst);
		}
	}
	return out;
}
