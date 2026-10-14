// Binding manifest schema for ui-* marketplace item types: the state shape a UI
// bundle binds to and the events it can emit. One source of truth for the
// studio's mock harness, for data-hud-* lint warnings, and for what an in-game
// consumer is allowed to SetHudState with.
//
// tLib owns the generic types and the helpers that read them. Concrete manifests
// live in their consumer resources — `uiRadarManifest`, `uiTelsHudManifest`,
// `uiDetectorManifest`, `uiRadioSkinManifest` — and tWeb's Studio VENDORS those
// files at build time (`scripts/sync-hud-sdk.ts`) so it can preview a layout
// with no game running.
//
// There was a runtime registry here — `registerUiManifest`, `getUiManifest`,
// `listUiManifests`, `unregisterUiManifest` — and three resources called the
// setter at boot. Nothing ever called a getter, in any repo: it was write-only
// for its whole life, kept "so a tool can iterate listUiManifests()" for a tool
// that was never written. The vendoring above is what the Studio actually does
// and it cannot use a registry anyway, because it runs with no game attached.
// Do not reintroduce one speculatively; add it when something reads it.
//
// There was also a STATIC registry here — `shared/ts/manifests.ts`, exported as
// `@tlib/shared/manifests`, holding hand-copied bodies of `uiRadioManifest` and
// `uiTelsHudManifest` under a comment saying "kept in sync manually". It is gone,
// and the two reasons it went are both reasons not to write another one:
//
//   1. It had already drifted, materially. 148 lines standing in for tRadio's 323
//      and 83 for tELS' 213: it defaulted the radio display to `ln01: "CH 01"` /
//      `ln02: "CITY PD"` and the softkeys to "ZN"/"CH"/"ST" — text tRadio has
//      never rendered on any screen — and had no `topLine1`, `topLine2` or
//      `zoneBankLetter` at all, which are the keys the painted heads bind. This is
//      the same defect tWeb's `scripts/sync-hud-sdk.ts` header describes finding
//      in its own hand-written port, inherited from tg-new's.
//   2. It could not be fixed by gating it the way `shared/ts/deck` is gated. That
//      vendoring runs from this PUBLIC library into private consumers. A manifest
//      sync would run the other way — tLib reading tRadio and tELS — which
//      inverts the dependency tLib exists to keep one-directional and puts two
//      paid resources' manifests in a public repo.
//
// Its only consumer was `internal/tgstudios-v2`, which now reads the real
// manifests off disk through its own sibling alias. A project that CANNOT see the
// siblings at build time should port tWeb's `hud-sdk:sync`/`hud-sdk:check` pair
// rather than copy a manifest by hand.
//
// Keys are dot-pathed so `leds.R1` resolves through HudBinder's `read()`.

// Open string: a consumer wanting compile-time narrowing augments the module on
// its own side, which keeps tLib vocabulary-clean.
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
  readonly hidden?: boolean;
  /** Canvas preview background for elements gated on this key, when truthy. */
  readonly previewBackground?: string;
}

export interface NumberState {
  readonly kind: "number";
  readonly label?: string;
  readonly default?: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
  readonly hidden?: boolean;
}

export interface StringState {
  readonly kind: "string";
  readonly label?: string;
  readonly default?: string;
  readonly placeholder?: string;
  readonly maxLength?: number;
  readonly hidden?: boolean;
}

export interface EnumState {
  readonly kind: "enum";
  readonly label?: string;
  readonly values: readonly string[];
  readonly default?: string;
  readonly hidden?: boolean;
}

export interface ColorState {
  readonly kind: "color";
  readonly label?: string;
  readonly default?: RgbaLiteral;
  readonly hidden?: boolean;
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

/** The default state object HudBinder expects, with dot keys expanded. */
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
  // NOT structuredClone: `base` is routinely a reactive store proxy (a Solid studio passes its
  // mock state straight in) and proxies throw DataCloneError. Mock state is plain JSON-shaped
  // either way, so the round-trip is equivalent and works in every host.
  const next: Record<string, unknown> = JSON.parse(JSON.stringify(base));
  for (const [key, value] of Object.entries(preset.state)) {
    setDeep(next, key, value);
  }
  return next;
}

/** Dot-path read — the same resolution HudBinder.resolve() performs, for callers outside it. */
export function resolveState(key: string, state: Record<string, unknown>): unknown {
  if (!key.includes(".")) return state[key];
  let cursor: unknown = state;
  for (const part of key.split(".")) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** Dot-path write, expanding `leds.R1` into nested objects. The write side of resolveState. */
export function setDeep(obj: Record<string, unknown>, key: string, value: unknown): void {
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
