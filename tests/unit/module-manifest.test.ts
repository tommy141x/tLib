// Oracle for the module.json contract, and the parity mechanism that stops the
// two implementations of it from drifting.
//
// There have to be two. The gate that decides whether a folder on a live server
// is a usable module runs in FiveM's server Lua VM
// (shared/imports/modules/shared.lua); the gate that decides whether this repo's
// own shipped content is valid, and the one the studio and the marketplace
// installer use, runs in TypeScript (shared/ts/modules/manifest.ts). Neither can
// call the other.
//
// They are deliberately NOT the same set of kinds. TypeScript knows
// `layout | theme | sound`; Lua knows `layout | theme`, because a sound is a flat
// audio file on a FiveM resource and a module only in the studio. Every sound
// case below therefore carries both verdicts — see `luaExpect`.
//
// So the CASES are written once, here, and this test does three things:
//   1. runs every case through the TypeScript validator and asserts the verdict;
//   2. serialises the same cases to a Lua table literal and asserts
//      tests/fixtures/module-manifest-cases.lua matches it byte for byte;
//   3. tests/lua/modules.lua dofiles that fixture and asserts the SAME verdicts
//      through the Lua validator.
//
// A rule added to one side and not the other therefore fails here (a new case
// the other validator does not agree with) or in modules.lua. A rule added with
// no case at all is the gap this cannot close — which is why the cases are
// grouped by field, so a missing group is visible by reading.
//
// Regenerate the Lua fixture after editing CASES:
//   MODULE_CASES_WRITE=1 bun test tests/unit/module-manifest.test.ts

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  MODULE_KINDS,
  MODULE_MANIFEST,
  MODULE_SCHEMA,
  type ModuleKind,
  parseModuleManifest,
  RESERVED_MODULE_IDS,
  soundModuleId,
  soundModulePath,
  stringifyModuleManifest,
} from "../../shared/ts/modules/manifest";

interface Case {
  /** Why this case exists, in the words a failure should be read with. */
  why: string;
  /** The folder name the manifest was read from. */
  id: string;
  /** The kind the scanning directory holds, or null for "caller does not know". */
  kind: ModuleKind | null;
  manifest: unknown;
  /** true = accepted; a string = refused, and the message must contain it. */
  expect: true | string;
  /**
   * The Lua verdict, when the two sides are not expected to agree.
   *
   * Two reasons, and both are deliberate:
   *
   * 1. `kind: "sound"` IS NOT A KIND A FIVEM RESOURCE READS. A sound is a flat
   *    audio file in `layouts/sounds/` so that an operator can drag a `.wav` in
   *    and have it work. It is a module in the STUDIO and in the MARKETPLACE,
   *    where a folder and a manifest carry its name, licence, duration and
   *    waveform peaks — and the installer reads that manifest and writes only
   *    the audio, flat. So every sound case below is checked in full by the
   *    TypeScript validator, which the studio and the installer use, and the Lua
   *    gate refuses it on `kind` grounds, which is the honest answer for a
   *    document nothing on a resource reads.
   *
   * 2. `json.decode` gives Lua no way to tell a JSON array from a JSON object —
   *    both arrive as a table — so a manifest that is `[]` cannot be refused for
   *    being an array there. It is still refused, for the next thing wrong with
   *    it.
   *
   * Spelling the Lua verdict out per case is better than loosening the
   * TypeScript message to whatever both happen to say.
   */
  luaExpect?: string;
}

/**
 * What the Lua gate says about any sound manifest: it does not know the kind.
 *
 * Not a weaker assertion than the TypeScript one — a different and equally
 * specific one. A sound manifest reaching a FiveM resource's `layouts/` is a
 * studio artefact in the wrong place, and naming the two kinds a resource can
 * actually use is the message an operator can act on.
 */
const KIND_UNKNOWN_IN_LUA = '"kind" must be one of layout, theme';

const layout = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  kind: "layout",
  id: "QRX-720",
  name: "QRX-720",
  version: "1.0.0",
  ...over,
});

