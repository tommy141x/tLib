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
        keys.add(el.getAttribute(attr)?.split(":")[0]);
      }
    }

    return { keys: [...keys], subNames };
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
  }

  getState(): Record<string, unknown> {
    return this.state;
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
