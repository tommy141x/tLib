// Animation channel decoders - the bit-level heart of a .ycd.
//
// Ported from CodeWalker.Core Clip.cs:969-1950 (MIT, dexyfex/Neodymium).
//
// A "channel" is one scalar stream over the animation's frames. Bone tracks are built
// from several: a position track is three channels, a rotation four (or three plus a
// reconstructed component - see AnimChannelCachedQuaternion). Nine encodings exist and
// each packs bits differently, so an off-by-one here produces plausible-looking numbers
// rather than an error. Every offset below is deliberate; do not "tidy" them.

export enum AnimChannelType {
	StaticQuaternion = 0,
	StaticVector3 = 1,
	StaticFloat = 2,
	RawFloat = 3,
	QuantizeFloat = 4,
	IndirectQuantizeFloat = 5,
	LinearFloat = 6,
	CachedQuaternion1 = 7,
	CachedQuaternion2 = 8,
}

export const ANIM_CHANNEL_TYPE_COUNT = 9;

/**
 * Cursor over a Sequence's packed `Data` blob.
 *
 * Four independent cursors run over the same bytes, which is why this is one object
 * rather than four readers:
 *   position          - channel parameter block, from byte 0
 *   channelListOffset - the nine per-type channel counts
 *   channelDataOffset - per-channel sequence/index words after those counts
 *   bitPosition       - free bit cursor, used while decoding a channel's value table
 *   frameBitOffset    - per-frame bit cursor, re-seated by beginFrame()
 */
export class AnimChannelDataReader {
	readonly data: Uint8Array;
	private readonly view: DataView;
	readonly numFrames: number;
	readonly chunkSize: number;
	readonly frameLength: number;

	position = 0;
	frame = 0;
	bitPosition = 0;
	channelListOffset: number;
	channelDataOffset: number;
	frameBitOffset = 0;

	/** Back-reference used by cached-quaternion channels to reach their siblings. */
	sequences: AnimSequence[] | null = null;

	constructor(data: Uint8Array, numFrames: number, chunkSize: number, frameOffset: number, frameLength: number) {
		this.data = data;
		this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		this.numFrames = numFrames;
		this.chunkSize = chunkSize;
		this.frameLength = frameLength;
		this.channelListOffset = frameOffset + frameLength * numFrames;
		this.channelDataOffset = this.channelListOffset + ANIM_CHANNEL_TYPE_COUNT * 2;
		this.frameOffset = frameOffset;
	}

	readonly frameOffset: number;

	readInt32(): number {
		const v = this.view.getInt32(this.position, true);
		this.position += 4;
		return v;
	}

	readFloat32(): number {
		const v = this.view.getFloat32(this.position, true);
		this.position += 4;
		return v;
	}

	readVector3(): [number, number, number] {
		const v: [number, number, number] = [
			this.view.getFloat32(this.position, true),
			this.view.getFloat32(this.position + 4, true),
			this.view.getFloat32(this.position + 8, true),
		];
		this.position += 12;
		return v;
	}

	/**
	 * Read `length` bits starting at absolute bit `startBit`.
	 *
	 * This is dexyfex's byte-at-a-time version rather than the older 64-bit-window one:
	 * the window version reads past the end of `data` on the final frames of some files.
	 * A negative startBit means an earlier field decoded wrong; returning 0 matches
	 * CodeWalker and keeps one bad channel from taking down the whole clip.
	 */
	getBits(startBit: number, length: number): number {
		if (startBit < 0) return 0;
		const startByte = Math.floor(startBit / 8);
		const bitOffset = startBit % 8;
		let result = 0;
		let shift = -bitOffset;
		let curByte = startByte;
		let bitsRemaining = length;
		while (bitsRemaining > 0) {
			const b = curByte < this.data.length ? this.data[curByte++] : 0;
			const shifted = shift < 0 ? b >>> -shift : (b << shift) >>> 0;
			const mask = (((1 << Math.min(bitsRemaining, 8)) - 1) << Math.max(shift, 0)) >>> 0;
			result = (result + ((shifted & mask) >>> 0)) >>> 0;
			bitsRemaining -= 8 + Math.min(shift, 0);
			shift += 8;
		}
		return result >>> 0;
	}

