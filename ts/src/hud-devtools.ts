// floating devtools panel for previewing HUD layouts in a regular browser.
// if window.invokeNative exists we're in FiveM NUI, otherwise inject the panel.

import type { HudBinder } from "./hud-template";

const EDITABLE_ATTRS = [
  "data-hud-btn",
  "data-hud-text",
  "data-hud-html",
  "data-hud-led",
  "data-hud-led-color",
  "data-hud-show",
  "data-hud-hide",
  "data-hud-eq",
  "data-hud-attr",
] as const;

const EDITABLE_SELECTOR = EDITABLE_ATTRS.map((a) => `[${a}]`).join(", ");

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

interface HudElementIdentity {
  label: string;
  cssSelector: string;
  key: string;
  attr: string;
}

interface EditorElement {
  el: HTMLElement;
  label: HTMLElement;
  handle: HTMLElement;
  identity: HudElementIdentity;
  savedOverflow: string;
  savedPosition: string;
  savedPointerEvents: string;
  // true if we flipped static → absolute. reset reverts this, disable doesn't.
  wasConverted: boolean;
  clickCapture: (e: MouseEvent) => void;
  dragDown: (e: MouseEvent) => void;
  resizeDown: (e: MouseEvent) => void;
}

export function isNUI(): boolean {
  try {
    return typeof (window as any).invokeNative === "function";
  } catch {
    return false;
  }
}

export interface HudDevToolsOptions {
  defaults?: Record<string, unknown>;
  beforeUpdate?: (state: Record<string, unknown>) => void;
  afterUpdate?: (state: Record<string, unknown>) => void;
  /** Show the "Show Buttons" highlight toggle (default: true) */
  showButtonHighlight?: boolean;
  /** Show the "Layout Editor" toggle (default: true) */
  showLayoutEditor?: boolean;
}

export class HudDevTools {
  private root: HTMLElement;
  private panel: HTMLElement;
  private binder: HudBinder;
  private state: Record<string, unknown>;
  private controls: DevToolControl[];
  private storageKey: string;
  private beforeUpdate?: (state: Record<string, unknown>) => void;
  private afterUpdate?: (state: Record<string, unknown>) => void;
  private opts: HudDevToolsOptions;

  // Layout editor
  private layoutEditorOn = false;
  private editorElements: EditorElement[] = [];
  private editorElementMap = new Map<HTMLElement, EditorElement>();
  private selectedEditorEl: HTMLElement | null = null;
  private editorInfoEl!: HTMLElement;
  private editorExportRow!: HTMLElement;