const theme = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  kind: "theme",
  id: "dark",
  name: "Dark",
  version: "1.0.0",
  ...over,
});

/** One well-formed face declaration, to vary one field at a time against. */
const face = (over: Record<string, unknown> = {}) => ({
  family: "Inter",
  file: "inter-400.woff2",
  weight: "400",
  license: "OFL-Inter.txt",
  ...over,
});

const sound = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  kind: "sound",
  id: "ptt",
  name: "PTT",
  version: "1.0.0",
  sound: { file: "ptt.wav" },
  ...over,
});

export const CASES: Case[] = [
  // accepted shapes
  {
    why: "the minimum a layout must declare",
    id: "QRX-720",
    kind: "layout",
    manifest: layout(),
    expect: true,
  },
  {
    why: "every optional identity field at once",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({
      author: "TIMMYG Studios",
      license: "LicenseRef-TIMMYG-Studios-Proprietary",
      description: "A big one.",
      slug: "tradio-qrx-720",
    }),
    expect: true,
  },
  {
    why: "a theme in its own directory",
    id: "dark",
    kind: "theme",
    manifest: { schema: 1, kind: "theme", id: "dark", name: "Dark", version: "1.0.0" },
    expect: true,
  },
  {
    why: "the minimum a sound must declare",
    id: "ptt",
    kind: "sound",
    manifest: sound(),
    expect: true,
    luaExpect: KIND_UNKNOWN_IN_LUA,
  },
  {
    why: "a sound carrying everything the preview wants",
    id: "ptt",
    kind: "sound",
    luaExpect: KIND_UNKNOWN_IN_LUA,
    manifest: sound({
      sound: { file: "ptt.wav", durationSeconds: 0.43, toneKeys: ["PTT"], peaks: [0, 0.5, 1] },
    }),
    expect: true,
  },
  {
    why: "a caller that does not know the kind accepts any valid one",
    id: "dark",
    kind: null,
    manifest: { schema: 1, kind: "theme", id: "dark", name: "Dark", version: "1.0.0" },
    expect: true,
  },
  {
    why: "a prerelease version",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ version: "2.0.0-rc.1" }),
    expect: true,
  },
  {
    why: "a two-part version",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ version: "1.4" }),
    expect: true,
  },

  // schema
  {
    why: "not an object at all",
    id: "QRX-720",
    kind: "layout",
    manifest: "nope",
    expect: "expected a JSON object",
  },
  {
    why: "an array is not a manifest",
    id: "QRX-720",
    kind: "layout",
    manifest: [],
    expect: "expected a JSON object",
    luaExpect: "declares schema",
  },
  {
    why: "a newer schema is refused, not half-read",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ schema: 2 }),
    expect: "declares schema",
  },
  {
    why: "a missing schema is refused",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ schema: null }),
    expect: "declares schema",
  },

  // kind
  {
    why: "an unknown kind",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ kind: "skin" }),
    expect: '"kind" must be one of',
  },
  {
    why: "a missing kind",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ kind: null }),
    expect: '"kind" must be one of',
  },
  {
    why: "THE COLLISION: a theme folder sitting in layouts/ is refused, not loaded as a layout",
    id: "dark",
    kind: "layout",
    manifest: { schema: 1, kind: "theme", id: "dark", name: "Dark", version: "1.0.0" },
    expect: 'declares kind "theme" but this directory holds layout modules',
  },
  {
    why: "and the same the other way round",
    id: "QRX-720",
    kind: "theme",
    manifest: layout(),
    expect: 'declares kind "layout" but this directory holds theme modules',
  },

  // id, and the reserved names
  {
    why: "a manifest whose id is not the folder it sits in",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ id: "QRX-760" }),
    expect: "they must match exactly",
  },
  {
    why: "case matters, because on a case-sensitive filesystem these are two folders",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ id: "qrx-720" }),
    expect: "they must match exactly",
  },
  {
    why: "a missing id",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ id: null }),
    expect: '"id" must be a non-empty string',
  },
  {
    why: "RESERVED: a layout cannot take the themes category directory's name",
    id: "themes",
    kind: "layout",
    manifest: layout({ id: "themes", name: "Themes" }),
    expect: "reserved directory name",
  },
  {
    why: "RESERVED: nor the sounds one",
    id: "sounds",
    kind: "layout",
    manifest: layout({ id: "sounds", name: "Sounds" }),
    expect: "reserved directory name",
  },

  // name and version
  {
    why: "an empty name",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ name: "   " }),
    expect: '"name" must be a non-empty string',
  },
  {
    why: "a missing name",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ name: null }),
    expect: '"name" must be a non-empty string',
  },
  {
    why: "a version that is not a version",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ version: "shipped" }),
    expect: '"version" must look like',
  },
  {
    why: "a missing version",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ version: null }),
    expect: '"version" must',
  },
  {
    why: "four parts is not semver",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ version: "1.2.3.4" }),
    expect: '"version" must look like',
  },
  {
    why: "a dangling prerelease marker",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ version: "1.2-" }),
    expect: '"version" must look like',
  },
  {
    why: "a single number is not a version",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ version: "1" }),
    expect: '"version" must look like',
  },

  // optional identity fields
  {
    why: "an author of the wrong type",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ author: 7 }),
    expect: '"author" must be a non-empty string',
  },
  {
    why: "an empty licence is a missing licence, not a licence",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ license: "" }),
    expect: '"license" must be a non-empty string',
  },
  {
    why: "a slug that could not key a catalogue lookup",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ slug: "TRadio Sound" }),
    expect: '"slug" must match',
  },

  // sound
  {
    why: "a sound with no sound block",
    id: "ptt",
    kind: "sound",
    manifest: sound({ sound: null }),
    expect: 'must carry a "sound" object',
    luaExpect: KIND_UNKNOWN_IN_LUA,
  },
  {
    why: "a sound with no file to play",
    id: "ptt",
    kind: "sound",
    manifest: sound({ sound: {} }),
    expect: '"sound.file" must be a non-empty string',
    luaExpect: KIND_UNKNOWN_IN_LUA,
  },
  {
    why: "sound.file must not be able to climb out of the folder",
    id: "ptt",
    kind: "sound",
    manifest: sound({ sound: { file: "../ptt.wav" } }),
    expect: "bare filename",
    luaExpect: KIND_UNKNOWN_IN_LUA,
  },
  {
    why: "nor reach into a subfolder",
    id: "ptt",
    kind: "sound",
    manifest: sound({ sound: { file: "wav/ptt.wav" } }),
    expect: "bare filename",
    luaExpect: KIND_UNKNOWN_IN_LUA,
  },
  {
    why: "nor be a backslash path",
    id: "ptt",
    kind: "sound",
    manifest: sound({ sound: { file: "wav\\ptt.wav" } }),
    expect: "bare filename",
    luaExpect: KIND_UNKNOWN_IN_LUA,
  },
  {
    why: "an audio format nothing can play",
    id: "ptt",
    kind: "sound",
    manifest: sound({ sound: { file: "ptt.flac" } }),
    expect: ".wav, .ogg or .mp3",
    luaExpect: KIND_UNKNOWN_IN_LUA,
  },
  {
    why: "ogg is a real option, not a theoretical one",
    id: "ptt",
    kind: "sound",
    manifest: sound({ sound: { file: "ptt.ogg" } }),
    expect: true,
    luaExpect: KIND_UNKNOWN_IN_LUA,
  },
  {
    why: "THE DERIVATION RULE: audio named something other than its folder would make every URL unresolvable",
    id: "ptt",
    kind: "sound",
    luaExpect: KIND_UNKNOWN_IN_LUA,
    manifest: sound({ sound: { file: "whistle.wav" } }),
    expect: "must be named after its folder",
  },
  {
    why: "a negative duration",
    id: "ptt",
    kind: "sound",
    manifest: sound({ sound: { file: "ptt.wav", durationSeconds: -1 } }),
    expect: "positive number",
    luaExpect: KIND_UNKNOWN_IN_LUA,
  },
  {
    why: "a tone key that is not a tone key",
    id: "ptt",
    kind: "sound",
    manifest: sound({ sound: { file: "ptt.wav", toneKeys: ["ptt"] } }),
    expect: '"sound.toneKeys" entry must match',
    luaExpect: KIND_UNKNOWN_IN_LUA,
  },
  {
    why: "a peak outside 0..1 would scale a preview wrong",
    id: "ptt",
    kind: "sound",
    manifest: sound({ sound: { file: "ptt.wav", peaks: [0, 1.5] } }),
    expect: '"sound.peaks" entry must be a number in 0..1',
    luaExpect: KIND_UNKNOWN_IN_LUA,
  },
  {
    why: "an empty peaks array says nothing and would render nothing",
    id: "ptt",
    kind: "sound",
    manifest: sound({ sound: { file: "ptt.wav", peaks: [] } }),
    expect: '"sound.peaks" must be',
    luaExpect: KIND_UNKNOWN_IN_LUA,
  },
  {
    why: "a layout carrying sound facts: a field that does nothing is a field someone will trust",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ sound: { file: "ptt.wav" } }),
    expect: 'must not carry "sound"',
  },

  // theme.fonts
  //
  // These ARE checked on both sides, unlike `sound`. A theme manifest is read
  // on a live server by the Lua gate and its `theme.fonts` is what the dispatch
  // panel turns into `@font-face` rules, so a malformed declaration produces a
  // font that registers under the wrong name or not at all — invisible at render
  // time, which is the exact failure this block exists to refuse.
  {
    why: "A THEME THAT SHIPS NO FONT: the four shipped themes that only SELECT a bundled family",
    id: "dark",
    kind: "theme",
    manifest: theme(),
    expect: true,
  },
  {
    why: "one declared face",
    id: "dark",
    kind: "theme",
    manifest: theme({ theme: { fonts: [face()] } }),
    expect: true,
  },
  {
    why: "three weights of one family, each with the licence that covers it",
    id: "dark",
    kind: "theme",
    manifest: theme({
      theme: {
        fonts: [
          face({ file: "inter-400.woff2", weight: "400" }),
          face({ file: "inter-600.woff2", weight: "600" }),
          face({ file: "inter-400-italic.woff2", weight: "400", style: "italic" }),
        ],
      },
    }),
    expect: true,
  },
  {
    why: "a variable font shipped as one file across a weight range",
    id: "dark",
    kind: "theme",
    manifest: theme({ theme: { fonts: [face({ file: "inter-var.woff2", weight: "100 800" })] } }),
    expect: true,
  },
  {
    why: "weight and style are optional and default to 400 normal",
    id: "dark",
    kind: "theme",
    manifest: theme({
      theme: { fonts: [{ family: "Inter", file: "inter.woff2", license: "OFL-Inter.txt" }] },
    }),
    expect: true,
  },
  {
    why: "an empty theme block is a half-written declaration, not a theme with no fonts",
    id: "dark",
    kind: "theme",
    manifest: theme({ theme: {} }),
    expect: '"theme.fonts" must be 1..32',
  },
  {
    why: "a theme block that is not an object",
    id: "dark",
    kind: "theme",
    manifest: theme({ theme: "Inter" }),
    expect: '"theme" must be an object',
    // json.decode hands Lua a string here too, and the Lua gate's first test is
    // the same type test, so the two agree on this one by construction.
  },
  {
    why: "THE DECLARATION RULE: a face with no family is the inference this removes",
    id: "dark",
    kind: "theme",
    manifest: theme({ theme: { fonts: [{ file: "inter-400.woff2", license: "OFL-Inter.txt" }] } }),
    expect: '"theme.fonts[0].family" must be a non-empty string',
  },
  {
    why: "a family name carrying a comma would silently become two families that match nothing",
    id: "dark",
    kind: "theme",
    manifest: theme({ theme: { fonts: [face({ family: "Inter, sans-serif" })] } }),
    expect: "a family name is one name",
  },
  {
    why: "nor a quote, which could close the @font-face rule it is interpolated into",
    id: "dark",
    kind: "theme",
    manifest: theme({ theme: { fonts: [face({ family: 'Inter"' })] } }),
    expect: "a family name is one name",
  },
  {
    why: "a face with no file",
    id: "dark",
    kind: "theme",
    manifest: theme({ theme: { fonts: [{ family: "Inter", license: "OFL-Inter.txt" }] } }),
    expect: '"theme.fonts[0].file" must be a non-empty string',
  },
  {
    why: "a font file must not be able to climb out of the module",
    id: "dark",
    kind: "theme",
    manifest: theme({ theme: { fonts: [face({ file: "../../inter.woff2" })] } }),
    expect: "bare filename",
  },
  {
    why: "nor name the fonts/ directory itself — the directory is the schema's, not the author's",
    id: "dark",
    kind: "theme",
    manifest: theme({ theme: { fonts: [face({ file: "fonts/inter.woff2" })] } }),
    expect: "bare filename",
  },
  {
    why: "a format the panel would need a second code path for",
    id: "dark",
    kind: "theme",
    manifest: theme({ theme: { fonts: [face({ file: "inter.ttf" })] } }),
    expect: "must end in .woff2",
  },
  {
    why: "THE LICENCE IS REQUIRED: a theme module is published and installed elsewhere",
    id: "dark",
    kind: "theme",
    manifest: theme({
      theme: { fonts: [{ family: "Inter", file: "inter-400.woff2", weight: "400" }] },
    }),
    expect: '"theme.fonts[0].license" must be a non-empty string',
  },
  {
    why: "an empty licence is a missing licence here too",
    id: "dark",
    kind: "theme",
    manifest: theme({ theme: { fonts: [face({ license: "  " })] } }),
    expect: '"theme.fonts[0].license" must be a non-empty string',
  },
  {
    why: "a licence that is a path rather than a file beside the font",
    id: "dark",
    kind: "theme",
    manifest: theme({ theme: { fonts: [face({ license: "../LICENSE" })] } }),
    expect: "bare filename",
  },
  {
    why: "a weight that is a CSS keyword, not a number @font-face can match",
    id: "dark",
    kind: "theme",
    manifest: theme({ theme: { fonts: [face({ weight: "bold" })] } }),
    expect: '"theme.fonts[0].weight" must be a weight like',
  },
  {
    why: "a weight above css-fonts-4's 1000",
    id: "dark",
    kind: "theme",
    manifest: theme({ theme: { fonts: [face({ weight: "1001" })] } }),
    expect: '"theme.fonts[0].weight" must be a weight like',
  },
  {
    why: "nor zero, nor a leading zero, which matches no face and is always a typo",
    id: "dark",
    kind: "theme",
    manifest: theme({ theme: { fonts: [face({ weight: "0400" })] } }),
    expect: '"theme.fonts[0].weight" must be a weight like',
  },
  {
    why: "three numbers is not a weight range",
    id: "dark",
    kind: "theme",
    manifest: theme({ theme: { fonts: [face({ weight: "100 400 800" })] } }),
    expect: '"theme.fonts[0].weight" must be a weight like',
  },
  {
    why: "a style the cascade has no meaning for",
    id: "dark",
    kind: "theme",
    manifest: theme({ theme: { fonts: [face({ style: "oblique" })] } }),
    expect: '"theme.fonts[0].style" must be "normal" or "italic"',
  },
  {
    why: "two faces at the same family, weight and style: one of them can never be used",
    id: "dark",
    kind: "theme",
    manifest: theme({
      theme: { fonts: [face({ file: "a.woff2" }), face({ file: "b.woff2" })] },
    }),
    expect: "twice; one of the two files would never be used",
  },
  {
    why: "case-insensitively the same family, because that is how CSS matches one",
    id: "dark",
    kind: "theme",
    manifest: theme({
      theme: { fonts: [face({ file: "a.woff2" }), face({ file: "b.woff2", family: "inter" })] },
    }),
    // ACCEPTED, and the divergence is honest: the manifest validator keys the
    // duplicate check on the family as DECLARED, while CSS matches family names
    // case-insensitively. Normalising here would mean the error message named a
    // family the author never typed. The resolver in ./theme-fonts.ts does
    // normalise, so these two faces resolve one token either way.
    expect: true,
  },
  {
    why: "a layout carrying theme facts: a field that does nothing is a field someone will trust",
    id: "QRX-720",
    kind: "layout",
    manifest: layout({ theme: { fonts: [face()] } }),
    expect: 'must not carry "theme"',
  },
  {
    why: "and a sound carrying them, which is the same mistake from the studio side",
    id: "ptt",
    kind: "sound",
    manifest: sound({ theme: { fonts: [face()] } }),
    expect: 'must not carry "theme"',
    luaExpect: KIND_UNKNOWN_IN_LUA,
  },
];