	readBits(length: number): number {
		const bits = this.getBits(this.bitPosition, length);
		this.bitPosition += length;
		return bits;
	}

	readChannelCount(): number {
		const v = this.view.getUint16(this.channelListOffset, true);
		this.channelListOffset += 2;
		return v;
	}

	readChannelDataBits(): number {
		const v = this.view.getUint16(this.channelDataOffset, true);
		this.channelDataOffset += 2;
		return v;
	}

	readChannelDataBytes(n: number): Uint8Array {
		const r = this.data.subarray(this.channelDataOffset, this.channelDataOffset + n);
		this.channelDataOffset += n;
		return r;
	}

	/** The per-type channel-data words are padded to groups of four. */
	alignChannelDataOffset(channelCount: number): void {
		const remainder = channelCount % 4;
		if (remainder > 0) this.channelDataOffset += (4 - remainder) * 2;
	}

	beginFrame(f: number): void {
		this.frame = f;
		this.frameBitOffset = (this.frameOffset + this.frameLength * f) * 8;
	}

	readFrameBits(n: number): number {
		const b = this.getBits(this.frameBitOffset, n);
		this.frameBitOffset += n;
		return b;
	}
}

/**
 * Reconstruct a quaternion's dropped component as sqrt(1 - x^2 - y^2 - z^2).
 *
 * The float32 rounding is load-bearing, not pedantry. The game and CodeWalker evaluate
 * the sum in float32, where a unit-length vector often rounds to slightly *above* 1, so
 * the clamp fires and the component is exactly 0. Computed in float64 the same data
 * lands slightly below 1 and yields ~1e-4 instead - which is visible as a hairline
 * rotation error on otherwise-static bones, and was caught by differential testing
 * against CodeWalker over ~92k sampled components.
 */
export function reconstructQuatComponent(x: number, y: number, z: number): number {
	const lenSq = Math.fround(Math.fround(Math.fround(x * x) + Math.fround(y * y)) + Math.fround(z * z));
	return Math.sqrt(Math.max(Math.fround(1 - lenSq), 0));
}

export abstract class AnimChannel {
	abstract readonly type: AnimChannelType;
	sequence = 0;
	index = 0;
	dataOffset = 0;
	frameOffset = 0;

	/** Read this channel's parameter block. Called once, before any frame data. */
	abstract read(reader: AnimChannelDataReader): void;

	/** Read this channel's slice of the current frame. Most encodings need this. */
	readFrame(_reader: AnimChannelDataReader): void {}

	/** How many bits this channel occupies in each frame record. */
	getFrameBits(): number {
		return 0;
	}

	evaluateFloat(_frame: number): number {
		return 0;
	}

	associate(sequence: number, index: number): void {
		this.sequence = sequence;
		this.index = index;
	}
}

export class AnimChannelStaticFloat extends AnimChannel {
	readonly type = AnimChannelType.StaticFloat;
	value = 0;

	read(reader: AnimChannelDataReader): void {
		this.value = reader.readFloat32();
	}
	evaluateFloat(): number {
		return this.value;
	}
}

export class AnimChannelStaticVector3 extends AnimChannel {
	readonly type = AnimChannelType.StaticVector3;
	value: [number, number, number] = [0, 0, 0];

	read(reader: AnimChannelDataReader): void {
		this.value = reader.readVector3();
	}
	// Deliberately no evaluateFloat override: this channel supplies three components
	// at once and AnimSequence.evaluateVector splats it directly. Matches CodeWalker.
}

export class AnimChannelStaticQuaternion extends AnimChannel {
	readonly type = AnimChannelType.StaticQuaternion;
	value: [number, number, number, number] = [0, 0, 0, 1];

	read(reader: AnimChannelDataReader): void {
		// Only XYZ are stored; W is reconstructed on the unit sphere. The max() guards
		// against a stored vector slightly longer than unit, which does occur.
		const [x, y, z] = reader.readVector3();
		this.value = [x, y, z, reconstructQuatComponent(x, y, z)];
	}
}

export class AnimChannelRawFloat extends AnimChannel {
	readonly type = AnimChannelType.RawFloat;
	values: Float32Array = new Float32Array(0);

	private static readonly conv = new DataView(new ArrayBuffer(4));

	read(reader: AnimChannelDataReader): void {
		this.values = new Float32Array(reader.numFrames);
	}

