// A skinned GTA character playing one `.ycd` clip, with no chrome and no renderer.
//
// The difference from `AnimViewerScene` is deliberate and is the whole reason this
// file exists beside it:
//
//   AnimViewerScene   An AUTHORING viewer. It owns a WebGLRenderer, OrbitControls
//                     and a TransformControls gizmo, draws a grid and a stick figure,
//                     and exists so a human can drag a prop into place and read the
//                     numbers back out.
//   PedPreviewRig     A PICTURE. Real skinned meshes, a fixed flattering camera, auto
//                     loop, nothing to click. It owns NO renderer and NO DOM
//                     listeners, because a page shows many of these at once and the
//                     browser caps WebGL contexts at around 16 — so one shared
//                     renderer draws every rig in turn (`preview-renderer.ts`).
//
// Node graph, unchanged from `AnimViewerScene` and for the same reason:
//
//   scene
//    +- zUp (Group, rotated -90 deg about X)   GTA Z-up -> three Y-up, done ONCE
//    |   +- mover (Object3D)                   root motion goes here
//    |   |   +- SKEL_ROOT (Bone) ... the rig   bone locals stay GTA-space
//    |   |       +- PropAttachment.root        local transform = the game placement
//    |   +- meshRoot (Group)                   the SkinnedMeshes
//    +- lights
//
// ── ⚠️ The SkinnedMeshes hang off `zUp`, NOT off `mover` ──────────────────────
//
// three skins as `bindMatrixInverse * (boneMatrixWorld * boneInverse) * bindMatrix * v`
// and then applies the MESH's own world matrix. Parent the mesh to `mover` and the
// mover's transform is applied twice — once through the bones, once through the mesh
// — so a clip with root motion drifts at double speed. `zUp` never moves, so hanging
// the meshes there makes the mesh matrix cancel exactly.
//
// ── ⚠️ `calculateInverses()` after parenting, before any pose ─────────────────
//
// `buildSkeleton` constructs its `THREE.Skeleton` while the bones are still
// unparented, so its bind-pose inverses are in bone-root space. Once the roots are
// added under `mover` the bones' world matrices gain the Z-up frame change, and the
// inverses have to be recomputed in that same space or the character renders inside
// out. It has to happen at REST: recomputing after a clip has posed the rig bakes
// that frame in as the bind pose.

import * as THREE from "three";

import type { Drawable } from "../rage/drawable";
import type { TextureDictionary } from "../rage/ytd";
import type { Animation } from "../rage/ycd";
import {
	applyPose,
	type BuildAnimationClipResult,
	buildAnimationClip,
	DEFAULT_MOVER_NODE_NAME,
} from "./anim-clip";
import { buildDrawableMeshes, type DrawableMeshResult } from "./drawable-mesh";
import {
	DEFAULT_PROP_BONE_TAG,
	type Placement6,
	PropAttachment,
} from "./prop-attach";
import { buildSkeleton, type SkeletonJson, type ViewerSkeleton } from "./skeleton";

export interface PedPreviewRigConfig {
	/** Parsed skeleton JSON. Rockstar-derived and never embedded here. */
	skeleton: SkeletonJson | unknown;
	fov?: number;
	/** Scene background. `null` leaves it transparent so the host's surface shows. */
	background?: number | null;
}

export interface PedPreviewFraming {
	/**
	 * `"upper"` frames chest-to-head, `"full"` the whole body.
	 *
	 * Upper is the right default for a radio animation: the gesture and the prop are
	 * both above the waist, and a full-body shot in a 16:9 card makes the character
	 * about 90 px tall with the hand-held radio a couple of pixels across.
	 */
	focus?: "upper" | "full";
	/** Degrees off dead-front, positive toward the character's own right. */
	azimuthDeg?: number;
	/** Degrees above the horizon. Small positive values read as eye level. */
	elevationDeg?: number;
	/** How much empty space around the subject. 1 is a tight fit. */
	padding?: number;
}

const DEFAULT_FRAMING: Required<PedPreviewFraming> = {
	focus: "upper",
	// A three-quarter view from the character's front-RIGHT. Right rather than left
	// because `PH_R_Hand` is the default prop hook: from the left the body occludes
	// the radio, which is the one object the preview exists to show.
	azimuthDeg: 28,
	elevationDeg: 6,
	padding: 1.12,
};

/** Fraction of the body's height, measured from the feet, where "upper" starts. */
const UPPER_BODY_FLOOR = 0.58;