/**
 * The kinds the Lua gate accepts, read out of the shipped file rather than
 * retyped. A hand-written copy here would keep agreeing with itself after the
 * Lua changed, which is exactly the drift this file exists to catch.
 */
const LUA_KINDS: string[] = (() => {
  const lua = fs.readFileSync(
    path.resolve(import.meta.dir, "../../shared/imports/modules/shared.lua"),
    "utf8"
  );
  const match = lua.match(/modules\.KINDS\s*=\s*\{([^}]*)\}/);
  if (!match) throw new Error("could not find modules.KINDS in the shipped Lua");
  return [...match[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*true/g)].map((m) => m[1]);
})();

describe("module.json contract", () => {
  test("the contract's own constants are what the tree is built on", () => {
    expect(MODULE_MANIFEST).toBe("module.json");
    expect(MODULE_SCHEMA).toBe(1);
    expect([...MODULE_KINDS]).toEqual(["layout", "theme", "sound"]);
    // And the Lua gate knows a SUBSET of them, on purpose. This is the one
    // place the asymmetry is asserted rather than described, so adding a kind to
    // one side and not the other is a decision someone has to make right here.
    expect(LUA_KINDS).toEqual(["layout", "theme"]);
    // The two category directories inside layouts/. Changing this list is a
    // release-note change: it decides which folder names a module may not take.
    expect([...RESERVED_MODULE_IDS]).toEqual(["sounds", "themes"]);
  });

  for (const c of CASES) {
    test(`${c.expect === true ? "accepts" : "refuses"}: ${c.why}`, () => {
      const run = () => parseModuleManifest(c.manifest, c.id, c.kind ?? undefined);
      if (c.expect === true) {
        const parsed = run();
        expect(parsed.id).toBe(c.id);
        expect(MODULE_KINDS).toContain(parsed.kind);
      } else {
        expect(run).toThrow(c.expect);
      }
    });
  }

  test("a parsed manifest round-trips through the serialiser the generators use", () => {
    const parsed = parseModuleManifest(
      {
        schema: 1,
        kind: "sound",
        luaExpect: KIND_UNKNOWN_IN_LUA,
        id: "ptt",
        name: "PTT",
        version: "1.2.3",
        author: "TIMMYG Studios",
        license: "LicenseRef-TIMMYG-Studios-Proprietary",
        description: "Push to talk.",
        slug: "tradio-ptt",
        sound: { file: "ptt.wav", durationSeconds: 0.5, toneKeys: ["PTT"], peaks: [0.1, 1] },
      },
      "ptt",
      "sound"
    );
    const text = stringifyModuleManifest(parsed);
    expect(text.endsWith("\n")).toBe(true);
    expect(parseModuleManifest(JSON.parse(text), "ptt", "sound")).toEqual(parsed);
    // Key order is fixed so a regenerated manifest is a no-op diff, which is
    // what lets `gen:modules --check` be a gate rather than a nuisance.
    expect(Object.keys(JSON.parse(text))).toEqual([
      "schema",
      "kind",
      "id",
      "name",
      "version",
      "author",
      "license",
      "description",
      "slug",
      "sound",
    ]);
  });

  test("a sound's path is derivable from its filename alone", () => {
    // This is what keeps every existing caller speaking bare filenames. If this
    // ever needs an index lookup, `toneWavMap`, `modelToneWavMap`,
    // `bgModeMappings` and the admin UI all become path-aware at once.
    expect(soundModuleId("alert_a.wav")).toBe("alert_a");
    expect(soundModuleId("bgDog.wav")).toBe("bgDog");
    expect(soundModulePath("alert_a.wav")).toBe("alert_a/alert_a.wav");
    expect(soundModulePath("ring-in.wav")).toBe("ring-in/ring-in.wav");
    expect(soundModulePath("airhorn.ogg")).toBe("airhorn/airhorn.ogg");
    // A name with no audio extension is not a sound file; the caller gets
    // something obviously wrong rather than a plausible wrong path.
    expect(soundModuleId("notes.txt")).toBe("notes.txt");
  });

  test("the Lua gate is driven by these same cases", () => {
    // Deliberately NOT under tests/lua/: scripts/test-lua.ts globs `**/*.lua`
    // there and runs every hit as a suite. A fixture that merely `return`s a
    // table would be dofile'd, exit zero and count as a passing suite — a
    // vacuous pass, which is the one failure that runner is written to avoid.
    const fixture = path.resolve(import.meta.dir, "../fixtures/module-manifest-cases.lua");
    const generated = luaFixture(CASES);
    if (process.env.MODULE_CASES_WRITE === "1") {
      fs.mkdirSync(path.dirname(fixture), { recursive: true });
      fs.writeFileSync(fixture, generated);
    }
    const onDisk = fs.existsSync(fixture) ? fs.readFileSync(fixture, "utf8") : "";
    expect(onDisk).toBe(generated);
  });
});

