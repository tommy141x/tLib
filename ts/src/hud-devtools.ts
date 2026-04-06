/**
 * HUD DevTools — browser-side development panel for previewing HTML layouts.
 *
 * When a ui.html layout is opened directly in a browser (not FiveM NUI),
 * this module detects the environment and injects a floating devtools panel
 * that lets designers manipulate state values and see the layout respond.
 *
 * Usage in ui.html:
 *   1. Define controls via a JSON script block:
 *      <script type="hud/devtools">
 *      [
 *        { "type": "toggle", "key": "leds.power", "label": "Power LED" },
 *        { "type": "slider", "key": "signal", "label": "Signal", "min": 1, "max": 5, "step": 1 },
 *        { "type": "select", "key": "battery", "label": "Battery", "options": ["0","1","2","3","4","5","c"] },
 *        { "type": "text",   "key": "ln01", "label": "Line 1", "default": "CHANNEL 1" }
 *      ]
 *      </script>
 *
 *   2. Include the auto-init script at the bottom:
 *      <script type="module">
 *        import { HudDevTools } from '../../path/to/hud-devtools.js';
 *        HudDevTools.auto(document.querySelector('.radio'));
 *      </script>
 *
 *   Or call it programmatically:
 *      const devtools = new HudDevTools(container, binder, controls);
 *
 * Control types:
 *   toggle  — on/off boolean (checkbox-style button)
 *   slider  — numeric range (min/max/step)
 *   select  — dropdown from a list of string options
 *   text    — free-form text input
 *
 * Environment detection:
 *   FiveM NUI has `window.invokeNative` — if absent, we're in a regular browser.
 */

import { HudBinder } from "./hud-template";

// ── Types ──

export interface DevToolControl {
  type: "toggle" | "slider" | "select" | "text";
  key: string;
  label: string;
  default?: unknown;
  // slider
  min?: number;
  max?: number;
  step?: number;
  // select
  options?: string[];
}

// ── Environment detection ──

/** Returns true if running inside FiveM's NUI browser (CEF). */
export function isNUI(): boolean {
  try {
    return typeof (window as any).invokeNative === "function";
  } catch {
    return false;
  }
}

// ── HudDevTools ──

export interface HudDevToolsOptions {
  /** Extra hardcoded state values not exposed as controls (e.g. display text defaults). */
  defaults?: Record<string, unknown>;
  /** Called before every binder.update() — mutate state in place for derived values. */
  beforeUpdate?: (state: Record<string, unknown>) => void;
}

export class HudDevTools {
  private panel: HTMLElement;
  private binder: HudBinder;
  private state: Record<string, unknown>;
  private controls: DevToolControl[];
  private storageKey: string;
  private beforeUpdate?: (state: Record<string, unknown>) => void;

  constructor(
    container: HTMLElement,
    binder: HudBinder,
    controls: DevToolControl[],
    options?: HudDevToolsOptions
  ) {
    this.binder = binder;
    this.controls = controls;
    this.state = {};
    this.beforeUpdate = options?.beforeUpdate;
    this.storageKey =
      "hud-devtools:" +
      location.pathname
        .replace(/\/ui\.html$/i, "")
        .split("/")
        .pop();

    // Apply hardcoded defaults first (not exposed as controls)
    if (options?.defaults) {
      for (const [k, v] of Object.entries(options.defaults)) {
        this.setNested(k, v);
      }
    }

    // Build initial state from control defaults
    for (const ctrl of controls) {
      this.setNested(ctrl.key, ctrl.default ?? this.controlDefault(ctrl));
    }

    // Restore saved state from localStorage
    try {
      const saved = localStorage.getItem(this.storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        this.deepMerge(this.state, parsed);
      }
    } catch {
      /* ignore */
    }

    // Apply initial state
    this.beforeUpdate?.(this.state);
    this.binder.update(this.state);

    // Build and inject the panel UI
    this.panel = this.buildPanel();
    document.body.appendChild(this.panel);
    this.makeDraggable();
  }

