// The animation viewer scene: a stick-figure ped playing a .ycd clip, with a
// bone-attached prop you can drag to author its placement.
//
// Framework-agnostic in the same way GizmoScene is: it owns a WebGLRenderer, a
// camera and its own rAF loop, takes a canvas, and exposes callbacks. `three` is a
// peer dependency. Nothing here imports a UI framework.
//
// Node graph:
//
//   scene
//    +- zUp (Group, rotated -90 deg about X)      GTA Z-up -> three Y-up, done ONCE
//    |   +- mover (Object3D)                       root motion goes here
//    |       +- SKEL_ROOT (Bone) ... the rig       bone locals stay GTA-space
//    |           +- PropAttachment.root            local transform = the game placement
//    +- grid, lights, TransformControls helper
//
// Keeping the conversion in one group is what lets prop-attach.ts hand its numbers
// straight to AttachEntityToEntity without a second conversion to keep in sync.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { Animation } from "../rage/ycd";
import type { BuiltClipKind } from "./anim-clip";
import {
  applyPose,
  type BuildAnimationClipResult,
  buildAnimationClip,
  DEFAULT_MOVER_NODE_NAME,
} from "./anim-clip";
import {
  type Placement6,
  PropAttachment,
  type PropPlacementRecord,
  type PropSource,
  DEFAULT_PROP_BONE_TAG,
} from "./prop-attach";
import { buildSkeleton, type SkeletonJson, type ViewerSkeleton } from "./skeleton";

export type TransformMode = "translate" | "rotate";

export interface AnimViewerSceneConfig {
  canvas: HTMLCanvasElement;
  /** Parsed skeleton JSON. Never embedded in this repo - the caller loads it. */
  skeleton?: SkeletonJson | unknown;
  fov?: number;
  /** Scene background. `null` leaves the canvas transparent. Default 0x141619. */
  background?: number | null;
  /** Radius of the joint spheres, metres. Default 0.012. */
  jointRadius?: number;
  showGrid?: boolean;
}

export interface AnimViewerPlaybackState {
  playing: boolean;
  time: number;
  duration: number;
  /** "pose" has no timeline: play/scrub controls should be hidden, not disabled-looking. */
  kind: BuiltClipKind;
  frame: number;
  frames: number;
  fps: number;
  speed: number;
  loop: boolean;
}

