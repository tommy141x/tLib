/**
 * Vehicle matrix math shared between gizmo consumers.
 * Pure functions — no scene state, no Three.js scene graph dependency.
 */

import * as THREE from "three";
import type { Vec3, VehicleMatrix } from "./types";

/**
 * Build a Three.js quaternion from a FiveM vehicle matrix.
 * Maps vehicle right/up/back to Three.js X/Y/Z columns.
 */
export function buildVehicleQuat(matrix: VehicleMatrix): THREE.Quaternion {
	const threeRight = new THREE.Vector3(matrix.right.x, matrix.right.z, -matrix.right.y).normalize();
	const threeUp = new THREE.Vector3(matrix.up.x, matrix.up.z, -matrix.up.y).normalize();
	const threeFwd = new THREE.Vector3(matrix.fwd.x, matrix.fwd.z, -matrix.fwd.y);
	const threeBack = threeFwd.negate().normalize();

	const rotMatrix = new THREE.Matrix4();
	rotMatrix.makeBasis(threeRight, threeUp, threeBack);
	return new THREE.Quaternion().setFromRotationMatrix(rotMatrix);
}

/** FiveM world position → vehicle-local offset */
export function fivemWorldToLocal(matrix: VehicleMatrix, wx: number, wy: number, wz: number): Vec3 {
	const dx = wx - matrix.pos.x;
	const dy = wy - matrix.pos.y;
	const dz = wz - matrix.pos.z;
	return {
		x: dx * matrix.right.x + dy * matrix.right.y + dz * matrix.right.z,
		y: dx * matrix.fwd.x + dy * matrix.fwd.y + dz * matrix.fwd.z,
		z: dx * matrix.up.x + dy * matrix.up.y + dz * matrix.up.z,
	};
}

/** Vehicle-local offset → FiveM world position */
export function fivemLocalToWorld(matrix: VehicleMatrix, lx: number, ly: number, lz: number): Vec3 {
	return {
		x: matrix.pos.x + matrix.right.x * lx + matrix.fwd.x * ly + matrix.up.x * lz,
		y: matrix.pos.y + matrix.right.y * lx + matrix.fwd.y * ly + matrix.up.y * lz,
		z: matrix.pos.z + matrix.right.z * lx + matrix.fwd.z * ly + matrix.up.z * lz,
	};
}
