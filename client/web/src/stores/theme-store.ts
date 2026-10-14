import { createSignal } from "solid-js";
import { onNuiEvent } from "../lib/nui";

interface ThemeDef {
  id: string;
  name?: string;
  cssVars?: Record<string, string>;
  extends?: string;
  font?: string;
  fontSize?: string;
}

const themes = new Map<string, ThemeDef>();
let activeThemeId = "";

function resolveVars(def: ThemeDef, seen = new Set<string>()): Record<string, string> {
  if (seen.has(def.id)) return {};
  seen.add(def.id);
  let vars: Record<string, string> = {};
  if (def.extends) {
    const base = themes.get(def.extends);
    if (base) vars = { ...resolveVars(base, seen) };
  }
  if (def.cssVars) Object.assign(vars, def.cssVars);
  return vars;
}

function applyTheme(): void {
  // Only write to :root. Menu-local full-color tokens and owner palettes win
  // over inherited HSL defaults; never push a global theme onto the menu root.
  applyScopedTheme(activeThemeId, document.documentElement);
}

const [themeRevision, setThemeRevision] = createSignal(0);

/**
 * The dependency `applyScopedTheme` reads internally, exported so a Solid 2
 * `createEffect(compute, apply)` can read it in COMPUTE.
 *
 * Only `compute` tracks. `applyScopedTheme` is a DOM write and belongs in
 * `apply`, but its own `themeRevision()` read would then subscribe to nothing
 * and a late theme registration would stop repainting — with no error, and
 * nothing in the markup to show for it. Every caller reads this alongside the
 * theme id it is passing.
 */
export { themeRevision };

const scopedProperties = new WeakMap<HTMLElement, string[]>();

export function applyScopedTheme(themeId: string | undefined, el: HTMLElement): void {
  // Track late registration/removal as well as a caller's selected theme id.
  themeRevision();
  for (const prop of scopedProperties.get(el) ?? []) el.style.removeProperty(prop);
  const def = themeId ? themes.get(themeId) : undefined;
  const properties: string[] = [];
  const set = (key: string, value: string) => {
    el.style.setProperty(key, value);
    properties.push(key);
  };
  if (def) {
    for (const [key, value] of Object.entries(resolveVars(def))) set(`--${key}`, value);
    if (def.font) {
      set("--font-sans", def.font);
      set("--font", def.font);
    }
    if (def.fontSize) set("font-size", def.fontSize);
  }
  scopedProperties.set(el, properties);
}

onNuiEvent<ThemeDef>("addTheme", (def) => {
  themes.set(def.id, def);
  applyTheme();
  setThemeRevision((value) => value + 1);
});

onNuiEvent<{ id: string }>("removeTheme", (data) => {
  themes.delete(data.id);
  if (activeThemeId === data.id) {
    activeThemeId = "";
  }
  applyTheme();
  setThemeRevision((value) => value + 1);
});

onNuiEvent<{ id: string }>("setTheme", (data) => {
  activeThemeId = data.id;
  applyTheme();
});