/**
 * The two bones whose separation defines the character's RIGHT, in the current pose.
 *
 * ── ⚠️ Why the camera cannot be a fixed vector ───────────────────────────────
 *
 * Because which way the character faces is a property of the CLIP, not of the rig.
 * Measured on this corpus: at rest, the freemode mesh's face is at three **+Z**, which
 * is GTA **-Y** — the opposite of where a ped entity's forward points in the game, so
 * a camera placed along GTA +Y sees the BACK OF ITS HEAD. And a clip is free to
 * rotate `SKEL_ROOT`: `molly@megaphone` turns it roughly 180 degrees, so its pose
 * faces the opposite way from the rest pose.
 * A fixed camera direction is therefore right for one of the two and wrong for the
 * other, and that is exactly how this shipped first: the animated preview looked
 * correct and a rest-pose one showed the character's back.
 *
 * So the facing is DERIVED from the posed skeleton. The shoulders are the right
 * bones for it: they define the chest plane, they are present on every ped rig, and
 * no clip moves them relative to each other by enough to matter.
 */
const SHOULDER_TAGS = { left: 64729, right: 10706 } as const;

/** Fallback facing when the shoulders are absent: GTA -Y, i.e. three +Z. */
const REST_FACING = new THREE.Vector3(0, 0, 1);

export interface PedPreviewStats {
	vertices: number;
	triangles: number;
	meshes: number;
	missingTextures: string[];
	warnings: string[];
}

export class PedPreviewRig {
	readonly scene = new THREE.Scene();
	readonly camera: THREE.PerspectiveCamera;
	/** The single GTA Z-up -> three Y-up frame change. */
	readonly zUp = new THREE.Group();
	/** Root-motion node. Mover tracks drive this; identity when the clip is in place. */
	readonly mover = new THREE.Object3D();
	/** Parent of every skinned mesh. A sibling of `mover` — see the header. */
	readonly meshRoot = new THREE.Group();

	skeleton: ViewerSkeleton | null = null;
	mixer: THREE.AnimationMixer | null = null;
	action: THREE.AnimationAction | null = null;
	clipInfo: BuildAnimationClipResult | null = null;
	prop: PropAttachment | null = null;

	/** Shared across every drawable this rig builds, so one skin map uploads once. */
	private readonly textureCache = new Map<number, THREE.Texture | null>();
	private readonly built: DrawableMeshResult[] = [];
	private propMeshes: DrawableMeshResult | null = null;
	private lights: THREE.Object3D[] = [];
	private framing: Required<PedPreviewFraming> = { ...DEFAULT_FRAMING };
	private disposed = false;

	constructor(config: PedPreviewRigConfig) {
		const { fov = 32, background = null } = config;
		if (background !== null) this.scene.background = new THREE.Color(background);

		// A long lens (32 deg rather than the authoring viewer's 45) flattens the
		// perspective the way a portrait lens does. At 45 the nearer shoulder of a
		// three-quarter view balloons and the head shrinks.
		this.camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.05, 50);
		this.camera.position.set(0.9, 1.3, -1.6);

		this.zUp.rotation.x = -Math.PI / 2;
		this.zUp.name = "GtaZUp";
		this.mover.name = DEFAULT_MOVER_NODE_NAME;
		this.zUp.add(this.mover);
		this.zUp.add(this.meshRoot);
		this.scene.add(this.zUp);

