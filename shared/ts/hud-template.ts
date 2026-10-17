// Data binding for HUD HTML templates: update(state) pushes values to every
// data-hud-* element in the tree — text, html, led, show, hide, led-color, eq,
// attr and btn.
//
// Why the node lists are cached
//
// update() used to run one querySelectorAll per attribute — eight full-subtree
// walks on every state push, against a DOM that only changes when new layout
// HTML is injected. Measured on the shipped layouts that was 272 (tRadar VPR-2)
// to 1,568 (tRadar VTX-2X) element visits per push, all of it re-deriving the
// same node lists. The lists are now built once and reused.
//
// scan() is the explicit invalidation point, and a MutationObserver is the
// implicit one: a layout script (tELS re-creates `[data-hud-script]` blocks as
// live elements, and they may add or retag nodes) mutates the tree after scan()
// has run, and a cache with no way to notice would bind the old set forever.
// The observer costs nothing while the DOM is static, which is the normal case.
//
// Why writes are compared against the DOM, not a shadow copy
//
// Skipping an unchanged write is the other half of the saving, but the value to
// compare against has to be read back from the element rather than remembered
// here. A layout script owns the same nodes we do — tELS's hands it `(state,
// root)` precisely so it can paint derived values — so a remembered "last value"
// goes stale the moment anything else writes, and we would then skip a write
// that was genuinely needed. Reading `el.textContent` is cheap; writing it is
// what invalidates layout.

/** Every attribute this binder understands. The grammar, in one place. */
export const HUD_BINDING_ATTRS = [
  "data-hud-text",
  "data-hud-html",
  "data-hud-led",
  "data-hud-show",
  "data-hud-hide",
  "data-hud-led-color",
  "data-hud-eq",
  "data-hud-attr",
  "data-hud-btn",
] as const;

export interface HudBinderOptions {
  onAction?: (action: string) => void;
  /** Return undefined to fall back to !!value. */
  resolveBool?: (key: string, state: Record<string, unknown>) => boolean | undefined;
}

/** One bound element, with its dot-path pre-split so update() never parses. */
interface Bound {
  el: HTMLElement;
  key: string;
  /** Pre-split dot path, or null for a flat key. */
  path: string[] | null;
  /** The half after the colon for `eq` (the match) and `attr` (the attribute). */
  suffix: string;
}

interface BindingCache {
  text: Bound[];
  html: Bound[];
  led: Bound[];
  show: Bound[];
  hide: Bound[];
  ledColor: Bound[];
  eq: Bound[];
  attr: Bound[];
  hasFitText: boolean;
}

function emptyCache(): BindingCache {
  return {
    text: [],
    html: [],
    led: [],
    show: [],
    hide: [],
    ledColor: [],
    eq: [],
    attr: [],
    hasFitText: false,
  };
}

export class HudBinder {
  private root: HTMLElement;
  private state: Record<string, unknown> = {};
  private opts: HudBinderOptions;

  private cache: BindingCache = emptyCache();
  private cacheValid = false;
  private observer: MutationObserver | null = null;
  /** Aborts the click listeners scan() attached, so a re-scan cannot double them. */
  private actions: AbortController | null = null;

  constructor(root: HTMLElement, opts?: HudBinderOptions) {
    this.root = root;
    this.opts = opts ?? {};
  }

  /** Call after injecting new layout HTML into the root element. */
  scan(): void {
    // Before anything else. Consumers normally replace innerHTML first, which
    // takes the old listeners away with the old nodes — but that is a convention,
    // not a guarantee, and a scan() over a tree that still holds its previous
    // listeners used to leave every button firing twice with nothing to show for
    // it. Aborting is cheap and makes the guarantee explicit.
    this.actions?.abort();
    this.actions = null;

    this.invalidate();
    this.buildCache();

    if (this.opts.onAction) {
      const controller = new AbortController();
      this.actions = controller;
      for (const btn of this.root.querySelectorAll<HTMLElement>("[data-hud-btn]")) {
        const action = btn.getAttribute("data-hud-btn");
        if (!action) continue;
        btn.addEventListener(
          "click",
          (e) => {
            e.stopPropagation();
            this.opts.onAction?.(action);
          },
          { signal: controller.signal }
        );
        // A `click` LISTENER ALONE DOES NOT IMPLEMENT `role="button"`.
        //
        // Every shipped faceplate declares `role="button" tabindex="0"` on its
        // keys — 65 of them across tRadar's five heads and tDetector's three —
        // so they are all reachable by Tab specifically so they can be operated.
        // They could not be: Tab to the KBX-2200's PWR key, press Enter, and the
        // radar did not power on and nothing logged. A `<div role="button">` gets
        // none of a real `<button>`'s key handling for free; that is the whole
        // cost of not using one, and the faceplates cannot use one because they
        // are absolutely-positioned transparent rects over a chassis render.
        //
        // Attached here rather than in each layout because this is the only
        // place the `data-hud-*` grammar is implemented — so it reaches every
        // THIRD-PARTY marketplace skin that already writes `tabindex="0"`, with
        // no markup change and nothing for a skin author to opt into.
        //
        // Space is prevented because its default action scrolls; Enter's is not,
        // because on these overlays there is no form to submit and no anchor to
        // follow. Both go through `click` rather than calling `onAction`, so a
        // key press and a pointer press stay one code path.
        btn.addEventListener(
          "keydown",
          (e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            if (e.repeat) return;
            if (e.key === " ") e.preventDefault();
            e.stopPropagation();
            btn.click();
          },
          { signal: controller.signal }
        );
      }
    }

    this.observe();
    this.update(this.state);
  }

