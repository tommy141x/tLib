import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import AdmZip from "adm-zip";
import {
  adoptLegacyInstallationFromData,
  type PreparedPayload,
  type ProtectedBuiltinInventory,
  protectedInventoryFromRelease,
  snapshotProtectedInventory,
  verifyLegacyInstallationFromData,
} from "../../../shared/ts/marketplace/installer";

let root: string;
let limit = 5 * 1024 * 1024;
let installPath = "assets";
mock.module("./config", () => ({ resolveConfig: () => ({ maxBundleBytes: limit }) }));
mock.module("./fivem", () => ({ fGetResourcePath: () => root }));
/**
 * A per-test content validator, reached through the REAL code path.
 *
 * `install.ts` calls `target.validate` with the prepared payload, which is the
 * only place a sound's `module.json` is ever visible: it is generated (or read
 * out of a zipped module) and passed in memory, because a flat audio file has
 * nowhere on disk to keep it. Observing it here rather than adding a parameter
 * to `installFromData` means these tests exercise the same hand-off a consumer's
 * own contract does.
 */
let validator: ((payload: PreparedPayload) => void) | undefined;
mock.module("./registry", () => ({
  get: (resourceName: string, type: string) => ({
    resourceName,
    type,
    installPath,
    validate: validator,
  }),
}));
const { installFromData, uninstallItem } = await import("./installer");
const wav = Buffer.from("RIFF1234WAVEoriginal sound");
const ogg = Buffer.from("OggSreplacement sound");
const base = () => path.join(root, "assets");
const file = (name: string) => path.join(base(), name);
const install = (data: Buffer, type = "sound", slug = "demo", digest = "", size = 0) =>
  installFromData("test", type, slug, data, digest, size);
