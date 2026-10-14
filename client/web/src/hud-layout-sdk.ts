import { layoutRect, MAX_OFFSET, REFERENCE_HEIGHT } from "@tlib/shared/hud-geometry";
import type { HudLayoutClient, HudLayoutUpdate as Update } from "../../../shared/ts/hud-layout";

type Binding = {
  element: HTMLElement;
  previousStyle: string | null;
  previousHidden: boolean;
  onEdit?: (editing: boolean) => void;
};
const bindings = new Map<string, Binding>();
const latest = new Map<string, Update>();
const anchors = new Set(["top-left", "top-right", "bottom-left", "bottom-right", "center"]);
function valid(data: unknown): data is Update {
  if (!data || typeof data !== "object") return false;
  const d = data as Update,
    l = d.layout;
  return (
    typeof d.id === "string" &&
    d.id.length <= 80 &&
    typeof d.editing === "boolean" &&
    !!l &&
    anchors.has(l.anchor) &&
    typeof l.visible === "boolean" &&
    [l.x, l.y, l.scale, d.width, d.height].every(Number.isFinite) &&
    Math.abs(l.x) <= MAX_OFFSET &&
    Math.abs(l.y) <= MAX_OFFSET &&
    l.scale >= 0.1 &&
    l.scale <= 4 &&
    d.width >= 8 &&
    d.width <= 4096 &&
    d.height >= 8 &&
    d.height <= 4096
  );
}
function apply(id: string) {
  const binding = bindings.get(id),
    update = latest.get(id);
  if (!binding || !update) return;
  const rect = layoutRect(update, update.layout, { width: innerWidth, height: innerHeight });
  // Use a dedicated wrapper: the widget's own transforms and contextual visibility stay untouched.
  // Placement rides on one composited transform rather than left/top, so a drag
  // preview does not relayout the consumer's whole document every frame.
  Object.assign(binding.element.style, {
    position: "fixed",
    left: "0px",
    top: "0px",
    right: "auto",
    bottom: "auto",
    width: `${update.width}px`,
    height: `${update.height}px`,
    transformOrigin: "top left",
    transform: `translate3d(${rect.left}px, ${rect.top}px, 0) scale(${(innerHeight / REFERENCE_HEIGHT) * update.layout.scale})`,
    willChange: update.editing ? "transform" : "",
    pointerEvents: update.editing ? "none" : "",
  });
  binding.element.hidden = !update.layout.visible;
  binding.onEdit?.(update.editing);
}
window.addEventListener("message", (event: MessageEvent) => {
  const data: unknown = event.data?.tlibHud;
  if (!valid(data)) return;
  if (!bindings.has(data.id) && latest.size >= 64) return;
  latest.set(data.id, data);
  apply(data.id);
});
window.addEventListener("resize", () => {
  for (const id of bindings.keys()) apply(id);
});

let readyPromise: Promise<void> | undefined;
function ready() {
  if (readyPromise) return readyPromise;
  const host = (
    window as Window & { GetParentResourceName?: () => string }
  ).GetParentResourceName?.();
  if (!host) return Promise.resolve();
  readyPromise = (async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 2000);
      try {
        const response = await fetch(`https://${host}/__tlib_hud_ready`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: controller.signal,
        });
        if (response.ok) return;
      } catch {
        /* Lua may still be starting. Retry the handshake, not layout mutations. */
      } finally {
        clearTimeout(deadline);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    readyPromise = undefined;
    console.warn("[tLib HUD] Consumer handshake failed; load @tLib/shared/imports/hud/client.lua.");
  })();
  return readyPromise;
}
const api: HudLayoutClient = {
  attach(id: string, element: HTMLElement, onEdit?: (editing: boolean) => void) {
    if (bindings.has(id)) throw new Error(`HUD component already attached: ${id}`);
    if (!/^[\w-]{1,80}$/.test(id) || bindings.size >= 16)
      throw new Error("Invalid HUD component ID or limit reached");
    const binding = {
      element,
      previousStyle: element.getAttribute("style"),
      previousHidden: element.hidden,
      onEdit,
    };
    bindings.set(id, binding);
    apply(id);
    void ready();
    return () => {
      if (bindings.get(id) !== binding) return;
      bindings.delete(id);
      if (binding.previousStyle === null) element.removeAttribute("style");
      else element.setAttribute("style", binding.previousStyle);
      element.hidden = binding.previousHidden;
      onEdit?.(false);
    };
  },
  ready,
};
(window as Window & { tLibHudLayout?: typeof api }).tLibHudLayout = api;

export type { Update };
