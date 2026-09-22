// tLib's own UI re-exports the shared NUI utilities.
// Consumer tScripts import from @tlib/shared/nui directly.
export {
  fetchNui,
  getResourceName,
  isNUI,
  onAnyNuiEvent,
  onNuiEvent,
} from "../../../../shared/ts/nui";