function bundle(files: Record<string, string> = { "ui.html": "<p>original</p>" }): Buffer {
  const zip = new AdmZip();
  for (const [name, value] of Object.entries(files)) zip.addFile(name, Buffer.from(value));
  return zip.toBuffer();
}
function patchCentral(data: Buffer, field: number, value: number): Buffer {
  const out = Buffer.from(data);
  const offset = out.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  out.writeUInt32LE(value, offset + field);
  return out;
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tlib-installer-test-"));
  limit = 5 * 1024 * 1024;
  installPath = "assets";
  validator = undefined;
});
afterEach(() => {
  mock.restore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("marketplace installer isolation and ownership", () => {
  test("installs ZIP with hash and removes studio metadata; receipt supports uninstall", () => {
    const data = bundle({ "ui.html": "hello\n<!-- studio-design:YWJj-->", "css/a.css": "body{}" });
    const digest = createHash("sha256").update(data).digest("hex");
    expect(install(data, "ui", "demo", `sha256:${digest}`, data.length).ok).toBe(true);
    expect(fs.readFileSync(file("demo/ui.html"), "utf8")).toBe("hello");
    expect(uninstallItem("test", "ui", "demo").ok).toBe(true);
    expect(fs.readdirSync(base())).toEqual([]);
  });
  test("raw audio installs as a FLAT FILE, and a format change removes the old one", () => {
    // A sound is a plain `.wav` in `layouts/sounds/`, not a folder. That is the
    // shape, chosen so an operator can drag an audio file in and have it work
    // with no manifest to author. The folder-and-`module.json` form of a sound
    // exists in the studio and the marketplace; `prepareBundle` reduces it here.
    expect(install(wav).ok).toBe(true);
    expect(fs.readFileSync(file("demo.wav"))).toEqual(wav);
    // Nothing else lands. No directory, and no manifest — a flat file has nowhere
    // to keep one, which is exactly why the metadata lives in the catalogue.
    expect(fs.readdirSync(base()).sort()).toEqual([".marketplace-demo.json", "demo.wav"]);
    expect(install(ogg).ok).toBe(true);
    // The receipt is what authorises removing the superseded `.wav`: the
    // destination changed extension, so without ownership the old file would be
    // left beside the new one and the resolver would pick by extension order.
    expect(fs.existsSync(file("demo.wav"))).toBe(false);
    expect(fs.readFileSync(file("demo.ogg"))).toEqual(ogg);
    expect(uninstallItem("test", "sound", "demo").ok).toBe(true);
    expect(fs.readdirSync(base())).toEqual([]);
  });
  test("a ZIPPED sound module from the studio installs as just its audio", () => {
    // The two input shapes, one destination. tWeb exports a sound as a folder
    // with a `module.json`; a FiveM resource gets the audio and nothing else.
    const manifest = JSON.stringify({
      schema: 1,
      kind: "sound",
      id: "demo",
      name: "Air Horn",
      version: "2.1.0",
      author: "Someone",
      license: "CC0-1.0",
      sound: { file: "demo.wav", durationSeconds: 1.5, peaks: [0, 1] },
    });
    const data = bundle({ "module.json": manifest, "demo.wav": wav.toString("binary") });
    expect(install(data).ok).toBe(true);
    expect(fs.readdirSync(base()).sort()).toEqual([".marketplace-demo.json", "demo.wav"]);
    // The manifest is DROPPED on purpose, not forgotten: nothing on a resource
    // reads one, and leaving it would put a second, unread description of the
    // sound next to the sound.
    expect(fs.existsSync(file("module.json"))).toBe(false);
    expect(uninstallItem("test", "sound", "demo").ok).toBe(true);
  });
  test("a zipped sound module is refused when it cannot produce playable audio", () => {
    // Each of these installs cleanly under a looser contract and then plays
    // nothing, which is the failure class worth a refusal.
    expect(install(bundle({ "demo.wav": "x" })).ok).toBe(false); // no manifest
    expect(install(bundle({ "module.json": "{" })).ok).toBe(false); // malformed
    expect(
      install(
        bundle({
          "module.json": JSON.stringify({
            schema: 1,
            kind: "sound",
            id: "demo",
            name: "d",
            version: "1.0.0",
            sound: { file: "demo.wav" },
          }),
        })
      ).ok
    ).toBe(false); // declares audio the bundle does not contain
    expect(fs.existsSync(base())).toBe(false);
  });
  test("names and versions the catalogue supplies reach a raw upload's manifest", () => {
    const seen: unknown[] = [];
    validator = (payload) => seen.push(payload.manifest);
    expect(
      installFromData("test", "sound", "demo", wav, "", 0, {
        name: "Air Horn",
        version: "2.1.0",
      }).ok
    ).toBe(true);
    expect(seen).toEqual([
      {
        schema: 1,
        kind: "sound",
        id: "demo",
        name: "Air Horn",
        version: "2.1.0",
        slug: "demo",
        sound: { file: "demo.wav" },
      },
    ]);
  });
  test("a raw upload with no catalogue metadata says so rather than inventing it", () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    validator = (payload) =>
      seen.push(payload.manifest as unknown as Record<string, unknown> | undefined);
    expect(install(wav).ok).toBe(true);
    expect(seen[0]?.name).toBe("demo");
    // 0.0.0 reads as "nobody told us", which is the truth for raw audio.
    expect(seen[0]?.version).toBe("0.0.0");
  });
  test("a zipped sound module's own manifest reaches the validator, parsed", () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    validator = (payload) =>
      seen.push(payload.manifest as unknown as Record<string, unknown> | undefined);
    const manifest = JSON.stringify({
      schema: 1,
      kind: "sound",
      id: "demo",
      name: "Air Horn",
      version: "3.0.0",
      author: "Someone",
      license: "CC0-1.0",
      sound: { file: "demo.wav", durationSeconds: 1.5, toneKeys: ["ALERT_A"], peaks: [0, 1] },
    });
    expect(
      install(bundle({ "module.json": manifest, "demo.wav": wav.toString("binary") })).ok
    ).toBe(true);
    // Everything the studio put in it, including the peaks that have nowhere to
    // live on a resource. This is the hand-off the marketplace relies on.
    expect(seen[0]?.author).toBe("Someone");
    expect(seen[0]?.license).toBe("CC0-1.0");
    expect((seen[0]?.sound as Record<string, unknown>)?.peaks).toEqual([0, 1]);
  });
  test.each(["demo", "demo.wav"])(
    "⛔ refuses an unreceipted existing %s for install and uninstall",
    (name) => {
      // THE PROTECTION PROPERTY, for BOTH shapes a target can take. Content
      // that ships with a resource has no receipt, and this refusal is the whole
      // reason it cannot be overwritten or uninstalled — not
      // `ProtectedBuiltinInventory`, which is measurably inert.
      //
      // Both names are probed regardless of item type, deliberately: a directory
      // called `demo` must block a sound install just as `demo.wav` must block a
      // layout install. Refusing more is the safe direction.
      fs.mkdirSync(base());
      if (name === "demo") {
        fs.mkdirSync(file(name));
        fs.writeFileSync(file("demo/keep"), "precious");
      } else fs.writeFileSync(file(name), "precious");
      expect(install(wav).ok).toBe(false);
      expect(uninstallItem("test", "sound", "demo").ok).toBe(false);
      expect(fs.existsSync(file(name))).toBe(true);
    }
  );
  test("⛔ a SHIPPED mixed-case sound stays un-uninstallable", () => {
    // tRadio ships `bgDog.wav`, `transEnd1.wav`, `QRX-720/`. A slug is always
    // lowercased, so the shipped name and the slug differ by case — and a Linux
    // container will not resolve one to the other.
    fs.mkdirSync(base());
    fs.writeFileSync(file("bgDog.wav"), "SHIPPED");
    const outcome = installFromData("test", "sound", "bgDog", wav, "", 0);
    expect(outcome.ok).toBe(false);
    // WHICH guard fires depends on the filesystem, and both are the right answer.
    // On a case-INSENSITIVE filesystem (this machine) the plain stat for
    // `bgdog.wav` finds `bgDog.wav` and the unreceipted-target refusal catches it
    // first. On a case-SENSITIVE one that stat misses and the case-variant scan is
    // the only thing standing there. Asserting one message would make this pass on
    // one platform and fail on the other while the property holds on both.
    if (!outcome.ok) expect(outcome.error).toMatch(/no marketplace ownership receipt|only by case/);
    expect(uninstallItem("test", "sound", "bgDog").ok).toBe(false);
    expect(fs.readFileSync(file("bgDog.wav"), "utf8")).toBe("SHIPPED");
  });
  test("receipt does not authorize removal of changed or newly added content", () => {
    expect(install(bundle(), "ui").ok).toBe(true);
    fs.writeFileSync(file("demo/unrelated"), "keep");
    expect(install(bundle(), "ui").ok).toBe(false);
    expect(uninstallItem("test", "ui", "demo").ok).toBe(false);
    expect(fs.readFileSync(file("demo/unrelated"), "utf8")).toBe("keep");
  });
  test("refuses symlinked install ancestor", () => {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, base(), "junction");
    expect(install(wav).ok).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  test("refuses symlinked owned payload", () => {
    expect(install(bundle(), "ui").ok).toBe(true);
    fs.renameSync(file("demo"), path.join(root, "outside"));
    fs.symlinkSync(path.join(root, "outside"), file("demo"), "junction");
    expect(install(bundle(), "ui").ok).toBe(false);
    expect(uninstallItem("test", "ui", "demo").ok).toBe(false);
  });
  test.each(["../outside", "C:/outside", "assets/CON", "assets.", "assets/stream:ads"])(
    "rejects unsafe registered path %s",
    (p) => {
      installPath = p;
      expect(install(wav).ok).toBe(false);
    }
  );
});

describe("bounded metadata and path validation", () => {
  test("rejects encryption flag without relying on misspelled dependency types", () => {
    const data = bundle();
    const central = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    data.writeUInt16LE(data.readUInt16LE(central + 8) | 1, central + 8);
    data.writeUInt16LE(data.readUInt16LE(6) | 1, 6);
    expect(install(data, "ui")).toEqual({
      ok: false,
      error: "encrypted zip entries are unsupported",
    });
    expect(fs.existsSync(file("demo"))).toBe(false);
  });
  test.each(["invalid", "sha256:", " ", "f".repeat(63)])("fails closed on hash %s", (digest) => {
    expect(install(wav, "sound", "demo", digest).ok).toBe(false);
    expect(fs.existsSync(base())).toBe(false);
  });
  test("rejects mismatches and malformed runtime input", () => {
    expect(install(wav, "sound", "demo", "0".repeat(64)).ok).toBe(false);
    expect(install(wav, "sound", "demo", "", 1).ok).toBe(false);
    expect(install(wav, "sound", "demo", "", -1).ok).toBe(false);
    expect(install(wav, "sound", "demo", "", NaN).ok).toBe(false);
    expect(install("not bytes" as unknown as Buffer).ok).toBe(false);
    expect(install(wav, "sound", 42 as unknown as string).ok).toBe(false);
    expect(install(wav, "sound", "CON").ok).toBe(false);
  });
  test("rejects raw UI, unknown sound magic, and RIFF non-WAVE", () => {
    expect(install(wav, "ui").ok).toBe(false);
    expect(install(Buffer.from("arbitrary bytes")).ok).toBe(false);
    expect(install(Buffer.from("RIFF1234AVI ")).ok).toBe(false);
  });
  test("bounds compressed and raw input", () => {
    limit = 10;
    expect(install(wav).ok).toBe(false);
    expect(install(bundle(), "ui").ok).toBe(false);
  });
  test("rejects declared oversized data before getData", () => {
    const data = patchCentral(bundle(), 24, limit + 1);
    const result = install(data, "ui");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("declared uncompressed");
    expect(fs.existsSync(base())).toBe(false);
  });
  test("bounds forged zero and small uncompressed sizes", () => {
    for (const size of [0, 1, 10001])
      expect(
        install(patchCentral(bundle({ "big.txt": "a".repeat(10000) }), 24, size), "ui").ok
      ).toBe(false);
  });
  test("rejects total expanded size and excessive entry counts", () => {
    const data = bundle({ a: "a".repeat(1000), b: "b".repeat(1000) });
    limit = 1500;
    expect(install(data, "ui").ok).toBe(false);
    limit = 5 * 1024 * 1024;
    const files = Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`f${i}`, "x"]));
    expect(install(bundle(files), "ui").ok).toBe(false);
  });
  test.each(["foo:ads", "CON.txt", "a/NUL", "trailing.", "trailing ", "A.txt|bad"])(
    "rejects unsafe ZIP entry %s",
    (name) => {
      expect(install(bundle({ [name]: "bad" }), "ui").ok).toBe(false);
    }
  );
  test("rejects traversal and absolute names preserved in hostile ZIP headers", () => {
    for (const name of ["../evil", "/abcdef", "abc\\def"]) {
      const data = bundle({ abcdefg: "bad" });
      let offset = data.indexOf(Buffer.from("abcdefg"));
      while (offset !== -1) {
        data.write(name, offset, "utf8");
        offset = data.indexOf(Buffer.from("abcdefg"), offset + 7);
      }
      expect(install(data, "ui").ok).toBe(false);
    }
  });
  test("rejects case aliases, file ancestors, and symlink zip entries", () => {
    expect(install(bundle({ "A.txt": "a", "a.txt": "b" }), "ui").ok).toBe(false);
    expect(install(bundle({ a: "a", "a/b": "b" }), "ui").ok).toBe(false);
    expect(install(bundle({ "A/x": "a", "a/y": "b" }), "ui").ok).toBe(false);
    expect(install(patchCentral(bundle(), 38, (0xa1ff << 16) >>> 0), "ui").ok).toBe(false);
  });
});

