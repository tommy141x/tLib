// Ped skeleton -> THREE.Bone hierarchy, in rest pose.
//
// The JSON this consumes is Rockstar-derived and is NEVER committed to this repo
// (see shared/ts/rage/README.md "Regenerating the ped skeletons"). Nothing here
// embeds a skeleton: the caller loads the file and passes the parsed object in.
//
// The one gotcha that matters: animation tracks address bones by *tag* (a joaat of
// the bone name), not by index. `byTag` is the lookup every consumer should use;
// `byIndex` exists only for walking the hierarchy.

import * as THREE from "three";

export interface SkeletonBoneJson {
  /** joaat of the bone name. This is what animation tracks reference. */
  tag: number;
  name: string;
  index: number;
  /** -1 for a root bone. */
  parentIndex: number;
  /** Local rest translation, in GTA space (Z-up), metres. */
  translation: [number, number, number];
  /** Local rest rotation as [x, y, z, w]. */
  rotation: [number, number, number, number];
  scale: [number, number, number];
  flags?: string;
}

export interface SkeletonJson {
  file?: string;
  version?: number;
  generation?: string;
  boneCount: number;
  bones: SkeletonBoneJson[];
}

/** A bone's local rest transform, kept so a pose can be reset without re-parsing. */
export interface RestTransform {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

export interface ViewerSkeleton {
  /** Bones in file order. Index i is the bone whose `index` field is i. */
  bones: THREE.Bone[];
  /** Bones with no parent. Normally exactly one (SKEL_ROOT). */
  roots: THREE.Bone[];
  /** tag -> bone. The lookup animation tracks need. */
  byTag: Map<number, THREE.Bone>;
  /** original GTA bone name -> bone. */
  byName: Map<string, THREE.Bone>;
  /** file index -> bone. */
  byIndex: Map<number, THREE.Bone>;
  /** Bone tag in file order, parallel to `bones`. */
  tags: number[];
  /**
   * The node name each bone was given, parallel to `bones`. Equal to the GTA name
   * unless it had to be disambiguated; AnimationClip track names are built from these.
   */
  nodeNames: string[];
  restPose: RestTransform[];
  /** THREE.Skeleton over the same bones, for callers that later bind a SkinnedMesh. */
  skeleton: THREE.Skeleton;
  /** Non-fatal problems: duplicate tags, missing parents, renamed nodes. */
  warnings: string[];
  /** Restore every bone to its rest transform. */
  resetToRest(): void;
  /** Bone carrying `tag`, or undefined. */
  boneByTag(tag: number): THREE.Bone | undefined;
  /** Dispose the THREE.Skeleton. The bones themselves hold no GPU resources. */
  dispose(): void;
}

export class SkeletonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkeletonParseError";
  }
}

function isFiniteNumberArray(value: unknown, length: number): boolean {
  return (
    Array.isArray(value) &&
    value.length >= length &&
    value.slice(0, length).every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/**
 * Validate an unknown value (a `JSON.parse` result) as a skeleton.
 *
 * Throws rather than coercing: a half-read skeleton produces a pose that looks
 * plausible and is wrong, which is much harder to diagnose than a thrown error.
 */
export function parseSkeletonJson(value: unknown): SkeletonJson {
  if (typeof value !== "object" || value === null) {
    throw new SkeletonParseError("skeleton JSON is not an object");
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.bones)) {
    throw new SkeletonParseError("skeleton JSON has no `bones` array");
  }
  if (raw.bones.length === 0) {
    throw new SkeletonParseError("skeleton JSON has zero bones");
  }

  const bones: SkeletonBoneJson[] = raw.bones.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new SkeletonParseError(`bones[${i}] is not an object`);
    }
    const b = entry as Record<string, unknown>;
    if (typeof b.tag !== "number" || !Number.isFinite(b.tag)) {
      throw new SkeletonParseError(`bones[${i}].tag is not a number`);
    }
    if (typeof b.name !== "string") {
      throw new SkeletonParseError(`bones[${i}].name is not a string`);
    }
    if (typeof b.index !== "number" || typeof b.parentIndex !== "number") {
      throw new SkeletonParseError(`bones[${i}] is missing index/parentIndex`);
    }
    if (!isFiniteNumberArray(b.translation, 3)) {
      throw new SkeletonParseError(`bones[${i}].translation is not 3 finite numbers`);
    }
    if (!isFiniteNumberArray(b.rotation, 4)) {
      throw new SkeletonParseError(`bones[${i}].rotation is not 4 finite numbers`);
    }
    const scale = isFiniteNumberArray(b.scale, 3) ? (b.scale as number[]) : [1, 1, 1];
    const t = b.translation as number[];
    const r = b.rotation as number[];
    return {
      tag: b.tag,
      name: b.name,
      index: b.index,
      parentIndex: b.parentIndex,
      translation: [t[0], t[1], t[2]],
      rotation: [r[0], r[1], r[2], r[3]],
      scale: [scale[0], scale[1], scale[2]],
      flags: typeof b.flags === "string" ? b.flags : undefined,
    };
  });

  const boneCount = typeof raw.boneCount === "number" ? raw.boneCount : bones.length;
  return {
    file: typeof raw.file === "string" ? raw.file : undefined,
    version: typeof raw.version === "number" ? raw.version : undefined,
    generation: typeof raw.generation === "string" ? raw.generation : undefined,
    boneCount,
    bones,
  };
}

