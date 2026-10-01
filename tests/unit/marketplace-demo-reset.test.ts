// resetInstalledToShipped: demo mode's start-time sweep.
//
// The property this file exists to hold is the one a demo server is sold on and
// the one that would be catastrophic to get wrong in the other direction: the
// sweep removes everything a visitor installed, and NOTHING the resource shipped
// with. Preinstalled marketplace content -- items that appear in the catalogue
// but arrive inside the release zip -- is the case that looks like it needs a
// special rule and does not, because it is never receipt-owned. That is asserted
// directly below rather than assumed.

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InstallTarget, resetInstalledToShipped } from "../../shared/ts/marketplace/installer";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const hash = (data: string) => createHash("sha256").update(data).digest("hex");

function fixture(type = "ui") {
  const root = fs.mkdtempSync(join(tmpdir(), "tlib-demo-reset-"));
  roots.push(root);
  const base = join(root, "layouts");
  fs.mkdirSync(base);
  const target: InstallTarget = {
    resourceName: "consumer",
    resourceRoot: root,
    type,
    installPath: "layouts",
    maxBundleBytes: 1024,
  };

  /** An installed item, exactly as installFromData leaves it: content + receipt. */
  const installed = (slug: string, body = "payload", receiptType = type) => {
    fs.mkdirSync(join(base, slug), { recursive: true });
    fs.writeFileSync(join(base, slug, "ui.html"), body);
    fs.writeFileSync(
      join(base, `.marketplace-${slug}.json`),
      JSON.stringify({
        version: 1,
        resourceName: "consumer",
        type: receiptType,
        slug,
        destination: slug,
        files: { "/": "directory", "ui.html": hash(body) },
      })
    );
  };

  /** Shipped content: real files, no receipt. This is what must survive. */
  const shipped = (slug: string, body = "builtin") => {
    fs.mkdirSync(join(base, slug), { recursive: true });
    fs.writeFileSync(join(base, slug, "ui.html"), body);
  };

  const listing = () => fs.readdirSync(base).sort();
  return { root, base, target, installed, shipped, listing };
}

test("removes every receipt-owned item and leaves shipped content untouched", () => {
  const f = fixture();
  f.installed("visitor-skin");
  f.installed("another-skin");
  // A preinstalled catalogue item and a plain shipped default. Neither has a
  // receipt, which is the whole reason neither needs an exception here.
  f.shipped("preinstalled-skin");
  f.shipped("default");

  const result = resetInstalledToShipped(f.target);

  expect(result).toEqual({ ok: true, removed: ["another-skin", "visitor-skin"], failed: [] });
  expect(f.listing()).toEqual(["default", "preinstalled-skin"]);
  // Not merely present -- byte-identical. A sweep that "restored" a shipped file
  // by rewriting it would pass a presence check and still corrupt the release.
  expect(fs.readFileSync(join(f.base, "preinstalled-skin", "ui.html"), "utf8")).toBe("builtin");
});

test("is idempotent and safe on a directory that was never installed into", () => {
  const f = fixture();
  f.shipped("default");

  expect(resetInstalledToShipped(f.target)).toEqual({ ok: true, removed: [], failed: [] });
  expect(resetInstalledToShipped(f.target)).toEqual({ ok: true, removed: [], failed: [] });
  expect(f.listing()).toEqual(["default"]);
});

test("a missing install directory is success with nothing removed, not an error", () => {
  const f = fixture();
  fs.rmSync(f.base, { recursive: true });
  // A resource that has never had anything installed has no layouts/ at all. On
  // a demo server that is the normal first boot, so it must not be reported as
  // a failure an operator is invited to investigate.
  expect(resetInstalledToShipped(f.target)).toEqual({ ok: true, removed: [], failed: [] });
});

test("one unremovable item does not abandon the rest of the sweep", () => {
  const f = fixture();
  f.installed("first");
  f.installed("tampered");
  f.installed("last");
  // Hand-edited after install: owned() refuses to delete content whose hashes no
  // longer match its receipt. Correct, and it must not become a foothold that
  // leaves every later item installed on a server whose entire promise is that
  // restarting cleans it.
  fs.writeFileSync(join(f.base, "tampered", "ui.html"), "edited by hand");

  const result = resetInstalledToShipped(f.target);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.removed).toEqual(["first", "last"]);
  expect(result.failed).toHaveLength(1);
  expect(result.failed[0].slug).toBe("tampered");
  expect(f.listing()).toEqual([".marketplace-tampered.json", "tampered"]);
});

test("only receipts belonging to this type are swept", () => {
  const f = fixture("ui");
  f.installed("skin");
  // Two item types can be registered against the same directory. Sweeping the
  // 'ui' target must not touch a 'sound' receipt, and must not report it as a
  // failure either -- the sound target's own pass will handle it.
  f.installed("tone", "payload", "sound");

  const result = resetInstalledToShipped(f.target);
  expect(result).toEqual({ ok: true, removed: ["skin"], failed: [] });
  expect(f.listing()).toEqual([".marketplace-tone.json", "tone"]);
});

test("a file where the install directory should be is refused, not walked", () => {
  const f = fixture();
  fs.rmSync(f.base, { recursive: true });
  fs.writeFileSync(f.base, "not a directory");
  const result = resetInstalledToShipped(f.target);
  expect(result.ok).toBe(false);
  expect(fs.readFileSync(f.base, "utf8")).toBe("not a directory");
});
