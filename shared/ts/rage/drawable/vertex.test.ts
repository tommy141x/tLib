import { describe, expect, test } from "bun:test";
import {
	attributeData,
	componentOffset,
	componentTypeAt,
	decodeVertexComponent,
	decodeVertices,
	derivedCountAndStride,
	floatToHalf,
	halfToFloat,
	legacyComponentIndex,
	legacyDeclarationFromG9,
	presentSemantics,
	repackGen9Vertices,
	VERTEX_SEMANTIC_NAMES,
	VertexComponentType,
	VertexDeclarationTypes,
	VertexSemantics,
	vertexComponentCount,
	vertexComponentSize,
	type VertexDeclaration,
	type VertexDeclarationG9,
	vertexTypeName,
} from "./vertex";

/** A declaration over GTAV1, the nibble map every shipped drawable uses. */
function gtav1(flags: number): VertexDeclaration {
	const d: VertexDeclaration = { flags, stride: 0, count: 0, types: VertexDeclarationTypes.GTAV1, unknown6: 0 };
	const { count, stride } = derivedCountAndStride(d);
	d.count = count;
	d.stride = stride;
	return d;
}

function decodeOne(type: VertexComponentType, bytes: number[]): number[] {
	const buffer = new Uint8Array(bytes);
	const view = new DataView(buffer.buffer);
	const out = new Float32Array(8);
	const written = decodeVertexComponent(type, view, 0, out, 0);
	return Array.from(out.subarray(0, written));
}

function leFloat(value: number): number[] {
	const b = new Uint8Array(4);
	new DataView(b.buffer).setFloat32(0, value, true);
	return Array.from(b);
}

function leHalf(value: number): number[] {
	const bits = floatToHalf(value);
	return [bits & 0xff, (bits >> 8) & 0xff];
}

describe("component metadata", () => {
	// CodeWalker VertexType.cs:31-68. Every one of the 16 enum values, so a typo in
	// the switch cannot hide behind the types that happen to be in the corpus.
	const expected: [VertexComponentType, number, number][] = [
		[VertexComponentType.Nothing, 0, 0],
		[VertexComponentType.Half2, 4, 2],
		[VertexComponentType.Float, 4, 1],
		[VertexComponentType.Half4, 8, 4],
		[VertexComponentType.FloatUnk, 0, 0],
		[VertexComponentType.Float2, 8, 2],
		[VertexComponentType.Float3, 12, 3],
		[VertexComponentType.Float4, 16, 4],
		[VertexComponentType.UByte4, 4, 4],
		[VertexComponentType.Colour, 4, 4],
		[VertexComponentType.RGBA8SNorm, 4, 4],
		[VertexComponentType.Unk1, 0, 0],
		[VertexComponentType.Unk2, 0, 0],
		[VertexComponentType.Unk3, 0, 0],
		[VertexComponentType.Unk4, 0, 0],
		[VertexComponentType.Unk5, 0, 0],
	];

	test.each(expected)("type %p is %p bytes and %p scalars", (type, size, count) => {
		expect(vertexComponentSize(type)).toBe(size);
		expect(vertexComponentCount(type)).toBe(count);
	});

	test("the sizes sum to the stride of the two commonest layouts", () => {
		// Default (PNCT) and DefaultEx (PNCTX); gtatool reports 36 and 52 for these.
		expect(derivedCountAndStride(gtav1(89))).toEqual({ count: 4, stride: 36 });
		expect(derivedCountAndStride(gtav1(16473))).toEqual({ count: 5, stride: 52 });
	});
});