  constructor(
    container: HTMLElement,
    binder: HudBinder,
    controls: DevToolControl[],
    options?: HudDevToolsOptions
  ) {
    this.root = container;
    this.binder = binder;
    this.controls = controls;
    this.state = {};
    this.opts = options ?? {};
    this.beforeUpdate = options?.beforeUpdate;
    this.afterUpdate = options?.afterUpdate;
    const pathSegment =
      location.pathname
        .replace(/\/ui\.html$/i, "")
        .split("/")
        .filter(Boolean)
        .pop() ??
      location.pathname.replace(/[^a-z0-9]/gi, "_") ??
      "default";
    this.storageKey = `hud-devtools:${pathSegment}`;

    // Apply hardcoded defaults first (not exposed as controls)
    if (options?.defaults) {
      for (const [k, v] of Object.entries(options.defaults)) {
        this.setNested(k, v);
      }
    }

    // Apply control defaults
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

    // Initial render
    this.beforeUpdate?.(this.state);
    this.binder.update(this.state);
    this.afterUpdate?.(this.state);

    this.panel = this.buildPanel();
    document.body.appendChild(this.panel);
    this.makeDraggable();
  }

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
    this.afterUpdate?.(this.state);
    this.saveState();
  }

  private buildPanel(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "hud-devtools";
    panel.innerHTML =
      '<div class="hdt-header">' +
      '<span class="hdt-title">&#9881; DevTools</span>' +
      '<div style="display:flex;gap:4px">' +
      '<button class="hdt-reset" title="Reset to defaults">Reset</button>' +
      '<button class="hdt-collapse" title="Collapse">&#8212;</button>' +
      "</div>" +
      "</div>" +
      '<div class="hdt-body"></div>';

    const body = panel.querySelector(".hdt-body") as HTMLElement;

    // Collapse
    const collapseBtn = panel.querySelector(".hdt-collapse") as HTMLButtonElement;
    let collapsed = false;
    collapseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      collapsed = !collapsed;
      body.style.display = collapsed ? "none" : "flex";
      collapseBtn.textContent = collapsed ? "+" : String.fromCharCode(0x2014);
    });

    // Reset
    panel.querySelector(".hdt-reset")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.clearSavedState();
      location.reload();
    });

    const scaleKey = `${this.storageKey}:scale`;
    let savedScale = 1;
    try {
      const ss = localStorage.getItem(scaleKey);
      if (ss) savedScale = parseFloat(ss) || 1;
    } catch {
      /* ignore */
    }
    this.root.style.transform = `scale(${savedScale})`;
    this.root.style.transformOrigin = "center center";

    {
      const row = document.createElement("div");
      row.className = "hdt-row";
      const lbl = document.createElement("label");
      lbl.className = "hdt-label";
      lbl.textContent = "Scale";
      row.appendChild(lbl);
      const wrap = document.createElement("div");
      wrap.className = "hdt-control";
      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "hdt-slider";
      slider.min = "0.5";
      slider.max = "3";
      slider.step = "0.1";
      slider.value = String(savedScale);
      const val = document.createElement("span");
      val.className = "hdt-value";
      val.textContent = savedScale.toFixed(1);
      slider.addEventListener("input", () => {
        const v = parseFloat(slider.value);
        this.root.style.transform = `scale(${v})`;
        val.textContent = v.toFixed(1);
        try {
          localStorage.setItem(scaleKey, String(v));
        } catch {
          /* ignore */
        }
      });
      wrap.appendChild(slider);
      wrap.appendChild(val);
      row.appendChild(wrap);
      body.appendChild(row);
    }

    const btnHighlightKey = `${this.storageKey}:btnHighlight`;
    let btnHighlightOn = false;
    try {
      btnHighlightOn = localStorage.getItem(btnHighlightKey) === "1";
    } catch {
      /* ignore */
    }

    if (this.opts.showButtonHighlight !== false) {
      if (!document.getElementById("hdt-btn-highlight-style")) {
        const hlStyle = document.createElement("style");
        hlStyle.id = "hdt-btn-highlight-style";
        hlStyle.textContent =
          ".hdt-btn-highlight [data-hud-btn]{background:rgba(59,130,246,0.25);border:1.5px solid rgba(59,130,246,0.5);border-radius:50%;box-shadow:0 0 6px rgba(59,130,246,0.3);}" +
          ".hdt-btn-highlight [data-hud-btn]:hover{background:rgba(59,130,246,0.45);}";
        document.head.appendChild(hlStyle);
      }
      if (btnHighlightOn) this.root.classList.add("hdt-btn-highlight");

      const row = document.createElement("div");
      row.className = "hdt-row";
      const lbl = document.createElement("label");
      lbl.className = "hdt-label";
      lbl.textContent = "Show Buttons";
      row.appendChild(lbl);
      const wrap = document.createElement("div");
      wrap.className = "hdt-control";
      const btn = document.createElement("button");
      btn.className = "hdt-toggle";
      btn.textContent = btnHighlightOn ? "ON" : "OFF";
      btn.classList.toggle("active", btnHighlightOn);
      btn.addEventListener("click", () => {
        btnHighlightOn = !btnHighlightOn;
        this.root.classList.toggle("hdt-btn-highlight", btnHighlightOn);
        btn.textContent = btnHighlightOn ? "ON" : "OFF";
        btn.classList.toggle("active", btnHighlightOn);
        try {
          localStorage.setItem(btnHighlightKey, btnHighlightOn ? "1" : "0");
        } catch {
          /* ignore */
        }
      });
      wrap.appendChild(btn);
      row.appendChild(wrap);
      body.appendChild(row);
    }

    if (this.opts.showLayoutEditor !== false) {
      const row = document.createElement("div");
      row.className = "hdt-row";
      const lbl = document.createElement("label");
      lbl.className = "hdt-label";
      lbl.textContent = "Layout Editor";
      row.appendChild(lbl);
      const wrap = document.createElement("div");
      wrap.className = "hdt-control";
      const btn = document.createElement("button");
      btn.className = "hdt-toggle";
      btn.textContent = "OFF";
      btn.addEventListener("click", () => {
        this.layoutEditorOn = !this.layoutEditorOn;
        btn.textContent = this.layoutEditorOn ? "ON" : "OFF";
        btn.classList.toggle("active", this.layoutEditorOn);
        if (this.layoutEditorOn) this.enableLayoutEditor();
        else this.disableLayoutEditor();
      });
      wrap.appendChild(btn);
      row.appendChild(wrap);
      body.appendChild(row);
    }

    // Editor info line — selected button coordinates
    this.editorInfoEl = document.createElement("div");
    this.editorInfoEl.className = "hdt-editor-info";
    this.editorInfoEl.style.display = "none";
    body.appendChild(this.editorInfoEl);

    // Editor export buttons
    this.editorExportRow = document.createElement("div");
    this.editorExportRow.className = "hdt-editor-exports";
    this.editorExportRow.style.display = "none";
    this.editorExportRow.appendChild(this.makeExportButton("Copy CSS", () => this.copyEditorCSS()));
    this.editorExportRow.appendChild(
      this.makeExportButton("Copy JSON", () => this.copyEditorJSON())
    );
    this.editorExportRow.appendChild(this.makeExportButton("Log", () => this.logEditorToConsole()));
    this.editorExportRow.appendChild(
      this.makeExportButton("Revert", () => this.resetEditorLayout())
    );
    body.appendChild(this.editorExportRow);

    const sep = document.createElement("div");
    sep.style.cssText = "height:1px;background:hsl(225 10% 30%/.6);margin:2px 0";
    body.appendChild(sep);

    for (const ctrl of this.controls) {
      const row = document.createElement("div");
      row.className = "hdt-row";
      const label = document.createElement("label");
      label.className = "hdt-label";
      label.textContent = ctrl.label;
      row.appendChild(label);
      row.appendChild(this.buildControl(ctrl));
      body.appendChild(row);
    }

    // Inject shared styles once
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
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

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

  private getEditorScale(): number {
    const m = this.root.style.transform.match(/scale\(([\d.]+)\)/);
    return m ? parseFloat(m[1]) : 1;
  }

  private getElementGeometry(el: HTMLElement): {
    left: number;
    top: number;
    width: number;
    height: number;
  } {
    const cs = getComputedStyle(el);
    const scale = this.getEditorScale();

    // Lazily-cached rects — at most one getBoundingClientRect call per rect per call.
    let rootRect: DOMRect | null = null;
    let elRect: DOMRect | null = null;
    const getElRect = (): DOMRect => {
      if (!elRect) elRect = el.getBoundingClientRect();
      return elRect;
    };
    const getRootRect = (): DOMRect => {
      if (!rootRect) rootRect = this.root.getBoundingClientRect();
      return rootRect;
    };

    // width/height: prefer inline → computed (if non-zero numeric) → actual bounding rect.
    // parseFloat("auto") = NaN, which is falsy, so auto-sized elements fall through to the rect.
    const width = el.style.width
      ? parseFloat(el.style.width)
      : parseFloat(cs.width) || getElRect().width / scale;
    const height = el.style.height
      ? parseFloat(el.style.height)
      : parseFloat(cs.height) || getElRect().height / scale;

    // left/top: prefer inline → computed (if not "auto") → bounding rect relative to root.
    const getOffset = (inline: string, computed: string, side: "left" | "top"): number => {
      if (inline) return parseFloat(inline);
      if (computed !== "auto") return parseFloat(computed) || 0;
      return (getElRect()[side] - getRootRect()[side]) / scale;
    };

    return {
      left: Math.round(getOffset(el.style.left, cs.left, "left")),
      top: Math.round(getOffset(el.style.top, cs.top, "top")),
      width: Math.round(width),
      height: Math.round(height),
    };
  }

  // nearest non-static ancestor (containing block for position:absolute)
  private getContainingBlock(el: HTMLElement): HTMLElement {
    let p = el.parentElement;
    while (p && p !== this.root) {
      if (getComputedStyle(p).position !== "static") return p;
      p = p.parentElement;
    }
    return this.root;
  }

  /** Three passes: data-hud-* elements, absolute-positioned descendants, img/svg.
   *  Deduped: if parent is already in set, child is excluded (moves with parent
   *  and including both creates duplicate overlapping outlines/labels. */
  private getEditableElements(): HTMLElement[] {
    const seen = new Set<HTMLElement>();
    for (const el of this.root.querySelectorAll<HTMLElement>(EDITABLE_SELECTOR)) {
      seen.add(el);
    }
    for (const el of this.root.querySelectorAll<HTMLElement>("*")) {
      if (getComputedStyle(el).position === "absolute") seen.add(el);
    }
    for (const el of this.root.querySelectorAll<HTMLElement>("img, svg")) {
      seen.add(el);
    }
    // skip elements whose containing block is already editable (avoids ghost outlines)
    // exception: img/svg always selectable since they have their own CSS sizes
    return [...seen].filter((el) => {
      if (!el.matches(EDITABLE_SELECTOR)) return true;
      const cb = this.getContainingBlock(el);
      return cb === this.root || !seen.has(cb);
    });
  }

  private updateEditorInfo(el: HTMLElement | null): void {
    if (!el) {
      this.editorInfoEl.textContent = "Click an element to select";
      return;
    }
    const entry = this.editorElementMap.get(el);
    const label = entry?.identity.label ?? "?";
    const { left, top, width, height } = this.getElementGeometry(el);
    this.editorInfoEl.textContent = `${label}  ·  ${left},${top}  ${width}${String.fromCharCode(0xd7)}${height}`;
  }

  private selectEditorElement(el: HTMLElement | null): void {
    if (this.selectedEditorEl && this.selectedEditorEl !== el) {
      this.selectedEditorEl.classList.remove("hdt-editor-selected");
    }
    this.selectedEditorEl = el;
    el?.classList.add("hdt-editor-selected");
    this.updateEditorInfo(el);
  }

  private makeExportButton(label: string, handler: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "hdt-toggle";
    btn.textContent = label;
    btn.style.cssText = "font-size:8px;padding:2px 6px;flex:1;min-width:0";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      handler();
      // Flash confirmation — only for copy buttons, not Reset
      if (label.startsWith("Copy")) {
        const orig = btn.textContent;
        btn.textContent = String.fromCharCode(0x2713);
        btn.classList.add("active");
        setTimeout(() => {
          btn.textContent = orig;
          btn.classList.remove("active");
        }, 1200);
      }
    });
    return btn;
  }

  // only returns elements the user actually moved/resized
  private getDirtyElements(): EditorElement[] {
    return this.editorElements.filter(
      ({ el }) => el.style.left || el.style.top || el.style.width || el.style.height
    );
  }

  private getElementIdentity(el: HTMLElement): HudElementIdentity {
    for (const attr of EDITABLE_ATTRS) {
      const val = el.getAttribute(attr);
      if (val == null) continue;
      const short = attr.replace("data-hud-", "");
      if (attr === "data-hud-btn") {
        return { label: val, cssSelector: `.hit-${val}`, key: val, attr };
      }
      return { label: `${val} (${short})`, cssSelector: `[${attr}="${val}"]`, key: val, attr };
    }
    // No data-hud-* — discovered via position:absolute or img/svg pass.
    // Use getAttribute("class") instead of el.className — SVG elements return SVGAnimatedString,
    // not a plain string, so .trim() would throw.
    if (el.id) {
      return { label: `#${el.id}`, cssSelector: `#${el.id}`, key: el.id, attr: "" };
    }
    const cls = el.getAttribute("class")?.trim().split(/\s+/)[0];
    if (cls) {
      return { label: `.${cls}`, cssSelector: `.${cls}`, key: cls, attr: "" };
    }
    return {
      label: el.tagName.toLowerCase(),
      cssSelector: el.tagName.toLowerCase(),
      key: el.tagName.toLowerCase(),
      attr: "",
    };
  }

  // Stored so we can remove the exact same listener reference in disableLayoutEditor
  private editorDragStartHandler: ((e: Event) => void) | null = null;

  private enableLayoutEditor(): void {
    // Prevent native browser drag on <img> and other draggable elements while editor is active
    this.editorDragStartHandler = (e: Event) => e.preventDefault();
    this.root.addEventListener("dragstart", this.editorDragStartHandler);

    const elements = this.getEditableElements();
    const scale = this.getEditorScale();

    // Pre-compute conversion geometry for all static elements BEFORE touching the DOM.
    // Converting element A to absolute removes it from normal flow, which would shift
    // element B's getBoundingClientRect() if we computed them one-by-one during the loop.
    type Conversion = { left: number; top: number; width: number; height: number } | null;
    const conversions: Conversion[] = elements.map((el) => {
      if (getComputedStyle(el).position !== "static") return null;
      const cb = this.getContainingBlock(el);
      const cbRect = cb.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      // Position relative to the containing block (where absolute coords are measured from).
      // Use actual bounding rect dimensions to handle inline/auto-sized elements correctly.
      return {
        left: Math.round((elRect.left - cbRect.left) / scale),
        top: Math.round((elRect.top - cbRect.top) / scale),
        width: Math.round(elRect.width / scale),
        height: Math.round(elRect.height / scale),
      };
    });

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const conv = conversions[i];
      const identity = this.getElementIdentity(el);

      // Apply static→absolute conversion using the pre-computed geometry
      const savedPosition = el.style.position;
      let wasConverted = false;
      if (conv) {
        el.style.position = "absolute";
        el.style.left = `${conv.left}px`;
        el.style.top = `${conv.top}px`;
        el.style.width = `${conv.width}px`;
        el.style.height = `${conv.height}px`;
        wasConverted = true;
      }

      // Floating label above the element
      const label = document.createElement("div");
      label.className = "hdt-editor-label";
      label.textContent = identity.label;
      // Force pointer events on — CSS may set pointer-events:none on img/svg/icons
      const savedPointerEvents = el.style.pointerEvents;
      el.style.pointerEvents = "auto";

      // Allow the label to overflow the element's clipping box upward
      const savedOverflow = el.style.overflow;
      el.style.overflow = "visible";
      el.appendChild(label);

      // Resize handle at bottom-right corner
      const handle = document.createElement("div");
      handle.className = "hdt-editor-handle";
      el.appendChild(handle);

      el.classList.add("hdt-editor-el");
      el.style.cursor = "move";

      // Capture-phase click: select element instead of firing onAction
      const clickCapture = (e: MouseEvent): void => {
        e.stopImmediatePropagation();
        this.selectEditorElement(el);
      };
      el.addEventListener("click", clickCapture, true);

      // Drag to reposition — delta divided by scale so layout px match screen px
      const dragDown = (e: MouseEvent): void => {
        if (e.target === handle) return;
        e.preventDefault();
        e.stopPropagation();
        const scale = this.getEditorScale();
        const x0 = e.clientX;
        const y0 = e.clientY;
        const { left: l0, top: t0 } = this.getElementGeometry(el);
        this.selectEditorElement(el);

        const onMove = (ev: MouseEvent): void => {
          el.style.left = `${Math.round(l0 + (ev.clientX - x0) / scale)}px`;
          el.style.top = `${Math.round(t0 + (ev.clientY - y0) / scale)}px`;
          this.updateEditorInfo(el);
        };
        const onUp = (): void => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      };
      el.addEventListener("mousedown", dragDown);

      // Resize via bottom-right corner handle
      const resizeDown = (e: MouseEvent): void => {
        e.preventDefault();
        e.stopPropagation();
        const scale = this.getEditorScale();
        const x0 = e.clientX;
        const y0 = e.clientY;
        const { width: w0, height: h0 } = this.getElementGeometry(el);
        this.selectEditorElement(el);

        const onMove = (ev: MouseEvent): void => {
          el.style.width = `${Math.max(8, Math.round(w0 + (ev.clientX - x0) / scale))}px`;
          el.style.height = `${Math.max(8, Math.round(h0 + (ev.clientY - y0) / scale))}px`;
          this.updateEditorInfo(el);
          // Re-run afterUpdate so fit-text and other size-dependent DOM effects update live
          this.afterUpdate?.(this.state);
        };
        const onUp = (): void => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      };
      handle.addEventListener("mousedown", resizeDown);

      const entry: EditorElement = {
        el,
        label,
        handle,
        identity,
        savedOverflow,
        savedPosition,
        savedPointerEvents,
        wasConverted,
        clickCapture,
        dragDown,
        resizeDown,
      };
      this.editorElements.push(entry);
      this.editorElementMap.set(el, entry);
    }

    this.editorInfoEl.textContent = "Click an element to select";
    this.editorInfoEl.style.display = "";
    this.editorExportRow.style.display = "flex";
  }

  private disableLayoutEditor(): void {
    if (this.editorDragStartHandler) {
      this.root.removeEventListener("dragstart", this.editorDragStartHandler);
      this.editorDragStartHandler = null;
    }
    for (const {
      el,
      label,
      handle,
      savedOverflow,
      savedPointerEvents,
      clickCapture,
      dragDown,
      resizeDown,
    } of this.editorElements) {
      el.removeEventListener("click", clickCapture, true);
      el.removeEventListener("mousedown", dragDown);
      handle.removeEventListener("mousedown", resizeDown);
      label.remove();
      handle.remove();
      el.classList.remove("hdt-editor-el", "hdt-editor-selected");
      el.style.cursor = "";
      el.style.overflow = savedOverflow;
      el.style.pointerEvents = savedPointerEvents;
      // Intentionally do NOT restore position for converted elements: their new absolute
      // coordinates represent the designer's edit and should persist after toggling off.
      // Reset (resetEditorLayout) is the only operation that fully reverts the conversion.
    }
    this.editorElements = [];
    this.editorElementMap.clear();
    this.selectedEditorEl = null;
    this.editorInfoEl.style.display = "none";
    this.editorExportRow.style.display = "none";
  }

  private copyEditorCSS(): void {
    const dirty = this.getDirtyElements();
    if (!dirty.length) {
      console.log("%c[DevTools] No elements moved — nothing to copy", "color:#f59e0b");
      return;
    }
    const lines = dirty.map(({ el, identity, wasConverted }) => {
      const { left, top, width, height } = this.getElementGeometry(el);
      const pos = wasConverted ? "position: absolute; " : "";
      return `${identity.cssSelector} { ${pos}left: ${left}px; top: ${top}px; width: ${width}px; height: ${height}px; }`;
    });
    const text = lines.join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
    console.log(
      `%c[DevTools] Copied CSS:%c\n${text}`,
      "color:#3b82f6;font-weight:bold",
      "color:inherit"
    );
  }

  private copyEditorJSON(): void {
    const dirty = this.getDirtyElements();
    if (!dirty.length) {
      console.log("%c[DevTools] No elements moved — nothing to copy", "color:#f59e0b");
      return;
    }
    const arr = dirty.map(({ el, identity, wasConverted }) => {
      const { left, top, width, height } = this.getElementGeometry(el);
      return {
        attr: identity.attr,
        key: identity.key,
        x: left,
        y: top,
        width,
        height,
        ...(wasConverted && { position: "absolute" }),
      };
    });
    const text = JSON.stringify(arr, null, 2);
    navigator.clipboard.writeText(text).catch(() => {});
    console.log(
      `%c[DevTools] Copied JSON:%c\n${text}`,
      "color:#3b82f6;font-weight:bold",
      "color:inherit"
    );
  }

  private logEditorToConsole(): void {
    const dirty = this.getDirtyElements();
    if (!dirty.length) {
      console.log("%c[DevTools] No elements moved", "color:#f59e0b");
      return;
    }
    console.group("%c[DevTools] Layout changes", "color:#3b82f6;font-weight:bold");
    for (const { el, identity } of dirty) {
      const { left, top, width, height } = this.getElementGeometry(el);
      console.log(
        `%c${identity.label}%c  left:${left} top:${top} ${width}\u00d7${height}`,
        "color:#f59e0b;font-weight:bold",
        "color:inherit"
      );
    }
    console.groupEnd();
  }

  private resetEditorLayout(): void {
    for (const { el, savedPosition, savedOverflow, wasConverted } of this.editorElements) {
      el.style.left = "";
      el.style.top = "";
      el.style.width = "";
      el.style.height = "";
      // For converted elements, fully revert the static→absolute conversion so the
      // element returns to its original layout-flow position.
      if (wasConverted) {
        el.style.position = savedPosition;
        el.style.overflow = savedOverflow;
      }
    }
    this.updateEditorInfo(this.selectedEditorEl);
  }

  destroy(): void {
    if (this.layoutEditorOn) this.disableLayoutEditor();
    this.panel.remove();
  }
}

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

