import { createSignal } from "solid-js";
import { onNuiEvent } from "@/lib/nui";
import { applyScopedTheme, themeRevision } from "@/stores/theme-store";

// The existing global theme host changes root styles on setTheme without bumping
// its registration revision. Observe that event locally; do not change menu theming.
const [globalRevision, setGlobalRevision] = createSignal(0);
onNuiEvent("setTheme", () => setGlobalRevision((value) => value + 1));

/**
 * Every reactive dependency `applyNuiTheme` has, as one accessor.
 *
 * Solid 2's `createEffect(compute, apply)` only tracks `compute`, so the two
 * revision reads buried inside `applyNuiTheme` (its own, and the one inside
 * `applyScopedTheme`) no longer subscribe to anything from an `apply` half.
 * Callers read this in compute; forgetting it leaves the panel on a stale
 * theme after `setTheme`, silently.
 */
export function nuiThemeDeps(): void {
  globalRevision();
  themeRevision();
}

/** Neutral stock NUI controls; an explicitly registered HSL primary still wins.
 * Do not infer an override from computed --primary: :root's stock value is blue.
 * Clear adapter-owned aliases before reapplying so theme removal returns neutral. */
export function applyNuiTheme(theme: string | undefined, element: HTMLElement) {
  globalRevision();
  for (const name of ["--nui-accent", "--nui-accent-raw", "--nui-accent-text", "--nui-danger"])
    element.style.removeProperty(name);
  applyScopedTheme(theme, element);
  const explicit = (name: string) =>
    element.style.getPropertyValue(name) || document.documentElement.style.getPropertyValue(name);
  if (explicit("--primary") && !element.style.getPropertyValue("--nui-accent")) {
    element.style.setProperty("--nui-accent", "hsl(var(--primary))");
    // --nui-accent-raw must move with --nui-accent. It holds the bare triplet the
    // alpha tints in nui.css are built on (focus ring 0.24, slider thumb 0.18),
    // and those cannot read it back out of the resolved colour above. Leave it
    // behind and a themed panel gets a theme-coloured border with a stock-white
    // focus ring. This relies on the same contract as the line above it: a
    // registered --primary is a bare HSL triplet, not a complete colour.
    element.style.setProperty("--nui-accent-raw", "var(--primary)");
    element.style.setProperty("--nui-accent-text", "hsl(var(--primary-foreground))");
  }
  if (explicit("--destructive") && !element.style.getPropertyValue("--nui-danger")) {
    element.style.setProperty("--nui-danger", "hsl(var(--destructive))");
  }
}
