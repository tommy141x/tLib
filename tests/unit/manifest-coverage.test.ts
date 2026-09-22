import { describe, expect, test } from "bun:test";
import {
  assertManifestOnDisk,
  assertManifestStaged,
  manifestCoverage,
  manifestCoverageOnDisk,
  stagedPrefix,
  stripLuaComments,
} from "../../shared/ts/build/manifest-coverage";

const MANIFEST = `
fx_version 'bodacious'
game 'gta5'

shared_scripts {
    '@tLib/imports.lua',
    'shared/utils.lua',
}

server_scripts {
    'server/dist/bundle.js',
    'server/sv_version.lua',
}

client_scripts {
    'client/cl_hud.lua',
    'client/cl_settings.lua',
}

ui_page 'client/ui/index.html'

files {
    'client/ui/**',
    'layouts/**/*.*',
    'data.json',
}

data_file 'DLC_ITYP_REQUEST' 'stream/arges.ytyp'
`;

const COMPLETE = [
  "shared/utils.lua",
  "server/dist",
  "server/sv_version.lua",
  "client/cl_hud.lua",
  "client/cl_settings.lua",
  "client/ui",
  "layouts",
  "data.json",
  "stream",
];

describe("manifest coverage", () => {
  test("a complete include list covers every declared path", () => {
    expect(manifestCoverage(MANIFEST, COMPLETE)).toEqual({ missing: [], checked: 10 });
  });

  test("a script in the manifest but not the include list is reported", () => {
    // The tAFK failure: two client_scripts entries existed on disk and loaded
    // in development, so nothing failed until the release zip was installed.
    const { missing } = manifestCoverage(
      MANIFEST,
      COMPLETE.filter((item) => item !== "client/cl_settings.lua")
    );
    expect(missing).toEqual(["client/cl_settings.lua"]);
  });

  test("a cross-resource @ path is another resource's to ship", () => {
    expect(manifestCoverage(MANIFEST, COMPLETE).missing).not.toContain("@tLib/imports.lua");
  });

  test("a data_file target counts: tELS shipped without its ytyp", () => {
    const { missing } = manifestCoverage(
      MANIFEST,
      COMPLETE.filter((item) => item !== "stream")
    );
    expect(missing).toEqual(["stream/arges.ytyp"]);
  });

  test("a directory glob is covered by staging its directory", () => {
    expect(stagedPrefix("client/ui/**")).toBe("client/ui");
    expect(stagedPrefix("layouts/**/*.*")).toBe("layouts");
    expect(stagedPrefix("audio/*.ogg")).toBe("audio");
    expect(stagedPrefix("data.json")).toBe("data.json");
  });

  test("an include entry is a path segment, not a string prefix", () => {
    // `client/ui` must not be satisfied by staging `client/u`.
    const { missing } = manifestCoverage(MANIFEST, [...COMPLETE, "client/u"]);
    expect(missing).toEqual([]);
    expect(
      manifestCoverage(
        MANIFEST,
        COMPLETE.map((i) => (i === "client/ui" ? "client/u" : i))
      ).missing
      // Reported as the manifest wrote them, so the message points at the line
      // to fix rather than at a prefix the manifest never mentions.
    ).toEqual(["client/ui/**", "client/ui/index.html"]);
  });

  test("a quoted phrase inside a Lua comment is not a release path", () => {
    // tAFK's files block explains, in a comment, that a missing entry makes
    // every track report "no usable beat data". The first version of this
    // check reported that sentence as an unstaged path and failed the build.
    const commented = MANIFEST.replace(
      "files {",
      `files {\n    -- Required, or every track reports "no usable beat data".`
    );
    expect(manifestCoverage(commented, COMPLETE).missing).toEqual([]);
  });

  test("an apostrophe in a comment does not swallow the entries after it", () => {
    // Unbalanced quotes are ordinary English. The `--` is found before the
    // apostrophe on that line, so the whole line goes before any string does.
    const commented = MANIFEST.replace(
      "client_scripts {",
      "client_scripts {\n    -- Order matters: the HUD's bounds are read by settings."
    );
    expect(manifestCoverage(commented, COMPLETE)).toEqual({ missing: [], checked: 10 });
  });

  test("a quote before a comment on the same line still closes", () => {
    // Here the string comes first, so quote tracking is what stops `--` inside
    // a path from truncating the line.
    expect(stripLuaComments(`    'client/cl_hud.lua', -- the HUD\n`)).toBe(
      "    'client/cl_hud.lua', \n"
    );
    expect(stripLuaComments(`    'client/cl--hud.lua',\n`)).toBe("    'client/cl--hud.lua',\n");
  });

  test("the on-disk check reports what the staging policy actually dropped", () => {
    // tRadio stages by predicate, not by list, so the only honest question is
    // what ended up in the tree. Here the policy admitted everything but the
    // stream models.
    const staged = new Set([
      "dist/shared/utils.lua",
      "dist/server/dist/bundle.js",
      "dist/server/sv_version.lua",
      "dist/client/cl_hud.lua",
      "dist/client/cl_settings.lua",
      "dist/client/ui",
      // ui_page names the file, not the directory, so the file is what is checked.
      "dist/client/ui/index.html",
      "dist/layouts",
      "dist/data.json",
    ]);
    const { missing, checked } = manifestCoverageOnDisk(MANIFEST, "dist", (p) => staged.has(p));
    expect(checked).toBe(10);
    expect(missing).toEqual(["stream/arges.ytyp"]);
  });

  test("the on-disk check names the staging policy, not the include list", () => {
    expect(() => assertManifestOnDisk(MANIFEST, "dist", () => false)).toThrow(
      /staging policy in scripts\/runtime-staging\.ts/
    );
  });

  test("a manifest that parses to nothing throws rather than passing", () => {
    expect(() => assertManifestStaged("fx_version 'bodacious'\n", [])).toThrow(
      /declares no loadable paths/
    );
  });

  test("the thrown message names every missing path", () => {
    expect(() => assertManifestStaged(MANIFEST, ["shared/utils.lua"])).toThrow(
      /client\/cl_hud\.lua/
    );
  });
});
