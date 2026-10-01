// Authoring a bone-attached prop offset, in the exact record the game consumes.
//
// The target is tRadio's RadioCreateAnimProp (client/cl_props.lua), which takes:
//
//   { model = "prop_cs_hand_radio", bone = 28422,
//     placement = { x, y, z, rotX, rotY, rotZ } }
//
// and calls
//
//   AttachEntityToEntity(obj, ped, GetPedBoneIndex(ped, bone),
//                        x, y, z, rotX, rotY, rotZ, ...)
//
// so `bone` is a bone TAG (GetPedBoneIndex maps tag -> index), the offset is in the
// bone's LOCAL frame in metres, and the rotations are Euler degrees.
//
// Why this file needs no coordinate conversion: the viewer keeps every bone's local
// transform in GTA space (Z-up) and does the Y-up conversion once, in a wrapper
// group above the whole rig (see AnimViewerScene). A prop parented to a bone
// therefore has a local position and rotation that are numerically the same values
// the native wants. The preview and the game agree by construction rather than by a
// conversion that has to be kept in sync.
//
// EULER CONVENTION. The degrees are applied as R = Rz(rz) * Ry(ry) * Rx(rx) in GTA
// axes, i.e. X first then Y then Z. That is the same convention `GizmoScene`'s
// prop gizmo already uses (it expresses it as a three.js "YZX" Euler in Y-up axes,
// which is the identical rotation once the -90 deg X frame change is applied). It
// is asserted by the round-trip tests here, and it is the one thing in this module
// that has NOT been confirmed against a running game - see the module README.

import * as THREE from "three";

/**
 * The right-hand PROP bone - RadioCreateAnimProp's ANIM_PROP_DEFAULT_BONE.
 *
 * Measured against the generated ped skeletons (both freemode models): tag 28422 is
 * `PH_R_Hand`, a child of `SKEL_R_Hand`, which is tag **57005**. PH_* are the
 * dedicated prop-attach helper bones, so 28422 is the right default - but it is
 * routinely mislabelled "SKEL_R_Hand" in FiveM snippets, and attaching to 57005
 * instead puts the prop in the wrist rather than the grip.
 */
export const PH_R_HAND_TAG = 28422;

/** `SKEL_R_Hand` proper. Not the prop-attach bone; see {@link PH_R_HAND_TAG}. */
export const SKEL_R_HAND_TAG = 57005;

/** The bone a hand-held prop attaches to when a record does not name one. */
export const DEFAULT_PROP_BONE_TAG = PH_R_HAND_TAG;

/** [x, y, z, rotX, rotY, rotZ] - metres then degrees, as AttachEntityToEntity takes them. */
export type Placement6 = [number, number, number, number, number, number];

/** The record RadioCreateAnimProp consumes. Serialise this straight into Lua/JSON. */
export interface PropPlacementRecord {
  model: string;
  /** A bone TAG, not an index. */
  bone: number;
  placement: Placement6;
}

/**
 * A prop to preview.
 *
 * `object3D` is the seam for the .ydr drawable renderer, which is being written in
 * parallel. Until it exists, `bounds` alone gives a correctly-sized stand-in, and
 * when it lands nothing in this interface changes: the drawable loader produces an
 * Object3D whose origin is the model origin, sets it here, and the wireframe box is
 * swapped out. `bounds` stays required so a source is always previewable and so the
 * box can still be shown as a bounding overlay.
 */
export interface PropSource {
  /** Model-space AABB in GTA axes, metres, relative to the model origin. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /** The real drawable, if one has been loaded. Its origin must be the model origin. */
  object3D?: THREE.Object3D;
  /** Model name, used as the record's `model` when the attachment has none. */
  name?: string;
}

const DEG = Math.PI / 180;

/**
 * FiveM attach Euler degrees -> quaternion, in GTA axes.
 *
 * three's "ZYX" Euler order composes as Rz * Ry * Rx, which is the convention
 * documented at the top of this file.
 */
export function fivemEulerToQuaternion(
  rx: number,
  ry: number,
  rz: number,
  target = new THREE.Quaternion()
): THREE.Quaternion {
  return target.setFromEuler(new THREE.Euler(rx * DEG, ry * DEG, rz * DEG, "ZYX"));
}

