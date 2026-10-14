// Reading what a layout declares and what it binds, out of its `ui.html` SOURCE.
//
// Why a text scanner exists next to HudBinder
//
// `HudBinder` answers the same question against a live DOM, which means a
// browser. This one is regex over the source text, so it runs under `bun test`
// with nothing loaded — which is what lets a layout lint check every shipped
// skin, and any skin a player installs from the marketplace, before it is ever
// rendered. That is worth having, because a mistyped key is SILENT at runtime:
// `data-hud-text="front.targetTxt"` paints an empty string forever with no
// error anywhere. Comparing what a layout binds against what the engine
// produces turns that into a build failure instead of a window that never lights.
//
// Why it is here rather than in each resource
//
// Three copies existed: tRadar's (complete), tDetector's layout lint (comments
// only) and tDetector's screenshot tool. Only tRadar's stripped `<style>`, and
// that omission is not cosmetic — tRadio's layouts address `data-hud-*` by CSS
// selector, so a scan that reads style blocks harvests keys that no element
// binds and the lint then passes on bindings that do not exist. Whichever copy
// a fourth resource had happened to start from decided whether its lint worked.
//
// Everything resource-specific is a parameter: the declaration prefix
// (`data-<prefix>-width` and friends) and the device classes that prefix allows.
// The `data-hud-*` binding grammar itself is shared by definition — it is
// HudBinder's.

/** Attributes whose whole value is a state key. */
const KEY_ATTRS = [
  "data-hud-text",
  "data-hud-html",
  "data-hud-led",
  "data-hud-show",
  "data-hud-hide",
  "data-hud-led-color",
] as const;

/** Attributes of the form `key:something`; only the head is a state key. */
const PREFIXED_ATTRS = ["data-hud-eq", "data-hud-attr"] as const;

export interface LayoutScanOptions {
  /**
   * The resource's own declaration namespace: `"radar"` reads
   * `data-radar-device-class`, `data-radar-width`, `data-radar-height` and
   * `data-radar-default-scale`.
   */
  prefix: string;
  /** Device classes this resource recognises. Anything else is reported, never guessed. */
  deviceClasses?: readonly string[];
  /** What `deviceClass` is when the layout declares nothing. */
  defaultDeviceClass?: string;
}

export interface LayoutScan {
  /** Declared, never inferred — a scanner layout sits in the same folder as the radios. */
  deviceClass: string;
  /** Declared chassis size in CSS px, or null when the layout does not say. */
  width: number | null;
  height: number | null;
  defaultScale: number;
  /** State keys the layout reads, deduped, in first-seen order. Dot paths kept whole. */
  bindings: string[];
  /** Button actions the layout fires. */
  actions: string[];
  /** Declarations recognised in shape but not in value. */
  unknown: string[];
}

/**
 * Drop everything that is not live markup.
 *
 * All three removals are load-bearing, and dropping any one of them makes the
 * lint pass on bindings that do not exist:
 *
 * - **Comments.** Every layout opens with a block listing the keys it consumes,
 *   written with placeholder names.
 * - **`<style>`.** tRadio's layouts select on `[data-hud-show="..."]`.
 * - **`<script>`.** tELS's layout script contains the attribute names as strings.
 */
export function stripProse(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const attr = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match = attr.exec(tag);
  while (match !== null) {
    out.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? "");
    match = attr.exec(tag);
  }
  return out;
}

function beforeColon(value: string): string {
  const colon = value.indexOf(":");
  return colon < 0 ? value : value.slice(0, colon);
}

export function scanLayout(html: string, opts: LayoutScanOptions): LayoutScan {
  const classes = new Set(opts.deviceClasses ?? []);
  const scan: LayoutScan = {
    deviceClass: opts.defaultDeviceClass ?? "",
    width: null,
    height: null,
    defaultScale: 1,
    bindings: [],
    actions: [],
    unknown: [],
  };

  const classAttr = `data-${opts.prefix}-device-class`;
  const widthAttr = `data-${opts.prefix}-width`;
  const heightAttr = `data-${opts.prefix}-height`;
  const scaleAttr = `data-${opts.prefix}-default-scale`;

  const bindings = new Set<string>();
  const actions = new Set<string>();
  let rootSeen = false;

  for (const [tag] of stripProse(html).matchAll(/<[a-zA-Z][^>]*>/g)) {
    const attrs = attributes(tag);

    // The first tag carrying a declaration is the root; a later one cannot
    // redeclare the device, which would leave "what is this layout" ambiguous.
    if (!rootSeen) {
      const declared = attrs.get(classAttr);
      if (declared !== undefined) {
        rootSeen = true;
        if (classes.size === 0 || classes.has(declared)) scan.deviceClass = declared;
        else scan.unknown.push(`device-class:${declared}`);
      }
    }

    const width = Number(attrs.get(widthAttr));
    if (attrs.has(widthAttr) && Number.isFinite(width)) scan.width ??= width;
    const height = Number(attrs.get(heightAttr));
    if (attrs.has(heightAttr) && Number.isFinite(height)) scan.height ??= height;
    const scale = Number(attrs.get(scaleAttr));
    if (attrs.has(scaleAttr) && Number.isFinite(scale) && scale > 0) scan.defaultScale = scale;

    for (const name of KEY_ATTRS) {
      const value = attrs.get(name);
      if (value) bindings.add(value);
    }

    for (const name of PREFIXED_ATTRS) {
      const value = attrs.get(name);
      // A colon-less `eq`/`attr` is malformed and HudBinder skips it outright.
      // Reporting the whole string as a key here would make the lint fail with a
      // confusing "unknown key" rather than the real complaint.
      if (value?.includes(":")) bindings.add(beforeColon(value));
      else if (value) scan.unknown.push(`${name}:${value}`);
    }

    const action = attrs.get("data-hud-btn");
    if (action) actions.add(action);
  }

  scan.bindings = [...bindings];
  scan.actions = [...actions];
  return scan;
}
