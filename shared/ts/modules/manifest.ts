// The on-disk module contract: a folder plus a `module.json` that declares what it is.
//
//   layouts/QRX-720/module.json        kind: "layout"
//
// `kind` is DECLARED, not inferred from location: the old marker-file convention
//
// There is no declared asset list. A module declares its IDENTITY; its CONTENT is
// `sound.file` and `theme.fonts[].file` are declared because nothing else can
// know which of several files is meant, or what family a `.woff2` provides.
//

/** The manifest filename. One name, in every kind of module. */
export const MODULE_MANIFEST = "module.json";

/** The only schema this tLib understands. Bump deliberately; never widen in place. */
export const MODULE_SCHEMA = 1;

export const MODULE_KINDS = ["layout", "theme", "sound"] as const;
export type ModuleKind = (typeof MODULE_KINDS)[number];

/**
 * Folder names a module may never take.
 */
export const RESERVED_MODULE_IDS = ["sounds", "themes"] as const;

/** Audio facts a sound module declares, because they cannot be scanned for. */
export interface ModuleSound {
  /** Bare filename of the audio inside this folder. `.wav`, `.ogg` or `.mp3`. */
  file: string;
  /** Measured length, for the admin list and the preview scrubber. */
  durationSeconds?: number;
  /** tRadio tone slots this sound is the stock asset for, e.g. `["ALERT_A"]`. */
  toneKeys?: string[];
  /** Normalised waveform peaks, 0..1, for a preview that decodes no audio. */
  peaks?: number[];
}

/**
 * The subdirectory a theme module's font files live in.
 */
export const MODULE_THEME_FONT_DIR = "fonts";

/**
 * One `@font-face` a theme module ships, as a declaration rather than a guess.
 */
export interface ModuleThemeFont {
  /**
   * The CSS family name this file provides, spelled exactly as a font token
   * will name it. This is the whole point of the declaration: it is what makes
   */
  family: string;
  /** Bare filename inside the module's `fonts/` directory. `.woff2` only. */
  file: string;
  /**
   * `font-weight` for this face. `"400"`, or a range like `"100 800"` for a
   * variable font shipped as one file.
   */
  weight?: string;
  /**
   * `font-style`. Default `normal`.
   */
  style?: "normal" | "italic";
  /**
   * Bare filename of the licence that covers this file, beside it in `fonts/`.
   *
   * REQUIRED, not optional, and that is a decision rather than an oversight.
   * This estate already pays the cost for its own two faces — `OFL-Poppins.txt`
   * and `OFL-JetBrainsMono.txt` sit next to their `.woff2` on purpose, and the
   * generated `fonts.css` header states the rule: "the license file must travel
   * with the woff2 files". A theme module is a MARKETPLACE ARTEFACT: it is
   * zipped, published and installed onto other people's servers, so a theme that
   * redistributes a third-party font with no licence beside it is a legal defect
   * the schema can refuse for free.
   *
   * Stated per FACE rather than once per family, because the licence attaches to
   * the FILE being redistributed. Three weights of one family repeating
   * `OFL-Inter.txt` is three true statements, not duplication.
   *
   * The existence of the file on disk is not checkable here — this validator
   * reads a decoded object and touches no filesystem — so it is asserted by the
   * consuming repo's gate. The NAME being declared is what makes that possible.
   */
  license: string;
}

/**
 * Theme facts a theme module declares. Fonts, and nothing else yet.
 *
 * A separate block rather than a top-level `fonts` key, mirroring `sound`: the
 * manifest's top level is IDENTITY (what this folder is, who wrote it, what
 * licence it carries) and a kind-scoped block is the facts only that kind has.
 */
export interface ModuleTheme {
  /** Every `@font-face` this theme ships. */
  fonts: ModuleThemeFont[];
}

export interface ModuleManifest {
  schema: typeof MODULE_SCHEMA;
  kind: ModuleKind;
  /** Must equal the folder name, byte for byte. */
  id: string;
  name: string;
  version: string;
  author?: string;
  license?: string;
  description?: string;
  /** Marketplace catalogue key, when this module has a listing. */
  slug?: string;
  sound?: ModuleSound;
  theme?: ModuleTheme;
}