/**
 * Build the THREE.Bone hierarchy in rest pose.
 *
 * Bone local transforms are used verbatim: they are GTA-space (Z-up) and stay that
 * way. Converting to three's Y-up is the job of the single wrapper group in
 * AnimViewerScene, so that every bone-local quantity - including a prop's attach
 * offset - is the same number here as it is in the game.
 */
export function buildSkeleton(input: SkeletonJson | unknown): ViewerSkeleton {
  // Always revalidate, even for an already-typed SkeletonJson: the cost is ~128
  // objects and it is the only thing standing between a truncated file and a pose
  // that renders without complaint.
  const json = parseSkeletonJson(input);
  const warnings: string[] = [];

  if (json.boneCount !== json.bones.length) {
    warnings.push(`boneCount is ${json.boneCount} but ${json.bones.length} bones are present`);
  }

  const bones: THREE.Bone[] = [];
  const byTag = new Map<number, THREE.Bone>();
  const byName = new Map<string, THREE.Bone>();
  const byIndex = new Map<number, THREE.Bone>();
  const tags: number[] = [];
  const nodeNames: string[] = [];
  const restPose: RestTransform[] = [];
  const usedNodeNames = new Set<string>();

  for (const def of json.bones) {
    const bone = new THREE.Bone();

    // Unique node names matter: AnimationClip tracks are resolved by name against
    // the object graph, so two bones sharing one name would silently drive the
    // wrong joint.
    let nodeName = def.name || `bone_${def.index}`;
    if (usedNodeNames.has(nodeName)) {
      const unique = `${nodeName}__${def.index}`;
      warnings.push(`bone name "${nodeName}" is duplicated; node renamed to "${unique}"`);
      nodeName = unique;
    }
    usedNodeNames.add(nodeName);
    bone.name = nodeName;

    bone.position.set(def.translation[0], def.translation[1], def.translation[2]);
    bone.quaternion.set(def.rotation[0], def.rotation[1], def.rotation[2], def.rotation[3]);
    bone.scale.set(def.scale[0], def.scale[1], def.scale[2]);
    bone.userData.boneTag = def.tag;
    bone.userData.boneIndex = def.index;
    bone.userData.gtaName = def.name;
    bone.userData.flags = def.flags;

    if (byTag.has(def.tag)) {
      warnings.push(
        `bone tag ${def.tag} is used by both "${byTag.get(def.tag)?.userData.gtaName}" and ` +
          `"${def.name}"; the first wins`
      );
    } else {
      byTag.set(def.tag, bone);
    }
    if (!byName.has(def.name)) byName.set(def.name, bone);
    byIndex.set(def.index, bone);

    bones.push(bone);
    tags.push(def.tag);
    nodeNames.push(nodeName);
    restPose.push({
      position: bone.position.clone(),
      quaternion: bone.quaternion.clone(),
      scale: bone.scale.clone(),
    });
  }

  const roots: THREE.Bone[] = [];
  json.bones.forEach((def, i) => {
    const bone = bones[i];
    if (def.parentIndex < 0) {
      roots.push(bone);
      return;
    }
    const parent = byIndex.get(def.parentIndex);
    if (!parent) {
      warnings.push(`bone "${def.name}" names parent index ${def.parentIndex}, which is absent`);
      roots.push(bone);
      return;
    }
    if (parent === bone) {
      warnings.push(`bone "${def.name}" is its own parent; treated as a root`);
      roots.push(bone);
      return;
    }
    parent.add(bone);
  });

  if (roots.length === 0) {
    throw new SkeletonParseError("skeleton has no root bone - the hierarchy is cyclic");
  }
  if (roots.length > 1) {
    warnings.push(`skeleton has ${roots.length} root bones; expected 1`);
  }

  for (const root of roots) root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);

  return {
    bones,
    roots,
    byTag,
    byName,
    byIndex,
    tags,
    nodeNames,
    restPose,
    skeleton,
    warnings,
    resetToRest() {
      bones.forEach((bone, i) => {
        const rest = restPose[i];
        bone.position.copy(rest.position);
        bone.quaternion.copy(rest.quaternion);
        bone.scale.copy(rest.scale);
      });
      for (const root of roots) root.updateMatrixWorld(true);
    },
    boneByTag(tag: number) {
      return byTag.get(tag);
    },
    dispose() {
      skeleton.dispose();
    },
  };
}
