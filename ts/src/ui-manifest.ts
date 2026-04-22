// Binding manifest schema for ui-* marketplace item types.
//
// A manifest describes the state shape a UI bundle binds to and the events
// it can emit. Same file drives:
//   * the studio's mock harness (generates control inputs + presets)
//   * client-side validation (unknown keys in data-hud-* → lint warning)
//   * in-game consumers (tRadio, tELS, …) as a single source of truth for
//     what they are allowed to SetHudState with.
//
// tLib owns ONLY the generic types + a mutable runtime registry. Concrete
// manifests (ui-radio, ui-tels-hud, …) live in their consumer resources and
// call registerUiManifest at boot. Studio iterates the registry via
// listUiManifests() — it never compile-time imports specific manifests.
//
// Keys are dot-pathed so `leds.R1`, `siren.stage` resolve correctly through
// HudBinder's existing resolve() logic.

// Open string. Consumers register their own keys at runtime. If a given
// consumer wants compile-time narrowing, it can declare-module-augment on
// its own side — tLib stays vocabulary-clean.
export type UiItemType = string;

export interface UiManifest {
  readonly schemaVersion: 1;
  readonly type: UiItemType;
  readonly label: string;
  readonly states: Record<string, StateDef>;
  readonly events: Record<string, EventDef>;
  readonly presets: Record<string, PresetDef>;
  readonly required?: readonly string[];
}

export type StateDef = BoolState | NumberState | StringState | EnumState | ColorState;

export interface BoolState {
  readonly kind: "boolean";
  readonly label?: string;
  readonly default?: boolean;
}

export interface NumberState {
  readonly kind: "number";
  readonly label?: string;
  readonly default?: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
}

export interface StringState {
  readonly kind: "string";
  readonly label?: string;
  readonly default?: string;
  readonly placeholder?: string;
  readonly maxLength?: number;
}

export interface EnumState {
  readonly kind: "enum";
  readonly label?: string;
  readonly values: readonly string[];
  readonly default?: string;
}

export interface ColorState {
  readonly kind: "color";
  readonly label?: string;
  readonly default?: RgbaLiteral;
}

export interface RgbaLiteral {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a?: number;
}

export interface EventDef {
  readonly label: string;
  readonly description?: string;
}

export interface PresetDef {
  readonly label: string;
  readonly state: Record<string, unknown>;
}

// ── Runtime registry ─────────────────────────────────────────────────────
// Consumers (tRadio2, tELS, …) own their manifest module and call
// registerUiManifest at boot. Re-registration with the same key overwrites
// (useful for hot-reload in studio dev).

const registry: Record<string, UiManifest> = {};

export function registerUiManifest(key: UiItemType, manifest: UiManifest): void {
  registry[key] = manifest;
}

export function getUiManifest(key: UiItemType): UiManifest | undefined {
  return registry[key];
}

export function listUiManifests(): Record<string, UiManifest> {
  return { ...registry };
}

export function unregisterUiManifest(key: UiItemType): void {
  delete registry[key];
}

// Flatten the manifest into the default state object HudBinder expects.
// Dot keys (`leds.R1`) get expanded into nested objects.
export function defaultStateFromManifest(manifest: UiManifest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(manifest.states)) {
    const value = stateDefault(def);
    if (value !== undefined) setDeep(out, key, value);
  }
  return out;
}

export function stateDefault(def: StateDef): unknown {
  switch (def.kind) {
    case "boolean":
      return def.default ?? false;
    case "number":
      return def.default ?? def.min ?? 0;
    case "string":
      return def.default ?? "";
    case "enum":
      return def.default ?? def.values[0];
    case "color":
      return def.default ?? { r: 0, g: 0, b: 0, a: 1 };
  }
}

export function applyPreset(
  base: Record<string, unknown>,
  preset: PresetDef
): Record<string, unknown> {
  const next: Record<string, unknown> = structuredClone(base);
  for (const [key, value] of Object.entries(preset.state)) {
    setDeep(next, key, value);
  }
  return next;
}

function setDeep(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (!key.includes(".")) {
    obj[key] = value;
    return;
  }
  const parts = key.split(".");
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    const existing = cursor[k];
    if (existing == null || typeof existing !== "object") {
      cursor[k] = {};
    }
    cursor = cursor[k] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}