describe("read-only legacy compatibility verification", () => {
  const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  const verify = (
    data: Buffer,
    type = "ui",
    sha = digest(data),
    size = data.length,
    protectedInventory?: ProtectedBuiltinInventory
  ) =>
    verifyLegacyInstallationFromData(
      {
        resourceName: "test",
        resourceRoot: root,
        type,
        installPath,
        maxBundleBytes: limit,
        protectedInventory,
      },
      "demo",
      data,
      sha,
      size
    );
  const legacy = (data: Buffer, type = "ui") => {
    expect(install(data, type).ok).toBe(true);
    fs.unlinkSync(file(".marketplace-demo.json"));
  };
  test("exact transformed HTML and nested inventory verify without writes or adoption authority", () => {
    const data = bundle({ "ui.html": "hello\n<!-- studio-design:YWJj-->", "css/a.css": "body{}" });
    legacy(data);
    const before = fs.statSync(file("demo/ui.html"));
    const write = spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("receipt disk full");
    });
    const result = verify(data);
    expect(result).toEqual({
      ok: true,
      classification: "verified-unreceipted",
      destination: file("demo"),
      packageHash: digest(data),
      fileCount: 2,
      adoptionAllowed: false,
      blocker: "builtin-boundary-unavailable",
    });
    expect(write).not.toHaveBeenCalled();
    expect(fs.readFileSync(file("demo/ui.html"), "utf8")).toBe("hello");
    expect(fs.statSync(file("demo/ui.html")).mtimeMs).toBe(before.mtimeMs);
    expect(fs.statSync(file("demo/ui.html")).ino).toBe(before.ino);
    expect(fs.readdirSync(base())).toEqual(["demo"]);
    expect(install(data, "ui").ok).toBe(false);
    expect(uninstallItem("test", "ui", "demo").ok).toBe(false);
  });
  test.each(["sound", "tone"])(
    "exact raw %s verifies but remains blocked, even for a potential built-in",
    (type) => {
      legacy(wav, type);
      const result = verify(wav, type);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.adoptionAllowed).toBe(false);
      expect(fs.readdirSync(base())).toEqual(["demo.wav"]);
    }
  );
  test.each(["modified", "extra file", "extra empty directory", "missing"])(
    "rejects %s inventory",
    (change) => {
      const data = bundle();
      legacy(data);
      if (change === "modified") fs.writeFileSync(file("demo/ui.html"), "<p>modified</p>");
      if (change === "extra file") fs.writeFileSync(file("demo/extra"), "unrelated");
      if (change === "extra empty directory") fs.mkdirSync(file("demo/empty"));
      if (change === "missing") fs.unlinkSync(file("demo/ui.html"));
      expect(verify(data).ok).toBe(false);
      expect(fs.existsSync(file(".marketplace-demo.json"))).toBe(false);
    }
  );
  test("verified release inventory refuses an exact-match built-in", () => {
    const data = bundle();
    legacy(data);
    const release = bundle({
      "test/fxmanifest.lua": "files {'assets/**/*'}",
      "test/assets/demo/ui.html": "<p>original</p>",
    });
    const policy = protectedInventoryFromRelease("test", release, digest(release));
    expect(policy.files).toEqual(["assets/demo/ui.html", "fxmanifest.lua"]);
    const result = verify(data, "ui", digest(data), data.length, policy);
    expect(result).toEqual({
      ok: false,
      error: "protected built-in destination; refusing legacy adoption",
    });
    expect(fs.readdirSync(base())).toEqual(["demo"]);
  });
  test("release inventory protects removed stock format and is case-insensitive", () => {
    legacy(wav, "sound");
    const release = bundle({ "test/assets/DEMO.ogg": "OggSstock" });
    const policy = protectedInventoryFromRelease("test", release, digest(release));
    expect(verify(wav, "sound", digest(wav), wav.length, policy).ok).toBe(false);
  });
  test("inventory uses release content rather than current disk or catalog guesses", () => {
    const data = bundle();
    legacy(data);
    const release = bundle({
      "test/fxmanifest.lua": "files {'assets/**/*'}",
      "test/assets/stock/ui.html": "stock",
    });
    const policy = protectedInventoryFromRelease("test", release, `sha256:${digest(release)}`);
    expect(policy.files).not.toContain("assets/demo/ui.html");
    expect(Object.isFrozen(policy.files)).toBe(true);
    const result = verify(data, "ui", digest(data), data.length, policy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.adoptionAllowed).toBe(false);
      expect(result.blocker).toBe("adoption-not-enabled");
    }
    expect(fs.existsSync(file(".marketplace-demo.json"))).toBe(false);
  });
  test("release inventory rejects bad hashes, foreign wrappers, unsafe paths, aliases and links", () => {
    const valid = bundle({ "test/assets/stock/ui.html": "stock" });
    expect(() => protectedInventoryFromRelease("test", valid, "0".repeat(64))).toThrow();
    for (const release of [
      bundle({ "other/assets/stock": "x" }),
      bundle({ "test/assets/CON": "x" }),
      bundle({ "test/assets/A/x": "x", "test/assets/a/y": "y" }),
      bundle({ "test/assets/a": "x", "test/assets/a/b": "y" }),
      patchCentral(valid, 38, (0xa1ff << 16) >>> 0),
    ]) {
      expect(() => protectedInventoryFromRelease("test", release, digest(release))).toThrow();
    }
  });
  test("missing or malformed policy cannot authorize migration", () => {
    const data = bundle();
    legacy(data);
    const result = verify(data);
    if (result.ok) expect(result.blocker).toBe("builtin-boundary-unavailable");
    for (const files of [[], ["../assets/demo"], ["assets/CON"], ["a", "A"]]) {
      expect(() =>
        snapshotProtectedInventory(
          { schema: 1, resourceName: "test", releaseHash: "a".repeat(64), files },
          "test"
        )
      ).toThrow();
    }
    expect(
      verify(data, "ui", digest(data), data.length, {
        schema: 1,
        resourceName: "other",
        releaseHash: "a".repeat(64),
        files: ["assets/stock/ui.html"],
      }).ok
    ).toBe(false);
  });
  test("untransformed studio HTML is not silently normalized on disk", () => {
    const html = "hello\n<!-- studio-design:YWJj-->";
    const data = bundle({ "ui.html": html });
    legacy(data);
    fs.writeFileSync(file("demo/ui.html"), html);
    expect(verify(data).ok).toBe(false);
    expect(fs.readFileSync(file("demo/ui.html"), "utf8")).toBe(html);
  });
  test.each(["", "bad", "0".repeat(64)])("requires verified package hash %s", (sha) => {
    legacy(wav, "sound");
    expect(verify(wav, "sound", sha).ok).toBe(false);
    expect(fs.readdirSync(base())).toEqual(["demo.wav"]);
  });
  test("honors prefixed digest, size and bundle limits", () => {
    legacy(wav, "sound");
    expect(verify(wav, "sound", `sha256:${digest(wav)}`).ok).toBe(true);
    expect(verify(wav, "sound", digest(wav), wav.length + 1).ok).toBe(false);
    limit = wav.length - 1;
    expect(verify(wav, "sound").ok).toBe(false);
  });
  test("refuses ambiguous destinations and mismatched package format", () => {
    legacy(wav, "sound");
    // A different container means a different destination name (`demo.ogg`
    // against a disk holding `demo.wav`), so the format mismatch is refused.
    expect(verify(ogg, "sound").ok).toBe(false);
    // And a directory sitting beside the flat file is a SECOND candidate for the
    // same slug. Adopting either would mint a receipt that claims one of two
    // things an operator can see, so neither is adopted.
    fs.mkdirSync(file("demo"));
    expect(verify(wav, "sound").ok).toBe(false);
  });
  test.each(["valid", "invalid"])("never overwrites an existing %s receipt", (kind) => {
    const data = bundle();
    expect(install(data, "ui").ok).toBe(true);
    if (kind === "invalid") fs.writeFileSync(file(".marketplace-demo.json"), "not JSON");
    const before = fs.readFileSync(file(".marketplace-demo.json"));
    expect(verify(data).ok).toBe(false);
    expect(fs.readFileSync(file(".marketplace-demo.json"))).toEqual(before);
  });
  test("rejects missing install without creating directories", () => {
    expect(verify(bundle()).ok).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });
  test("rejects case-aliased destination", () => {
    legacy(wav, "sound");
    fs.renameSync(file("demo.wav"), file("DEMO.wav"));
    expect(verify(wav, "sound").ok).toBe(false);
  });
  test.each(["../outside", "C:/outside", "assets/CON", "assets/stream:ads"])(
    "rejects unsafe target %s",
    (p) => {
      legacy(wav, "sound");
      installPath = p;
      expect(verify(wav, "sound").ok).toBe(false);
    }
  );
  test("shares hostile archive validation with the installer", () => {
    legacy(bundle());
    for (const data of [
      bundle({ "CON.txt": "bad" }),
      bundle({ a: "x", "a/b": "y" }),
      bundle({ "A/x": "a", "a/y": "b" }),
      patchCentral(bundle(), 38, (0xa1ff << 16) >>> 0),
    ]) {
      expect(verify(data).ok).toBe(false);
    }
  });
  test("rejects hardlinks and symlinked payload/ancestors", () => {
    const data = bundle();
    legacy(data);
    fs.linkSync(file("demo/ui.html"), path.join(root, "linked"));
    expect(verify(data).ok).toBe(false);
    fs.unlinkSync(path.join(root, "linked"));
    fs.renameSync(file("demo"), path.join(root, "outside"));
    fs.symlinkSync(path.join(root, "outside"), file("demo"), "junction");
    expect(verify(data).ok).toBe(false);
    fs.rmSync(base(), { recursive: true });
    fs.symlinkSync(path.join(root, "outside"), base(), "junction");
    expect(verify(data).ok).toBe(false);
  });
  test("detects receipt appearing during verification and never replaces it", () => {
    const data = bundle();
    legacy(data);
    const open = fs.openSync;
    let injected = false;
    spyOn(fs, "openSync").mockImplementation((p, flags, mode) => {
      if (!injected && String(p) === file("demo/ui.html")) {
        injected = true;
        fs.writeFileSync(file(".marketplace-demo.json"), "concurrent receipt", { flag: "wx" });
      }
      return open(p, flags, mode);
    });
    expect(verify(data).ok).toBe(false);
    expect(injected).toBe(true);
    expect(fs.readFileSync(file(".marketplace-demo.json"), "utf8")).toBe("concurrent receipt");
  });
});