describe("half floats", () => {
	// Known binary16 bit patterns, including both ends of the range and the subnormal
	// boundary. The subnormal case is the one a naive implementation gets wrong: there
	// is no implicit leading 1, so 0x0001 is 2^-24, not 2^-15.
	const cases: [number, number][] = [
		[0x0000, 0],
		[0x3c00, 1],
		[0x3800, 0.5],
		[0xc000, -2],
		[0x0001, 2 ** -24],
		[0x03ff, 1023 * 2 ** -24],
		[0x0400, 2 ** -14],
		[0x7bff, 65504],
		[0x3555, 0.333251953125],
	];
	test.each(cases)("0x%s decodes to %p", (bits, value) => {
		expect(halfToFloat(bits)).toBe(value);
	});

	test("signed zero keeps its sign", () => {
		expect(Object.is(halfToFloat(0x8000), -0)).toBe(true);
	});

	test("infinities and NaN", () => {
		expect(halfToFloat(0x7c00)).toBe(Number.POSITIVE_INFINITY);
		expect(halfToFloat(0xfc00)).toBe(Number.NEGATIVE_INFINITY);
		expect(Number.isNaN(halfToFloat(0x7e00))).toBe(true);
	});

	test("floatToHalf round-trips every representable normal", () => {
		// Every normal half bit pattern, both signs, excluding inf/NaN exponents.
		let checked = 0;
		for (let bits = 0; bits < 0x7c00; bits++) {
			const value = halfToFloat(bits);
			expect(floatToHalf(value)).toBe(bits);
			const negative = halfToFloat(bits | 0x8000);
			expect(floatToHalf(negative)).toBe(bits === 0 ? 0x8000 : bits | 0x8000);
			checked += 2;
		}
		expect(checked).toBe(0x7c00 * 2);
	});

	test("floatToHalf saturates and flushes at the edges", () => {
		expect(floatToHalf(Number.POSITIVE_INFINITY)).toBe(0x7c00);
		expect(floatToHalf(-Number.POSITIVE_INFINITY)).toBe(0xfc00);
		expect(floatToHalf(1e30)).toBe(0x7c00);
		expect(floatToHalf(1e-30)).toBe(0x0000);
		expect(Number.isNaN(halfToFloat(floatToHalf(Number.NaN)))).toBe(true);
	});
});

describe("decodeVertexComponent", () => {
	test("Half2 reads two little-endian halves", () => {
		expect(decodeOne(VertexComponentType.Half2, [...leHalf(1), ...leHalf(-0.5)])).toEqual([1, -0.5]);
	});

	test("Half4 reads four", () => {
		expect(
			decodeOne(VertexComponentType.Half4, [...leHalf(1), ...leHalf(2), ...leHalf(-1), ...leHalf(0.25)]),
		).toEqual([1, 2, -1, 0.25]);
	});

	test("Float, Float2, Float3 and Float4 read little-endian binary32", () => {
		expect(decodeOne(VertexComponentType.Float, leFloat(1.5))).toEqual([1.5]);
		expect(decodeOne(VertexComponentType.Float2, [...leFloat(1), ...leFloat(2)])).toEqual([1, 2]);
		expect(decodeOne(VertexComponentType.Float3, [...leFloat(1), ...leFloat(2), ...leFloat(3)])).toEqual([1, 2, 3]);
		expect(
			decodeOne(VertexComponentType.Float4, [...leFloat(1), ...leFloat(2), ...leFloat(3), ...leFloat(4)]),
		).toEqual([1, 2, 3, 4]);
	});

	test("UByte4 stays raw - it carries bone indices, not a colour", () => {
		expect(decodeOne(VertexComponentType.UByte4, [0, 1, 128, 255])).toEqual([0, 1, 128, 255]);
	});

	test("Colour is UNORM over 255", () => {
		// Math.fround because the destination is a Float32Array: 128/255 is not
		// representable in binary32 and comparing against the float64 value fails.
		expect(decodeOne(VertexComponentType.Colour, [0, 255, 51, 128])).toEqual([
			0,
			1,
			Math.fround(0.2),
			Math.fround(128 / 255),
		]);
	});

	test("RGBA8SNorm is int8/127 clamped at -1", () => {
		// 0x80 is -128; D3D SNORM maps both -128 and -127 to exactly -1.
		expect(decodeOne(VertexComponentType.RGBA8SNorm, [0x00, 0x7f, 0x81, 0x80])).toEqual([0, 1, -1, -1]);
		expect(decodeOne(VertexComponentType.RGBA8SNorm, [0x40, 0xc0, 0x01, 0xff])).toEqual([
			Math.fround(64 / 127),
			Math.fround(-64 / 127),
			Math.fround(1 / 127),
			Math.fround(-1 / 127),
		]);
	});

	test("zero-width types write nothing", () => {
		for (const type of [
			VertexComponentType.Nothing,
			VertexComponentType.FloatUnk,
			VertexComponentType.Unk1,
			VertexComponentType.Unk2,
			VertexComponentType.Unk3,
			VertexComponentType.Unk4,
			VertexComponentType.Unk5,
		]) {
			expect(decodeOne(type, [1, 2, 3, 4, 5, 6, 7, 8])).toEqual([]);
		}
	});

	test("reads at a non-zero offset without touching earlier output", () => {
		const bytes = new Uint8Array([0xff, 0xff, ...leFloat(7), ...leFloat(8)]);
		const out = new Float32Array([99, 99, 99, 99]);
		const written = decodeVertexComponent(
			VertexComponentType.Float2,
			new DataView(bytes.buffer),
			2,
			out,
			1,
		);
		expect(written).toBe(2);
		expect(Array.from(out)).toEqual([99, 7, 8, 99]);
	});
});

