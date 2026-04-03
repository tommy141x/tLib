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

// ============================================================================
// Types
// ============================================================================

/**
 * CSS custom properties for a theme
 */
export interface ThemeVars {
  [key: string]: string;
}

/**
 * A theme definition
 */
export interface ThemeDefinition {
  /** Unique identifier for the theme */
  id: string;
  /** Display name */
  name: string;
  /** Optional description */
  description?: string;
  /** CSS custom properties to apply */
  cssVars?: ThemeVars;
  /** Base theme to extend from (supports recursive inheritance) */
  extends?: string;
  /** Font family to use (e.g., "Inter", "Space Grotesk", "Press Start 2P") */
  font?: string;
  /** Base font size as percentage (e.g., "87.5%" for 14px, "100%" for 16px) */
  fontSize?: string;
}

/**
 * Configuration for the theme system
 */
export interface ThemeConfig {
  /** Available themes */
  themes: ThemeDefinition[];
  /** Default theme ID */
  defaultTheme?: string;
  /** Storage key for persistence (defaults to "theme") */
  storageKey?: string;
  /** Attribute to set on root element: "class" or "data-theme" (defaults to "class") */
  attribute?: "class" | "data-theme";
  /** Whether to sync theme across tabs (defaults to true) */
  syncAcrossTabs?: boolean;
}

interface ThemeContextValue {
  /** Current theme ID */
  theme: () => string;
  /** Set the theme by ID */
  setTheme: (themeId: string) => void;
  /** Get all available themes */
  themes: () => ThemeDefinition[];
  /** Get the current theme definition */
  currentTheme: () => ThemeDefinition | undefined;
  /** Check if mounted (client-side only) */
  mounted: () => boolean;
}

// ============================================================================
// Context
// ============================================================================

const ThemeContext = createContext<ThemeContextValue>();

// ============================================================================
// Provider
// ============================================================================

export interface ThemeProviderProps {
  children: JSX.Element;
  /** Configuration options */
  config: ThemeConfig;
}

export const ThemeProvider: Component<ThemeProviderProps> = (props) => {
  const config = props.config;
  const storageKey = config.storageKey || "theme";
  const attribute = config.attribute || "class";
  const syncAcrossTabs = config.syncAcrossTabs ?? true;

  const [themes] = createSignal<ThemeDefinition[]>(config.themes);

  // Initialize theme - always start with default to avoid hydration mismatch
  const [theme, setThemeState] = createSignal<string>(
    config.defaultTheme || config.themes[0]?.id || "",
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

  // Recursively collect CSS vars from base themes
  const collectThemeVars = (
    themeId: string,
    visited = new Set<string>(),
  ): ThemeVars => {
    // Prevent circular dependencies
    if (visited.has(themeId)) {
      console.warn(`Circular theme dependency detected: ${themeId}`);
      return {};
    }
    visited.add(themeId);

    const themeDef = themes().find((t) => t.id === themeId);
    if (!themeDef) return {};

    // If theme extends another, recursively collect base vars first
    let mergedVars: ThemeVars = {};
    if (themeDef.extends) {
      mergedVars = collectThemeVars(themeDef.extends, visited);
    }

    // Merge current theme's vars on top of base vars
    if (themeDef.cssVars) {
      mergedVars = { ...mergedVars, ...themeDef.cssVars };
    }

    // Add font if specified
    if (themeDef.font) {
      mergedVars["font-sans"] = themeDef.font;
    }

    // Add fontSize if specified
    if (themeDef.fontSize) {
      mergedVars["font-size"] = themeDef.fontSize;
    }

    return mergedVars;
  };

  // Apply theme to document
  const applyTheme = (themeId: string) => {
    if (typeof document === "undefined") return;

    const themeDef = themes().find((t) => t.id === themeId);
    if (!themeDef) return;

    const root = document.documentElement;

    // Remove all theme classes/attributes
    if (attribute === "class") {
      themes().forEach((t) => {
        root.classList.remove(t.id);
      });

      // Apply theme class and all parent classes for CSS-defined themes
      const themeChain: string[] = [];
      let currentId: string | undefined = themeId;
      const visited = new Set<string>();

      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        themeChain.unshift(currentId);
        const current = themes().find((t) => t.id === currentId);
        currentId = current?.extends;
      }

      // Apply all classes in the inheritance chain
      // Skip 'base' as it uses :root, not a CSS class
      themeChain.forEach((id) => {
        if (id !== "base") {
          root.classList.add(id);
        }
      });
    } else {
      root.setAttribute("data-theme", themeId);
    }

    // Remove any previously applied inline CSS variables (for proper merging)
    // Only remove variables that were set by themes, not base CSS
    const existingStyle = document.getElementById("theme-vars-override");
    if (existingStyle) {
      existingStyle.remove();
    }

    // Collect all CSS vars including inherited ones
    const mergedVars = collectThemeVars(themeId);

    // Apply CSS variables if provided
    // Only override what's defined in the theme - everything else falls back to :root or .themeClass in CSS
    if (Object.keys(mergedVars).length > 0) {
      const style = document.createElement("style");
      style.id = "theme-vars-override";

      // Separate fontSize from other CSS vars - it needs to go on html element
      const { "font-size": fontSize, ...otherVars } = mergedVars;

      let cssContent = "";

      // Apply fontSize to html element for proper rem scaling
      if (fontSize) {
        cssContent += `html {\n  font-size: ${fontSize};\n}\n`;
      }

      // Apply other CSS vars to :root
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

  // Apply theme when it changes
  createEffect(() => {
    if (!mounted()) return;
    applyTheme(theme());
  });

  // Listen for storage changes (sync across tabs)
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

  // Initialize on mount - restore saved theme from localStorage
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

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook to access theme state and controls
 * Must be used within a ThemeProvider
 */
export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

/**
 * Hook to access theme state and controls (safe version)
 * Returns undefined if not within a ThemeProvider
 */
export function useThemeSafe() {
  return useContext(ThemeContext);
}

// ============================================================================
// Theme Switcher Component (Optional convenience component)
// ============================================================================

export interface ThemeSwitcherProps {
  class?: string;
  /** Show theme descriptions */
  showDescription?: boolean;
  /** Render custom button for each theme */
  renderButton?: (theme: ThemeDefinition, isActive: boolean) => JSX.Element;
}

export const ThemeSwitcher: Component<ThemeSwitcherProps> = (props) => {
  const { themes, theme: currentThemeId, setTheme, mounted } = useTheme();
  const [local, others] = splitProps(props, [
    "class",
    "showDescription",
    "renderButton",
  ]);

  return (
    <Show
      when={mounted()}
      fallback={<div class="animate-pulse h-20 w-full bg-muted/50 rounded" />}
    >
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
                    : "border-border bg-card hover:border-primary/50",
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
                  <span class="text-xs text-muted-foreground">
                    {themeDef.description}
                  </span>
                </Show>
              </button>
            );
          }}
        </For>
      </div>
    </Show>
  );
};

// ============================================================================
// Blocking Script (prevents flash of unstyled content)
// ============================================================================

/**
 * Generate a script to prevent flash of unstyled content
 * Inject this in your document <head> before any content
 *
 * @example
 * // In your app's <head>:
 * <script innerHTML={themeScript(config)} />
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

        // Apply CSS variables if theme has overrides
        // This would need to be generated dynamically based on your themes
      } catch (e) {}
    })();
  `.trim();
};

export { ThemeProvider as Theme };
