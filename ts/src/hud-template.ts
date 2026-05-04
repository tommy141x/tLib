// data-binding for HUD HTML templates.
// update(state) pushes values to all data-hud-* elements automatically.
// supports: text, html, led, show, hide, led-color, eq, attr, btn

export interface HudBinderOptions {
  onAction?: (action: string) => void;
  // return undefined to fall back to !!value
  resolveBool?: (key: string, state: Record<string, unknown>) => boolean | undefined;
}

export class HudBinder {
  private root: HTMLElement;
  private state: Record<string, unknown> = {};
  private opts: HudBinderOptions;

  constructor(root: HTMLElement, opts?: HudBinderOptions) {
    this.root = root;
    this.opts = opts ?? {};
  }

  /**
   * Scan the injected layout HTML, wire up button handlers, and bind initial state.
   * Call this after injecting new layout HTML into the root element.
   */
  scan(): void {
    // Wire up button click handlers
    if (this.opts.onAction) {
      const btns = this.root.querySelectorAll<HTMLElement>("[data-hud-btn]");
      for (const btn of btns) {
        const action = btn.getAttribute("data-hud-btn")!;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.opts.onAction?.(action);
        });
      }
    }

    // Apply current state to new layout
    this.update(this.state);
  }

  scanKeys(): { keys: string[]; subNames: Record<string, string[]> } {
    if (!this.root) return { keys: [], subNames: {} };
    const keys = new Set<string>();
    const subNames: Record<string, string[]> = {};

    for (const attr of [
      "data-hud-text",
      "data-hud-html",
      "data-hud-led",
      "data-hud-show",
      "data-hud-hide",
    ]) {
      for (const el of this.root.querySelectorAll<HTMLElement>(`[${attr}]`)) {
        const val = el.getAttribute(attr)!;
        keys.add(this.topKey(val));
      }
    }

    for (const el of this.root.querySelectorAll<HTMLElement>("[data-hud-led-color]")) {
      const val = el.getAttribute("data-hud-led-color")!;
      const dot = val.indexOf(".");
      if (dot >= 0) {
        const top = val.slice(0, dot);
        const sub = val.slice(dot + 1);
        keys.add(top);
        if (!subNames[top]) subNames[top] = [];
        subNames[top].push(sub);
      } else {
        keys.add(val);
      }
    }

    for (const attr of ["data-hud-eq", "data-hud-attr"]) {
      for (const el of this.root.querySelectorAll<HTMLElement>(`[${attr}]`)) {
        const v = el.getAttribute(attr)?.split(":")[0];
        if (v) keys.add(v);
      }
    }

    // data-hud-keys: additional keys declared by layout scripts
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-hud-keys]")) {
      for (const k of el.getAttribute("data-hud-keys")!.split(",")) {
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
    probe.style.cssText = "position:fixed;top:-9999px;left:-9999px;white-space:nowrap;visibility:hidden;pointer-events:none;";
    doc.body.appendChild(probe);
    for (const el of Array.from(this.root.querySelectorAll<HTMLElement>("[data-fit-max]"))) {
      const span = el.querySelector<HTMLElement>("span");
      const text = span?.textContent ?? "";
      const max = parseFloat(el.getAttribute("data-fit-max") ?? "") || 14;
      if (!span || !text) { el.style.fontSize = max + "px"; continue; }
      const cw = el.offsetWidth;
      if (cw <= 0) continue;
      const cs = win.getComputedStyle(span);
      probe.style.fontSize = max + "px";
      probe.style.fontFamily = cs.fontFamily;
      probe.style.fontWeight = cs.fontWeight;
      probe.style.letterSpacing = cs.letterSpacing;
      probe.textContent = text;
      const sw = probe.offsetWidth;
      el.style.fontSize = sw > cw && sw > 0 ? Math.max(1, Math.floor(max * cw / sw)) + "px" : max + "px";
    }
    doc.body.removeChild(probe);
  }

  update(newState: Record<string, unknown>): void {
    this.state = newState;

    // data-hud-text
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-hud-text]")) {
      const val = this.resolve(el.getAttribute("data-hud-text")!);
      el.textContent = val != null ? String(val) : "";
    }

    // data-hud-html
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-hud-html]")) {
      const val = this.resolve(el.getAttribute("data-hud-html")!);
      el.innerHTML = val != null ? String(val) : "";
    }

    // data-hud-led
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-hud-led]")) {
      el.classList.toggle("active", this.resolveBool(el.getAttribute("data-hud-led")!));
    }

    // data-hud-show
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-hud-show]")) {
      el.style.display = this.resolveBool(el.getAttribute("data-hud-show")!) ? "" : "none";
    }

    // data-hud-hide
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-hud-hide]")) {
      el.style.display = this.resolveBool(el.getAttribute("data-hud-hide")!) ? "none" : "";
    }

    // data-hud-led-color
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-hud-led-color]")) {
      const val = this.resolve(el.getAttribute("data-hud-led-color")!) as
        | { r: number; g: number; b: number; a?: number }
        | undefined;
      if (val && val.r != null) {
        el.style.backgroundColor = `rgba(${val.r}, ${val.g}, ${val.b}, ${val.a ?? 1})`;
      } else {
        el.style.backgroundColor = "";
      }
    }

    // data-hud-eq="key:value"
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-hud-eq]")) {
      const spec = el.getAttribute("data-hud-eq")!;
      const colonIdx = spec.indexOf(":");
      const key = spec.slice(0, colonIdx);
      const match = spec.slice(colonIdx + 1);
      el.classList.toggle("active", String(this.resolve(key)) === match);
    }

    // data-hud-attr="key:attrName"
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-hud-attr]")) {
      const spec = el.getAttribute("data-hud-attr")!;
      const colonIdx = spec.indexOf(":");
      const key = spec.slice(0, colonIdx);
      const attr = spec.slice(colonIdx + 1);
      if (key && attr) {
        const val = this.resolve(key);
        if (val != null && val !== "" && val !== false) {
          el.setAttribute(attr, String(val));
        } else {
          el.removeAttribute(attr);
        }
      }
    }

    // Theme — toggle .theme-dark on the root element
    const themeVal = this.state["theme"];
    if (themeVal !== undefined) {
      this.root.classList.toggle("theme-dark", themeVal === "Dark");
    }

    // Fit-text — deferred so layout is settled
    const doc = this.root.ownerDocument;
    const win = doc?.defaultView;
    if (win && this.root.querySelector("[data-fit-max]")) {
      win.requestAnimationFrame(() => this.fitText());
    }
  }

  getState(): Record<string, unknown> {
    return this.state;
  }

  getRoot(): HTMLElement {
    return this.root;
  }

  // supports dot paths like "leds.R1"
  private resolve(key: string): unknown {
    if (key.includes(".")) {
      const parts = key.split(".");
      let obj: any = this.state;
      for (const p of parts) {
        if (obj == null) return undefined;
        obj = obj[p];
      }
      return obj;
    }
    return this.state[key];
  }

  private resolveBool(key: string): boolean {
    if (this.opts.resolveBool) {
      const custom = this.opts.resolveBool(key, this.state);
      if (custom !== undefined) return custom;
    }
    return !!this.resolve(key);
  }

  private topKey(key: string): string {
    const dot = key.indexOf(".");
    return dot >= 0 ? key.slice(0, dot) : key;
  }
}