  /**
   * Release the observer and every listener scan() attached.
   *
   * Call from the host's teardown. Not required for correctness when the root
   * itself is discarded — but a MutationObserver holds a strong reference to the
   * node it watches, so a long-lived host that swaps layouts without disposing
   * accumulates observers on detached trees.
   */
  dispose(): void {
    this.actions?.abort();
    this.actions = null;
    this.observer?.disconnect();
    this.observer = null;
    this.invalidate();
  }

  private observe(): void {
    this.observer?.disconnect();
    this.observer = null;
    const win = this.root.ownerDocument?.defaultView;
    // Absent in a non-DOM host; the cache then rests on scan() alone, which is
    // what every consumer already calls after replacing the markup.
    if (!win || typeof win.MutationObserver !== "function") return;
    const observer = new win.MutationObserver(() => this.invalidate());
    observer.observe(this.root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [...HUD_BINDING_ATTRS, "data-fit-max"],
    });
    this.observer = observer;
  }

  private invalidate(): void {
    this.cacheValid = false;
  }

  private bind(attr: string, split: boolean): Bound[] {
    const out: Bound[] = [];
    for (const el of this.root.querySelectorAll<HTMLElement>(`[${attr}]`)) {
      const raw = el.getAttribute(attr);
      if (raw === null) continue;
      let key = raw;
      let suffix = "";
      if (split) {
        const colon = raw.indexOf(":");
        // A malformed `data-hud-eq` with no colon used to bind the key "" and
        // compare against the whole string. Skipping it is the honest read:
        // there is no key to resolve.
        if (colon < 0) continue;
        key = raw.slice(0, colon);
        suffix = raw.slice(colon + 1);
      }
      out.push({ el, key, path: key.includes(".") ? key.split(".") : null, suffix });
    }
    return out;
  }

  private buildCache(): void {
    this.cache = {
      text: this.bind("data-hud-text", false),
      html: this.bind("data-hud-html", false),
      led: this.bind("data-hud-led", false),
      show: this.bind("data-hud-show", false),
      hide: this.bind("data-hud-hide", false),
      ledColor: this.bind("data-hud-led-color", false),
      eq: this.bind("data-hud-eq", true),
      attr: this.bind("data-hud-attr", true),
      hasFitText: this.root.querySelector("[data-fit-max]") !== null,
    };
    this.cacheValid = true;
  }

  private ensureCache(): void {
    if (!this.cacheValid) this.buildCache();
  }

  scanKeys(): { keys: string[]; subNames: Record<string, string[]> } {
    if (!this.root) return { keys: [], subNames: {} };
    this.ensureCache();
    const keys = new Set<string>();
    const subNames: Record<string, string[]> = {};

    // The top of a dot path is what Lua has to send; `front.targetText` needs `front`.
    const top = (b: Bound): string => b.path?.[0] ?? b.key;

    for (const list of [
      this.cache.text,
      this.cache.html,
      this.cache.led,
      this.cache.show,
      this.cache.hide,
    ]) {
      for (const b of list) keys.add(top(b));
    }

    // led-color alone also reports the REST of the path. tELS's Lua builds `leds` as a table of
    // colours and needs the sub-names to know which entries to fill; the other attributes only ever
    // need the top-level key.
    for (const b of this.cache.ledColor) {
      const head = top(b);
      keys.add(head);
      if (!b.path) continue;
      const rest = b.path.slice(1).join(".");
      const list = subNames[head] ?? [];
      list.push(rest);
      subNames[head] = list;
    }

    for (const list of [this.cache.eq, this.cache.attr]) {
      for (const b of list) if (b.key) keys.add(b.key);
    }

    // Additional keys a layout script declares for itself.
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-hud-keys]")) {
      for (const k of (el.getAttribute("data-hud-keys") ?? "").split(",")) {
        const trimmed = k.trim();
        if (trimmed) keys.add(trimmed);
      }
    }

    return { keys: [...keys], subNames };
  }

  fitText(): void {
    const doc = this.root.ownerDocument;
    const win = doc?.defaultView;
    if (!win || !doc.body) return;
    const probe = doc.createElement("span");
    probe.style.cssText =
      "position:fixed;top:-9999px;left:-9999px;white-space:nowrap;visibility:hidden;pointer-events:none;";
    doc.body.appendChild(probe);
    for (const el of Array.from(this.root.querySelectorAll<HTMLElement>("[data-fit-max]"))) {
      const span = el.querySelector<HTMLElement>("span");
      const text = span?.textContent ?? "";
      const max = parseFloat(el.getAttribute("data-fit-max") ?? "") || 14;
      if (!span || !text) {
        this.setStyle(el, "fontSize", `${max}px`);
        continue;
      }
      const cw = el.offsetWidth;
      if (cw <= 0) continue;
      const cs = win.getComputedStyle(span);
      probe.style.fontSize = `${max}px`;
      probe.style.fontFamily = cs.fontFamily;
      probe.style.fontWeight = cs.fontWeight;
      probe.style.letterSpacing = cs.letterSpacing;
      probe.textContent = text;
      const sw = probe.offsetWidth;
      this.setStyle(
        el,
        "fontSize",
        sw > cw && sw > 0 ? `${Math.max(1, Math.floor((max * cw) / sw))}px` : `${max}px`
      );
    }
    doc.body.removeChild(probe);
  }

  update(newState: Record<string, unknown>): void {
    this.state = newState;
    this.ensureCache();

    for (const b of this.cache.text) {
      const val = this.read(b);
      const next = val != null ? String(val) : "";
      if (b.el.textContent !== next) b.el.textContent = next;
    }

    for (const b of this.cache.html) {
      const val = this.read(b);
      const next = val != null ? String(val) : "";
      if (b.el.innerHTML !== next) b.el.innerHTML = next;
    }

    for (const b of this.cache.led) {
      this.setClass(b.el, "active", this.readBool(b));
    }

    for (const b of this.cache.show) {
      this.setStyle(b.el, "display", this.readBool(b) ? "" : "none");
    }

    for (const b of this.cache.hide) {
      this.setStyle(b.el, "display", this.readBool(b) ? "none" : "");
    }

    for (const b of this.cache.ledColor) {
      const val = this.read(b) as { r: number; g: number; b: number; a?: number } | undefined;
      this.setStyle(
        b.el,
        "backgroundColor",
        val && val.r != null ? `rgba(${val.r}, ${val.g}, ${val.b}, ${val.a ?? 1})` : ""
      );
    }

    for (const b of this.cache.eq) {
      this.setClass(b.el, "active", String(this.read(b)) === b.suffix);
    }

    for (const b of this.cache.attr) {
      if (!b.key || !b.suffix) continue;
      const val = this.read(b);
      if (val != null && val !== "" && val !== false) {
        const next = String(val);
        if (b.el.getAttribute(b.suffix) !== next) b.el.setAttribute(b.suffix, next);
      } else if (b.el.hasAttribute(b.suffix)) {
        b.el.removeAttribute(b.suffix);
      }
    }

    const themeVal = this.state.theme;
    if (themeVal !== undefined) {
      this.setClass(this.root, "theme-dark", themeVal === "Dark");
    }

    // Deferred so the layout has settled.
    const win = this.root.ownerDocument?.defaultView;
    if (win && this.cache.hasFitText) {
      win.requestAnimationFrame(() => this.fitText());
    }
  }

  getState(): Record<string, unknown> {
    return this.state;
  }

  getRoot(): HTMLElement {
    return this.root;
  }

  private setClass(el: HTMLElement, cls: string, on: boolean): void {
    if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
  }

  private setStyle(el: HTMLElement, prop: "display" | "backgroundColor" | "fontSize", to: string) {
    if (el.style[prop] !== to) el.style[prop] = to;
  }

  /** Resolve a pre-split binding. The hot path: no string work per element. */
  private read(b: Bound): unknown {
    if (b.path === null) return this.state[b.key];
    let obj: unknown = this.state;
    for (const p of b.path) {
      if (obj == null || typeof obj !== "object") return undefined;
      obj = (obj as Record<string, unknown>)[p];
    }
    return obj;
  }

  private readBool(b: Bound): boolean {
    if (this.opts.resolveBool) {
      const custom = this.opts.resolveBool(b.key, this.state);
      if (custom !== undefined) return custom;
    }
    return !!this.read(b);
  }
}
