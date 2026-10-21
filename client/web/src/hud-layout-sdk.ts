import { layoutRect, MAX_OFFSET, REFERENCE_HEIGHT } from "@tlib/shared/hud-geometry";
import type { HudLayoutClient, HudLayoutUpdate as Update } from "../../../shared/ts/hud-layout";

type Binding = {
  element: HTMLElement;
  previousStyle: string | null;
  /**
   * The element's own property type, not `boolean`. `hidden` is
   * `boolean | string` -- the HTML spec admits `hidden="until-found"` -- and
   * this field exists only to be read at bind and written back at unbind, so
   * narrowing it would silently coerce a consumer's `until-found` to `true`.
   * It typechecked as `boolean` only because the Bun types that widen it were
   * never installed on a runner; see client/web/tsconfig.json.
   */
  previousHidden: HTMLElement["hidden"];
  /** The element's own `style.visibility`, restored rather than assumed empty. */
  previousVisibility: string;
  /** True once a real placement has been written, which is when it may paint. */
  placed: boolean;
  revealTimer?: ReturnType<typeof setTimeout>;
  onEdit?: (editing: boolean) => void;
};

/**
 * How long an unplaced widget stays hidden before it is shown anyway.
 *
 * A placement normally lands in the same frame or the next one. This only runs
 * when none ever arrives, and it exists so the worst case is the old visible
 * jump rather than a widget nobody can see. Short enough not to read as a
 * loading delay, long enough to cover a slow consumer handshake.
 */
const REVEAL_FAILSAFE_MS = 1_000;
const bindings = new Map<string, Binding>();
const latest = new Map<string, Update>();
const anchors = new Set(["top-left", "top-right", "bottom-left", "bottom-right", "center"]);
function valid(data: unknown): data is Update {
  if (!data || typeof data !== "object") return false;
  const d = data as Update;
  const l = d.layout;
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
  const binding = bindings.get(id);
  const update = latest.get(id);
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
  // The placement is on the element now, so it is safe to paint. See `attach`.
  if (!binding.placed) {
    binding.placed = true;
    if (binding.revealTimer !== undefined) {
      clearTimeout(binding.revealTimer);
      binding.revealTimer = undefined;
    }
    binding.element.style.visibility = binding.previousVisibility ?? "";
  }
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
    // ⚠️ HIDDEN UNTIL PLACED, so a saved layout does not arrive as a visible jump.
    //
    // `apply` needs a binding AND a pushed update. The element is in the DOM and
    // painted from the consumer's own CSS before that update lands, so a player
    // with a saved position watched the widget appear at its authored spot and
    // then teleport to where they had put it -- reported across the t* resources,
    // tRadar most visibly. Nothing was wrong with the placement; it was simply
    // applied a frame or more after the thing was already on screen.
    //
    // `visibility` rather than `hidden` or `display`: it suppresses paint without
    // disturbing the consumer's own layout or its `hidden` bookkeeping, and the
    // element's prior value is restored rather than assumed to be the default.
    //
    // ⚠️ THE TIMER IS NOT OPTIONAL. If no update ever arrives -- tLib not loaded,
    // a handshake that fails, a consumer that binds an id nothing pushes -- a
    // permanently invisible widget is far worse than the jump this removes. The
    // failsafe reveals it anyway, unplaced, which is exactly the old behaviour.
    const binding: Binding = {
      element,
      previousStyle: element.getAttribute("style"),
      previousHidden: element.hidden,
      previousVisibility: element.style.visibility,
      placed: false,
      onEdit,
    };
    element.style.visibility = "hidden";
    binding.revealTimer = setTimeout(() => {
      binding.revealTimer = undefined;
      if (binding.placed) return;
      binding.element.style.visibility = binding.previousVisibility ?? "";
    }, REVEAL_FAILSAFE_MS);
    bindings.set(id, binding);
    apply(id);
    void ready();
    return () => {
      if (bindings.get(id) !== binding) return;
      bindings.delete(id);
      if (binding.revealTimer !== undefined) clearTimeout(binding.revealTimer);
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
