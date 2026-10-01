// @tlib/shared/rage-viewer - three.js rendering for the RAGE readers in
// @tlib/shared/rage.
//
// Split deliberately: `rage/` parses and stays dependency-free so it can be tested
// headlessly and imported by callers that only want data; `rage-viewer/` is where
// `three` enters the graph, as a peer dependency (>=0.150.0).

export {
  AnimViewerScene,
  type AnimViewerPlaybackState,
  type AnimViewerSceneConfig,
  type TransformMode,
} from "./AnimViewerScene";
export {
  applyPose,
  buildAnimationClip,
  type BuildAnimationClipOptions,
  type BuildAnimationClipResult,
  type BuiltClipKind,
  DEFAULT_MOVER_NODE_NAME,
  describeAnimationTracks,
  enforceQuaternionContinuity,
  nativeFps,
  normaliseQuaternionValues,
  type SkippedTrack,
} from "./anim-clip";
export {
  buildDrawableMeshes,
  createRageTexture,
  DIFFUSE_PARAM_HASHES,
  type DrawableMeshOptions,
  type DrawableMeshResult,
  resolveDiffuse,
} from "./drawable-mesh";
export {
  PedPreviewRig,
  type PedPreviewFraming,
  type PedPreviewRigConfig,
  type PedPreviewStats,
} from "./ped-preview";
export {
  type PreviewHandle,
  SharedPreviewRenderer,
  type SharedPreviewRendererOptions,
} from "./preview-renderer";
export {
  type AnimationClassification,
  type AnimationKind,
  classifyAnimation,
  isFacialTrack,
  isPreviewableOnPed,
  PED_RIG_MIN_MATCH,
  type TagSource,
} from "./classify";
export {
  createPlacementRecord,
  DEFAULT_PROP_BONE_TAG,
  fivemEulerToQuaternion,
  formatPlacementLua,
  normalisePlacementRecord,
  type Placement6,
  placementToTransform,
  PropAttachment,
  type PropAttachmentOptions,
  type PropPlacementRecord,
  type PropSource,
  quaternionToFivemEuler,
  PH_R_HAND_TAG,
  SKEL_R_HAND_TAG,
  transformToPlacement,
} from "./prop-attach";
export {
  buildSkeleton,
  parseSkeletonJson,
  type RestTransform,
  type SkeletonBoneJson,
  type SkeletonJson,
  SkeletonParseError,
  type ViewerSkeleton,
} from "./skeleton";