describe("declaration layout", () => {
	// GTAV1 nibbles from the low end: 6,9,9,6,9,9,5,5,5,5,5,5,5,5,7,7.
	test("componentTypeAt reads the right nibble", () => {
		const d = gtav1(0xffff);
		expect(componentTypeAt(d, VertexSemantics.Position)).toBe(VertexComponentType.Float3);
		expect(componentTypeAt(d, VertexSemantics.BlendWeights)).toBe(VertexComponentType.Colour);
		expect(componentTypeAt(d, VertexSemantics.BlendIndices)).toBe(VertexComponentType.Colour);
		expect(componentTypeAt(d, VertexSemantics.Normal)).toBe(VertexComponentType.Float3);
		expect(componentTypeAt(d, VertexSemantics.Colour0)).toBe(VertexComponentType.Colour);
		expect(componentTypeAt(d, VertexSemantics.TexCoord0)).toBe(VertexComponentType.Float2);
		expect(componentTypeAt(d, VertexSemantics.Tangent)).toBe(VertexComponentType.Float4);
		expect(componentTypeAt(d, VertexSemantics.Binormal)).toBe(VertexComponentType.Float4);
	});

	test("componentOffset sums only the present slots below it", () => {
		const d = gtav1(89); // Position, Normal, Colour0, TexCoord0
		expect(presentSemantics(d)).toEqual([0, 3, 4, 6]);
		expect(componentOffset(d, VertexSemantics.Position)).toBe(0);
		expect(componentOffset(d, VertexSemantics.Normal)).toBe(12);
		expect(componentOffset(d, VertexSemantics.Colour0)).toBe(24);
		expect(componentOffset(d, VertexSemantics.TexCoord0)).toBe(28);
		// Absent slots still have a well-defined offset - the sum below them.
		expect(componentOffset(d, VertexSemantics.BlendWeights)).toBe(12);
	});

	test("vertexTypeName names the common layouts", () => {
		expect(vertexTypeName(gtav1(89))).toBe("Default");
		expect(vertexTypeName(gtav1(16473))).toBe("DefaultEx");
		expect(vertexTypeName(gtav1(95))).toBe("PBBNCT");
	});

	test("the cloth layouts are told apart by `types`, not by `flags`", () => {
		const cloth2: VertexDeclaration = {
			flags: 16473,
			stride: 0,
			count: 0,
			types: VertexDeclarationTypes.GTAV2,
			unknown6: 0,
		};
		const cloth3: VertexDeclaration = { flags: 89, stride: 0, count: 0, types: VertexDeclarationTypes.GTAV3, unknown6: 0 };
		expect(vertexTypeName(cloth2)).toBe("PCCH2H4");
		expect(vertexTypeName(cloth3)).toBe("PNCH2");
		// The same flags under GTAV1 are the non-cloth layouts.
		expect(vertexTypeName(gtav1(16473))).toBe("DefaultEx");
		expect(vertexTypeName(gtav1(89))).toBe("Default");
	});

	test("an unknown layout reports its flags rather than inventing a name", () => {
		expect(vertexTypeName(gtav1(0b1010))).toBe("10");
	});

	test("the GTAV2 cloth layout decodes its packed components", () => {
		// GTAV2 = 0x030000000199A006: Position Float3, Normal Colour(Dec3N), Colour0/1
		// Colour, TexCoord0 Half2, Tangent Half4. This is the only place Half2/Half4
		// appear in a GTA V declaration, so it is covered synthetically.
		const d: VertexDeclaration = {
			flags: 16473,
			stride: 0,
			count: 0,
			types: VertexDeclarationTypes.GTAV2,
			unknown6: 0,
		};
		expect(componentTypeAt(d, VertexSemantics.Position)).toBe(VertexComponentType.Float3);
		expect(componentTypeAt(d, VertexSemantics.Normal)).toBe(VertexComponentType.RGBA8SNorm);
		expect(componentTypeAt(d, VertexSemantics.Colour0)).toBe(VertexComponentType.Colour);
		expect(componentTypeAt(d, VertexSemantics.Colour1)).toBe(VertexComponentType.Colour);
		expect(componentTypeAt(d, VertexSemantics.TexCoord0)).toBe(VertexComponentType.Half2);
		expect(componentTypeAt(d, VertexSemantics.Tangent)).toBe(VertexComponentType.Half4);
	});
});