describe("explicit verified legacy adoption", () => {
  const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  const policy = (): ProtectedBuiltinInventory => ({
    schema: 1,
    resourceName: "test",
    releaseHash: "a".repeat(64),
    files: ["assets/stock/ui.html"],
  });
  const adopt = (
    data: Buffer,
    changes: Record<string, unknown> = {},
    authChanges: Record<string, unknown> = {}
  ) =>
    adoptLegacyInstallationFromData(
      {
        resourceName: "test",
        resourceRoot: root,
        type: "ui",
        installPath,
        maxBundleBytes: limit,
        protectedInventory: policy(),
        ...changes,
      },
      "demo",
      data,
      digest(data),
      data.length,
      {
        action: "adopt-verified-legacy",
        resourceName: "test",
        type: "ui",
        slug: "demo",
        packageHash: digest(data),
        protectedReleaseHash: "a".repeat(64),
        ...authChanges,
      }
    );
  const legacy = (data: Buffer) => {
    expect(install(data, "ui").ok).toBe(true);
    fs.unlinkSync(file(".marketplace-demo.json"));
  };
  test("adopts transformed exact content by receipt only; normal managed uninstall then works", () => {
    const data = bundle({ "ui.html": "hello\n<!-- studio-design:YWJj-->", "css/a.css": "body{}" });
    legacy(data);
    const before = fs.statSync(file("demo/ui.html"));
    const result = adopt(data);
    expect(result).toEqual({
      ok: true,
      adoptedAt: file("demo"),
      fileCount: 2,
      payloadBytesWritten: 0,
    });
    const after = fs.statSync(file("demo/ui.html"));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(fs.readFileSync(file("demo/ui.html"), "utf8")).toBe("hello");
    expect(fs.statSync(file(".marketplace-demo.json")).nlink).toBe(1);
    expect(
      JSON.parse(fs.readFileSync(file(".marketplace-demo.json"), "utf8")).adoption.packageHash
    ).toBe(digest(data));
    expect(fs.readdirSync(base()).sort()).toEqual([".marketplace-demo.json", "demo"]);
    expect(uninstallItem("test", "ui", "demo").ok).toBe(true);
  });
  // "ambiguous" is no longer in this list. It wrote a flat `demo.wav` beside the
  // `demo/` directory, which was a second candidate destination when a sound
  // could install as a bare file. With one candidate per slug it is not a
  // candidate at all, so the case cannot reach the hazard it was written for and
  // keeping it would be a test that passes without exercising anything.
  test.each(["modified", "extra", "missing"])("refuses %s content without a receipt", (kind) => {
    const data = bundle();
    legacy(data);
    if (kind === "modified") fs.writeFileSync(file("demo/ui.html"), "changed");
    if (kind === "extra") fs.mkdirSync(file("demo/extra"));
    if (kind === "missing") fs.unlinkSync(file("demo/ui.html"));
    expect(adopt(data).ok).toBe(false);
    expect(fs.existsSync(file(".marketplace-demo.json"))).toBe(false);
    expect(fs.readdirSync(base()).some((name) => name.startsWith(".marketplace-"))).toBe(false);
  });
  test("requires policy, exact authorization and package hash", () => {
    const data = bundle();
    legacy(data);
    expect(adopt(data, { protectedInventory: undefined }).ok).toBe(false);
    for (const auth of [
      { action: "install" },
      { resourceName: "other" },
      { type: "sound" },
      { slug: "stock" },
      { packageHash: "0".repeat(64) },
      { protectedReleaseHash: "0".repeat(64) },
    ])
      expect(adopt(data, {}, auth).ok).toBe(false);
    expect(
      adoptLegacyInstallationFromData(
        {
          resourceName: "test",
          resourceRoot: root,
          type: "ui",
          installPath,
          maxBundleBytes: limit,
          protectedInventory: policy(),
        },
        "demo",
        data,
        "0".repeat(64),
        data.length,
        {
          action: "adopt-verified-legacy",
          resourceName: "test",
          type: "ui",
          slug: "demo",
          packageHash: "0".repeat(64),
          protectedReleaseHash: "a".repeat(64),
        }
      ).ok
    ).toBe(false);
    expect(fs.readdirSync(base())).toEqual(["demo"]);
  });
  test("refuses exact built-in content, unsafe policy/target and existing receipts", () => {
    const data = bundle();
    legacy(data);
    expect(
      adopt(data, { protectedInventory: { ...policy(), files: ["assets/demo/ui.html"] } }).ok
    ).toBe(false);
    expect(adopt(data, { protectedInventory: { ...policy(), files: ["../unsafe"] } }).ok).toBe(
      false
    );
    expect(adopt(data, { installPath: "../outside" }).ok).toBe(false);
    fs.writeFileSync(file(".marketplace-demo.json"), "existing unrelated receipt");
    expect(adopt(data).ok).toBe(false);
    expect(fs.readFileSync(file(".marketplace-demo.json"), "utf8")).toBe(
      "existing unrelated receipt"
    );
  });
  test("fails closed on stale target lock", () => {
    const data = bundle();
    legacy(data);
    fs.mkdirSync(file(".marketplace-lock-demo"));
    expect(adopt(data).ok).toBe(false);
    expect(fs.existsSync(file(".marketplace-lock-demo"))).toBe(true);
    expect(fs.existsSync(file(".marketplace-demo.json"))).toBe(false);
  });
  test.each(["write", "fsync", "link"])(
    "failed receipt %s leaves payload unreceipted",
    (operation) => {
      const data = bundle();
      legacy(data);
      if (operation === "write") {
        const write = fs.writeFileSync;
        spyOn(fs, "writeFileSync").mockImplementation((p, value, opts) => {
          if (path.basename(String(p)) === "receipt")
            throw new Error("injected receipt write failure");
          return write(p, value, opts);
        });
      } else if (operation === "fsync")
        spyOn(fs, "fsyncSync").mockImplementation(() => {
          throw new Error("injected fsync failure");
        });
      else
        spyOn(fs, "linkSync").mockImplementation(() => {
          throw new Error("hardlinks unsupported");
        });
      expect(adopt(data).ok).toBe(false);
      expect(fs.readFileSync(file("demo/ui.html"), "utf8")).toBe("<p>original</p>");
      expect(fs.readdirSync(base())).toEqual(["demo"]);
    }
  );
  test("exclusive publication preserves a concurrent receipt", () => {
    const data = bundle();
    legacy(data);
    const link = fs.linkSync;
    spyOn(fs, "linkSync").mockImplementation((from, to) => {
      fs.writeFileSync(to, "concurrent", { flag: "wx" });
      link(from, to);
    });
    expect(adopt(data).ok).toBe(false);
    expect(fs.readFileSync(file(".marketplace-demo.json"), "utf8")).toBe("concurrent");
  });
  test.each(["staging", "publication"])(
    "detects payload mutation during %s and removes only its own receipt",
    (phase) => {
      const data = bundle();
      legacy(data);
      if (phase === "staging") {
        const sync = fs.fsyncSync;
        spyOn(fs, "fsyncSync").mockImplementation((fd) => {
          fs.writeFileSync(file("demo/ui.html"), "edited during stage");
          sync(fd);
        });
      } else {
        const link = fs.linkSync;
        spyOn(fs, "linkSync").mockImplementation((from, to) => {
          fs.writeFileSync(file("demo/ui.html"), "edited during publication");
          link(from, to);
        });
      }
      expect(adopt(data).ok).toBe(false);
      expect(fs.existsSync(file(".marketplace-demo.json"))).toBe(false);
      expect(fs.readFileSync(file("demo/ui.html"), "utf8")).toContain("edited during");
      expect(fs.readdirSync(base())).toEqual(["demo"]);
    }
  );
  test("adopts raw audio without renaming or rewriting its payload", () => {
    expect(install(wav).ok).toBe(true);
    fs.unlinkSync(file(".marketplace-demo.json"));
    const before = fs.statSync(file("demo.wav"));
    expect(adopt(wav, { type: "sound" }, { type: "sound" }).ok).toBe(true);
    expect(fs.statSync(file("demo.wav")).ino).toBe(before.ino);
    expect(fs.statSync(file("demo.wav")).mtimeMs).toBe(before.mtimeMs);
    expect(uninstallItem("test", "sound", "demo").ok).toBe(true);
  });
  test("refuses hardlinked files and symlinked legacy payloads", () => {
    const data = bundle();
    legacy(data);
    fs.linkSync(file("demo/ui.html"), path.join(root, "hardlink"));
    expect(adopt(data).ok).toBe(false);
    fs.unlinkSync(path.join(root, "hardlink"));
    fs.renameSync(file("demo"), path.join(root, "outside"));
    fs.symlinkSync(path.join(root, "outside"), file("demo"), "junction");
    expect(adopt(data).ok).toBe(false);
    expect(fs.existsSync(file(".marketplace-demo.json"))).toBe(false);
  });
  test("failed temporary receipt unlink withdraws the newly published receipt", () => {
    const data = bundle();
    legacy(data);
    const unlink = fs.unlinkSync;
    spyOn(fs, "unlinkSync").mockImplementation((p) => {
      if (path.basename(String(p)) === "receipt")
        throw new Error("injected receipt unlink failure");
      unlink(p);
    });
    expect(adopt(data).ok).toBe(false);
    expect(fs.existsSync(file(".marketplace-demo.json"))).toBe(false);
    expect(fs.readFileSync(file("demo/ui.html"), "utf8")).toBe("<p>original</p>");
  });
  test("shared target lock rejects reentrant adoption/install/uninstall after receipt publication", () => {
    const data = bundle();
    legacy(data);
    const unlink = fs.unlinkSync;
    let checked = false;
    spyOn(fs, "unlinkSync").mockImplementation((p) => {
      unlink(p);
      if (!checked && path.basename(String(p)) === "receipt") {
        checked = true;
        expect(adopt(data).ok).toBe(false);
        expect(install(data, "ui").ok).toBe(false);
        expect(uninstallItem("test", "ui", "demo").ok).toBe(false);
      }
    });
    expect(adopt(data).ok).toBe(true);
    expect(checked).toBe(true);
  });
});

