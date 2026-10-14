/**
 * The `validate` content-contract hook on an install target.
 *
 * The hook exists so a consuming resource can refuse a bundle that is safe to extract but is
 * not a valid instance of its own item type — the gap that let a tRadio layout with no
 * declared dimensions install with a 200 OK and go wrong later on a player's machine.
 *
 * Three properties are worth pinning, and each of these tests fails if its property is lost:
 *
 *   1. it is called, with the PREPARED bytes (post studio-comment strip), not the raw archive;
 *   2. a rejection leaves NOTHING on disk — not a staging directory, not a receipt, and above
 *      all not a damaged previous install;
 *   3. absence of a validator changes nothing, so every pre-existing consumer is unaffected.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import AdmZip from "adm-zip";
import {
  type ContentValidator,
  type InstallTarget,
  installFromData,
  type PreparedPayload,
} from "../../shared/ts/marketplace/installer";

let root: string;

const target = (validate?: ContentValidator): InstallTarget => ({
  resourceName: "test",
  resourceRoot: root,
  type: "ui",
  installPath: "layouts",
  maxBundleBytes: 5 * 1024 * 1024,
  ...(validate ? { validate } : {}),
});

const base = () => path.join(root, "layouts");

function bundle(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, value] of Object.entries(files)) zip.addFile(name, Buffer.from(value));
  return zip.toBuffer();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tlib-validator-test-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("install content validators", () => {
  test("receives the prepared payload, with ui.html already stripped of studio metadata", () => {
    const seen: PreparedPayload[] = [];
    const data = bundle({
      "ui.html": "<p>hi</p>\n<!-- studio-design:YWJj-->",
      "css/a.css": "body{}",
    });
    expect(
      installFromData(
        target((p) => void seen.push(p)),
        "demo",
        data,
        "",
        0
      ).ok
    ).toBe(true);

    expect(seen).toHaveLength(1);
    const payload = seen[0] as PreparedPayload;
    expect(payload.type).toBe("ui");
    expect(payload.slug).toBe("demo");
    expect(payload.zip).toBe(true);
    expect([...payload.files.keys()].sort()).toEqual(["css/a.css", "ui.html"]);
    // The POINT of handing over the prepared map rather than the archive: a validator that
    // parsed the raw entry would be reading bytes that never reach disk.
    expect(payload.files.get("ui.html")?.toString("utf8")).toBe("<p>hi</p>");
    expect(fs.readFileSync(path.join(base(), "demo", "ui.html"), "utf8")).toBe("<p>hi</p>");
  });

  test("a throwing validator refuses the install and reports its own message", () => {
    const outcome = installFromData(
      target(() => {
        throw new Error("no dimensions declared");
      }),
      "demo",
      bundle({ "ui.html": "<p>hi</p>" }),
      "",
      0
    );
    expect(outcome.ok).toBe(false);
    // Verbatim, so a consumer can write for the server owner who reads it.
    expect(outcome.ok === false && outcome.error).toBe("no dimensions declared");
  });

  test("a rejected install leaves no directory, no receipt and no staging residue", () => {
    const outcome = installFromData(
      target(() => {
        throw new Error("rejected");
      }),
      "demo",
      bundle({ "ui.html": "<p>hi</p>" }),
      "",
      0
    );
    expect(outcome.ok).toBe(false);
    // The hook runs before mkdir, so even the install root should be absent — a rejection is
    // not allowed to be the thing that creates the destination.
    expect(fs.existsSync(base())).toBe(false);
  });

  test("a rejected RE-install leaves the previous install exactly as it was", () => {
    // The failure mode that matters most in practice: a good layout is installed, an update
    // is published broken, and the operator clicks install. The old one must survive intact.
    const first = bundle({ "ui.html": "<p>good</p>", "img/a.png": "A" });
    expect(installFromData(target(), "demo", first, "", 0).ok).toBe(true);
    const before = fs.readdirSync(path.join(base(), "demo")).sort();

    const outcome = installFromData(
      target(() => {
        throw new Error("broken update");
      }),
      "demo",
      bundle({ "ui.html": "<p>broken</p>" }),
      "",
      0
    );
    expect(outcome.ok).toBe(false);
    expect(fs.readFileSync(path.join(base(), "demo", "ui.html"), "utf8")).toBe("<p>good</p>");
    expect(fs.readdirSync(path.join(base(), "demo")).sort()).toEqual(before);
    // No abandoned transaction directories beside it.
    expect(fs.readdirSync(base()).filter((n) => n.includes("transaction"))).toEqual([]);
  });

  test("a successful re-install REPLACES the tree — a dropped file does not survive it", () => {
    // This is the defect the `ui` install path shipped with: it wrote the new entries over the
    // old directory without clearing it, so a file the new version had removed stayed behind
    // through both the re-download and a restart, and the layout ran as a hybrid of two
    // releases. Pinned here because it is invisible unless something looks for an absence.
    expect(
      installFromData(
        target(),
        "demo",
        bundle({ "ui.html": "<p>v1</p>", "img/old.png": "OLD" }),
        "",
        0
      ).ok
    ).toBe(true);
    expect(fs.existsSync(path.join(base(), "demo", "img", "old.png"))).toBe(true);

    expect(installFromData(target(), "demo", bundle({ "ui.html": "<p>v2</p>" }), "", 0).ok).toBe(
      true
    );
    expect(fs.readFileSync(path.join(base(), "demo", "ui.html"), "utf8")).toBe("<p>v2</p>");
    expect(fs.existsSync(path.join(base(), "demo", "img", "old.png"))).toBe(false);
  });

  test("no validator means no behaviour change, digest checking included", () => {
    const data = bundle({ "ui.html": "<p>hi</p>" });
    const digest = createHash("sha256").update(data).digest("hex");
    expect(installFromData(target(), "demo", data, `sha256:${digest}`, data.length).ok).toBe(true);
    expect(fs.readFileSync(path.join(base(), "demo", "ui.html"), "utf8")).toBe("<p>hi</p>");
  });

  test("the validator runs AFTER the archive checks, so it never sees an unsafe bundle", () => {
    // Ordering matters: a validator is consumer code and must not be handed a bundle whose
    // paths and sizes have not been reconciled yet.
    //
    // Asserted with the byte limit rather than with a zip-slip entry, because AdmZip
    // normalises `..` away when an entry is ADDED — `addFile("../escape.html")` stores
    // "escape.html", so the obvious fixture quietly tests nothing and passes. (Found the
    // honest way: this test failed on its first run with a successful install.) tLib covers
    // traversal refusal directly in server/lib/marketplace/installer.test.ts, where the
    // fixture patches the central directory. The limit check is the first thing prepareBundle
    // does, so it proves the ordering just as well without a hand-built archive.
    let called = false;
    const outcome = installFromData(
      {
        ...target(() => {
          called = true;
        }),
        maxBundleBytes: 64,
      },
      "demo",
      bundle({ "ui.html": "x".repeat(4096) }),
      "",
      0
    );
    expect(outcome.ok).toBe(false);
    expect(called).toBe(false);
    expect(fs.existsSync(base())).toBe(false);
  });
});