  /** Set a possibly-dotted key in the state object. */
  private setNested(key: string, value: unknown): void {
    if (key.includes(".")) {
      const parts = key.split(".");
      let obj: any = this.state;
      for (let i = 0; i < parts.length - 1; i++) {
        if (obj[parts[i]] == null || typeof obj[parts[i]] !== "object") {
          obj[parts[i]] = {};
        }
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = value;
    } else {
      this.state[key] = value;
    }
  }

  private saveState(): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.state));
    } catch {
      /* ignore */
    }
  }

  private clearSavedState(): void {
    try {
      localStorage.removeItem(this.storageKey);
    } catch {
      /* ignore */
    }
  }

  private deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
    for (const k of Object.keys(source)) {
      const sv = source[k];
      if (
        sv &&
        typeof sv === "object" &&
        !Array.isArray(sv) &&
        target[k] &&
        typeof target[k] === "object"
      ) {
        this.deepMerge(target[k] as Record<string, unknown>, sv as Record<string, unknown>);
      } else {
        target[k] = sv;
      }
    }
  }

  /** Resolve a possibly-dotted key from the state object. */
  private getNested(key: string): unknown {
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

  private controlDefault(ctrl: DevToolControl): unknown {
    switch (ctrl.type) {
      case "toggle":
        return false;
      case "slider":
        return ctrl.min ?? 0;
      case "select":
        return ctrl.options?.[0] ?? "";
      case "text":
        return "";
    }
  }

  private update(key: string, value: unknown): void {
    this.setNested(key, value);
    this.beforeUpdate?.(this.state);
    this.binder.update(this.state);
    this.saveState();
  }

  private buildPanel(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "hud-devtools";
    panel.innerHTML = `
			<div class="hdt-header">
				<span class="hdt-title">\u2699 DevTools</span>
				<div style="display:flex;gap:4px">
					<button class="hdt-reset" title="Reset to defaults">Reset</button>
					<button class="hdt-collapse" title="Collapse">\u2014</button>
				</div>
			</div>
			<div class="hdt-body"></div>
		`;

    const body = panel.querySelector(".hdt-body")!;
    const collapseBtn = panel.querySelector(".hdt-collapse") as HTMLButtonElement;
    let collapsed = false;
    collapseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      collapsed = !collapsed;
      (body as HTMLElement).style.display = collapsed ? "none" : "flex";
      collapseBtn.textContent = collapsed ? "+" : "\u2014";
    });
    panel.querySelector(".hdt-reset")!.addEventListener("click", (e) => {
      e.stopPropagation();
      this.clearSavedState();
      location.reload();
    });

    for (const ctrl of this.controls) {
      const row = document.createElement("div");
      row.className = "hdt-row";

      const label = document.createElement("label");
      label.className = "hdt-label";
      label.textContent = ctrl.label;
      row.appendChild(label);

      const controlEl = this.buildControl(ctrl);
      row.appendChild(controlEl);
      body.appendChild(row);
    }

    // Inject styles
    if (!document.getElementById("hud-devtools-styles")) {
      const style = document.createElement("style");
      style.id = "hud-devtools-styles";
      style.textContent = DEVTOOLS_CSS;
      document.head.appendChild(style);
    }

    return panel;
  }

  private buildControl(ctrl: DevToolControl): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "hdt-control";

    switch (ctrl.type) {
      case "toggle": {
        const btn = document.createElement("button");
        btn.className = "hdt-toggle";
        const val = !!this.getNested(ctrl.key);
        btn.textContent = val ? "ON" : "OFF";
        btn.classList.toggle("active", val);
        btn.addEventListener("click", () => {
          const next = !this.getNested(ctrl.key);
          this.update(ctrl.key, next);
          btn.textContent = next ? "ON" : "OFF";
          btn.classList.toggle("active", next);
        });
        wrap.appendChild(btn);
        break;
      }
      case "slider": {
        const input = document.createElement("input");
        input.type = "range";
        input.className = "hdt-slider";
        input.min = String(ctrl.min ?? 0);
        input.max = String(ctrl.max ?? 100);
        input.step = String(ctrl.step ?? 1);
        input.value = String(this.getNested(ctrl.key) ?? ctrl.min ?? 0);
        const valSpan = document.createElement("span");
        valSpan.className = "hdt-value";
        valSpan.textContent = input.value;
        input.addEventListener("input", () => {
          const v = Number(input.value);
          this.update(ctrl.key, v);
          valSpan.textContent = String(v);
        });
        wrap.appendChild(input);
        wrap.appendChild(valSpan);
        break;
      }
      case "select": {
        const select = document.createElement("select");
        select.className = "hdt-select";
        for (const opt of ctrl.options ?? []) {
          const o = document.createElement("option");
          o.value = opt;
          o.textContent = opt;
          select.appendChild(o);
        }
        select.value = String(this.getNested(ctrl.key) ?? "");
        select.addEventListener("change", () => {
          this.update(ctrl.key, select.value);
        });
        wrap.appendChild(select);
        break;
      }
      case "text": {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "hdt-text";
        input.value = String(this.getNested(ctrl.key) ?? "");
        input.placeholder = ctrl.label;
        input.addEventListener("input", () => {
          this.update(ctrl.key, input.value);
        });
        wrap.appendChild(input);
        break;
      }
    }
    return wrap;
  }

  private makeDraggable(): void {
    const header = this.panel.querySelector(".hdt-header") as HTMLElement;
    let dragging = false;
    let startX = 0,
      startY = 0,
      startLeft = 0,
      startTop = 0;

    header.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).tagName === "BUTTON") return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = this.panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      this.panel.style.left = `${startLeft + (e.clientX - startX)}px`;
      this.panel.style.top = `${startTop + (e.clientY - startY)}px`;
      this.panel.style.right = "auto";
    });

    window.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  /** Destroy the panel. */
  destroy(): void {
    this.panel.remove();
  }

  // ── Static auto-init ──

  /**
   * Auto-initialize devtools if running in a regular browser (not FiveM NUI).
   * Reads controls from `<script type="hud/devtools">` inside the container.
   * Creates a HudBinder, wires it up, and injects the devtools panel.
   *
   * @param root The layout root element (e.g. `.radio` or `.wh`)
   * @param binderOpts Optional HudBinder options
   * @returns The HudDevTools instance, or null if inside NUI
   */
  static auto(
    root: HTMLElement | null,
    binderOpts?: {
      resolveBool?: (key: string, state: Record<string, unknown>) => boolean | undefined;
    }
  ): HudDevTools | null {
    if (isNUI() || !root) return null;

    // Parse controls from <script type="hud/devtools">
    const scriptEl = root.querySelector('script[type="hud/devtools"]');
    let controls: DevToolControl[] = [];
    if (scriptEl?.textContent) {
      try {
        controls = JSON.parse(scriptEl.textContent);
      } catch (e) {
        console.error("[HudDevTools] Failed to parse devtools config:", e);
      }
    }

    if (controls.length === 0) {
      console.warn(
        '[HudDevTools] No controls defined. Add <script type="hud/devtools">[...]</script>'
      );
      return null;
    }

    // Create a binder for the layout
    const binder = new HudBinder(root, {
      onAction: (action) => console.log(`[DevTools] Button pressed: ${action}`),
      ...binderOpts,
    });
    binder.scan();

    // Apply theme class for CSS
    root.closest(".theme-dark, .theme-light") ?? root.parentElement?.classList.add("theme-dark");

    return new HudDevTools(root, binder, controls);
  }
}

