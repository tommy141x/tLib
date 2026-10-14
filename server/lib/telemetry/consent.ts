/**
 * Consent. One fact, one control: the convar HIDES the switch, it is not an
 * `or`, and the server is the only authority. The hub has no switch any more.
 * Design notes: docs/internal/telemetry-consent.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fGetConvar, fGetCurrentResourceName, fGetResourcePath } from "./fivem";

/** The convar. Same `tlib_` grammar and truthiness as `tlib_demo`. */
export const TELEMETRY_CONVAR = "tlib_telemetry";

/** The stored switch. Must never appear in a release archive. */
export const CONSENT_FILE = "telemetry-consent.json";

/**
 * An override for the ingest credential, so a dev run can point at a local
 * worker. Not a customer-facing setting: the shipped build authenticates with
 * `TLIB_PUBLIC_KEY` like every other tWeb call.
 */
export const TELEMETRY_KEY_CONVAR = "tlib_telemetry_key";

export type ConsentSource = "convar" | "switch" | "default";

export interface Consent {
  enabled: boolean;
  source: ConsentSource;
  /** `true` when the convar decided. Derived, so no UI has to re-decide. */
  locked: boolean;
  /** The exact convar text, so a UI can say what it was set to. Never guessed. */
  convarValue: string;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

/**
 * Read the convar. UNSET and SET-TO-NONSENSE are different answers: an
 * unparseable value resolves to `false` with `source: "convar"`, so a UI shows
 * the value it could not read instead of a control.
 */
function readConvar(): { set: boolean; enabled: boolean; raw: string } {
  let raw = "";
  try {
    raw = fGetConvar(TELEMETRY_CONVAR, "");
  } catch {
    return { set: false, enabled: false, raw: "" };
  }
  const v = raw.trim().toLowerCase();
  if (v === "") return { set: false, enabled: false, raw: "" };
  if (TRUE_VALUES.has(v)) return { set: true, enabled: true, raw };
  if (FALSE_VALUES.has(v)) return { set: true, enabled: false, raw };
  return { set: true, enabled: false, raw };
}

function selfPath(file: string): string | null {
  try {
    const root = fGetResourcePath(fGetCurrentResourceName());
    return root ? path.join(root, file) : null;
  } catch {
    return null;
  }
}

/** The stored switch, or `null` when it has never been set. */
export function readStoredSwitch(): boolean | null {
  const target = selfPath(CONSENT_FILE);
  if (!target) return null;
  try {
    if (!fs.existsSync(target)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { enabled?: unknown }).enabled === "boolean"
    ) {
      return (parsed as { enabled: boolean }).enabled;
    }
    // A file that exists and does not parse is UNSET, not off: a corrupt file
    // is not evidence of a decision, and showing the switch is recoverable.
    return null;
  } catch {
    return null;
  }
}

export type SetConsentResult =
  | { ok: true; consent: Consent }
  | { ok: false; reason: "locked" | "write-failed"; detail: string; consent: Consent };

/**
 * Write the stored switch. REFUSES when the convar has decided rather than
 * storing a value that would then be ignored.
 */
export function setStoredSwitch(enabled: boolean): SetConsentResult {
  const current = resolve();
  if (current.locked) {
    return {
      ok: false,
      reason: "locked",
      detail: `${TELEMETRY_CONVAR} is set to "${current.convarValue}"; the convar decides and the switch is hidden. Unset it to use the switch.`,
      consent: current,
    };
  }
  const target = selfPath(CONSENT_FILE);
  if (!target) {
    return {
      ok: false,
      reason: "write-failed",
      detail: "could not resolve tLib's own resource path",
      consent: current,
    };
  }
  try {
    fs.writeFileSync(target, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
  } catch (e) {
    return {
      ok: false,
      reason: "write-failed",
      detail: e instanceof Error ? e.message : String(e),
      consent: current,
    };
  }
  return { ok: true, consent: resolve() };
}

/**
 * THE answer. Not memoised: a cached verdict means a mid-session convar or
 * switch change silently does nothing. Called once per flush, not per event.
 */
export function resolve(): Consent {
  const convar = readConvar();
  if (convar.set) {
    return {
      enabled: convar.enabled,
      source: "convar",
      locked: true,
      convarValue: convar.raw,
    };
  }
  const stored = readStoredSwitch();
  if (stored !== null) {
    return { enabled: stored, source: "switch", locked: false, convarValue: "" };
  }
  return { enabled: false, source: "default", locked: false, convarValue: "" };
}

/**
 * The per-install id is NOT owned here and is not re-exported: callers import
 * `server/lib/install-id.ts`. It rides every tWeb-bound request whether or not
 * diagnostics are on, so the convar does not govern it.
 */