describe("transaction rollback", () => {
  test("failed staged receipt write leaves managed payload and receipt unchanged", () => {
    expect(install(wav).ok).toBe(true);
    const receipt = fs.readFileSync(file(".marketplace-demo.json"));
    const write = fs.writeFileSync;
    spyOn(fs, "writeFileSync").mockImplementation((p, data, opts) => {
      if (path.basename(String(p)) === "receipt") throw new Error("injected receipt disk full");
      return write(p, data, opts);
    });
    expect(install(ogg).ok).toBe(false);
    expect(fs.readFileSync(file(".marketplace-demo.json"))).toEqual(receipt);
    expect(fs.readFileSync(file("demo.wav"))).toEqual(wav);
    expect(fs.readdirSync(base()).sort()).toEqual([".marketplace-demo.json", "demo.wav"]);
  });
  test.each(["ui", "sound"])(
    "restores previous %s payload and receipt after commit rename fails",
    (type) => {
      const first = type === "ui" ? bundle() : wav;
      const next = type === "ui" ? bundle({ "ui.html": "new" }) : ogg;
      expect(install(first, type).ok).toBe(true);
      const receipt = fs.readFileSync(file(".marketplace-demo.json"));
      const originalRename = fs.renameSync;
      let failed = false;
      spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (!failed && path.basename(String(from)) === "receipt") {
          failed = true;
          throw new Error("injected rename failure");
        }
        originalRename(from, to);
      });
      expect(install(next, type).ok).toBe(false);
      expect(failed).toBe(true);
      expect(fs.readFileSync(file(".marketplace-demo.json"))).toEqual(receipt);
      expect(fs.readFileSync(file(type === "ui" ? "demo/ui.html" : "demo.wav"))).toEqual(
        type === "ui" ? Buffer.from("<p>original</p>") : wav
      );
      expect(
        fs.readdirSync(base()).some((name) => name.startsWith(".marketplace-transaction-"))
      ).toBe(false);
    }
  );
  test("failed first payload rename restores ZIP backup", () => {
    expect(install(bundle(), "ui").ok).toBe(true);
    const rename = fs.renameSync;
    spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (path.basename(String(from)) === "payload") throw new Error("injected commit failure");
      rename(from, to);
    });
    expect(install(bundle({ "ui.html": "new" }), "ui").ok).toBe(false);
    expect(fs.readFileSync(file("demo/ui.html"), "utf8")).toBe("<p>original</p>");
  });
  test("failed rollback preserves backups for recovery", () => {
    expect(install(wav).ok).toBe(true);
    const rename = fs.renameSync;
    spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (["payload", "backup"].includes(path.basename(String(from))))
        throw new Error("injected filesystem failure");
      rename(from, to);
    });
    const result = install(ogg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("recovery retained at");
    const transaction = fs
      .readdirSync(base())
      .find((name) => name.startsWith(".marketplace-transaction-"))!;
    // The backup of a flat sound destination IS the audio file.
    expect(fs.readFileSync(file(`${transaction}/backup`))).toEqual(wav);
  });
  test("failed uninstall receipt move restores old payload", () => {
    expect(install(wav).ok).toBe(true);
    const rename = fs.renameSync;
    spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from) === file(".marketplace-demo.json"))
        throw new Error("injected receipt move failure");
      rename(from, to);
    });
    expect(uninstallItem("test", "sound", "demo").ok).toBe(false);
    expect(fs.readFileSync(file("demo.wav"))).toEqual(wav);
  });
  test("raw staged write failure leaves old payload and receipt untouched", () => {
    expect(install(wav).ok).toBe(true);
    const write = fs.writeFileSync;
    spyOn(fs, "writeFileSync").mockImplementation((p, data, opts) => {
      // A flat sound stages AS the file named `payload`, which is what makes this
      // injection reach the audio write rather than the receipt write.
      if (path.basename(String(p)) === "payload") throw new Error("injected disk full");
      return write(p, data, opts);
    });
    expect(install(ogg).ok).toBe(false);
    expect(fs.readFileSync(file("demo.wav"))).toEqual(wav);
    expect(fs.readdirSync(base()).sort()).toEqual([".marketplace-demo.json", "demo.wav"]);
  });
});
