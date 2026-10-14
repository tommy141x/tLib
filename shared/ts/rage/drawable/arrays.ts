// Bulk typed-array reads over a ResourceReader.
//
// `ResourceReader` exposes scalar accessors and `simpleArray`, which builds a JS array
// through a closure per element. A 65,535-entry index buffer does not want that, so
// these read straight out of the segment's DataView into a typed array. All reads are
// explicitly little-endian, so an unaligned virtual address is fine.

import type { ResourceReader } from "../reader";

export function uint16sAt(r: ResourceReader, address: number, count: number): Uint16Array {
  const out = new Uint16Array(count > 0 ? count : 0);
  if (!address || count <= 0) return out;
  const bytes = r.bytesAt(address, count * 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) out[i] = view.getUint16(i * 2, true);
  return out;
}

export function int16sAt(r: ResourceReader, address: number, count: number): Int16Array {
  const out = new Int16Array(count > 0 ? count : 0);
  if (!address || count <= 0) return out;
  const bytes = r.bytesAt(address, count * 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

export function uint32sAt(r: ResourceReader, address: number, count: number): Uint32Array {
  const out = new Uint32Array(count > 0 ? count : 0);
  if (!address || count <= 0) return out;
  const bytes = r.bytesAt(address, count * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) out[i] = view.getUint32(i * 4, true);
  return out;
}

export function float32sAt(r: ResourceReader, address: number, count: number): Float32Array {
  const out = new Float32Array(count > 0 ? count : 0);
  if (!address || count <= 0) return out;
  const bytes = r.bytesAt(address, count * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** 64-bit values as JS numbers. Every one of these is a virtual address in practice. */
export function uint64sAt(r: ResourceReader, address: number, count: number): number[] {
  if (!address || count <= 0) return [];
  const out: number[] = new Array(count);
  const bytes = r.bytesAt(address, count * 8);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) out[i] = Number(view.getBigUint64(i * 8, true));
  return out;
}

/** A 64-bit field read as a bigint, for values that genuinely exceed 2^53. */
export function bigUint64(r: ResourceReader): bigint {
  const lo = BigInt(r.uint32() >>> 0);
  const hi = BigInt(r.uint32() >>> 0);
  return (hi << 32n) | lo;
}

/** `count` floats from the current position. */
export function readFloats(r: ResourceReader, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = r.float32();
  return out;
}

/** A 3-component vector, as three consecutive floats. */
export function readVector3(r: ResourceReader): [number, number, number] {
  return [r.float32(), r.float32(), r.float32()];
}

/** A 4-component vector. */
export function readVector4(r: ResourceReader): [number, number, number, number] {
  return [r.float32(), r.float32(), r.float32(), r.float32()];
}