const VERSION = /^\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
const TONE_KEY = /^[A-Z0-9_]+$/;
const AUDIO = /\.(?:wav|ogg|mp3)$/i;
/**
 * woff2 only.
 *
 * Not a shortage of imagination: every engine the panel runs in — including the
 * CEF 103 the game's NUI is — has supported woff2 since 2016, it is 25-30%
 * smaller than woff and several times smaller than the ttf/otf it was compressed
 * from, and one format means one `format()` string and one code path. A theme
 * that only has a ttf converts it once at authoring time; a theme that ships one
 * would make every consumer carry a second branch forever.
 */
const FONT_FILE = /\.woff2$/i;
/**
 * A face's `font-weight`: `400`, or a variable range `100 800`.
 *
 * 1..1000, which is css-fonts-4's range and not the 100..900 of the nine named
 * weights — a variable font may legally be instanced anywhere in it. Leading
 * zeros are refused because `0400` is not a number any `@font-face` matches and
 * is always a typo.
 */
const FONT_WEIGHT = /^(?:[1-9]\d{0,2}|1000)(?: (?:[1-9]\d{0,2}|1000))?$/;
/**
 * Characters a declared family name may not contain.
 *
 * `family` is interpolated into `@font-face { font-family: "<family>" }`, so a
 * quote or a brace could close the rule and inject another, and a COMMA would
 * silently make one declaration into two family names — which matches no face
 * and falls back exactly as loudly as the bug this whole feature exists to kill.
 */
const FONT_FAMILY_FORBIDDEN = /["'{};,\\]|^\s|\s$/;

const MAX_NAME = 120;
const MAX_TEXT = 2048;
const MAX_PEAKS = 512;
const MAX_TONE_KEYS = 64;
/**
 * A theme ships a handful of faces, not a library. The cap is here because every
 * declared face becomes an `@font-face` the panel emits and a file a gate must
 * stat, and an unbounded list is an unbounded amount of both.
 */
const MAX_THEME_FONTS = 32;

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`module.json: "${field}" must be a non-empty string of at most ${max} chars`);
  return value;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value, field, max);
}

/** `alert_a.wav` -> `alert_a`. A sound module's folder id is its audio file's stem. */
export function soundModuleId(file: string): string {
  return file.replace(AUDIO, "");
}

/**
 * Where a sound module's audio lives, relative to the sounds directory.
 *
 * Derivable from the filename alone, with no manifest read and no index lookup,
 * BECAUSE the contract requires the folder id to be the file's stem. That one
 * rule is what keeps `toneWavMap`, `modelToneWavMap`, `bgModeMappings` and the
 * admin UI all speaking bare filenames exactly as they did — an operator's saved
 * tone mapping did not have to be migrated, and nothing had to start shipping a
 * path. It is a declared rule, not a coincidence: `parseModuleManifest` refuses a
 * manifest where the two disagree.
 */
export function soundModulePath(file: string): string {
  return `${soundModuleId(file)}/${file}`;
}

function soundFacts(value: unknown, id: string): ModuleSound {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error('module.json: a "sound" module must carry a "sound" object');
  const raw = value as Record<string, unknown>;
  const file = text(raw.file, "sound.file", 255);
  if (file.includes("/") || file.includes("\\") || file.startsWith("."))
    throw new Error('module.json: "sound.file" must be a bare filename inside this folder');
  if (!AUDIO.test(file))
    throw new Error('module.json: "sound.file" must end in .wav, .ogg or .mp3');
  if (soundModuleId(file) !== id)
    throw new Error(
      `module.json: "sound.file" is "${file}" but the folder is "${id}"; a sound module's audio must be named after its folder`
    );

  const out: ModuleSound = { file };

  if (raw.durationSeconds !== undefined && raw.durationSeconds !== null) {
    const d = raw.durationSeconds;
    if (typeof d !== "number" || !Number.isFinite(d) || d <= 0)
      throw new Error('module.json: "sound.durationSeconds" must be a positive number');
    out.durationSeconds = d;
  }

  if (raw.toneKeys !== undefined && raw.toneKeys !== null) {
    if (!Array.isArray(raw.toneKeys) || raw.toneKeys.length > MAX_TONE_KEYS)
      throw new Error(`module.json: "sound.toneKeys" must be an array of at most ${MAX_TONE_KEYS}`);
    out.toneKeys = raw.toneKeys.map((key) => {
      if (typeof key !== "string" || !TONE_KEY.test(key))
        throw new Error('module.json: every "sound.toneKeys" entry must match /^[A-Z0-9_]+$/');
      return key;
    });
  }

  if (raw.peaks !== undefined && raw.peaks !== null) {
    if (!Array.isArray(raw.peaks) || !raw.peaks.length || raw.peaks.length > MAX_PEAKS)
      throw new Error(`module.json: "sound.peaks" must be 1..${MAX_PEAKS} numbers`);
    out.peaks = raw.peaks.map((peak) => {
      if (typeof peak !== "number" || !Number.isFinite(peak) || peak < 0 || peak > 1)
        throw new Error('module.json: every "sound.peaks" entry must be a number in 0..1');
      return peak;
    });
  }

  return out;
}