	readFrame(reader: AnimChannelDataReader): void {
		const bits = reader.readFrameBits(32);
		// Reinterpret the 32 bits as a float rather than converting numerically.
		AnimChannelRawFloat.conv.setUint32(0, bits, true);
		this.values[reader.frame] = AnimChannelRawFloat.conv.getFloat32(0, true);
	}

	getFrameBits(): number {
		return 32;
	}

	evaluateFloat(frame: number): number {
		return this.values.length > 0 ? this.values[frame % this.values.length] : 0;
	}
}

export class AnimChannelQuantizeFloat extends AnimChannel {
	readonly type = AnimChannelType.QuantizeFloat;
	valueBits = 0;
	quantum = 0;
	offset = 0;
	values: Float32Array = new Float32Array(0);

	read(reader: AnimChannelDataReader): void {
		this.valueBits = reader.readInt32();
		this.quantum = reader.readFloat32();
		this.offset = reader.readFloat32();
		this.values = new Float32Array(reader.numFrames);
	}

	readFrame(reader: AnimChannelDataReader): void {
		const bits = reader.readFrameBits(this.valueBits);
		this.values[reader.frame] = bits * this.quantum + this.offset;
	}

	getFrameBits(): number {
		return this.valueBits;
	}

	evaluateFloat(frame: number): number {
		return this.values.length > 0 ? this.values[frame % this.values.length] : this.offset;
	}
}

export class AnimChannelIndirectQuantizeFloat extends AnimChannel {
	readonly type = AnimChannelType.IndirectQuantizeFloat;
	frameBits = 0;
	valueBits = 0;
	numInts = 0;
	quantum = 0;
	offset = 0;
	/** Shared value table; frames index into it. */
	values: Float32Array = new Float32Array(0);
	frames: Uint32Array = new Uint32Array(0);

	read(reader: AnimChannelDataReader): void {
		this.frameBits = reader.readInt32();
		this.valueBits = reader.readInt32();
		this.numInts = reader.readInt32();
		this.quantum = reader.readFloat32();
		this.offset = reader.readFloat32();

		this.frames = new Uint32Array(reader.numFrames);

		// The table length is not stored. It is bounded both by the space the ints
		// occupy and by how many distinct entries a frame index can address; the
		// smaller bound wins. (CodeWalker carries the same "any better way?" note.)
		const byCapacity = Math.floor((this.numInts * 32) / this.valueBits);
		const byIndexRange = (1 << this.frameBits) - 1;
		const numValues = Math.min(byCapacity, byIndexRange);

		this.values = new Float32Array(Math.max(numValues, 0));
		reader.bitPosition = reader.position * 8;
		for (let i = 0; i < numValues; i++) {
			this.values[i] = reader.readBits(this.valueBits) * this.quantum + this.offset;
		}
		reader.position += this.numInts * 4;
	}

	readFrame(reader: AnimChannelDataReader): void {
		this.frames[reader.frame] = reader.readFrameBits(this.frameBits);
	}

	getFrameBits(): number {
		return this.frameBits;
	}

	evaluateFloat(frame: number): number {
		if (this.frames.length === 0) return this.offset;
		const idx = this.frames[frame % this.frames.length];
		return idx < this.values.length ? this.values[idx] : this.offset;
	}
}

export class AnimChannelLinearFloat extends AnimChannel {
	readonly type = AnimChannelType.LinearFloat;
	quantum = 0;
	offset = 0;
	values: Float32Array = new Float32Array(0);

