export { cliArg } from "./argv.ts";
export type { BuildResult } from "./bun-builder.ts";
export {
  buildServerBundle,
  bunBuild,
  copyAssets,
  DEFAULT_HTML_MINIFY_OPTS,
  minifyHtmlFile,
  viteBuild,
} from "./bun-builder.ts";
export type { ProdConfig } from "./core.ts";
export {
  addDirToZip,
  buildViteUI,
  cleanDir,
  createZip,
  installDeps,
  run,
  runProd,
  stageFiles,
  step,
} from "./core.ts";
export type {
  DeckCheckResult,
  DeckPaths,
  DeckPluginConfig,
  DeckSourceFile,
  DeckSourceScan,
  DeckStamp,
} from "./deck-pack.ts";
export {
  checkDeckArtifact,
  deckPaths,
  packDeckPlugin,
  readDeckStamp,
  scanDeckSources,
} from "./deck-pack.ts";
export type {
  CssContractOptions,
  CssRule,
  ShadowFinding,
  SurfaceCollision,
} from "./css-contract.ts";
export {
  blurredShadow,
  cssRules,
  findBlurredShadows,
  findSurfaceCollisions,
  formatBlurredShadows,
  formatSurfaceCollisions,
  SURFACE_CSS,
  subjectClasses,
  surfaceClassNames,
} from "./css-contract.ts";
/**
 * The CEF 103 output contract — what a NUI bundle may not contain.
 *
 * Deliberately separate from `css-contract.ts`: that one owns the blurred
 * `box-shadow` length parser and the surface-collision rules, and this one reads
 * only the BUILT stylesheet for constructs the engine silently drops. Two gates,
 * no overlap, so neither has to know the other's job.
 *
 * It carries two floors — `R-MEDIA-FLOOR` and `R-SIZE-FLOOR` — because "no
 * `oklch` found" and "no CSS was read" are otherwise the same green. That earned
 * itself immediately: pointed at a Vite staging directory emptied after assets
 * are hoisted, it went red on both floors instead of passing confidently on
 * nothing.
 */
export type { CefContractOptions, CefContractResult, CefFinding } from "./cef-output-contract.ts";
export { checkCefOutput, formatCefResult } from "./cef-output-contract.ts";
export type { DeadClass, DeadClassOptions } from "./dead-classes.ts";
export { findDeadClasses, formatDeadClasses, runDeadClassCheck } from "./dead-classes.ts";
export type { DevConfig, WatcherDef } from "./dev.ts";
export { startDevMode } from "./dev.ts";
export type {
  GalleryCli,
  GalleryResult,
  GalleryShot,
  GalleryState,
  HudGalleryOptions,
} from "./hud-gallery.ts";
export {
  fileUrl,
  findChromium,
  listLayouts,
  parseGalleryCli,
  renderHudGallery,
  statesFromManifest,
} from "./hud-gallery.ts";
export { checkLicenseCompliance } from "./license.ts";
export type { ManifestCoverage } from "./manifest-coverage.ts";
export {
  assertManifestOnDisk,
  assertManifestStaged,
  manifestCoverage,
  manifestCoverageOnDisk,
  stagedPrefix,
  stripLuaComments,
} from "./manifest-coverage.ts";
export type {
  MarketplaceReleaseMetadata,
  MarketplaceReleaseMetadataOptions,
} from "./marketplace-inventory.ts";
export { writeMarketplaceReleaseMetadata } from "./marketplace-inventory.ts";
export type {
  PropEditorGalleryCli,
  PropEditorGalleryInit,
  PropEditorGalleryOptions,
  PropEditorGalleryResult,
  PropEditorGalleryShot,
  PropEditorGalleryStep,
  PropEditorGalleryView,
} from "./prop-editor-gallery.ts";
export {
  clickTool,
  EDITOR_UP,
  ensureNuiBundle,
  GALLERY_PROP_DATA,
  GALLERY_VEHICLE_MATRIX,
  parsePropEditorGalleryCli,
  PROP_EDITOR_ROOT,
  renderPropEditorGallery,
  reportPropEditorGallery,
  SHARED_PROP_EDITOR_VIEWS,
  stripPropEditorGalleryArgs,
  toolActive,
  toolSelector,
} from "./prop-editor-gallery.ts";
export type { StagingConfig } from "./prod.ts";
export { ProductionStager } from "./prod.ts";
export type { StandardBuildOptions } from "./resource.ts";
export { buildStandardResource, runStandardBuild } from "./resource.ts";
export type { VersionTarget } from "./version.ts";
export {
  getManifestVersion,
  readBackVersions,
  syncVersions,
  syncVersionToCargoToml,
  syncVersionToJson,
  syncVersionToTsConst,
  throwIfMissed,
  toSemver,
} from "./version.ts";
export type { NuiBundleOptions } from "./nui-vite.ts";
export { nuiBundleOptions } from "./nui-vite.ts";
export type {
  SelfHostWebFontsOptions,
  SelfHostWebFontsResult,
  WebFontFamily,
} from "./web-fonts.ts";
export { selfHostWebFonts } from "./web-fonts.ts";
