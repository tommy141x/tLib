import type { ClassValue } from "clsx";
import clsx from "clsx";
import type { Component, JSX } from "solid-js";
import {
  createContext,
  createEffect,
  createSignal,
  For,
  onMount,
  Show,
  splitProps,
  useContext,
} from "solid-js";
import { unoMerge } from "unocss-merge";
import IconCheck from "~icons/lucide/check";

function cn(...classLists: ClassValue[]) {
  return unoMerge(clsx(classLists));
}

export interface ThemeVars {
  [key: string]: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  description?: string;
  cssVars?: ThemeVars;
  /** Another theme's id; inheritance is recursive. */
  extends?: string;
  font?: string;
  /** A percentage, e.g. "87.5%" for 14px. Applied to <html> so rem scales. */
  fontSize?: string;
}

export interface ThemeConfig {
  themes: ThemeDefinition[];
  defaultTheme?: string;
  /** localStorage key; defaults to "theme". */
  storageKey?: string;
  /** Defaults to "class". */
  attribute?: "class" | "data-theme";
  /** Defaults to true. */
  syncAcrossTabs?: boolean;
}

interface ThemeContextValue {
  theme: () => string;
  setTheme: (themeId: string) => void;
  themes: () => ThemeDefinition[];
  currentTheme: () => ThemeDefinition | undefined;
  /** False until onMount, i.e. until storage has been read. */
  mounted: () => boolean;
}

const ThemeContext = createContext<ThemeContextValue>();

export interface ThemeProviderProps {
  children: JSX.Element;
  config: ThemeConfig;
}

export const ThemeProvider: Component<ThemeProviderProps> = (props) => {
  const config = props.config;
  const storageKey = config.storageKey || "theme";
  const attribute = config.attribute || "class";
  const syncAcrossTabs = config.syncAcrossTabs ?? true;

  const [themes] = createSignal<ThemeDefinition[]>(config.themes);

  // Start on the default: reading storage here would mismatch the server render.
  const [theme, setThemeState] = createSignal<string>(
    config.defaultTheme || config.themes[0]?.id || ""
  );
  const [mounted, setMounted] = createSignal(false);

  const setTheme = (themeId: string) => {
    const themeExists = config.themes.some((t) => t.id === themeId);
    if (!themeExists) {
      console.warn(`Theme "${themeId}" not found in available themes`);
      return;
    }

    setThemeState(themeId);
    if (typeof window !== "undefined") {
      localStorage.setItem(storageKey, themeId);
    }
  };

  const currentTheme = () => {
    return themes().find((t) => t.id === theme());
  };

  const collectThemeVars = (themeId: string, visited = new Set<string>()): ThemeVars => {
    if (visited.has(themeId)) {
      console.warn(`Circular theme dependency detected: ${themeId}`);
      return {};
    }
    visited.add(themeId);

    const themeDef = themes().find((t) => t.id === themeId);
    if (!themeDef) return {};

    let mergedVars: ThemeVars = {};
    if (themeDef.extends) {
      mergedVars = collectThemeVars(themeDef.extends, visited);
    }
    if (themeDef.cssVars) {
      mergedVars = { ...mergedVars, ...themeDef.cssVars };
    }
    if (themeDef.font) {
      mergedVars["font-sans"] = themeDef.font;
    }
    if (themeDef.fontSize) {
      mergedVars["font-size"] = themeDef.fontSize;
    }

    return mergedVars;
  };

  const applyTheme = (themeId: string) => {
    if (typeof document === "undefined") return;

    const themeDef = themes().find((t) => t.id === themeId);
    if (!themeDef) return;

    const root = document.documentElement;

    if (attribute === "class") {
      themes().forEach((t) => {
        root.classList.remove(t.id);
      });

      const themeChain: string[] = [];
      let currentId: string | undefined = themeId;
      const visited = new Set<string>();

      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        themeChain.unshift(currentId);
        const current = themes().find((t) => t.id === currentId);
        currentId = current?.extends;
      }

      // 'base' lives on :root rather than a class of its own.
      themeChain.forEach((id) => {
        if (id !== "base") {
          root.classList.add(id);
        }
      });
    } else {
      root.setAttribute("data-theme", themeId);
    }

    const existingStyle = document.getElementById("theme-vars-override");
    if (existingStyle) {
      existingStyle.remove();
    }

    // Only what the theme names is overridden; the rest falls back to the
    // stylesheet's :root or .themeClass.
    const mergedVars = collectThemeVars(themeId);
    if (Object.keys(mergedVars).length > 0) {
      const style = document.createElement("style");
      style.id = "theme-vars-override";

      const { "font-size": fontSize, ...otherVars } = mergedVars;

      let cssContent = "";
      if (fontSize) {
        cssContent += `html {\n  font-size: ${fontSize};\n}\n`;
      }
      if (Object.keys(otherVars).length > 0) {
        const cssVarEntries = Object.entries(otherVars)
          .map(([key, value]) => {
            const cssVar = key.startsWith("--") ? key : `--${key}`;
            return `  ${cssVar}: ${value};`;
          })
          .join("\n");

        cssContent += `:root {\n${cssVarEntries}\n}`;
      }

      style.textContent = cssContent;
      document.head.appendChild(style);
    }
  };

  createEffect(() => {
    if (!mounted()) return;
    applyTheme(theme());
  });

  createEffect(() => {
    if (!mounted() || !syncAcrossTabs) return;

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === storageKey && e.newValue) {
        setThemeState(e.newValue);
      }
    };

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  });

  onMount(() => {
    const stored = localStorage.getItem(storageKey);
    if (stored && config.themes.some((t) => t.id === stored)) {
      setThemeState(stored);
      applyTheme(stored);
    } else {
      applyTheme(theme());
    }
    setMounted(true);
  });

  return (
    <ThemeContext.Provider
      value={{
        theme,
        setTheme,
        themes,
        currentTheme,
        mounted,
      }}
    >
      {props.children}
    </ThemeContext.Provider>
  );
};

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