/**
 * Serialise CASES as a Lua table literal.
 *
 * Deliberately small and total rather than general: it handles exactly the JSON
 * value types a case can contain and THROWS on anything else, so a case shape
 * the Lua suite could not receive faithfully fails here instead of arriving
 * there silently altered. `nil` is the one lossy spot in any JS→Lua mapping —
 * a JSON `null` field and an absent field are the same thing in a Lua table —
 * so a case that means "this field is missing" and one that means "this field
 * is null" are the same case on that side, which is true of the runtime too:
 * `json.decode` gives Lua no way to tell them apart either.
 */
function luaFixture(cases: Case[]): string {
  const lines = [
    "-- GENERATED by tests/unit/module-manifest.test.ts. Do not edit.",
    "--",
    "-- The module.json cases, shared with the TypeScript validator so the two",
    "-- implementations of one contract cannot drift. Regenerate with:",
    "--   MODULE_CASES_WRITE=1 bun test tests/unit/module-manifest.test.ts",
    "return {",
  ];
  for (const c of cases) {
    lines.push("    {");
    lines.push(`        why = ${lua(c.why)},`);
    lines.push(`        id = ${lua(c.id)},`);
    lines.push(`        kind = ${c.kind === null ? "nil" : lua(c.kind)},`);
    lines.push(`        manifest = ${lua(c.manifest)},`);
    // `luaExpect` wins unconditionally, including over an ACCEPTED case. A sound
    // manifest is valid TypeScript-side and refused Lua-side, so the override has
    // to be able to flip the verdict and not merely reword a refusal.
    const luaVerdict =
      c.luaExpect !== undefined ? lua(c.luaExpect) : c.expect === true ? "true" : lua(c.expect);
    lines.push(`        expect = ${luaVerdict},`);
    lines.push("    },");
  }
  lines.push("}", "");
  return lines.join("\n");
}

function lua(value: unknown): string {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("non-finite numbers cannot cross into the fixture");
    return String(value);
  }
  if (typeof value === "string")
    return `"${value.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\n")}"`;
  if (Array.isArray(value)) return `{ ${value.map(lua).join(", ")} }`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, v]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        throw new Error(`key ${key} needs bracket syntax the fixture does not emit`);
      return `${key} = ${lua(v)}`;
    });
    return entries.length ? `{ ${entries.join(", ")} }` : "{}";
  }
  throw new Error(`unsupported case value type: ${typeof value}`);
}
