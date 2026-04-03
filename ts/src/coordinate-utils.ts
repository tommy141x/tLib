/**
 * Coordinate conversion between FiveM and Three.js coordinate systems.
 *
 * FiveM:    Right-handed, Z-up.  X = right, Y = forward, Z = up
 * Three.js: Right-handed, Y-up.  X = right, Y = up, Z = backward
 *
 * Mapping: FiveM (x, y, z) -> Three.js (x, z, -y)
 *          Three.js (x, y, z) -> FiveM (x, -z, y)
 */

import * as THREE from "three";

/** Convert a FiveM world position to Three.js world position */
export function fivemToThreePos(x: number, y: number, z: number): THREE.Vector3 {
	return new THREE.Vector3(x, z, -y);
}

/** Convert a Three.js world position back to FiveM world position */
export function threeToFivemPos(v: THREE.Vector3): { x: number; y: number; z: number } {
	return { x: v.x, y: -v.z, z: v.y };
}

/**
 * Apply FiveM camera position + focus point to a Three.js camera.
 * Uses camera.lookAt() instead of rotation conversion - simple and correct.
 */
export function applyCameraSync(
	camera: THREE.PerspectiveCamera,
	position: { x: number; y: number; z: number },
	focus: { x: number; y: number; z: number },
): void {
	camera.position.set(position.x, position.z, -position.y);
	camera.lookAt(focus.x, focus.z, -focus.y);
}
