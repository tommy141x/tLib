// Staged installs with rollback and receipts. Legacy verification proves byte
// equivalence only, never marketplace ownership or permission to mutate built-ins.
//
// This file is the public surface; the modules behind it are internal.
export type {
  InstallFailure,
  InstallOutcome,
  InstallResult,
  InstallTarget,
  ProtectedBuiltinInventory,
  UninstallOutcome,
  UninstallResult,
} from "./installer/core";
export type { InstallationInspection, InstallationInspectionOutcome } from "./installer/inspection";
export { inspectInstallation } from "./installer/inspection";
export { installFromData, uninstallItem } from "./installer/install";
export type {
  LegacyAdoptionAuthorization,
  LegacyAdoptionOutcome,
  LegacyAdoptionResult,
  LegacyVerificationOutcome,
  LegacyVerificationResult,
} from "./installer/legacy";
export {
  adoptLegacyInstallationFromData,
  verifyLegacyInstallationFromData,
} from "./installer/legacy";
export type {
  MarketplaceLockInspection,
  MarketplaceLockOwner,
  MarketplaceLockRecoveryConfirmation,
} from "./installer/lock";
export { inspectMarketplaceLock, recoverMarketplaceLock } from "./installer/lock";
export { protectedInventoryFromRelease, snapshotProtectedInventory } from "./installer/protected";
