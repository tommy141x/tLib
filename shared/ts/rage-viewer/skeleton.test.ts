import { expect, test } from "bun:test";
import * as THREE from "three";
import {
  buildSkeleton,
  parseSkeletonJson,
  type SkeletonBoneJson,
  type SkeletonJson,
  SkeletonParseError,
} from "./skeleton";

function bone(partial: Partial<SkeletonBoneJson> & { index: number }): SkeletonBoneJson {
  return {
    tag: partial.tag ?? partial.index,
    name: partial.name ?? `BONE_${partial.index}`,
    index: partial.index,
    parentIndex: partial.parentIndex ?? -1,
    translation: partial.translation ?? [0, 0, 0],
    rotation: partial.rotation ?? [0, 0, 0, 1],
    scale: partial.scale ?? [1, 1, 1],
  };
}

// A three-bone chain with a deliberately non-monotonic tag order, so that a
// tag-as-index bug cannot pass.
function chain(): SkeletonJson {
  return {
    boneCount: 3,
    bones: [
      bone({ index: 0, tag: 0, name: "SKEL_ROOT" }),
      bone({ index: 1, tag: 11816, name: "SKEL_Pelvis", parentIndex: 0, translation: [0, 0, 1] }),
      bone({ index: 2, tag: 28422, name: "PH_R_Hand", parentIndex: 1, translation: [0.2, 0, 0] }),
    ],
  };
}

test("parseSkeletonJson rejects malformed input instead of coercing", () => {
  expect(() => parseSkeletonJson(null)).toThrow(SkeletonParseError);
  expect(() => parseSkeletonJson({})).toThrow(/no `bones` array/);
  expect(() => parseSkeletonJson({ bones: [] })).toThrow(/zero bones/);
  expect(() => parseSkeletonJson({ bones: [{ tag: 1, name: "a", index: 0 }] })).toThrow(
    /index\/parentIndex/
  );
  expect(() =>
    parseSkeletonJson({
      bones: [{ tag: 1, name: "a", index: 0, parentIndex: -1, translation: [0, 0], rotation: [] }],
    })
  ).toThrow(/translation/);
  expect(() =>
    parseSkeletonJson({
      bones: [
        {
          tag: 1,
          name: "a",
          index: 0,
          parentIndex: -1,
          translation: [0, 0, 0],
          rotation: [0, 0, 0],
        },
      ],
    })
  ).toThrow(/rotation/);
});

test("parseSkeletonJson defaults a missing scale to unit", () => {
  const json = parseSkeletonJson({
    bones: [
      {
        tag: 1,
        name: "a",
        index: 0,
        parentIndex: -1,
        translation: [1, 2, 3],
        rotation: [0, 0, 0, 1],
      },
    ],
  });
  expect(json.bones[0].scale).toEqual([1, 1, 1]);
  expect(json.boneCount).toBe(1);
});

test("buildSkeleton wires the hierarchy and indexes by tag", () => {
  const skel = buildSkeleton(chain());
  expect(skel.bones).toHaveLength(3);
  expect(skel.roots).toHaveLength(1);
  expect(skel.roots[0].name).toBe("SKEL_ROOT");
  expect(skel.warnings).toEqual([]);

  const hand = skel.byTag.get(28422);
  expect(hand).toBeDefined();
  expect(hand?.name).toBe("PH_R_Hand");
  expect(hand?.parent?.name).toBe("SKEL_Pelvis");
  expect(skel.boneByTag(11816)?.name).toBe("SKEL_Pelvis");
  // The bug this guards: tag 28422 is not index 28422, and index 2 is not tag 2.
  expect(skel.byIndex.get(2)).toBe(hand as THREE.Bone);
  expect(skel.byTag.get(2)).toBeUndefined();
  expect(skel.tags).toEqual([0, 11816, 28422]);
});

test("buildSkeleton composes world transforms down the chain", () => {
  const skel = buildSkeleton(chain());
  skel.roots[0].updateMatrixWorld(true);
  const hand = skel.byTag.get(28422) as THREE.Bone;
  const world = new THREE.Vector3().setFromMatrixPosition(hand.matrixWorld);
  // Pelvis is +1 on GTA Z, hand is +0.2 on GTA X, and bone locals stay GTA-space.
  expect(world.x).toBeCloseTo(0.2, 6);
  expect(world.y).toBeCloseTo(0, 6);
  expect(world.z).toBeCloseTo(1, 6);
});

test("resetToRest restores a posed skeleton", () => {
  const skel = buildSkeleton(chain());
  const hand = skel.byTag.get(28422) as THREE.Bone;
  hand.position.set(9, 9, 9);
  hand.quaternion.set(0.5, 0.5, 0.5, 0.5);
  skel.resetToRest();
  expect(hand.position.toArray()).toEqual([0.2, 0, 0]);
  expect(hand.quaternion.toArray()).toEqual([0, 0, 0, 1]);
});

test("a duplicate bone tag warns and keeps the first", () => {
  const json = chain();
  json.bones[2].tag = 11816;
  const skel = buildSkeleton(json);
  expect(skel.byTag.get(11816)?.name).toBe("SKEL_Pelvis");
  expect(skel.warnings.join(" ")).toMatch(/tag 11816 is used by both/);
});

test("a duplicate bone name is renamed so clip tracks stay unambiguous", () => {
  const json = chain();
  json.bones[2].name = "SKEL_Pelvis";
  const skel = buildSkeleton(json);
  expect(skel.nodeNames).toEqual(["SKEL_ROOT", "SKEL_Pelvis", "SKEL_Pelvis__2"]);
  expect(new Set(skel.nodeNames).size).toBe(3);
  expect(skel.warnings.join(" ")).toMatch(/duplicated/);
});

test("a missing parent is reported and the bone becomes a root", () => {
  const json = chain();
  json.bones[2].parentIndex = 77;
  const skel = buildSkeleton(json);
  expect(skel.roots).toHaveLength(2);
  expect(skel.warnings.join(" ")).toMatch(/parent index 77/);
});

test("boneCount disagreeing with the array is a warning, not a failure", () => {
  const json = chain();
  json.boneCount = 128;
  const skel = buildSkeleton(json);
  expect(skel.bones).toHaveLength(3);
  expect(skel.warnings.join(" ")).toMatch(/boneCount is 128 but 3/);
});
