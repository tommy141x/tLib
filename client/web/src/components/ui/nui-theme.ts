import { createSignal } from "solid-js";
import { onNuiEvent } from "@/lib/nui";
import { applyScopedTheme } from "@/stores/theme-store";

// The existing global theme host changes root styles on setTheme without bumping
// its registration revision. Observe that event locally; do not change menu theming.
const [globalRevision, setGlobalRevision] = createSignal(0);
onNuiEvent("setTheme", () => setGlobalRevision((value) => value + 1));

/** Neutral stock NUI controls; an explicitly registered HSL primary still wins.
 * Do not infer an override from computed --primary: :root's stock value is blue.
 * Clear adapter-owned aliases before reapplying so theme removal returns neutral. */
export function applyNuiTheme(theme: string | undefined, element: HTMLElement) {
  globalRevision();
  for (const name of ["--nui-accent", "--nui-accent-text", "--nui-danger"])
    element.style.removeProperty(name);
  applyScopedTheme(theme, element);
  const explicit = (name: string) =>
    element.style.getPropertyValue(name) || document.documentElement.style.getPropertyValue(name);
  if (explicit("--primary") && !element.style.getPropertyValue("--nui-accent")) {
    element.style.setProperty("--nui-accent", "hsl(var(--primary))");
    element.style.setProperty("--nui-accent-text", "hsl(var(--primary-foreground))");
  }
  if (explicit("--destructive") && !element.style.getPropertyValue("--nui-danger")) {
    element.style.setProperty("--nui-danger", "hsl(var(--destructive))");
  }
}
