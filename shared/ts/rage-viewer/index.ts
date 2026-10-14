// @tlib/shared/rage-viewer - three.js rendering for the RAGE readers in
// @tlib/shared/rage.
//
// Split deliberately: `rage/` parses and stays dependency-free so it can be tested
// headlessly and imported by callers that only want data; `rage-viewer/` is where
// `three` enters the graph, as a peer dependency (>=0.150.0).

export {
  type AnimViewerPlaybackState,
  AnimViewerScene,
  type AnimViewerSceneConfig,
  type TransformMode,
} from "./AnimViewerScene";
export {
  applyPose,
  type BuildAnimationClipOptions,
  type BuildAnimationClipResult,
  type BuiltClipKind,
  buildAnimationClip,
  DEFAULT_MOVER_NODE_NAME,
  describeAnimationTracks,
  enforceQuaternionContinuity,
  nativeFps,
  normaliseQuaternionValues,
  type SkippedTrack,
} from "./anim-clip";
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
  buildDrawableMeshes,
  createRageTexture,
  DIFFUSE_PARAM_HASHES,
  type DrawableMeshOptions,
  type DrawableMeshResult,
  resolveDiffuse,
} from "./drawable-mesh";
export {
  type PedPreviewFraming,
  PedPreviewRig,
  type PedPreviewRigConfig,
  type PedPreviewStats,
} from "./ped-preview";
export {
  type PreviewHandle,
  SharedPreviewRenderer,
  type SharedPreviewRendererOptions,
} from "./preview-renderer";
export {
  createPlacementRecord,
  DEFAULT_PROP_BONE_TAG,
  fivemEulerToQuaternion,
  formatPlacementLua,
  normalisePlacementRecord,
  PH_R_HAND_TAG,
  type Placement6,
  PropAttachment,
  type PropAttachmentOptions,
  type PropPlacementRecord,
  type PropSource,
  placementToTransform,
  quaternionToFivemEuler,
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