	/**
	 * Chunked delta encoding. Frames are grouped into chunks; each chunk stores a start
	 * value and a bit offset to its delta stream, and each subsequent frame stores a
	 * delta encoded as (fixed low bits) + (Elias-gamma-style run of zeroes terminated by
	 * a one) + an optional sign bit. The running delta accumulates, so the value is a
	 * second-order integration, not a simple sum.
	 */
	read(reader: AnimChannelDataReader): void {
		const numInts = reader.readInt32();
		const counts = reader.readInt32();
		this.quantum = reader.readFloat32();
		this.offset = reader.readFloat32();

		const startBit = reader.position * 8;
		const offsetBits = counts & 0xff; // per-chunk delta-stream bit offset width
		const valueBits = (counts >> 8) & 0xff; // per-chunk start value width
		const deltaBits = (counts >> 16) & 0xff; // fixed low bits of each frame delta

		const streamLength = reader.data.length * 8;
		const numFrames = reader.numFrames;
		const chunkSize = reader.chunkSize;
		const numChunks = Math.floor((chunkSize + numFrames - 1) / chunkSize);
		const deltaOffset = startBit + numChunks * (offsetBits + valueBits);

		reader.bitPosition = startBit;
		const chunkOffsets = new Int32Array(numChunks);
		const chunkValues = new Int32Array(numChunks);
		const frameValues = new Float32Array(numFrames);

		for (let i = 0; i < numChunks; i++) {
			chunkOffsets[i] = offsetBits > 0 ? reader.readBits(offsetBits) : 0;
		}
		for (let i = 0; i < numChunks; i++) {
			chunkValues[i] = valueBits > 0 ? reader.readBits(valueBits) : 0;
		}

		for (let i = 0; i < numChunks; i++) {
			reader.bitPosition = chunkOffsets[i] + deltaOffset;
			let value = chunkValues[i];
			const chunkStartFrame = i * chunkSize;
			let inc = 0;

			for (let j = 0; j < chunkSize; j++) {
				const frame = chunkStartFrame + j;
				if (frame >= numFrames) break;

				frameValues[frame] = value * this.quantum + this.offset;

				if (j + 1 >= chunkSize) break; // last frame of the chunk carries no delta

				let delta = deltaBits !== 0 ? reader.readBits(deltaBits) : 0;
				const scanStart = reader.bitPosition;
				let bit = 0;
				while (bit === 0) {
					bit = reader.readBits(1);
					// Guard against a malformed stream spinning forever at the end of data.
					if (reader.bitPosition >= streamLength) break;
				}
				delta |= (reader.bitPosition - scanStart - 1) << deltaBits;
				if (delta !== 0 && reader.readBits(1) === 1) delta = -delta;
				inc += delta;
				value += inc;
			}
		}

		this.values = frameValues;

		// Rewind the four header fields, then skip the whole parameter block. The
		// bitstream just consumed is interleaved with it, so position cannot simply
		// be left where the bit cursor ended up.
		reader.position -= 16;
		reader.position += numInts * 4;
	}

	evaluateFloat(frame: number): number {
		return this.values.length > 0 ? this.values[frame % this.values.length] : this.offset;
	}
}

export class AnimChannelCachedQuaternion extends AnimChannel {
	readonly type: AnimChannelType.CachedQuaternion1 | AnimChannelType.CachedQuaternion2;
	/** Which quaternion component this channel reconstructs (0=X .. 3=W). */
	quatIndex = 0;

	private reader: AnimChannelDataReader | null = null;
	private cache: Float32Array | null = null;

	constructor(type: AnimChannelType.CachedQuaternion1 | AnimChannelType.CachedQuaternion2) {
		super();
		this.type = type;
	}

	read(reader: AnimChannelDataReader): void {
		// Stores no data of its own - it is derived from its three sibling channels,
		// which are not parsed yet at this point. Hence the lazy cache below.
		this.reader = reader;
	}

	/**
	 * The dropped component, reconstructed as sqrt(1 - x^2 - y^2 - z^2) from siblings
	 * 0..2 of the same sequence. Always non-negative: the encoder chooses which
	 * component to drop so that the reconstruction's sign is known.
	 */
	get values(): Float32Array {
		if (this.cache) return this.cache;
		const reader = this.reader;
		const siblings = reader?.sequences?.[this.sequence]?.channels;
		if (!reader || !siblings) return new Float32Array(0);

		const cache = new Float32Array(reader.numFrames);
		const [a, b, c] = [siblings[0], siblings[1], siblings[2]];
		for (let i = 0; i < cache.length; i++) {
			const x = a?.evaluateFloat(i) ?? 0;
			const y = b?.evaluateFloat(i) ?? 0;
			const z = c?.evaluateFloat(i) ?? 0;
			cache[i] = reconstructQuatComponent(x, y, z);
		}
		this.cache = cache;
		return cache;
	}

	evaluateFloat(frame: number): number {
		const v = this.values;
		return v.length > 0 ? v[frame % v.length] : 0;
	}
}