/** Inverse of {@link fivemEulerToQuaternion}. Degrees, GTA axes. */
export function quaternionToFivemEuler(q: THREE.Quaternion): [number, number, number] {
  const e = new THREE.Euler().setFromQuaternion(q, "ZYX");
  return [e.x / DEG, e.y / DEG, e.z / DEG];
}

/** Build a placement record, filling in the defaults the Lua side would apply. */
export function createPlacementRecord(
  model: string,
  bone: number = DEFAULT_PROP_BONE_TAG,
  placement: Partial<Placement6> | number[] = []
): PropPlacementRecord {
  const p = placement as number[];
  return {
    model,
    bone,
    placement: [num(p[0]), num(p[1]), num(p[2]), num(p[3]), num(p[4]), num(p[5])],
  };
}

/**
 * Validate and normalise an unknown record.
 *
 * Mirrors the Lua reader's coercions exactly: a missing or non-numeric placement
 * slot becomes 0, and a missing/invalid bone becomes the right-hand default. It
 * throws only on the one thing Lua also rejects - a model that is not a non-empty
 * string - so that a record this function accepts is a record the game will accept.
 */
export function normalisePlacementRecord(value: unknown): PropPlacementRecord {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("placement record is not an object");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.model !== "string" || raw.model === "") {
    throw new TypeError("placement record needs a non-empty `model` string");
  }
  const boneRaw = typeof raw.bone === "string" ? Number(raw.bone) : raw.bone;
  const bone =
    typeof boneRaw === "number" && Number.isFinite(boneRaw) ? boneRaw : DEFAULT_PROP_BONE_TAG;
  const p = Array.isArray(raw.placement) ? (raw.placement as unknown[]) : [];
  return {
    model: raw.model,
    bone,
    placement: [num(p[0]), num(p[1]), num(p[2]), num(p[3]), num(p[4]), num(p[5])],
  };
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** Bone-local position + quaternion described by a placement, in GTA axes. */
export function placementToTransform(placement: Placement6): {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
} {
  return {
    position: new THREE.Vector3(placement[0], placement[1], placement[2]),
    quaternion: fivemEulerToQuaternion(placement[3], placement[4], placement[5]),
  };
}

/** Inverse of {@link placementToTransform}. */
export function transformToPlacement(
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
  precision = 6
): Placement6 {
  const [rx, ry, rz] = quaternionToFivemEuler(quaternion);
  const r = (n: number) => round(n, precision);
  return [r(position.x), r(position.y), r(position.z), r(rx), r(ry), r(rz)];
}

function round(n: number, precision: number): number {
  const f = 10 ** precision;
  // -0 reads badly in a config file and is not a different number.
  const v = Math.round(n * f) / f;
  return v === 0 ? 0 : v;
}

/** Lua table literal for the record, ready to paste into a config. */
export function formatPlacementLua(record: PropPlacementRecord, indent = ""): string {
  const p = record.placement.map((n) => n.toFixed(2)).join(", ");
  return (
    `${indent}{ model = ${JSON.stringify(record.model)}, bone = ${record.bone},\n` +
    `${indent}  placement = { ${p} } }`
  );
}

export interface PropAttachmentOptions {
  /** Colour of the stand-in wireframe box. */
  boxColor?: number;
  /** Also show the box when a real drawable is present. Default false. */
  showBoundsWithObject?: boolean;
}

/**
 * A prop parented to a skeleton bone, whose local transform IS the game placement.
 *
 * The node hierarchy is deliberately shallow:
 *
 *   <bone>  ->  root (position/quaternion = the placement)  ->  content
 *
 * so `root.position` and `root.quaternion` can be handed straight to
 * TransformControls: three writes a dragged object's transform back in parent
 * space, which here is bone-local GTA space, which is what the native takes.
 */
export class PropAttachment {
  /** Parent this to a bone. Its local transform is the placement. */
  readonly root = new THREE.Object3D();

  private content = new THREE.Group();
  private boxMesh: THREE.LineSegments | null = null;
  private boxGeometry: THREE.BufferGeometry | null = null;
  private boxMaterial: THREE.LineBasicMaterial | null = null;
  private drawable: THREE.Object3D | null = null;

