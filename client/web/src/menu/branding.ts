// Server branding: a banner image and an accent colour, pushed from Lua rather
// than compiled into the stylesheet, so an owner need not fork and rebuild the
// NUI to put their mark on the menu.
//
// Both values land somewhere a string can do damage -- the accent in a CSS custom
// property, the banner in an <img src> -- so the validators below are allowlists
// of the exact shapes they may take rather than sanitizers. A rejected value
// leaves the menu looking as it does with no branding configured.

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A game texture, resolved as MenuIcon resolves a row icon: CitizenFX registers
// https://nui-img, so a dictionary the client already streams needs no image file.
export interface BannerTexture {
  dictionary: string;
  texture: string;
}
export interface BannerImage {
  url: string;
}
export type BannerSource = BannerTexture | BannerImage;

// The same fields are accepted at every layer, so there is one shape to learn.
// `theme` names one registered through AddTheme, where full CSS-variable control
// already lives, so there is one theme registry rather than two.
export interface Theme {
  accent?: string;
  banner?: BannerSource;
  theme?: string;
  skin?: MenuSkin;
}

// Presentation, not colour: 'default' is the shared look tLib's dialogs and toasts
// use, 'vmenu' the legacy one. A closed set, because it selects a stylesheet
// rather than supplying a value to one.
export type MenuSkin = "default" | "vmenu";
export const MENU_SKINS: readonly MenuSkin[] = ["default", "vmenu"];
export const DEFAULT_MENU_SKIN: MenuSkin = "default";
export function isMenuSkin(value: unknown): value is MenuSkin {
  // Reads MENU_SKINS rather than repeating it. The two spellings were a second
  // source of truth for one list, and the array was the copy nothing read.
  return MENU_SKINS.includes(value as MenuSkin);
}

// Three layers, most specific first: the page's own theme, the theme of the
// resource that created it, then these interface defaults. Menu ids are
// `owner:name`, so the middle layer needs no plumbing -- the page says who made it.
export interface Branding {
  accent?: string;
  banner?: BannerSource;
  themes?: {
    owners?: Record<string, Theme>;
    menus?: Record<string, Theme>;
  };
}