export function constructChannel(type: AnimChannelType): AnimChannel | null {
	switch (type) {
		case AnimChannelType.StaticQuaternion:
			return new AnimChannelStaticQuaternion();
		case AnimChannelType.StaticVector3:
			return new AnimChannelStaticVector3();
		case AnimChannelType.StaticFloat:
			return new AnimChannelStaticFloat();
		case AnimChannelType.RawFloat:
			return new AnimChannelRawFloat();
		case AnimChannelType.QuantizeFloat:
			return new AnimChannelQuantizeFloat();
		case AnimChannelType.IndirectQuantizeFloat:
			return new AnimChannelIndirectQuantizeFloat();
		case AnimChannelType.LinearFloat:
			return new AnimChannelLinearFloat();
		case AnimChannelType.CachedQuaternion1:
			return new AnimChannelCachedQuaternion(AnimChannelType.CachedQuaternion1);
		case AnimChannelType.CachedQuaternion2:
			return new AnimChannelCachedQuaternion(AnimChannelType.CachedQuaternion2);
		default:
			return null;
	}
}

export type Vec4 = [number, number, number, number];

/** One bone track's channels within a Sequence. */
export class AnimSequence {
	channels: (AnimChannel | null)[] = [];
	/** True when the rotation is stored as three components plus a reconstructed one. */
	isType7Quat = false;
	boneId = 0;
	track = 0;

	/**
	 * Assemble a quaternion from a type-7 track by slotting the reconstructed
	 * component back into the position the encoder dropped it from.
	 */
	evaluateQuaternionType7(frame: number): Vec4 {
		if (!this.isType7Quat) {
			return [
				this.channels[0]?.evaluateFloat(frame) ?? 0,
				this.channels[1]?.evaluateFloat(frame) ?? 0,
				this.channels[2]?.evaluateFloat(frame) ?? 0,
				this.channels[3]?.evaluateFloat(frame) ?? 0,
			];
		}

		// The cached channel sits at index 3 for CachedQuaternion1 and 4 for type 2.
		let cached = this.channels[3];
		if (!(cached instanceof AnimChannelCachedQuaternion)) cached = this.channels[4] ?? null;
		if (!(cached instanceof AnimChannelCachedQuaternion)) return [0, 0, 0, 1];

		const x = this.channels[0]?.evaluateFloat(frame) ?? 0;
		const y = this.channels[1]?.evaluateFloat(frame) ?? 0;
		const z = this.channels[2]?.evaluateFloat(frame) ?? 0;
		const n = cached.evaluateFloat(frame);

		switch (cached.quatIndex) {
			case 0:
				return [n, x, y, z];
			case 1:
				return [x, n, y, z];
			case 2:
				return [x, y, n, z];
			case 3:
				return [x, y, z, n];
			default:
				return [0, 0, 0, 1];
		}
	}

	/**
	 * The track's value at `frame` as four components.
	 *
	 * Positions and scales fill XYZ and leave W at zero; rotations fill all four. The
	 * component cursor advances by 3 for a static vector and 4 for a static quaternion
	 * because those channels carry several components each, unlike the scalar encodings.
	 */
	evaluateVector(frame: number): Vec4 {
		if (this.channels.length === 0) return [0, 0, 0, 0];
		if (this.isType7Quat) {
			const q = this.evaluateQuaternionType7(frame);
			const len = Math.hypot(q[0], q[1], q[2], q[3]);
			// Normalizing should be redundant; it stops one bad track exploding a pose.
			return len > 0 ? [q[0] / len, q[1] / len, q[2] / len, q[3] / len] : [0, 0, 0, 1];
		}

		const v: Vec4 = [0, 0, 0, 0];
		let c = 0;
		for (const channel of this.channels) {
			if (c >= 4) break;
			if (channel instanceof AnimChannelStaticVector3) {
				for (let n = 0; n < 3 && c + n < 4; n++) v[c + n] = channel.value[n];
				c += 3;
			} else if (channel instanceof AnimChannelStaticQuaternion) {
				for (let n = 0; n < 4 && c + n < 4; n++) v[c + n] = channel.value[n];
				c += 4;
			} else {
				v[c] = channel?.evaluateFloat(frame) ?? 0;
				c++;
			}
		}
		return v;
	}
}