  private source: PropSource | null = null;
  private options: Required<PropAttachmentOptions>;

  model: string;
  boneTag: number;

  constructor(
    model = "",
    boneTag: number = DEFAULT_PROP_BONE_TAG,
    options: PropAttachmentOptions = {}
  ) {
    this.model = model;
    this.boneTag = boneTag;
    this.options = {
      boxColor: options.boxColor ?? 0x00d0ff,
      showBoundsWithObject: options.showBoundsWithObject ?? false,
    };
    this.root.name = "PropAttachment";
    this.root.add(this.content);
  }

  /**
   * Set or replace what is rendered.
   *
   * Passing a source with only `bounds` renders a wireframe box of exactly that
   * size, positioned so the box sits where the model would relative to its origin.
   * Passing one with `object3D` renders that instead. The drawable renderer drops
   * in here and nowhere else.
   */
  setSource(source: PropSource | null): void {
    this.source = source;
    if (source?.name && !this.model) this.model = source.name;

    if (this.drawable) {
      this.content.remove(this.drawable);
      this.drawable = null;
    }
    this.disposeBox();

    if (!source) return;

    if (source.object3D) {
      this.drawable = source.object3D;
      this.content.add(this.drawable);
    }
    if (!source.object3D || this.options.showBoundsWithObject) {
      this.buildBox(source.bounds);
    }
  }

  getSource(): PropSource | null {
    return this.source;
  }

  private buildBox(bounds: PropSource["bounds"]): void {
    const sx = Math.max(bounds.max[0] - bounds.min[0], 1e-4);
    const sy = Math.max(bounds.max[1] - bounds.min[1], 1e-4);
    const sz = Math.max(bounds.max[2] - bounds.min[2], 1e-4);
    const box = new THREE.BoxGeometry(sx, sy, sz);
    // BoxGeometry is centred on its own origin; move it so the AABB sits where the
    // model's does relative to the model origin. Getting this wrong offsets every
    // authored placement by half the prop.
    box.translate(
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2
    );
    this.boxGeometry = new THREE.EdgesGeometry(box);
    box.dispose();
    this.boxMaterial = new THREE.LineBasicMaterial({ color: this.options.boxColor });
    this.boxMesh = new THREE.LineSegments(this.boxGeometry, this.boxMaterial);
    this.boxMesh.name = "PropBoundsBox";
    this.content.add(this.boxMesh);
  }

  private disposeBox(): void {
    if (this.boxMesh) this.content.remove(this.boxMesh);
    this.boxGeometry?.dispose();
    this.boxMaterial?.dispose();
    this.boxMesh = null;
    this.boxGeometry = null;
    this.boxMaterial = null;
  }

  /** Move the attachment onto a bone, keeping the placement. */
  attachToBone(bone: THREE.Object3D, boneTag?: number): void {
    if (typeof boneTag === "number") this.boneTag = boneTag;
    else if (typeof bone.userData.boneTag === "number") this.boneTag = bone.userData.boneTag;
    bone.add(this.root);
  }

  detach(): void {
    this.root.removeFromParent();
  }

  setPlacement(placement: Placement6): void {
    const { position, quaternion } = placementToTransform(placement);
    this.root.position.copy(position);
    this.root.quaternion.copy(quaternion);
  }

  /** The current placement, read back out of the node transform. */
  getPlacement(precision = 6): Placement6 {
    return transformToPlacement(this.root.position, this.root.quaternion, precision);
  }

  /** The full record, ready for the game. */
  getRecord(precision = 6): PropPlacementRecord {
    return { model: this.model, bone: this.boneTag, placement: this.getPlacement(precision) };
  }

  /** Apply a record wholesale, including its bone tag. */
  applyRecord(record: PropPlacementRecord | unknown): PropPlacementRecord {
    const normalised = normalisePlacementRecord(record);
    this.model = normalised.model;
    this.boneTag = normalised.bone;
    this.setPlacement(normalised.placement);
    return normalised;
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  /** Drops the wireframe box. A caller-supplied `object3D` is NOT disposed here. */
  dispose(): void {
    this.disposeBox();
    if (this.drawable) {
      this.content.remove(this.drawable);
      this.drawable = null;
    }
    this.root.removeFromParent();
  }
}