		this.setupLighting();
		this.setSkeleton(config.skeleton);
	}

	/**
	 * Three lights, no environment map.
	 *
	 * `AnimViewerScene` builds a PMREM from `RoomEnvironment`, which needs a renderer
	 * — and this class deliberately has none. Three analytic lights cost nothing per
	 * rig, are identical across every preview on the page, and give a character
	 * enough form: a key from the camera's side, a cool fill opposite it so the
	 * shadow side is not black, and a rim to lift the silhouette off the background.
	 */
	private setupLighting(): void {
		const hemi = new THREE.HemisphereLight(0xdfe7f2, 0x2a2e36, 1.15);
		const key = new THREE.DirectionalLight(0xfff4e6, 2.1);
		key.position.set(1.6, 2.4, -2.2);
		const fill = new THREE.DirectionalLight(0x9fc4ff, 0.7);
		fill.position.set(-2.4, 0.9, -1.2);
		const rim = new THREE.DirectionalLight(0xffffff, 1.1);
		rim.position.set(-0.6, 1.8, 2.6);
		this.lights = [hemi, key, fill, rim];
		for (const light of this.lights) this.scene.add(light);
	}

	// ---------------------------------------------------------------- skeleton

	setSkeleton(json: SkeletonJson | unknown): ViewerSkeleton {
		const skeleton = buildSkeleton(json);
		this.skeleton = skeleton;
		for (const root of skeleton.roots) this.mover.add(root);

		// ⚠️ Both lines, in this order, at rest. See the header.
		this.zUp.updateMatrixWorld(true);
		skeleton.skeleton.calculateInverses();

		this.mixer = new THREE.AnimationMixer(this.zUp);
		return skeleton;
	}

	// -------------------------------------------------------------- geometry

	/**
	 * Add one drawable's meshes to the character.
	 *
	 * Called once per ped component (`head`, `uppr`, `lowr`, ...). Skinned meshes are
	 * bound here, against `meshRoot`'s world matrix, which is the bind matrix that
	 * makes the double-transform in the header cancel.
	 */
	addDrawable(drawable: Drawable, textures: readonly TextureDictionary[]): DrawableMeshResult {
		const skeleton = this.skeleton;
		const result = buildDrawableMeshes(drawable, {
			textures,
			skeleton: skeleton ?? undefined,
			textureCache: this.textureCache,
			// Call order IS layer order: clothing is modelled on the body and touches
			// it, so a later component gets a depth bias towards the camera. The caller
			// adds components body-first, which is the order the game composes them in.
			depthLayer: this.built.length,
		});
		this.meshRoot.add(result.object);
		this.meshRoot.updateMatrixWorld(true);

		if (skeleton) {
			for (const mesh of result.meshes) {
				if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
					(mesh as THREE.SkinnedMesh).bind(skeleton.skeleton, mesh.matrixWorld.clone());
				}
			}
		}
		this.built.push(result);
		return result;
	}

	/** Totals across every drawable added so far, plus anything they complained about. */
	get stats(): PedPreviewStats {
		let vertices = 0;
		let triangles = 0;
		let meshes = 0;
		const missingTextures: string[] = [];
		const warnings: string[] = [];
		for (const result of [...this.built, ...(this.propMeshes ? [this.propMeshes] : [])]) {
			vertices += result.vertices;
			triangles += result.triangles;
			meshes += result.meshes.length;
			missingTextures.push(...result.missingTextures);
			warnings.push(...result.warnings);
		}
		return { vertices, triangles, meshes, missingTextures, warnings };
	}

	// ------------------------------------------------------------------- prop

	/**
	 * Attach a prop's drawable to a bone tag with a placement.
	 *
	 * ⚠️ The default tag is 28422 (`PH_R_Hand`), the dedicated prop-attach helper
	 * bone — NOT `SKEL_R_Hand`, which is 57005 and is the wrist joint. The placement
	 * is the six numbers `AttachEntityToEntity` takes, applied by `prop-attach.ts`
	 * with no coordinate conversion, which is why the preview and the game agree.
	 */
	setProp(
		model: string,
		drawable: Drawable | null,
		textures: readonly TextureDictionary[],
		boneTag: number = DEFAULT_PROP_BONE_TAG,
		placement: Placement6 = [0, 0, 0, 0, 0, 0],
	): PropAttachment | null {
		this.clearProp();
		const bone = this.skeleton?.byTag.get(boneTag);
		if (!bone) return null;

		const attachment = new PropAttachment(model, boneTag);
		if (drawable) {
			const result = buildDrawableMeshes(drawable, {
				textures,
				textureCache: this.textureCache,
			});
			this.propMeshes = result;
			attachment.setSource({
				bounds: { min: drawable.boundingBoxMin, max: drawable.boundingBoxMax },
				object3D: result.object,
				name: model,
			});
		}
		attachment.setPlacement(placement);
		attachment.attachToBone(bone, boneTag);
		this.prop = attachment;
		return attachment;
	}

	private clearProp(): void {
		this.prop?.dispose();
		this.prop = null;
		this.propMeshes?.dispose();
		this.propMeshes = null;
	}

	// --------------------------------------------------------------- animation

	/**
	 * Build, bind and start a clip. Auto-loops; there is nothing here to pause it.
	 *
	 * A one-frame POSE is written straight onto the bones rather than run through the
	 * mixer: three's `LoopRepeat` divides by the clip duration, and there is nothing
	 * to interpolate anyway. `kind` on the result is how a caller tells the two apart.
	 */
	setAnimation(animation: Animation, name = "clip"): BuildAnimationClipResult | null {
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
			// Always in place. A preview is a fixed camera on a fixed subject; a clip
			// with root motion would walk its character out of frame.
			rootMotion: false,
			moverNodeName: DEFAULT_MOVER_NODE_NAME,
		});
		this.clipInfo = result;

		if (result.kind === "pose") {
			this.action = null;
			applyPose(animation, skeleton, 0);
			this.zUp.updateMatrixWorld(true);
			return result;
		}

		this.action = mixer.clipAction(result.clip);
		this.action.loop = THREE.LoopRepeat;
		this.action.play();
		mixer.setTime(0);
		this.zUp.updateMatrixWorld(true);
		return result;
	}

	/** True when the loaded asset is a single held pose rather than an animation. */
	get isPose(): boolean {
		return this.clipInfo?.kind === "pose";
	}

	/** Advance the clip. A pose ignores it, which is what makes a still stay still. */
	update(delta: number): void {
		if (this.mixer && this.action) this.mixer.update(delta);
	}

	// ------------------------------------------------------------------ camera

	/**
	 * Point the camera at the character, once.
	 *
	 * Framed from the MESH bounds when there are meshes and from the bone positions
	 * when there are not, so a rig that failed to load its body still produces a
	 * sensible picture instead of a camera at the origin looking at nothing.
	 *
	 * ⚠️ Measured at the CURRENT pose, and called after `setAnimation`. A clip's
	 * first frame can be a long way from the rest pose — a lean, a crouch — and
	 * framing the rest pose then playing the clip puts the head out of shot.
	 */
	frame(options: PedPreviewFraming = {}): void {
		const framing = { ...DEFAULT_FRAMING, ...options };
		this.framing = framing;
		this.zUp.updateMatrixWorld(true);

		const box = this.subjectBox(framing.focus);
		if (!box) return;

		const centre = box.getCenter(new THREE.Vector3());
		const size = box.getSize(new THREE.Vector3());

		const az = THREE.MathUtils.degToRad(framing.azimuthDeg);
		const el = THREE.MathUtils.degToRad(framing.elevationDeg);
		// Azimuth is measured off the character's OWN forward, toward its OWN right,
		// both read out of the current pose — see SHOULDER_TAGS for why a fixed world
		// direction cannot work here.
		const { forward, right } = this.facing();
		const up = new THREE.Vector3(0, 1, 0);
		const direction = new THREE.Vector3()
			.addScaledVector(forward, Math.cos(az) * Math.cos(el))
			.addScaledVector(right, Math.sin(az) * Math.cos(el))
			.addScaledVector(up, Math.sin(el))
			.normalize();

		const vFov = THREE.MathUtils.degToRad(this.camera.fov);
		const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);

		// ⚠️ Fit the BOX as it is seen, not a sphere around it.
		//
		// The obvious `size.length() / 2` fits a bounding sphere, and a bounding
		// sphere around a standing figure has a radius 1.7x its half-height — the arms
		// and the front-to-back depth go into the diagonal and push the camera back
		// until the character is a third of the frame with black on every side. That
		// is what this did first, and it looked like the framing code had not run.
		//
		// What matters is the SILHOUETTE along this VIEW DIRECTION: the width the box
		// projects across the view and its depth along it. Both are exact for an
		// axis-aligned box seen from a horizontal yaw, which is what this is.
		//
		// ⚠️ Computed from the world-space direction, NOT from `az`. `az` is measured
		// in the CHARACTER's frame now, and the box is world axis-aligned — using the
		// angle from one frame against extents in the other silently mixes them up.
		const view = new THREE.Vector3(direction.x, 0, direction.z);
		if (view.lengthSq() < 1e-8) view.set(0, 0, 1);
		view.normalize();
		const halfHeight = Math.max(size.y / 2, 0.02);
		const apparentWidth = Math.abs(size.x * view.z) + Math.abs(size.z * view.x);
		const apparentDepth = Math.abs(size.x * view.x) + Math.abs(size.z * view.z);

		// Fit on BOTH axes. Fitting only the vertical puts a wide gesture's hands
		// outside a 16:9 frame; fitting only the horizontal crops the head. The depth
		// term is added rather than scaled: it moves the camera off the front FACE of
		// the box, which is what stops the nearer shoulder clipping the near plane.
		const distance =
			Math.max(halfHeight / Math.tan(vFov / 2), apparentWidth / 2 / Math.tan(hFov / 2)) *
				framing.padding +
			apparentDepth / 2;

		this.camera.position.copy(centre).addScaledVector(direction, distance);
		this.camera.lookAt(centre);
		const reach = Math.max(size.length() / 2, 0.05);
		this.camera.near = Math.max(distance - reach * 1.5, 0.02);
		this.camera.far = distance + reach * 6;
		this.camera.updateProjectionMatrix();
	}

	/** Re-run the last framing against the current aspect ratio. */
	reframe(): void {
		this.frame(this.framing);
	}

	/**
	 * The character's own forward and right axes in WORLD space, in the current pose.
	 *
	 * Both are horizontal: a camera that tilted with a leaning torso would roll the
	 * horizon, which reads as a mistake rather than as a camera move. Elevation is
	 * applied separately, about world up.
	 */
	private facing(): { forward: THREE.Vector3; right: THREE.Vector3 } {
		const up = new THREE.Vector3(0, 1, 0);
		const left = this.skeleton?.byTag.get(SHOULDER_TAGS.left);
		const rightBone = this.skeleton?.byTag.get(SHOULDER_TAGS.right);

		let right: THREE.Vector3 | null = null;
		if (left && rightBone) {
			const a = new THREE.Vector3().setFromMatrixPosition(left.matrixWorld);
			const b = new THREE.Vector3().setFromMatrixPosition(rightBone.matrixWorld);
			const across = b.sub(a);
			// Flatten onto the horizontal plane BEFORE normalising, so a shrugged or
			// twisted shoulder changes the yaw and not the roll.
			across.addScaledVector(up, -across.dot(up));
			if (across.lengthSq() > 1e-8) right = across.normalize();
		}
		if (!right) {
			// No shoulders: fall back to the measured rest facing rather than to an
			// arbitrary axis, and derive `right` from it the same way.
			const forward = REST_FACING.clone();
			return { forward, right: new THREE.Vector3().crossVectors(forward, up).normalize() };
		}
		// ⚠️ `up x right`, in that order, and it is NOT the order that looks right.
		//
		// Measured on the freemode rig: `SKEL_L_Clavicle` sits at x = +0.032 and
		// `SKEL_R_Clavicle` at x = -0.032, so the character's own right is three
		// **-X** — and its face is at three **+Z**. Only `up x right` maps one to the
		// other; `right x up` gives -Z and puts the camera behind the head, which is
		// what it did, twice, before the clavicle positions were actually printed.
		const forward = new THREE.Vector3().crossVectors(up, right).normalize();
		return { forward, right };
	}

	private subjectBox(focus: "upper" | "full"): THREE.Box3 | null {
		const box = new THREE.Box3();
		let any = false;

		for (const result of this.built) {
			for (const mesh of result.meshes) {
				const bounds = mesh.geometry.boundingBox;
				if (!bounds) continue;
				// Rest-pose bounds in GTA space, lifted into world space through the
				// mesh's own matrix. Good enough to frame with: a clip moves limbs, not
				// the body's extent, by more than the padding absorbs.
				box.union(bounds.clone().applyMatrix4(mesh.matrixWorld));
				any = true;
			}
		}

		if (!any && this.skeleton) {
			const point = new THREE.Vector3();
			for (const bone of this.skeleton.bones) {
				box.expandByPoint(point.setFromMatrixPosition(bone.matrixWorld));
				any = true;
			}
		}
		if (!any || box.isEmpty()) return null;

		if (focus === "upper") {
			const floor = box.min.y + (box.max.y - box.min.y) * UPPER_BODY_FLOOR;
			// Only the vertical is clipped. Narrowing X and Z as well would crop an
			// outstretched arm, which on a radio animation is the subject.
			box.min.y = Math.min(floor, box.max.y - 1e-3);
		}
		return box;
	}

	// ------------------------------------------------------------------ teardown

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.action?.stop();
		this.action = null;
		this.mixer?.stopAllAction();
		this.mixer = null;
		this.clearProp();
		for (const result of this.built) result.dispose();
		this.built.length = 0;
		// The cache owns every texture the drawables shared, so it is disposed here
		// and not by them — see `buildDrawableMeshes`'s `ownedTextures`.
		for (const texture of this.textureCache.values()) texture?.dispose();
		this.textureCache.clear();
		if (this.skeleton) {
			for (const root of this.skeleton.roots) root.removeFromParent();
			this.skeleton.dispose();
			this.skeleton = null;
		}
		for (const light of this.lights) light.removeFromParent();
		this.lights = [];
		this.scene.clear();
	}
}
