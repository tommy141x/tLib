import { onNuiEvent } from "@/lib/nui";

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

function resolveVars(def: ThemeDef): Record<string, string> {
  let vars: Record<string, string> = {};
  if (def.extends) {
    const base = themes.get(def.extends);
    if (base) vars = { ...resolveVars(base) };
  }
  if (def.cssVars) Object.assign(vars, def.cssVars);
  return vars;
}

function applyTheme(id: string, el: HTMLElement = document.documentElement): void {
  for (const prop of [...el.style]) {
    if (prop.startsWith("--")) el.style.removeProperty(prop);
  }

  if (!id) return;
  const def = themes.get(id);
  if (!def) return;

  const vars = resolveVars(def);
  for (const [key, val] of Object.entries(vars)) {
    el.style.setProperty(`--${key}`, val);
  }
  if (def.font) el.style.setProperty("--font-sans", def.font);
  if (def.fontSize) el.style.fontSize = def.fontSize;
}

export function applyScopedTheme(themeId: string | undefined, el: HTMLElement): void {
  if (themeId) applyTheme(themeId, el);
}

export function getActiveTheme(): string {
  return activeThemeId;
}

onNuiEvent<ThemeDef>("addTheme", (def) => {
  themes.set(def.id, def);
});

onNuiEvent<{ id: string }>("removeTheme", (data) => {
  themes.delete(data.id);
  if (activeThemeId === data.id) {
    activeThemeId = "";
  }
});

onNuiEvent<{ id: string }>("setTheme", (data) => {
  activeThemeId = data.id;
});