// ── DevTools Panel CSS ──

const DEVTOOLS_CSS = `
.hud-devtools {
	position: fixed;
	top: 20px;
	right: 20px;
	width: 280px;
	background: hsl(225 8% 12%);
	border: 1px solid hsl(225 10% 30% / 0.6);
	border-radius: 8px;
	box-shadow: 0 4px 24px rgba(0,0,0,0.4);
	font-family: Inter, -apple-system, sans-serif;
	font-size: 11px;
	color: hsl(220 10% 90%);
	z-index: 99999;
	user-select: none;
	overflow: hidden;
}

.hdt-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 8px 12px;
	background: hsl(225 8% 16%);
	border-bottom: 1px solid hsl(225 10% 30% / 0.6);
	cursor: grab;
}
.hdt-header:active { cursor: grabbing; }

.hdt-title {
	font-weight: 600;
	font-size: 10px;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	color: hsl(211 80% 55%);
}

.hdt-collapse, .hdt-reset {
	background: none;
	border: none;
	color: hsl(220 8% 58%);
	cursor: pointer;
	font-size: 14px;
	line-height: 1;
	padding: 0 4px;
}
.hdt-collapse:hover, .hdt-reset:hover { color: hsl(220 10% 90%); }
.hdt-reset {
	font-size: 9px;
	font-family: monospace;
	padding: 2px 6px;
	border-radius: 3px;
	background: hsl(225 10% 26% / 0.4);
}
.hdt-reset:hover { background: hsl(0 62% 50%); color: #fff; }

.hdt-body {
	display: flex;
	flex-direction: column;
	gap: 6px;
	padding: 10px 12px;
	max-height: 70vh;
	overflow-y: auto;
}

.hdt-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.hdt-label {
	font-size: 10px;
	font-family: monospace;
	color: hsl(220 10% 90%);
	white-space: nowrap;
	flex-shrink: 0;
}

.hdt-control {
	display: flex;
	align-items: center;
	gap: 6px;
	flex: 1;
	justify-content: flex-end;
}

/* Toggle */
.hdt-toggle {
	padding: 2px 10px;
	font-size: 9px;
	font-family: monospace;
	border-radius: 4px;
	border: none;
	cursor: pointer;
	background: hsl(225 10% 26% / 0.6);
	color: hsl(220 8% 58%);
	transition: background 0.15s, color 0.15s;
}
.hdt-toggle.active {
	background: hsl(211 80% 55%);
	color: #fff;
}

/* Slider */
.hdt-slider {
	-webkit-appearance: none;
	appearance: none;
	width: 100px;
	height: 4px;
	border-radius: 2px;
	background: hsl(225 10% 26%);
	outline: none;
	cursor: pointer;
}
.hdt-slider::-webkit-slider-thumb {
	-webkit-appearance: none;
	width: 12px; height: 12px;
	border-radius: 50%;
	background: hsl(211 80% 55%);
	cursor: pointer;
}
.hdt-value {
	font-size: 10px;
	font-family: monospace;
	color: hsl(211 80% 55%);
	font-variant-numeric: tabular-nums;
	min-width: 16px;
	text-align: right;
}

/* Select */
.hdt-select {
	background: hsl(225 10% 22%);
	color: hsl(220 10% 90%);
	border: 1px solid hsl(225 10% 30%);
	border-radius: 4px;
	padding: 2px 6px;
	font-size: 10px;
	font-family: monospace;
	cursor: pointer;
	outline: none;
}
.hdt-select:focus { border-color: hsl(211 80% 55%); }

/* Text input */
.hdt-text {
	background: hsl(225 10% 22%);
	color: hsl(220 10% 90%);
	border: 1px solid hsl(225 10% 30%);
	border-radius: 4px;
	padding: 3px 6px;
	font-size: 10px;
	font-family: monospace;
	width: 120px;
	outline: none;
}
.hdt-text:focus { border-color: hsl(211 80% 55%); }
.hdt-text::placeholder { color: hsl(220 8% 58% / 0.5); }

/* Scrollbar */
.hdt-body::-webkit-scrollbar { width: 4px; }
.hdt-body::-webkit-scrollbar-track { background: transparent; }
.hdt-body::-webkit-scrollbar-thumb { background: hsl(220 8% 58% / 0.3); border-radius: 2px; }
`;