/** undefined outside a ThemeProvider, where useTheme would throw. */
export function useThemeSafe() {
  return useContext(ThemeContext);
}

export interface ThemeSwitcherProps {
  class?: string;
  showDescription?: boolean;
  renderButton?: (theme: ThemeDefinition, isActive: boolean) => JSX.Element;
}

export const ThemeSwitcher: Component<ThemeSwitcherProps> = (props) => {
  const { themes, theme: currentThemeId, setTheme, mounted } = useTheme();
  const [local, others] = splitProps(props, ["class", "showDescription", "renderButton"]);

  return (
    <Show when={mounted()} fallback={<div class="animate-pulse h-20 w-full bg-muted/50 rounded" />}>
      <div class={cn("flex flex-col gap-2", local.class)} {...others}>
        <For each={themes()}>
          {(themeDef) => {
            const isActive = currentThemeId() === themeDef.id;

            if (local.renderButton) {
              return (
                <button type="button" onClick={() => setTheme(themeDef.id)}>
                  {local.renderButton(themeDef, isActive)}
                </button>
              );
            }

            return (
              <button
                type="button"
                onClick={() => setTheme(themeDef.id)}
                class={cn(
                  "flex flex-col items-start gap-1 p-3 rounded-lg border-2 transition-all text-left",
                  "hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isActive
                    ? "border-primary bg-primary/5"
                    : "border-border bg-card hover:border-primary/50"
                )}
                aria-label={`Select ${themeDef.name} theme`}
                aria-pressed={isActive}
              >
                <div class="flex items-center justify-between w-full">
                  <span class="font-medium">{themeDef.name}</span>
                  <Show when={isActive}>
                    <IconCheck class="size-4 text-primary" />
                  </Show>
                </div>
                <Show when={local.showDescription && themeDef.description}>
                  <span class="text-xs text-muted-foreground">{themeDef.description}</span>
                </Show>
              </button>
            );
          }}
        </For>
      </div>
    </Show>
  );
};

/**
 * A blocking script for <head>, ahead of any content: it sets the theme class
 * before first paint so there is no flash of the default theme.
 *
 *   <script innerHTML={themeScript(config)} />
 */
export const themeScript = (config: ThemeConfig) => {
  const storageKey = config.storageKey || "theme";
  const attribute = config.attribute || "class";
  const defaultTheme = config.defaultTheme || config.themes[0]?.id || "";
  const themeIds = config.themes.map((t) => t.id);

  return `
    (function() {
      try {
        var theme = localStorage.getItem('${storageKey}');
        var validThemes = ${JSON.stringify(themeIds)};

        if (!theme || validThemes.indexOf(theme) === -1) {
          theme = '${defaultTheme}';
        }

        if ('${attribute}' === 'class') {
          document.documentElement.classList.add(theme);
        } else {
          document.documentElement.setAttribute('data-theme', theme);
        }
      } catch (e) {}
    })();
  `.trim();
};

export { ThemeProvider as Theme };
