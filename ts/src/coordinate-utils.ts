// FiveM is Z-up, Three.js is Y-up
// FiveM (x,y,z) → Three (x,z,-y) and back (x,-z,y)

import * as THREE from "three";

export function fivemToThreePos(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, z, -y);
}

export function threeToFivemPos(v: THREE.Vector3): { x: number; y: number; z: number } {
  return { x: v.x, y: -v.z, z: v.y };
}

// lookAt is easier than converting rotations and it just works
export function applyCameraSync(
  camera: THREE.PerspectiveCamera,
  position: { x: number; y: number; z: number },
  focus: { x: number; y: number; z: number }
): void {
  camera.position.set(position.x, position.z, -position.y);
  camera.lookAt(focus.x, focus.z, -focus.y);
}