export class AnimViewerScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  orbit: OrbitControls;
  transformControls: TransformControls;

  /** The single GTA Z-up -> three Y-up frame change. */
  readonly zUp = new THREE.Group();
  /** Root-motion node. Mover tracks drive this; it is identity when in place. */
  readonly mover = new THREE.Object3D();

  skeleton: ViewerSkeleton | null = null;
  mixer: THREE.AnimationMixer | null = null;
  action: THREE.AnimationAction | null = null;
  clipInfo: BuildAnimationClipResult | null = null;
  prop: PropAttachment | null = null;

  onPlacementChange: ((record: PropPlacementRecord) => void) | null = null;
  onTimeChange: ((state: AnimViewerPlaybackState) => void) | null = null;
  /** Warnings from skeleton/clip building, surfaced rather than swallowed. */
  onWarnings: ((warnings: string[]) => void) | null = null;

  private gizmoHelper: THREE.Object3D;
  private jointGroup = new THREE.Group();
  private jointGeometry: THREE.SphereGeometry | null = null;
  private jointMaterial: THREE.MeshStandardMaterial | null = null;
  private joints: THREE.InstancedMesh | null = null;
  private boneLines: THREE.LineSegments | null = null;
  private boneLinePairs: [THREE.Object3D, THREE.Object3D][] = [];
  private grid: THREE.GridHelper | null = null;
  private pmrem: THREE.PMREMGenerator | null = null;
  private environment: THREE.Texture | null = null;

  private animationId: number | null = null;
  private loopGeneration = 0;
  private disposed = false;
  // performance.now() rather than THREE.Clock: Clock is deprecated in three 0.18x
  // and its replacement lives in addons, which is a heavier import than a subtraction.
  private lastFrameTime = 0;

  private playing = false;
  private speed = 1;
  private looping = true;
  private rootMotion = false;
  private currentAnimation: Animation | null = null;
  private currentClipName = "clip";

  private jointRadius: number;
  private tmpVec = new THREE.Vector3();
  private tmpInverse = new THREE.Matrix4();
  private tmpMatrix = new THREE.Matrix4();
  private unitScale = new THREE.Vector3(1, 1, 1);
  /** Joint spheres are unrotated; this stays identity. */
  private noRotation = new THREE.Quaternion();

  constructor(config: AnimViewerSceneConfig) {
    const { canvas, fov = 45, background = 0x141619, showGrid = true } = config;
    this.jointRadius = config.jointRadius ?? 0.012;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio ?? 1);
    this.renderer.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1, false);

    this.scene = new THREE.Scene();
    if (background !== null) this.scene.background = new THREE.Color(background);

    this.camera = new THREE.PerspectiveCamera(
      fov,
      (canvas.clientWidth || 1) / (canvas.clientHeight || 1),
      0.01,
      100
    );
    this.camera.position.set(1.6, 1.2, 1.6);

    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.enableDamping = true;
    this.orbit.target.set(0, 0.95, 0);

    // GTA is Z-up; three is Y-up. One group, one place.
    this.zUp.rotation.x = -Math.PI / 2;
    this.zUp.name = "GtaZUp";
    this.mover.name = DEFAULT_MOVER_NODE_NAME;
    this.zUp.add(this.mover);
    this.mover.add(this.jointGroup);
    this.scene.add(this.zUp);

    this.setupLighting();
    if (showGrid) {
      this.grid = new THREE.GridHelper(10, 20, 0x3a4048, 0x23272c);
      this.scene.add(this.grid);
    }

    this.transformControls = new TransformControls(this.camera, canvas);
    this.transformControls.setSize(0.6);
    this.transformControls.setSpace("local");
    this.gizmoHelper = this.transformControls.getHelper();
    this.gizmoHelper.visible = false;
    this.transformControls.enabled = false;
    this.scene.add(this.gizmoHelper);

    this.transformControls.addEventListener("dragging-changed", (event) => {
      this.orbit.enabled = !event.value;
    });
    this.transformControls.addEventListener("objectChange", () => {
      if (this.prop) this.onPlacementChange?.(this.prop.getRecord());
    });

    this.onResize = this.onResize.bind(this);
    window.addEventListener("resize", this.onResize);

    if (config.skeleton) this.setSkeleton(config.skeleton);
  }

  private setupLighting(): void {
    // RoomEnvironment is neutral studio lighting: it shows silhouette and depth
    // without tinting anything, which a single directional light does not.
    try {
      this.pmrem = new THREE.PMREMGenerator(this.renderer);
      const room = new RoomEnvironment();
      this.environment = this.pmrem.fromScene(room, 0.04).texture;
      this.scene.environment = this.environment;
      room.dispose();
    } catch {
      // A context without float render targets (or a mocked renderer in tests)
      // cannot build a PMREM. Fall back rather than refusing to construct.
      this.pmrem = null;
    }
    const hemi = new THREE.HemisphereLight(0xffffff, 0x303038, 1.2);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(2, 4, 3);
    this.scene.add(key);
  }

  // ---------------------------------------------------------------- skeleton

  setSkeleton(json: SkeletonJson | unknown): ViewerSkeleton {
    this.clearSkeleton();
    const skeleton = buildSkeleton(json);
    this.skeleton = skeleton;
    for (const root of skeleton.roots) this.mover.add(root);
    this.buildStickFigure(skeleton);
    this.mixer = new THREE.AnimationMixer(this.zUp);
    if (skeleton.warnings.length) this.onWarnings?.(skeleton.warnings);
    // Re-apply an animation that was set before the skeleton arrived.
    if (this.currentAnimation) this.setAnimation(this.currentAnimation, this.currentClipName);
    return skeleton;
  }

  private clearSkeleton(): void {
    this.action?.stop();
    this.action = null;
    this.mixer = null;
    this.clipInfo = null;
    if (this.skeleton) {
      for (const root of this.skeleton.roots) root.removeFromParent();
      this.skeleton.dispose();
      this.skeleton = null;
    }
    this.disposeStickFigure();
  }

  /**
   * Joint spheres as one InstancedMesh plus a LineSegments of parent->child bones.
   * Both are rebuilt from bone world matrices each frame; nothing is parented to a
   * bone, so the draw cost is two objects regardless of bone count.
   */
  private buildStickFigure(skeleton: ViewerSkeleton): void {
    const count = skeleton.bones.length;
    this.jointGeometry = new THREE.SphereGeometry(this.jointRadius, 10, 8);
    this.jointMaterial = new THREE.MeshStandardMaterial({
      color: 0xe8eef5,
      roughness: 0.45,
      metalness: 0.05,
    });
    this.joints = new THREE.InstancedMesh(this.jointGeometry, this.jointMaterial, count);
    this.joints.frustumCulled = false;
    this.joints.name = "Joints";
    this.jointGroup.add(this.joints);

    this.boneLinePairs = [];
    for (const bone of skeleton.bones) {
      const parent = bone.parent;
      if (parent && (parent as THREE.Bone).isBone) {
        this.boneLinePairs.push([parent, bone]);
      }
    }
    const positions = new Float32Array(this.boneLinePairs.length * 6);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color: 0x6fb7ff });
    this.boneLines = new THREE.LineSegments(geometry, material);
    this.boneLines.frustumCulled = false;
    this.boneLines.name = "BoneLines";
    this.jointGroup.add(this.boneLines);

    this.updateStickFigure();
  }

  private disposeStickFigure(): void {
    if (this.joints) {
      this.jointGroup.remove(this.joints);
      this.joints.dispose();
      this.joints = null;
    }
    this.jointGeometry?.dispose();
    this.jointMaterial?.dispose();
    this.jointGeometry = null;
    this.jointMaterial = null;
    if (this.boneLines) {
      this.jointGroup.remove(this.boneLines);
      this.boneLines.geometry.dispose();
      (this.boneLines.material as THREE.Material).dispose();
      this.boneLines = null;
    }
    this.boneLinePairs = [];
  }

  /** Pull bone world matrices into the instanced joints and the line buffer. */
  updateStickFigure(): void {
    const skeleton = this.skeleton;
    if (!skeleton) return;
    // From zUp, not from jointGroup: the bones hang off `mover`, a sibling of
    // jointGroup, so updating jointGroup's subtree leaves every bone matrixWorld
    // stale and the whole figure collapses onto the origin.
    this.zUp.updateMatrixWorld(true);

    // Bone world matrices are expressed back into jointGroup space once, so the
    // instanced joints and the line buffer share one frame of reference.
    const inverse = this.tmpInverse.copy(this.jointGroup.matrixWorld).invert();

    if (this.joints) {
      for (let i = 0; i < skeleton.bones.length; i++) {
        const bone = skeleton.bones[i];
        this.tmpVec.setFromMatrixPosition(bone.matrixWorld).applyMatrix4(inverse);
        this.tmpMatrix.compose(this.tmpVec, this.noRotation, this.unitScale);
        this.joints.setMatrixAt(i, this.tmpMatrix);
      }
      this.joints.instanceMatrix.needsUpdate = true;
    }

    if (this.boneLines) {
      const attr = this.boneLines.geometry.getAttribute("position") as THREE.BufferAttribute;
      const array = attr.array as Float32Array;
      for (let i = 0; i < this.boneLinePairs.length; i++) {
        const [a, b] = this.boneLinePairs[i];
        this.tmpVec.setFromMatrixPosition(a.matrixWorld).applyMatrix4(inverse);
        array[i * 6] = this.tmpVec.x;
        array[i * 6 + 1] = this.tmpVec.y;
        array[i * 6 + 2] = this.tmpVec.z;
        this.tmpVec.setFromMatrixPosition(b.matrixWorld).applyMatrix4(inverse);
        array[i * 6 + 3] = this.tmpVec.x;
        array[i * 6 + 4] = this.tmpVec.y;
        array[i * 6 + 5] = this.tmpVec.z;
      }
      attr.needsUpdate = true;
      this.boneLines.geometry.computeBoundingSphere();
    }
  }

  // --------------------------------------------------------------- animation

  /** Build and bind a clip. Safe to call before a skeleton is set; it is deferred. */
  setAnimation(
    animation: Animation,
    name = "clip",
    options: { rootMotion?: boolean } = {}
  ): BuildAnimationClipResult | null {
    this.currentAnimation = animation;
    this.currentClipName = name;
    if (typeof options.rootMotion === "boolean") this.rootMotion = options.rootMotion;

    const skeleton = this.skeleton;
    const mixer = this.mixer;
    if (!skeleton || !mixer) return null;

    this.action?.stop();
    mixer.stopAllAction();
    mixer.uncacheRoot(this.zUp);
    skeleton.resetToRest();
    this.mover.position.set(0, 0, 0);
    this.mover.quaternion.identity();

    const result = buildAnimationClip(animation, skeleton, {
      name,
      rootMotion: this.rootMotion,
      moverNodeName: DEFAULT_MOVER_NODE_NAME,
    });
    this.clipInfo = result;
    if (result.warnings.length) this.onWarnings?.(result.warnings);

    if (result.kind === "pose") {
      // A held pose is written straight onto the bones. Going through the mixer
      // would mean a duration-0 clip, and three's LoopRepeat divides by the
      // duration - and there is nothing to interpolate anyway.
      this.action = null;
      this.playing = false;
      applyPose(animation, skeleton, 0);
      this.updateStickFigure();
      this.emitTime();
      return result;
    }

    this.action = mixer.clipAction(result.clip);
    this.action.loop = this.looping ? THREE.LoopRepeat : THREE.LoopOnce;
    this.action.clampWhenFinished = true;
    this.action.timeScale = this.speed;
    this.action.play();
    this.action.paused = !this.playing;
    mixer.setTime(0);
    this.updateStickFigure();
    this.emitTime();
    return result;
  }

  /** True when the loaded asset is a single held pose rather than an animation. */
  get isPose(): boolean {
    return this.clipInfo?.kind === "pose";
  }

  /** Toggle "in place" vs "apply root motion". Rebuilds the clip. */
  setRootMotion(enabled: boolean): void {
    if (this.rootMotion === enabled) return;
    this.rootMotion = enabled;
    const time = this.time;
    if (this.currentAnimation) {
      this.setAnimation(this.currentAnimation, this.currentClipName);
      this.setTime(time);
    }
  }

  get rootMotionEnabled(): boolean {
    return this.rootMotion;
  }

  play(): void {
    // Nothing to play on a pose; claiming `playing` would make the UI show a
    // running transport for a clip whose time never advances.
    if (!this.action) return;
    this.playing = true;
    this.action.paused = false;
  }

  pause(): void {
    this.playing = false;
    if (this.action) this.action.paused = true;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  setSpeed(speed: number): void {
    this.speed = Number.isFinite(speed) ? speed : 1;
    if (this.action) this.action.timeScale = this.speed;
  }

  setLoop(loop: boolean): void {
    this.looping = loop;
    if (this.action) this.action.loop = loop ? THREE.LoopRepeat : THREE.LoopOnce;
  }

  get duration(): number {
    // A pose has no timeline to scrub, whatever the file's duration field says.
    if (this.clipInfo?.kind !== "animation") return 0;
    return this.clipInfo.duration;
  }

  get time(): number {
    return this.action?.time ?? 0;
  }

  /** Scrub, in seconds. Applies the pose immediately whether playing or not. */
  setTime(seconds: number): void {
    if (!this.mixer || !this.action) return;
    const duration = this.duration;
    const clamped = duration > 0 ? Math.max(0, Math.min(seconds, duration)) : 0;
    this.action.time = clamped;
    // A zero-delta mixer update re-evaluates every binding at the action's current
    // time without advancing it, which is what makes a paused scrub show the pose.
    // mixer.setTime() would instead rescale every action's time and is wrong here.
    this.mixer.update(0);
    this.updateStickFigure();
    this.emitTime();
  }

  /** Scrub by frame index at the clip's native rate. */
  setFrame(frame: number): void {
    const fps = this.clipInfo?.fps ?? 0;
    if (fps <= 0) return;
    this.setTime(frame / fps);
  }

  get playbackState(): AnimViewerPlaybackState {
    const fps = this.clipInfo?.fps ?? 0;
    return {
      playing: this.playing,
      time: this.time,
      duration: this.duration,
      kind: this.clipInfo?.kind ?? "empty",
      frame: fps > 0 ? Math.round(this.time * fps) : 0,
      frames: this.clipInfo?.frames ?? 0,
      fps,
      speed: this.speed,
      loop: this.looping,
    };
  }

  private emitTime(): void {
    this.onTimeChange?.(this.playbackState);
  }

  // -------------------------------------------------------------------- prop

  /**
   * Attach a prop to a bone tag and show its TransformControls gizmo.
   *
   * With no `source` the attachment exists but draws nothing; call
   * `prop.setSource(...)` when the drawable or its bounds are known.
   */
  attachProp(
    model: string,
    boneTag: number = DEFAULT_PROP_BONE_TAG,
    placement: Placement6 = [0, 0, 0, 0, 0, 0],
    source?: PropSource
  ): PropAttachment | null {
    if (!this.skeleton) return null;
    const bone = this.skeleton.byTag.get(boneTag);
    if (!bone) return null;

    this.detachProp();
    const prop = new PropAttachment(model, boneTag);
    if (source) prop.setSource(source);
    prop.setPlacement(placement);
    prop.attachToBone(bone, boneTag);
    this.prop = prop;

    this.transformControls.attach(prop.root);
    this.transformControls.enabled = true;
    this.gizmoHelper.visible = true;
    return prop;
  }

  /** Move the current prop to a different bone, keeping its placement numbers. */
  setPropBone(boneTag: number): boolean {
    const bone = this.skeleton?.byTag.get(boneTag);
    if (!bone || !this.prop) return false;
    bone.add(this.prop.root);
    this.prop.boneTag = boneTag;
    this.onPlacementChange?.(this.prop.getRecord());
    return true;
  }

  detachProp(): void {
    if (!this.prop) return;
    this.transformControls.detach();
    this.transformControls.enabled = false;
    this.gizmoHelper.visible = false;
    this.prop.dispose();
    this.prop = null;
  }

  setTransformMode(mode: TransformMode): void {
    this.transformControls.setMode(mode);
  }

  setTransformSnap(translate: number | null, rotateDeg: number | null): void {
    this.transformControls.setTranslationSnap(translate);
    this.transformControls.setRotationSnap(
      rotateDeg === null ? null : THREE.MathUtils.degToRad(rotateDeg)
    );
  }

  // ------------------------------------------------------------------ camera

  /** Point the camera at the rig's current bounding box. */
  frameSkeleton(paddingFactor = 1.6): void {
    if (!this.skeleton) return;
    this.zUp.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const bone of this.skeleton.bones) {
      this.tmpVec.setFromMatrixPosition(bone.matrixWorld);
      box.expandByPoint(this.tmpVec);
    }
    if (box.isEmpty()) return;
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.1);
    const distance = (radius * paddingFactor) / Math.tan((this.camera.fov * Math.PI) / 360);
    this.orbit.target.copy(centre);
    this.camera.position
      .copy(centre)
      .add(new THREE.Vector3(1, 0.35, 1).normalize().multiplyScalar(distance));
    this.camera.updateProjectionMatrix();
    this.orbit.update();
  }

  /** Frame the attached prop instead, for fine placement work. */
  frameProp(paddingFactor = 3): void {
    if (!this.prop) return;
    this.prop.root.updateMatrixWorld(true);
    const centre = new THREE.Vector3().setFromMatrixPosition(this.prop.root.matrixWorld);
    const source = this.prop.getSource();
    const radius = source
      ? Math.max(
          Math.hypot(
            source.bounds.max[0] - source.bounds.min[0],
            source.bounds.max[1] - source.bounds.min[1],
            source.bounds.max[2] - source.bounds.min[2]
          ) / 2,
          0.05
        )
      : 0.15;
    const distance = (radius * paddingFactor) / Math.tan((this.camera.fov * Math.PI) / 360);
    this.orbit.target.copy(centre);
    this.camera.position
      .copy(centre)
      .add(new THREE.Vector3(1, 0.35, 1).normalize().multiplyScalar(distance));
    this.orbit.update();
  }

  setFov(fov: number): void {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  private onResize(): void {
    const canvas = this.renderer.domElement;
    const parent = canvas.parentElement;
    const w = parent?.clientWidth || canvas.clientWidth || 1;
    const h = parent?.clientHeight || canvas.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  // ------------------------------------------------------------------- loop

  /** One frame of simulation + render. Exposed so a host can drive it manually. */
  tick(delta: number): void {
    if (this.playing && this.mixer) this.mixer.update(delta);
    this.orbit.update();
    if (this.playing) {
      this.updateStickFigure();
      this.emitTime();
    }
    this.renderer.render(this.scene, this.camera);
  }

  startLoop(): void {
    if (this.disposed || this.animationId !== null) return;
    const generation = ++this.loopGeneration;
    this.lastFrameTime = now();
    const loop = () => {
      if (this.disposed || generation !== this.loopGeneration) return;
      this.animationId = requestAnimationFrame(loop);
      const t = now();
      // Clamp: a backgrounded tab returns with a multi-second delta that would
      // jump the clip forward instead of pausing it.
      const delta = Math.min(Math.max(t - this.lastFrameTime, 0) / 1000, 0.1);
      this.lastFrameTime = t;
      this.tick(delta);
    };
    loop();
  }

  stopLoop(): void {
    ++this.loopGeneration;
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    window.removeEventListener("resize", this.onResize);
    this.detachProp();
    this.transformControls.detach();
    this.transformControls.dispose();
    this.orbit.dispose();
    this.clearSkeleton();
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      const gridMaterial = this.grid.material;
      if (Array.isArray(gridMaterial)) for (const m of gridMaterial) m.dispose();
      else gridMaterial.dispose();
      this.grid = null;
    }
    this.environment?.dispose();
    this.pmrem?.dispose();
    this.renderer.dispose();
  }
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
