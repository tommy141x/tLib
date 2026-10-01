// Paged reader over an RSC7 resource's two segments.
//
// Ported from CodeWalker.Core ResourceData.cs:44-163 (ResourceDataReader).
//
// Positions are *virtual addresses*, not buffer offsets. Which segment an address
// belongs to is a bitmask test, not a top-byte compare, and system is tested first:
//
//   (pos & 0x50000000) === 0x50000000  -> system,   offset = pos & ~0x50000000
//   (pos & 0x60000000) === 0x60000000  -> graphics, offset = pos & ~0x60000000
//
// Order matters. 0x60000000 & 0x50000000 is 0x40000000, so a graphics address fails
// the system test and falls through correctly; reversing the two would misroute every
// system read.

import { GRAPHICS_BASE, type Rsc7Resource, SYSTEM_BASE } from "./rsc7";

export class ResourceReadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ResourceReadError";
	}
}

/** Which segment a virtual address resolves to. */
export type Segment = "system" | "graphics";

export class ResourceReader {
	readonly system: DataView;
	readonly graphics: DataView;
	/** Current virtual address. Starts at the system base, as CodeWalker does. */
	position = SYSTEM_BASE;

	constructor(resource: Rsc7Resource) {
		this.system = new DataView(
			resource.system.buffer,
			resource.system.byteOffset,
			resource.system.byteLength,
		);
		this.graphics = new DataView(
			resource.graphics.buffer,
			resource.graphics.byteOffset,
			resource.graphics.byteLength,
		);
	}

	/** Resolve a virtual address to its segment and byte offset within it. */
	resolve(address: number): { view: DataView; offset: number; segment: Segment } {
		// Addresses stay well inside 2^32 in practice, but the masks below are only
		// meaningful on a uint32, so normalise first.
		const pos = address >>> 0;
		if ((pos & SYSTEM_BASE) === SYSTEM_BASE) {
			return { view: this.system, offset: pos & ~SYSTEM_BASE, segment: "system" };
		}
		if ((pos & GRAPHICS_BASE) === GRAPHICS_BASE) {
			return { view: this.graphics, offset: pos & ~GRAPHICS_BASE, segment: "graphics" };
		}
		throw new ResourceReadError(`illegal virtual address 0x${pos.toString(16).padStart(8, "0")}`);
	}

	private at(address: number, size: number): { view: DataView; offset: number } {
		const { view, offset, segment } = this.resolve(address);
		if (offset + size > view.byteLength) {
			throw new ResourceReadError(
				`read of ${size} bytes at ${segment}+0x${offset.toString(16)} runs past the ` +
					`${segment} segment (${view.byteLength} bytes)`,
			);
		}
		return { view, offset };
	}

	seek(address: number): this {
		this.position = address;
		return this;
	}

	// --- absolute reads (do not move `position`) ---

	byteAt(address: number): number {
		const { view, offset } = this.at(address, 1);
		return view.getUint8(offset);
	}
	uint16At(address: number): number {
		const { view, offset } = this.at(address, 2);
		return view.getUint16(offset, true);
	}
	int16At(address: number): number {
		const { view, offset } = this.at(address, 2);
		return view.getInt16(offset, true);
	}
	uint32At(address: number): number {
		const { view, offset } = this.at(address, 4);
		return view.getUint32(offset, true);
	}
	int32At(address: number): number {
		const { view, offset } = this.at(address, 4);
		return view.getInt32(offset, true);
	}
	float32At(address: number): number {
		const { view, offset } = this.at(address, 4);
		return view.getFloat32(offset, true);
	}

	/**
	 * Read a 64-bit value as a JS number.
	 *
	 * Resource pointers are virtual addresses well under 2^53, so this is lossless
	 * for every pointer in a real file. It throws rather than silently rounding if
	 * that ever stops being true.
	 */
	uint64At(address: number): number {
		const { view, offset } = this.at(address, 8);
		const value = view.getBigUint64(offset, true);
		if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new ResourceReadError(`64-bit value 0x${value.toString(16)} exceeds Number.MAX_SAFE_INTEGER`);
		}
		return Number(value);
	}

	bytesAt(address: number, length: number): Uint8Array {
		const { view, offset } = this.at(address, length);
		return new Uint8Array(view.buffer, view.byteOffset + offset, length);
	}

	// --- sequential reads (advance `position`) ---

	byte(): number {
		const v = this.byteAt(this.position);
		this.position += 1;
		return v;
	}
	uint16(): number {
		const v = this.uint16At(this.position);
		this.position += 2;
		return v;
	}
	int16(): number {
		const v = this.int16At(this.position);
		this.position += 2;
		return v;
	}
	uint32(): number {
		const v = this.uint32At(this.position);
		this.position += 4;
		return v;
	}
	int32(): number {
		const v = this.int32At(this.position);
		this.position += 4;
		return v;
	}
	float32(): number {
		const v = this.float32At(this.position);
		this.position += 4;
		return v;
	}
	uint64(): number {
		const v = this.uint64At(this.position);
		this.position += 8;
		return v;
	}
	/** A pointer field. Zero means null and is returned as 0. */
	pointer(): number {
		return this.uint64();
	}
	skip(bytes: number): this {
		this.position += bytes;
		return this;
	}

	/** Read `count` floats starting at the current position. */
	float32Array(count: number): Float32Array {
		const out = new Float32Array(count);
		for (let i = 0; i < count; i++) out[i] = this.float32();
		return out;
	}

	/** NUL-terminated string at an absolute address. `null` for a null pointer. */
	stringAt(address: number, maxLength = 1024): string | null {
		if (!address) return null;
		const { view, offset, segment } = this.resolve(address);
		let end = offset;
		const limit = Math.min(view.byteLength, offset + maxLength);
		while (end < limit && view.getUint8(end) !== 0) end++;
		if (end === limit && end < view.byteLength) {
			throw new ResourceReadError(`unterminated string at ${segment}+0x${offset.toString(16)}`);
		}
		let s = "";
		for (let i = offset; i < end; i++) s += String.fromCharCode(view.getUint8(i));
		return s;
	}

	/**
	 * Read a block at an absolute address without disturbing the current position.
	 * Returns `null` for a null pointer so callers can treat optional blocks uniformly.
	 */
	atPointer<T>(address: number, read: (reader: ResourceReader) => T): T | null {
		if (!address) return null;
		const saved = this.position;
		try {
			this.position = address;
			return read(this);
		} finally {
			this.position = saved;
		}
	}

	/**
	 * A `ResourceSimpleArray`-style inline array: `count` fixed-size items laid out
	 * contiguously from `address`.
	 */
	simpleArray<T>(address: number, count: number, read: (reader: ResourceReader) => T): T[] {
		if (!address || count <= 0) return [];
		const saved = this.position;
		try {
			this.position = address;
			const out: T[] = new Array(count);
			for (let i = 0; i < count; i++) out[i] = read(this);
			return out;
		} finally {
			this.position = saved;
		}
	}

	/**
	 * A `ResourcePointerArray64`-style array: `count` 64-bit pointers at `address`,
	 * each to an item. Null entries are preserved so indices stay aligned with the
	 * file - several formats index these arrays positionally.
	 */
	pointerArray<T>(address: number, count: number, read: (reader: ResourceReader) => T): (T | null)[] {
		if (!address || count <= 0) return [];
		const pointers: number[] = [];
		const saved = this.position;
		try {
			this.position = address;
			for (let i = 0; i < count; i++) pointers.push(this.pointer());
		} finally {
			this.position = saved;
		}
		return pointers.map((p) => this.atPointer(p, read));
	}
}
