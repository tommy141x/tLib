// Three.js TransformControls on a transparent overlay.
// game objects are rendered by Lua, this just draws the gizmo handles.

import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { applyCameraSync, fivemToThreePos, threeToFivemPos } from "../coordinate-utils";
import type {
  EditorMode,
  GizmoItemData,
  GizmoSceneConfig,
  SpaceMode,
  Vec3,
  VehicleMatrix,
} from "./types";
import { buildVehicleQuat, fivemLocalToWorld, fivemWorldToLocal } from "./vehicle-math";

export class GizmoScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  transformControls: TransformControls;
  gizmoTarget: THREE.Mesh;

  private animationId: number | null = null;
  private selectedIdx = -1;
  private selectedIndices: number[] = [];
  private dragStartFivemPos: Vec3 | null = null;

  private matrix: VehicleMatrix = {
    fwd: { x: 0, y: 1, z: 0 },
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    pos: { x: 0, y: 0, z: 0 },
  };
  private vehicleQuat = new THREE.Quaternion();

  private features: Required<NonNullable<GizmoSceneConfig["features"]>>;

  scaleStartSw = 0;
  scaleStartSh = 0;

  // gimbal lock tracking
  private prevYaw = 0;
  private prevPitch = 0;
  private prevRoll = 0;

  private currentItems: GizmoItemData[] = [];
  private snapActive = false;
  private snapThreshold = 0.01;

  onPositionChange: ((fivemWorldPos: Vec3) => void) | null = null;
  onMultiTranslate: ((indices: number[], worldDelta: Vec3) => void) | null = null;
  onRotationChange: ((a: number, b: number, c: number) => void) | null = null;
  onScaleChange: ((sw: number, sh: number) => void) | null = null;
  onMultiScale: ((indices: number[], scaleX: number, scaleY: number) => void) | null = null;
  onDragStart: (() => void) | null = null;
  onDragEnd: (() => void) | null = null;
  onItemClick: ((idx: number, shiftKey: boolean, ctrlKey: boolean) => void) | null = null;

  constructor(config: GizmoSceneConfig) {
    const { canvas, fov = 50 } = config;
    this.features = {
      scale: config.features?.scale ?? false,
      picking: config.features?.picking ?? false,
      multiSelect: config.features?.multiSelect ?? false,
      snap: config.features?.snap ?? false,
    };

    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      fov,
      canvas.clientWidth / canvas.clientHeight,
      0.01,
      1000
    );

    const targetGeo = new THREE.BoxGeometry(0.02, 0.02, 0.02);
    const targetMat = new THREE.MeshBasicMaterial({ visible: false });
    this.gizmoTarget = new THREE.Mesh(targetGeo, targetMat);
    this.scene.add(this.gizmoTarget);

    this.transformControls = new TransformControls(this.camera, canvas);
    this.transformControls.setSize(0.75);
    this.transformControls.setSpace("local");
    this.transformControls.attach(this.gizmoTarget);
    this.scene.add(this.transformControls.getHelper());

    this.transformControls.visible = false;
    this.transformControls.enabled = false;

    this.transformControls.addEventListener("objectChange", () => {
      if (this.selectedIdx < 0) return;
      const mode = this.transformControls.mode;

      if (mode === "translate") {
        const fivemPos = threeToFivemPos(this.gizmoTarget.position);

        if (
          this.features.multiSelect &&
          this.selectedIndices.length > 1 &&
          this.dragStartFivemPos
        ) {
          const delta: Vec3 = {
            x: fivemPos.x - this.dragStartFivemPos.x,
            y: fivemPos.y - this.dragStartFivemPos.y,
            z: fivemPos.z - this.dragStartFivemPos.z,
          };
          this.onMultiTranslate?.(this.selectedIndices, delta);
        } else {
          const local = fivemWorldToLocal(this.matrix, fivemPos.x, fivemPos.y, fivemPos.z);
          const snapped =
            this.features.snap && this.snapActive
              ? this.snapToItems(local, this.selectedIdx)
              : local;
          if (
            this.features.snap &&
            this.snapActive &&
            (snapped.x !== local.x || snapped.y !== local.y || snapped.z !== local.z)
          ) {
            const sw = fivemLocalToWorld(this.matrix, snapped.x, snapped.y, snapped.z);
            const threeSnapped = fivemToThreePos(sw.x, sw.y, sw.z);
            this.gizmoTarget.position.copy(threeSnapped);
            this.onPositionChange?.(sw);
          } else {
            this.onPositionChange?.(fivemPos);
          }
        }
      } else if (mode === "rotate") {
        const rot = this.extractLedRotation();
        this.onRotationChange?.(rot.yaw, rot.pitch, rot.roll);
      } else if (mode === "scale" && this.features.scale) {
        const s = this.gizmoTarget.scale;
        if (this.features.multiSelect && this.selectedIndices.length > 1) {
          this.onMultiScale?.(this.selectedIndices, s.x, s.y);
        } else {
          this.onScaleChange?.(this.scaleStartSw * s.x, this.scaleStartSh * s.y);
        }
      }
    });

    this.transformControls.addEventListener("dragging-changed", (event) => {
      if (event.value) {
        this.dragStartFivemPos = threeToFivemPos(this.gizmoTarget.position);
        this.onDragStart?.();
      } else {
        this.dragStartFivemPos = null;
        this.onDragEnd?.();
        if (this.features.scale && this.transformControls.mode === "scale") {
          this.gizmoTarget.scale.set(1, 1, 1);
        }
      }
    });

    if (this.features.picking) {
      let mouseDownPos: { x: number; y: number } | null = null;
      let wasDragging = false;
      canvas.addEventListener("pointerdown", (e) => {
        mouseDownPos = { x: e.clientX, y: e.clientY };
        wasDragging = false;
      });
      canvas.addEventListener("pointermove", (e) => {
        if (mouseDownPos) {
          const dx = e.clientX - mouseDownPos.x;
          const dy = e.clientY - mouseDownPos.y;
          if (dx * dx + dy * dy > 16) wasDragging = true;
        }
      });
      canvas.addEventListener("pointerup", (e) => {
        if (wasDragging || !mouseDownPos) {
          mouseDownPos = null;
          return;
        }
        mouseDownPos = null;
        if (this.transformControls.dragging) return;
        this._pickItem(e);
      });
    }

    this._onResize = this._onResize.bind(this);
    window.addEventListener("resize", this._onResize);
  }

  //  Lifecycle
  private _onResize(): void {
    const parent = this.renderer.domElement.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  startLoop(): void {
    const loop = () => {
      this.animationId = requestAnimationFrame(loop);
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  stopLoop(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  dispose(): void {
    this.stopLoop();
    window.removeEventListener("resize", this._onResize);
    this.transformControls.detach();
    this.transformControls.dispose();
    this.gizmoTarget.geometry.dispose();
    (this.gizmoTarget.material as THREE.Material).dispose();
    this.renderer.dispose();
  }

  //  Camera
  syncCamera(position: Vec3, focus: Vec3): void {
    applyCameraSync(this.camera, position, focus);
  }

  setFov(fov: number): void {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  //  Vehicle Matrix
  setVehicleMatrix(fwd: Vec3, right: Vec3, up: Vec3, pos: Vec3): void;
  setVehicleMatrix(matrix: VehicleMatrix): void;
  setVehicleMatrix(fwdOrMatrix: Vec3 | VehicleMatrix, right?: Vec3, up?: Vec3, pos?: Vec3): void {
    if (right && up && pos) {
      this.matrix = { fwd: fwdOrMatrix as Vec3, right, up, pos };
    } else {
      this.matrix = fwdOrMatrix as VehicleMatrix;
    }
    this.vehicleQuat = buildVehicleQuat(this.matrix);
  }

  updateGizmoPosition(
    items: GizmoItemData[],
    selectedIdx: number,
    selectedIndices?: number[]
  ): void {
    this.selectedIdx = selectedIdx;
    this.selectedIndices = selectedIndices ?? (selectedIdx >= 0 ? [selectedIdx] : []);

    if (this.selectedIndices.length === 0 || selectedIdx < 0 || selectedIdx >= items.length) {
      this.transformControls.visible = false;
      this.transformControls.enabled = false;
      return;
    }

    // Position: center of selected items (multi) or single item
    if (this.features.multiSelect && this.selectedIndices.length > 1) {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      let count = 0;
      for (const i of this.selectedIndices) {
        if (i >= 0 && i < items.length) {
          cx += items[i].x;
          cy += items[i].y;
          cz += items[i].z;
          count++;
        }
      }
      if (count > 0) {
        cx /= count;
        cy /= count;
        cz /= count;
      }
      const wc = fivemLocalToWorld(this.matrix, cx, cy, cz);
      this.gizmoTarget.position.copy(fivemToThreePos(wc.x, wc.y, wc.z));
    } else {
      const wp = this.itemToThreeWorld(items[selectedIdx]);
      this.gizmoTarget.position.copy(wp);
    }

    // Orientation: from primary (last selected) item's yaw/pitch/roll
    const item = items[selectedIdx];
    const yaw = (item.yaw as number) ?? 0;
    const pitch = (item.pitch as number) ?? 0;
    const roll = (item.roll as number) ?? 0;

    this.gizmoTarget.quaternion.copy(this.vehicleQuat);
    const yawQ = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      THREE.MathUtils.degToRad(-yaw)
    );
    const pitchQ = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      THREE.MathUtils.degToRad(pitch)
    );
    const rollQ = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      THREE.MathUtils.degToRad(roll)
    );
    this.gizmoTarget.quaternion.multiply(yawQ).multiply(pitchQ).multiply(rollQ);

    this.prevYaw = yaw;
    this.prevPitch = pitch;
    this.prevRoll = roll;

    // Store sw/sh for scale mode (if present)
    this.scaleStartSw = (item.sw as number) ?? 1;
    this.scaleStartSh = (item.sh as number) ?? 1;
    this.gizmoTarget.scale.set(1, 1, 1);

    this.transformControls.visible = true;
    this.transformControls.enabled = true;
  }

  // YXZ euler with gimbal lock tracking
  extractLedRotation(): { yaw: number; pitch: number; roll: number } {
    const invVehicle = this.vehicleQuat.clone().invert();
    const localQuat = invVehicle.multiply(this.gizmoTarget.quaternion.clone());

    const m = new THREE.Matrix4().makeRotationFromQuaternion(localQuat);
    const te = m.elements;
    const m23 = te[9];
    const sinX = Math.max(-1, Math.min(1, -m23));

    const ex1 = Math.asin(sinX);
    let ey1: number;
    let ez1: number;
    if (Math.abs(sinX) < 0.9999999) {
      ey1 = Math.atan2(te[8], te[10]);
      ez1 = Math.atan2(te[1], te[5]);
    } else {
      ey1 = Math.atan2(-te[2], te[0]);
      ez1 = 0;
    }

    const ex2 = ex1 >= 0 ? Math.PI - ex1 : -Math.PI - ex1;
    const norm = (a: number) => {
      while (a > Math.PI) a -= 2 * Math.PI;
      while (a < -Math.PI) a += 2 * Math.PI;
      return a;
    };
    const ey2 = norm(ey1 + Math.PI);
    const ez2 = norm(ez1 + Math.PI);

    const r = THREE.MathUtils.radToDeg;
    const s1 = { yaw: -r(ey1), pitch: r(ex1), roll: r(ez1) };
    const s2 = { yaw: -r(ey2), pitch: r(ex2), roll: r(ez2) };

    const angDist = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);
    const d1 =
      angDist(s1.yaw, this.prevYaw) +
      angDist(s1.pitch, this.prevPitch) +
      angDist(s1.roll, this.prevRoll);
    const d2 =
      angDist(s2.yaw, this.prevYaw) +
      angDist(s2.pitch, this.prevPitch) +
      angDist(s2.roll, this.prevRoll);

    const result = d1 <= d2 ? s1 : s2;
    this.prevYaw = result.yaw;
    this.prevPitch = result.pitch;
    this.prevRoll = result.roll;
    return result;
  }

  // dolu_tool euler convention (YZX order)
  updatePropGizmo(propData: {
    x: number;
    y: number;
    z: number;
    rx: number;
    ry: number;
    rz: number;
  }): void {
    this.selectedIdx = 0;
    this.selectedIndices = [0];

    const world = fivemLocalToWorld(this.matrix, propData.x, propData.y, propData.z);
    this.gizmoTarget.position.copy(fivemToThreePos(world.x, world.y, world.z));

    const localEuler = new THREE.Euler(
      THREE.MathUtils.degToRad(propData.rx),
      THREE.MathUtils.degToRad(propData.rz),
      -THREE.MathUtils.degToRad(propData.ry),
      "YZX"
    );
    const localQuat = new THREE.Quaternion().setFromEuler(localEuler);
    this.gizmoTarget.quaternion.copy(this.vehicleQuat).multiply(localQuat);

    this.transformControls.visible = true;
    this.transformControls.enabled = true;
  }

  // extract as FiveM rx/ry/rz degrees (dolu_tool YZX)
  extractPropRotation(): { rx: number; ry: number; rz: number } {
    const invVehicle = this.vehicleQuat.clone().invert();
    const localQuat = invVehicle.multiply(this.gizmoTarget.quaternion.clone());
    const euler = new THREE.Euler().setFromQuaternion(localQuat, "YZX");
    return {
      rx: THREE.MathUtils.radToDeg(euler.x),
      ry: -THREE.MathUtils.radToDeg(euler.z),
      rz: THREE.MathUtils.radToDeg(euler.y),
    };
  }

  //  Mode / Space / Snap
  setMode(mode: EditorMode): void {
    this.transformControls.setMode(mode);
  }

  setSpace(space: SpaceMode): void {
    this.transformControls.setSpace(space);
  }

  setSnap(enabled: boolean, translate: number, rotateDeg: number, scale: number): void {
    this.snapActive = enabled;
    this.snapThreshold = translate;
    if (enabled) {
      this.transformControls.setRotationSnap(THREE.MathUtils.degToRad(rotateDeg));
      this.transformControls.setScaleSnap(scale);
    } else {
      this.transformControls.setRotationSnap(null);
      this.transformControls.setScaleSnap(null);
    }
    this.transformControls.setTranslationSnap(null);
  }

  setCurrentItems(items: GizmoItemData[]): void {
    this.currentItems = items;
  }

  //  Picking
  private _pickItem(e: PointerEvent): void {
    if (!this.currentItems.length || !this.onItemClick) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;

    let bestIdx = -1;
    let bestDist = 30;
    const v = new THREE.Vector3();

    for (let i = 0; i < this.currentItems.length; i++) {
      const threePos = this.itemToThreeWorld(this.currentItems[i]);
      v.copy(threePos).project(this.camera);
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      if (v.z > 1) continue;
      const dx = sx - mx;
      const dy = sy - my;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      this.onItemClick(bestIdx, e.shiftKey, e.ctrlKey || e.metaKey);
    }
  }

  //  Internal helpers
  private itemToThreeWorld(item: GizmoItemData): THREE.Vector3 {
    const wp = fivemLocalToWorld(this.matrix, item.x, item.y, item.z);
    return fivemToThreePos(wp.x, wp.y, wp.z);
  }

  /**
   * Snap local coords to nearby items per-axis.
   * Checks center alignment and, if items have sw/sh, edge alignment.
   */
  private snapToItems(local: Vec3, selfIdx: number): Vec3 {
    const t = this.snapThreshold;
    const self = this.currentItems[selfIdx];
    if (!self) return local;

    const selfSw = (self.sw as number) ?? 0;
    const selfSh = (self.sh as number) ?? 0;
    let sx = local.x;
    let sy = local.y;
    let sz = local.z;
    let bestDx = t;
    let bestDy = t;
    let bestDz = t;

    for (let i = 0; i < this.currentItems.length; i++) {
      if (i === selfIdx) continue;
      const other = this.currentItems[i];
      const otherSw = (other.sw as number) ?? 0;
      const otherSh = (other.sh as number) ?? 0;

      // X axis
      const xTargets = [other.x];
      if (selfSw && otherSw) {
        xTargets.push(
          other.x + otherSw - selfSw,
          other.x - otherSw + selfSw,
          other.x + otherSw + selfSw,
          other.x - otherSw - selfSw
        );
      }
      for (const xt of xTargets) {
        const d = Math.abs(local.x - xt);
        if (d < bestDx) {
          bestDx = d;
          sx = xt;
        }
      }

      // Y axis
      const d_y = Math.abs(local.y - other.y);
      if (d_y < bestDy) {
        bestDy = d_y;
        sy = other.y;
      }

      // Z axis
      const zTargets = [other.z];
      if (selfSh && otherSh) {
        zTargets.push(
          other.z + otherSh - selfSh,
          other.z - otherSh + selfSh,
          other.z + otherSh + selfSh,
          other.z - otherSh - selfSh
        );
      }
      for (const zt of zTargets) {
        const d = Math.abs(local.z - zt);
        if (d < bestDz) {
          bestDz = d;
          sz = zt;
        }
      }
    }

    return { x: sx, y: sy, z: sz };
  }
}