describe("decodeVertices", () => {
	test("splits a Default buffer into per-semantic arrays", () => {
		const d = gtav1(89);
		const bytes = new Uint8Array(d.stride * 2);
		const view = new DataView(bytes.buffer);
		const write = (v: number, offset: number, values: number[]) => {
			for (let i = 0; i < values.length; i++) view.setFloat32(v * d.stride + offset + i * 4, values[i], true);
		};
		write(0, 0, [1, 2, 3]);
		write(0, 12, [0, 0, 1]);
		bytes.set([255, 128, 0, 255], 24);
		write(0, 28, [0.25, 0.75]);
		write(1, 0, [-1, -2, -3]);
		write(1, 12, [1, 0, 0]);
		bytes.set([0, 0, 0, 0], d.stride + 24);
		write(1, 28, [0.5, 0.5]);

		const decoded = decodeVertices(d, bytes, 2);
		expect(decoded.warnings).toEqual([]);
		expect(decoded.count).toBe(2);
		expect(decoded.attributes.map((a) => a.name)).toEqual(["Position", "Normal", "Colour0", "TexCoord0"]);
		expect(Array.from(attributeData(decoded, VertexSemantics.Position) ?? [])).toEqual([1, 2, 3, -1, -2, -3]);
		expect(Array.from(attributeData(decoded, VertexSemantics.Normal) ?? [])).toEqual([0, 0, 1, 1, 0, 0]);
		expect(Array.from(attributeData(decoded, VertexSemantics.TexCoord0) ?? [])).toEqual([0.25, 0.75, 0.5, 0.5]);
		expect(attributeData(decoded, VertexSemantics.Tangent)).toBeNull();

		const colour = decoded.bySemantic[VertexSemantics.Colour0];
		expect(colour?.data[0]).toBe(1);
		expect(colour?.data[1]).toBe(Math.fround(128 / 255));
		// Packed components also expose their unscaled bytes; this is what makes
		// blend indices usable, since GTAV1 declares those as `Colour` too.
		expect(Array.from(colour?.raw ?? [])).toEqual([255, 128, 0, 255, 0, 0, 0, 0]);
		expect(decoded.bySemantic[VertexSemantics.Position]?.raw).toBeNull();
	});

	test("blend indices come back as integers through `raw`", () => {
		const d = gtav1(95); // PBBNCT: Position, BlendWeights, BlendIndices, Normal, Colour0, TexCoord0
		const bytes = new Uint8Array(d.stride);
		bytes.set([255, 0, 0, 0], componentOffset(d, VertexSemantics.BlendWeights));
		bytes.set([3, 17, 0, 0], componentOffset(d, VertexSemantics.BlendIndices));
		const decoded = decodeVertices(d, bytes, 1);
		const indices = decoded.bySemantic[VertexSemantics.BlendIndices];
		expect(Array.from(indices?.raw ?? [])).toEqual([3, 17, 0, 0]);
		// ...and as fractions through `data`, which is why `raw` has to exist.
		expect(indices?.data[0]).toBe(Math.fround(3 / 255));
		expect(decoded.bySemantic[VertexSemantics.BlendWeights]?.data[0]).toBe(1);
	});

	test("a short buffer is reported, not silently truncated to garbage", () => {
		const d = gtav1(89);
		const decoded = decodeVertices(d, new Uint8Array(d.stride), 4);
		expect(decoded.count).toBe(1);
		expect(decoded.warnings.join(" ")).toContain("buffer holds 1 vertices");
	});

	test("a zero stride produces nothing and says so", () => {
		const decoded = decodeVertices(gtav1(89), new Uint8Array(36), 1, 0);
		expect(decoded.attributes).toEqual([]);
		expect(decoded.warnings.join(" ")).toContain("vertex stride is 0");
	});

	test("a stored stride that disagrees with the derived one is reported", () => {
		const d = gtav1(89);
		const decoded = decodeVertices({ ...d, stride: 40 }, new Uint8Array(40), 1, 40);
		expect(decoded.warnings.join(" ")).toContain("disagrees");
	});

	test("every semantic name is defined", () => {
		expect(VERTEX_SEMANTIC_NAMES).toHaveLength(16);
		for (const n of VERTEX_SEMANTIC_NAMES) expect(n.length).toBeGreaterThan(0);
	});
});