/* Layout editor */
.hdt-editor-info {
	font-family: monospace;
	font-size: 9px;
	color: hsl(220 8% 58%);
	padding: 1px 0;
	min-height: 13px;
}

.hdt-editor-exports {
	gap: 3px;
	flex-wrap: wrap;
}

/* Editor element states — driven by classes set in JS */
.hdt-editor-el {
	outline: 1px dashed rgba(59,130,246,0.5) !important;
}
.hdt-editor-el:hover {
	outline: 1px dashed rgba(59,130,246,0.8) !important;
}
.hdt-editor-selected {
	outline: 2px solid hsl(211 80% 55%) !important;
	box-shadow: 0 0 8px rgba(59,130,246,0.6) !important;
}

.hdt-editor-label {
	position: absolute;
	bottom: calc(100% + 3px);
	left: 50%;
	transform: translateX(-50%);
	font-family: monospace;
	font-size: 8px;
	line-height: 1.4;
	white-space: nowrap;
	color: #fff;
	background: rgba(0,0,0,0.75);
	padding: 1px 4px;
	border-radius: 2px;
	pointer-events: none;
	z-index: 9999;
	opacity: 0;
	transition: opacity 0.1s;
}
/* Show label only on hover or when the element is selected */
.hdt-editor-el:hover > .hdt-editor-label,
.hdt-editor-selected > .hdt-editor-label {
	opacity: 1;
}

.hdt-editor-handle {
	position: absolute;
	right: -3px;
	bottom: -3px;
	width: 7px;
	height: 7px;
	background: hsl(211 80% 55%);
	border-radius: 1px;
	cursor: se-resize;
	z-index: 2;
}

/* Scrollbar */
.hdt-body::-webkit-scrollbar { width: 4px; }
.hdt-body::-webkit-scrollbar-track { background: transparent; }
.hdt-body::-webkit-scrollbar-thumb { background: hsl(220 8% 58% / 0.3); border-radius: 2px; }
`;
