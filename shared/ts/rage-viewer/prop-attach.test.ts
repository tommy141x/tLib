import { expect, test } from "bun:test";
import * as THREE from "three";
import {
  createPlacementRecord,
  DEFAULT_PROP_BONE_TAG,
  fivemEulerToQuaternion,
  formatPlacementLua,
  normalisePlacementRecord,
  type Placement6,
  placementToTransform,
  PropAttachment,
  quaternionToFivemEuler,
  PH_R_HAND_TAG,
  SKEL_R_HAND_TAG,
  transformToPlacement,
} from "./prop-attach";
import { buildSkeleton, type SkeletonJson } from "./skeleton";

const SKEL: SkeletonJson = {
  boneCount: 2,
  bones: [
    {
      tag: 0,
      name: "SKEL_ROOT",
      index: 0,
      parentIndex: -1,
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    {
      tag: PH_R_HAND_TAG,
      name: "PH_R_Hand",
      index: 1,
      parentIndex: 0,
      translation: [0.2, 0, 1.3],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
  ],
};

/** Non-null assert with a real failure message instead of a `!`. */
function req<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${what}`);
  return value;
}

test("the default prop bone is PH_R_Hand (28422), matching the Lua default", () => {
  // Measured, not assumed: 28422 is PH_R_Hand in both freemode skeletons, and
  // SKEL_R_Hand is 57005. Snippets that call 28422 "SKEL_R_Hand" are wrong.
  expect(PH_R_HAND_TAG).toBe(28422);
  expect(DEFAULT_PROP_BONE_TAG).toBe(PH_R_HAND_TAG);
  expect(SKEL_R_HAND_TAG).toBe(57005);
  const record = createPlacementRecord("prop_cs_hand_radio");
  expect(record).toEqual({
    model: "prop_cs_hand_radio",
    bone: 28422,
    placement: [0, 0, 0, 0, 0, 0],
  });
});

test("createPlacementRecord zero-fills short placements the way Lua does", () => {
  expect(createPlacementRecord("m", 1, [0.13, 0.05]).placement).toEqual([0.13, 0.05, 0, 0, 0, 0]);
});

test("normalisePlacementRecord mirrors the Lua reader's coercions", () => {
  // tonumber(x) or 0 on every slot; tonumber(prop.bone) or the default.
  expect(
    normalisePlacementRecord({ model: "m", placement: [0.1, null, "0.3", {}, undefined, -60] })
  ).toEqual({ model: "m", bone: 28422, placement: [0.1, 0, 0.3, 0, 0, -60] });
  expect(normalisePlacementRecord({ model: "m", bone: "12345" }).bone).toBe(12345);
  expect(normalisePlacementRecord({ model: "m", bone: "not-a-number" }).bone).toBe(28422);
  expect(normalisePlacementRecord({ model: "m", placement: "nope" }).placement).toEqual([
    0, 0, 0, 0, 0, 0,
  ]);
});

test("normalisePlacementRecord rejects exactly what Lua rejects", () => {
  expect(() => normalisePlacementRecord({ model: "" })).toThrow(/non-empty/);
  expect(() => normalisePlacementRecord({ model: 5 })).toThrow(/non-empty/);
  expect(() => normalisePlacementRecord(null)).toThrow(/not an object/);
});

test("euler degrees round-trip through the quaternion", () => {
  const cases: [number, number, number][] = [
    [0, 0, 0],
    [-113, 0, -60],
    [12.5, -33.25, 170],
    [-45, 60, -90],
    [180, 0, 0],
  ];
  for (const [rx, ry, rz] of cases) {
    const q = fivemEulerToQuaternion(rx, ry, rz);
    const back = quaternionToFivemEuler(q);
    // Compare orientations, not angle triples: an equivalent triple is not a bug.
    const q2 = fivemEulerToQuaternion(back[0], back[1], back[2]);
    expect(Math.abs(q.dot(q2))).toBeCloseTo(1, 10);
  }
});

test("the euler convention is Rz * Ry * Rx in GTA axes", () => {
  // Asserted against a hand-composed matrix so the convention cannot drift silently.
  const rx = 30;
  const ry = -20;
  const rz = 75;
  const d = Math.PI / 180;
  const expected = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 0, 1), rz * d)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry * d))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), rx * d));
  expect(Math.abs(fivemEulerToQuaternion(rx, ry, rz).dot(expected))).toBeCloseTo(1, 12);
});

test("the euler convention agrees with GizmoScene's prop gizmo across the Z-up frame", () => {
  // GizmoScene expresses the same rotation in three's Y-up axes as
  // Euler(rx, rz, -ry, "YZX"). Conjugating ours by the -90 deg X frame change must
  // give exactly that, or the viewer and the existing editor would disagree.
  const rx = 22;
  const ry = -14;
  const rz = 130;
  const d = Math.PI / 180;
  const zUp = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const ours = fivemEulerToQuaternion(rx, ry, rz);
  const conjugated = zUp.clone().multiply(ours).multiply(zUp.clone().invert());
  const gizmo = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(rx * d, rz * d, -ry * d, "YZX")
  );
  expect(Math.abs(conjugated.dot(gizmo))).toBeCloseTo(1, 12);
});

test("placement <-> transform round-trips exactly", () => {
  const placement: Placement6 = [0.13, 0.05, 0.01, -113, 0, -60];
  const { position, quaternion } = placementToTransform(placement);
  expect(position.toArray()).toEqual([0.13, 0.05, 0.01]);
  const back = transformToPlacement(position, quaternion, 4);
  expect(back[0]).toBeCloseTo(0.13, 6);
  expect(back[1]).toBeCloseTo(0.05, 6);
  expect(back[2]).toBeCloseTo(0.01, 6);
  expect(back[3]).toBeCloseTo(-113, 3);
  expect(back[4]).toBeCloseTo(0, 3);
  expect(back[5]).toBeCloseTo(-60, 3);
});

test("transformToPlacement rounds and never emits -0", () => {
  const p = transformToPlacement(new THREE.Vector3(-1e-12, 1.23456789, 0), new THREE.Quaternion(), 4);
  expect(Object.is(p[0], -0)).toBe(false);
  expect(p[0]).toBe(0);
  expect(p[1]).toBe(1.2346);
});

test("PropAttachment's local transform IS the placement", () => {
  const skel = buildSkeleton(SKEL);
  const prop = new PropAttachment("prop_cs_hand_radio");
  prop.attachToBone(req(skel.byTag.get(PH_R_HAND_TAG), "PH_R_Hand"));
  prop.setPlacement([0.13, 0.05, 0.01, -113, 0, -60]);

  expect(prop.root.parent?.name).toBe("PH_R_Hand");
  expect(prop.root.position.toArray()).toEqual([0.13, 0.05, 0.01]);

  const record = prop.getRecord(4);
  expect(record.model).toBe("prop_cs_hand_radio");
  expect(record.bone).toBe(28422);
  expect(record.placement[0]).toBe(0.13);
  expect(record.placement[3]).toBeCloseTo(-113, 3);
  expect(record.placement[5]).toBeCloseTo(-60, 3);
});

test("attachToBone adopts the bone's tag from userData", () => {
  const skel = buildSkeleton(SKEL);
  const prop = new PropAttachment("m", 1);
  prop.attachToBone(req(skel.byTag.get(PH_R_HAND_TAG), "PH_R_Hand"));
  expect(prop.boneTag).toBe(PH_R_HAND_TAG);
});

test("a dragged transform reads back as a game-ready record with no conversion", () => {
  // TransformControls writes an object's transform in PARENT space, which here is
  // bone-local GTA space. This simulates that write.
  const skel = buildSkeleton(SKEL);
  const prop = new PropAttachment("prop_cs_hand_radio");
  prop.attachToBone(req(skel.byTag.get(PH_R_HAND_TAG), "PH_R_Hand"));
  prop.root.position.set(0.02, -0.04, 0.11);
  prop.root.quaternion.copy(fivemEulerToQuaternion(10, 20, 30));

  const record = prop.getRecord(4);
  expect(record.placement.slice(0, 3)).toEqual([0.02, -0.04, 0.11]);
  expect(record.placement[3]).toBeCloseTo(10, 3);
  expect(record.placement[4]).toBeCloseTo(20, 3);
  expect(record.placement[5]).toBeCloseTo(30, 3);
});

test("applyRecord round-trips a record through the node and back", () => {
  const prop = new PropAttachment();
  const source = { model: "prop_cs_hand_radio", bone: 12345, placement: [0.1, 0.2, 0.3, 45, -30, 90] };
  prop.applyRecord(source);
  expect(prop.model).toBe("prop_cs_hand_radio");
  expect(prop.boneTag).toBe(12345);
  const back = prop.getRecord(4);
  expect(back.model).toBe(source.model);
  expect(back.bone).toBe(source.bone);
  for (let i = 0; i < back.placement.length; i++) {
    expect(back.placement[i]).toBeCloseTo(source.placement[i], 3);
  }
});

test("a bounds-only source renders a correctly sized box at the model's offset", () => {
  const prop = new PropAttachment("m");
  prop.setSource({ bounds: { min: [-0.03, -0.02, 0], max: [0.03, 0.02, 0.18] } });

  const box = prop.root.getObjectByName("PropBoundsBox") as THREE.LineSegments;
  expect(box).toBeDefined();
  prop.root.updateMatrixWorld(true);
  const bbox = new THREE.Box3().setFromObject(box);
  expect(bbox.min.toArray()[0]).toBeCloseTo(-0.03, 6);
  expect(bbox.max.toArray()[2]).toBeCloseTo(0.18, 6);
  // The AABB is NOT centred on the origin: the attach offset is measured from the
  // model origin, so the box must sit where the model does.
  expect(bbox.getCenter(new THREE.Vector3()).z).toBeCloseTo(0.09, 6);
});

test("an object3D source replaces the box and is never disposed by us", () => {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const drawable = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  drawable.name = "Drawable";
  const prop = new PropAttachment("m");
  prop.setSource({ bounds: { min: [0, 0, 0], max: [1, 1, 1] }, object3D: drawable });

  expect(prop.root.getObjectByName("Drawable")).toBe(drawable);
  expect(prop.root.getObjectByName("PropBoundsBox")).toBeUndefined();

  prop.dispose();
  // A caller-owned drawable outliving the attachment is the contract the .ydr
  // renderer will rely on.
  expect(geometry.attributes.position).toBeDefined();
});

test("showBoundsWithObject keeps the box alongside the drawable", () => {
  const drawable = new THREE.Object3D();
  const prop = new PropAttachment("m", PH_R_HAND_TAG, { showBoundsWithObject: true });
  prop.setSource({ bounds: { min: [0, 0, 0], max: [1, 1, 1] }, object3D: drawable });
  expect(prop.root.getObjectByName("PropBoundsBox")).toBeDefined();
});

test("setSource(null) clears everything", () => {
  const prop = new PropAttachment("m");
  prop.setSource({ bounds: { min: [0, 0, 0], max: [1, 1, 1] } });
  prop.setSource(null);
  expect(prop.root.getObjectByName("PropBoundsBox")).toBeUndefined();
  expect(prop.getSource()).toBeNull();
});

test("formatPlacementLua emits the shape cl_props.lua documents", () => {
  const lua = formatPlacementLua(
    createPlacementRecord("prop_cs_hand_radio", 28422, [0.13, 0.05, 0.01, -113, 0, -60])
  );
  expect(lua).toBe(
    '{ model = "prop_cs_hand_radio", bone = 28422,\n' +
      "  placement = { 0.13, 0.05, 0.01, -113.00, 0.00, -60.00 } }"
  );
});