/** Where one of a theme module's font files lives, relative to the module folder. */
export function moduleThemeFontPath(file: string): string {
  return `${MODULE_THEME_FONT_DIR}/${file}`;
}

function bareFileName(value: unknown, field: string): string {
  const file = text(value, field, 255);
  if (file.includes("/") || file.includes("\\") || file.startsWith("."))
    throw new Error(`module.json: "${field}" must be a bare filename inside this folder`);
  return file;
}

function themeFacts(value: unknown): ModuleTheme {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error('module.json: "theme" must be an object');
  const raw = value as Record<string, unknown>;

  // An empty `theme` block is refused rather than normalised away. `fonts` is
  // the only thing a theme block carries, so `"theme": {}` means the author
  // started declaring a font and stopped — and a half-written declaration that
  // validates is how a theme ends up shipping a woff2 nothing registers.
  if (!Array.isArray(raw.fonts) || !raw.fonts.length || raw.fonts.length > MAX_THEME_FONTS)
    throw new Error(`module.json: "theme.fonts" must be 1..${MAX_THEME_FONTS} font declarations`);

  const seen = new Set<string>();
  const fonts: ModuleThemeFont[] = raw.fonts.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`module.json: "theme.fonts[${index}]" must be an object`);
    const font = entry as Record<string, unknown>;

    const family = text(font.family, `theme.fonts[${index}].family`, MAX_NAME);
    if (FONT_FAMILY_FORBIDDEN.test(family))
      throw new Error(
        `module.json: "theme.fonts[${index}].family" is ${JSON.stringify(family)}; a family name is one name — no quotes, commas, braces, semicolons or surrounding space`
      );

    const file = bareFileName(font.file, `theme.fonts[${index}].file`);
    if (!FONT_FILE.test(file))
      throw new Error(`module.json: "theme.fonts[${index}].file" must end in .woff2`);

    const license = bareFileName(font.license, `theme.fonts[${index}].license`);

    const out: ModuleThemeFont = { family, file, license };

    if (font.weight !== undefined && font.weight !== null) {
      const weight = text(font.weight, `theme.fonts[${index}].weight`, 32);
      if (!FONT_WEIGHT.test(weight))
        throw new Error(
          `module.json: "theme.fonts[${index}].weight" must be a weight like "400" or a variable range like "100 800", not ${JSON.stringify(weight)}`
        );
      out.weight = weight;
    }

    if (font.style !== undefined && font.style !== null) {
      const style = text(font.style, `theme.fonts[${index}].style`, 16);
      if (style !== "normal" && style !== "italic")
        throw new Error(`module.json: "theme.fonts[${index}].style" must be "normal" or "italic"`);
      out.style = style;
    }

    // Two faces claiming the same family+weight+style is one of them silently
    // losing to the other in the cascade, and a theme author cannot see which.
    const key = `${family}|${out.weight ?? "400"}|${out.style ?? "normal"}`;
    if (seen.has(key))
      throw new Error(
        `module.json: "theme.fonts" declares ${JSON.stringify(family)} at weight ${out.weight ?? "400"} ${out.style ?? "normal"} twice; one of the two files would never be used`
      );
    seen.add(key);

    return out;
  });

  return { fonts };
}