// #rrggbb only -- no named colour, no rgb(), no var(). The value is written into a
// custom property, where anything else could carry a second declaration, a url()
// or an image-set() into the panel's style attribute.
const HEX = /^#[0-9a-f]{6}$/i;
export function isAccent(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

// The game's own asset naming, so neither segment can introduce a '/', a '..', a
// query string or a quote into https://nui-img/{dictionary}/{texture}.
const ASSET_NAME = /^[a-z0-9_]{1,64}$/i;
// RFC 3986's set. No space, quote, angle bracket or backslash, so the URL cannot
// terminate the attribute it is rendered into.
const URL_CHARS = /^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;
export const MAX_BANNER_URL = 512;
export function isBannerSource(value: unknown): value is BannerSource {
  if (!object(value)) return false;
  if ("url" in value) {
    if (
      Object.keys(value).length !== 1 ||
      typeof value.url !== "string" ||
      value.url.length > MAX_BANNER_URL ||
      !URL_CHARS.test(value.url)
    )
      return false;
    try {
      const url = new URL(value.url);
      // https only: http is a mixed-content block inside CEF anyway, and
      // data:/blob:/javascript: put author-controlled bytes behind an origin check
      // that never runs. Credentials here are never legitimate.
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }
  return (
    Object.keys(value).length === 2 &&
    typeof value.dictionary === "string" &&
    typeof value.texture === "string" &&
    ASSET_NAME.test(value.dictionary) &&
    ASSET_NAME.test(value.texture)
  );
}

// The override map is a configuration table, not menu content: a snapshot-sized
// one would grow the store without going through the presentation budget.
export const MAX_ACCENT_OVERRIDES = 64;

// Mirrors MenuSchema.theme. The engine validates at registration so a developer is
// told which field is wrong; this is the boundary that decides, because it is the
// one the value crosses on its way into the document.
const THEME_ID = /^[\w:.-]{1,64}$/;
export function isTheme(value: unknown): value is Theme {
  if (!object(value)) return false;
  if (
    !Object.keys(value).every(
      (key) => key === "accent" || key === "banner" || key === "theme" || key === "skin"
    )
  )
    return false;
  if (value.accent !== undefined && !isAccent(value.accent)) return false;
  if (value.banner !== undefined && !isBannerSource(value.banner)) return false;
  if (value.theme !== undefined && (typeof value.theme !== "string" || !THEME_ID.test(value.theme)))
    return false;
  if (value.skin !== undefined && !isMenuSkin(value.skin)) return false;
  return Object.keys(value).length > 0;
}

function isThemeMap(value: unknown): value is Record<string, Theme> {
  if (!object(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > MAX_ACCENT_OVERRIDES) return false;
  return entries.every(([id, theme]) => id.length > 0 && id.length <= 256 && isTheme(theme));
}

export function isBranding(value: unknown): value is Branding {
  if (
    !object(value) ||
    !Object.keys(value).every((key) => key === "accent" || key === "banner" || key === "themes")
  )
    return false;
  if (value.accent !== undefined && !isAccent(value.accent)) return false;
  if (value.banner !== undefined && !isBannerSource(value.banner)) return false;
  if (value.themes !== undefined) {
    if (!object(value.themes)) return false;
    if (!Object.keys(value.themes).every((key) => key === "owners" || key === "menus"))
      return false;
    if (value.themes.owners !== undefined && !isThemeMap(value.themes.owners)) return false;
    if (value.themes.menus !== undefined && !isThemeMap(value.themes.menus)) return false;
  }
  return true;
}

// A Lua empty table crosses as {} or [] indiscriminately, which is the difference
// between "no banner configured" and a whole branding push rejected because the
// banner was written as an empty table. Absence has to survive the wire, so an
// empty collection in either slot is dropped rather than validated.
export function normalizeBranding(value: unknown): Branding | undefined {
  if (!object(value)) return undefined;
  const empty = (entry: unknown) =>
    Array.isArray(entry) ? entry.length === 0 : object(entry) && Object.keys(entry).length === 0;
  const candidate: Record<string, unknown> = { ...value };
  if (empty(candidate.banner)) delete candidate.banner;
  // The same one level deeper. The engine omits `themes` entirely when nothing is
  // themed, so this stays a normalization rather than a guess at intent.
  if (object(candidate.themes)) {
    const themes: Record<string, unknown> = { ...candidate.themes };
    if (empty(themes.owners)) delete themes.owners;
    if (empty(themes.menus)) delete themes.menus;
    if (Object.keys(themes).length === 0) delete candidate.themes;
    else candidate.themes = themes;
  } else if (empty(candidate.themes)) delete candidate.themes;
  return isBranding(candidate) ? candidate : undefined;
}

export function bannerUrl(banner: BannerSource | undefined): string | undefined {
  if (!banner || !isBannerSource(banner)) return undefined;
  return "url" in banner ? banner.url : `https://nui-img/${banner.dictionary}/${banner.texture}`;
}

// Own properties only: these maps arrive as JSON, and a menu id read through the
// prototype chain would answer with a function for "__proto__" or "constructor".
function own<T>(map: Record<string, T> | undefined, key: string): T | undefined {
  return map && Object.hasOwn(map, key) ? map[key] : undefined;
}

// Before the first colon, not the last: 'a:b:c' is owner 'a'.
export function ownerOf(menuId: string): string | undefined {
  const colon = menuId.indexOf(":");
  return colon > 0 ? menuId.slice(0, colon) : undefined;
}

// Flattened field by field, not whole-object: a resource setting only an accent
// must not lose the interface banner, and taking the most specific theme object
// whole would blank every field it omits.
export function resolveTheme(branding: Branding | undefined, menuId: string): Theme {
  const owner = ownerOf(menuId);
  const layers: (Theme | undefined)[] = [
    own(branding?.themes?.menus, menuId),
    owner ? own(branding?.themes?.owners, owner) : undefined,
    { accent: branding?.accent, banner: branding?.banner },
  ];
  const resolved: Theme = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (resolved.accent === undefined && isAccent(layer.accent)) resolved.accent = layer.accent;
    if (resolved.banner === undefined && isBannerSource(layer.banner))
      resolved.banner = layer.banner;
    if (
      resolved.theme === undefined &&
      typeof layer.theme === "string" &&
      THEME_ID.test(layer.theme)
    ) {
      resolved.theme = layer.theme;
    }
    if (resolved.skin === undefined && isMenuSkin(layer.skin)) resolved.skin = layer.skin;
  }
  return resolved;
}

export function accentFor(branding: Branding | undefined, menuId: string): string | undefined {
  return resolveTheme(branding, menuId).accent;
}

export function bannerFor(
  branding: Branding | undefined,
  menuId: string
): BannerSource | undefined {
  return resolveTheme(branding, menuId).banner;
}

export function themeIdFor(branding: Branding | undefined, menuId: string): string | undefined {
  return resolveTheme(branding, menuId).theme;
}

// Never undefined: the root carries data-skin at all times, so the stylesheet
// matches one selector rather than testing for presence.
export function skinFor(branding: Branding | undefined, menuId: string): MenuSkin {
  return resolveTheme(branding, menuId).skin ?? DEFAULT_MENU_SKIN;
}

const channel = (value: number) => {
  const part = value / 255;
  return part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
};

// WCAG 2.x relative luminance. The header text colour derives from this rather
// than being fixed white, or a pale banner or accent gives an unreadable title.
export function relativeLuminance(hex: string): number {
  if (!isAccent(hex)) return 0;
  const value = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((value >> 16) & 255) +
    0.7152 * channel((value >> 8) & 255) +
    0.0722 * channel(value & 255)
  );
}

// The two contrast ratios cross at L = 0.1791. Comparing them rather than testing
// a midpoint means the ink chosen always has the higher WCAG contrast.
export function inkForLuminance(luminance: number): "#000000" | "#ffffff" {
  const onBlack = (luminance + 0.05) / 0.05;
  const onWhite = 1.05 / (luminance + 0.05);
  return onBlack >= onWhite ? "#000000" : "#ffffff";
}
export const readableInk = (hex: string): "#000000" | "#ffffff" =>
  inkForLuminance(relativeLuminance(hex));

const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
const hex2 = (value: number) => clamp(value).toString(16).padStart(2, "0");
// Mix toward black (negative) or white (positive), so one accent produces both
// stops of the brand header's gradient. -0.45 lands the dark stop beside the
// hand-picked one the stylesheet shipped: '#16385e' against '#123967'.
export function shade(hex: string, amount: number): string {
  if (!isAccent(hex)) return hex;
  const value = Number.parseInt(hex.slice(1), 16);
  const mix = (part: number) => (amount < 0 ? part * (1 + amount) : part + (255 - part) * amount);
  return `#${hex2(mix((value >> 16) & 255))}${hex2(mix((value >> 8) & 255))}${hex2(mix(value & 255))}`;
}

// Weighted by alpha: a banner is usually a logo on transparency, and counting its
// transparent corners as black would put white ink on a white logo. Undefined when
// nothing is opaque enough to judge, so the caller falls back to the accent.
export function averageLuminance(pixels: ArrayLike<number>): number | undefined {
  let total = 0,
    weight = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = pixels[index + 3]! / 255;
    if (alpha <= 0) continue;
    total +=
      alpha *
      (0.2126 * channel(pixels[index]!) +
        0.7152 * channel(pixels[index + 1]!) +
        0.0722 * channel(pixels[index + 2]!));
    weight += alpha;
  }
  return weight > 0 ? total / weight : undefined;
}

// Downsampled to 8x8: the answer is an average, so decoding a 4K logo pixel by
// pixel buys nothing. nui-img and any remote host are cross-origin, so the tainted
// canvas makes getImageData throw -- an expected path, landing on the accent.
export function sampleInk(image: HTMLImageElement): "#000000" | "#ffffff" | undefined {
  try {
    if (!image.naturalWidth || !image.naturalHeight) return undefined;
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(image, 0, 0, 8, 8);
    const luminance = averageLuminance(context.getImageData(0, 0, 8, 8).data);
    return luminance === undefined ? undefined : inkForLuminance(luminance);
  } catch {
    return undefined;
  }
}