describe("gen9 declarations", () => {
	test("legacyComponentIndex maps the twelve usable RAGE slots", () => {
		expect(legacyComponentIndex(0)).toBe(VertexSemantics.Position);
		expect(legacyComponentIndex(4)).toBe(VertexSemantics.Normal);
		expect(legacyComponentIndex(8)).toBe(VertexSemantics.Tangent);
		expect(legacyComponentIndex(16)).toBe(VertexSemantics.BlendWeights);
		expect(legacyComponentIndex(20)).toBe(VertexSemantics.BlendIndices);
		expect(legacyComponentIndex(24)).toBe(VertexSemantics.Colour0);
		expect(legacyComponentIndex(28)).toBe(VertexSemantics.TexCoord0);
		expect(legacyComponentIndex(33)).toBe(VertexSemantics.TexCoord5);
		// Everything else is dropped rather than guessed at.
		for (const i of [1, 2, 3, 5, 12, 21, 34, 51]) expect(legacyComponentIndex(i)).toBe(-1);
	});

	function makeG9(slots: { index: number; format: number; offset: number }[], stride: number): VertexDeclarationG9 {
		const g9: VertexDeclarationG9 = {
			offsets: new Uint32Array(52),
			sizes: new Uint8Array(52),
			types: new Uint8Array(52),
			data: 0n,
			hasSOA: false,
			vertexSize: stride,
			vertexCount: 0,
			elementCount: slots.length,
		};
		for (const s of slots) {
			g9.types[s.index] = s.format;
			g9.offsets[s.index] = s.offset;
			g9.sizes[s.index] = stride; // gen9 stores the stride here, not an element size
		}
		return g9;
	}

	test("a gen9 block converts to the equivalent legacy declaration", () => {
		// The real ztr540.ydr layout: POSITION0, NORMAL0, COLOR0, TEXCOORD0, TANGENT0.
		const g9 = makeG9(
			[
				{ index: 0, format: 6, offset: 0 }, // R32G32B32_FLOAT
				{ index: 4, format: 6, offset: 12 },
				{ index: 8, format: 2, offset: 24 }, // R32G32B32A32_FLOAT
				{ index: 24, format: 28, offset: 40 }, // R8G8B8A8_UNORM
				{ index: 28, format: 16, offset: 44 }, // R32G32_TYPELESS
			],
			52,
		);
		const legacy = legacyDeclarationFromG9(g9);
		expect(legacy.flags).toBe(16473); // DefaultEx
		expect(legacy.stride).toBe(52);
		expect(legacy.count).toBe(5);
		expect(vertexTypeName(legacy)).toBe("DefaultEx");
	});

	test("repackGen9Vertices moves each component to its legacy offset", () => {
		// Gen9 order here is Position, Normal, Tangent, Colour, TexCoord; legacy order
		// is Position, Normal, Colour, TexCoord, Tangent. The shuffle is the whole point.
		const stride = 52;
		const g9 = makeG9(
			[
				{ index: 0, format: 6, offset: 0 },
				{ index: 4, format: 6, offset: 12 },
				{ index: 8, format: 2, offset: 24 },
				{ index: 24, format: 28, offset: 40 },
				{ index: 28, format: 16, offset: 44 },
			],
			stride,
		);
		const legacy = legacyDeclarationFromG9(g9);

		const src = new Uint8Array(stride * 2);
		for (let v = 0; v < 2; v++) {
			const base = v * stride;
			src.set([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3], base + 0); // position
			src.set([4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6], base + 12); // normal
			src.set(new Uint8Array(16).fill(7), base + 24); // tangent
			src.set([8, 9, 10, 11], base + 40); // colour
			src.set([12, 12, 12, 12, 13, 13, 13, 13], base + 44); // texcoord
		}

		const out = repackGen9Vertices(g9, legacy, src, 2, stride);
		for (let v = 0; v < 2; v++) {
			const base = v * stride;
			expect(Array.from(out.subarray(base + componentOffset(legacy, VertexSemantics.Position), base + 12))).toEqual([
				1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
			]);
			const colourAt = base + componentOffset(legacy, VertexSemantics.Colour0);
			expect(Array.from(out.subarray(colourAt, colourAt + 4))).toEqual([8, 9, 10, 11]);
			const tangentAt = base + componentOffset(legacy, VertexSemantics.Tangent);
			expect(Array.from(out.subarray(tangentAt, tangentAt + 16))).toEqual(Array(16).fill(7));
			const uvAt = base + componentOffset(legacy, VertexSemantics.TexCoord0);
			expect(Array.from(out.subarray(uvAt, uvAt + 8))).toEqual([12, 12, 12, 12, 13, 13, 13, 13]);
		}
		// Legacy tangent sits at 36, gen9 tangent at 24: the buffers are not equal.
		expect(componentOffset(legacy, VertexSemantics.Tangent)).toBe(36);
		expect(Array.from(out)).not.toEqual(Array.from(src));
	});

	test("gen9 slots with no legacy equivalent are dropped, not mis-mapped", () => {
		const g9 = makeG9(
			[
				{ index: 0, format: 6, offset: 0 },
				{ index: 40, format: 16, offset: 12 }, // TEXCOORD12 - no legacy slot
			],
			12,
		);
		const legacy = legacyDeclarationFromG9(g9);
		expect(legacy.flags).toBe(1);
		expect(legacy.stride).toBe(12);
		const out = repackGen9Vertices(g9, legacy, new Uint8Array(12).fill(5), 1, 12);
		expect(Array.from(out)).toEqual(Array(12).fill(5));
	});
});