/**
 * Validate one parsed `module.json`.
 *
 * @param value   the decoded JSON
 * @param id      the folder name it was read from; the manifest must agree
 * @param kind    the kind the scanning base holds, when the caller knows it
 *
 * REFUSES BY THROWING, and the message is written for the server owner who
 * will read it in the console. A refusal is the right outcome for a kind/
 * directory mismatch rather than a warning: a `kind: "theme"` folder sitting in
 * `layouts/` that the layout loader accepts anyway will 404 on `ui.html` at
 * render time on a player's machine, which is the failure mode worth paying a
 * start-time error to avoid. The operator's fix is one move — put the folder in
 * the directory its kind names.
 */
export function parseModuleManifest(value: unknown, id: string, kind?: ModuleKind): ModuleManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("module.json: expected a JSON object");
  const raw = value as Record<string, unknown>;

  if (raw.schema !== MODULE_SCHEMA)
    throw new Error(
      `module.json: declares schema ${JSON.stringify(raw.schema)}; this tLib understands ${MODULE_SCHEMA}`
    );

  const declaredKind = raw.kind;
  if (typeof declaredKind !== "string" || !MODULE_KINDS.includes(declaredKind as ModuleKind))
    throw new Error(`module.json: "kind" must be one of ${MODULE_KINDS.join(", ")}`);
  if (kind && declaredKind !== kind)
    throw new Error(
      `module.json: "${id}" declares kind "${declaredKind}" but this directory holds ${kind} modules`
    );

  const declaredId = text(raw.id, "id", 120);
  if (declaredId !== id)
    throw new Error(
      `module.json: "id" is "${declaredId}" but the folder is "${id}"; they must match exactly`
    );
  if ((RESERVED_MODULE_IDS as readonly string[]).includes(declaredId))
    throw new Error(
      `module.json: "${declaredId}" is a reserved directory name and cannot be a module id`
    );

  const version = text(raw.version, "version", 64);
  if (!VERSION.test(version))
    throw new Error(`module.json: "version" must look like 1.2.3, not "${version}"`);

  const slug = optionalText(raw.slug, "slug", 120);
  if (slug !== undefined && !SLUG.test(slug))
    throw new Error(`module.json: "slug" must match /^[a-z0-9][a-z0-9_-]*$/, not "${slug}"`);

  const manifest: ModuleManifest = {
    schema: MODULE_SCHEMA,
    kind: declaredKind as ModuleKind,
    id: declaredId,
    name: text(raw.name, "name", MAX_NAME),
    version,
  };

  const author = optionalText(raw.author, "author", MAX_NAME);
  if (author !== undefined) manifest.author = author;
  const license = optionalText(raw.license, "license", MAX_NAME);
  if (license !== undefined) manifest.license = license;
  const description = optionalText(raw.description, "description", MAX_TEXT);
  if (description !== undefined) manifest.description = description;
  if (slug !== undefined) manifest.slug = slug;

  if (manifest.kind === "sound") manifest.sound = soundFacts(raw.sound, declaredId);
  else if (raw.sound !== undefined && raw.sound !== null)
    // A field that does nothing is a field someone will eventually trust.
    throw new Error(`module.json: a "${manifest.kind}" module must not carry "sound"`);

  // `theme` is OPTIONAL on a theme — a theme that merely selects a family the
  // app already bundles ships no font and declares no block, which is four of
  // the five shipped dispatch themes and must keep working untouched.
  if (raw.theme !== undefined && raw.theme !== null) {
    if (manifest.kind !== "theme")
      throw new Error(`module.json: a "${manifest.kind}" module must not carry "theme"`);
    manifest.theme = themeFacts(raw.theme);
  }

  return manifest;
}

/** Serialise a manifest the way the generators and the installer write it. */
export function stringifyModuleManifest(manifest: ModuleManifest): string {
  const ordered: Record<string, unknown> = {
    schema: manifest.schema,
    kind: manifest.kind,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
  };
  if (manifest.author) ordered.author = manifest.author;
  if (manifest.license) ordered.license = manifest.license;
  if (manifest.description) ordered.description = manifest.description;
  if (manifest.slug) ordered.slug = manifest.slug;
  if (manifest.sound) ordered.sound = manifest.sound;
  if (manifest.theme) ordered.theme = manifest.theme;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
