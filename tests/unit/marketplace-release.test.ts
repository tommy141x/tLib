import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeMarketplaceReleaseMetadata } from "../../shared/ts/build/marketplace-inventory";

let root: string;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const manifest = () => ({
  "fxmanifest.lua": sha("manifest"),
  "layouts/stock/ui.html": sha("stock"),
});
const options = () => ({
  stagingRoot: root,
  resourceName: "consumer",
  sourceRevision: "a".repeat(40),
  expectedFiles: manifest(),
});
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-release-"));
  fs.mkdirSync(path.join(root, "layouts/stock"), { recursive: true });
  fs.writeFileSync(path.join(root, "fxmanifest.lua"), "manifest");
  fs.writeFileSync(path.join(root, "layouts/stock/ui.html"), "stock");
});
afterEach(() => {
  mock.restore();
  fs.rmSync(root, { recursive: true, force: true });
});
test("post-staging hook records explicit approved shipped inventory without rewriting payload", () => {
  const before = fs.statSync(path.join(root, "layouts/stock/ui.html"));
  const metadata = writeMarketplaceReleaseMetadata(options());
  expect(metadata.protectedInventory.source).toBe("release-staging");
  expect(metadata.protectedInventory.files).toEqual(["fxmanifest.lua", "layouts/stock/ui.html"]);
  expect(metadata.shippedFiles).toEqual([
    { path: "fxmanifest.lua", sha256: sha("manifest"), bytes: 8 },
    { path: "layouts/stock/ui.html", sha256: sha("stock"), bytes: 5 },
  ]);
  expect(JSON.parse(fs.readFileSync(path.join(root, ".marketplace-release.json"), "utf8"))).toEqual(
    metadata
  );
  expect(fs.statSync(path.join(root, "layouts/stock/ui.html")).mtimeMs).toBe(before.mtimeMs);
  expect(fs.statSync(path.join(root, "layouts/stock/ui.html")).ino).toBe(before.ino);
  expect(() => writeMarketplaceReleaseMetadata(options())).toThrow();
  expect(JSON.parse(fs.readFileSync(path.join(root, ".marketplace-release.json"), "utf8"))).toEqual(
    metadata
  );
});
test.each(["modified", "extra", "missing", "empty directory"])(
  "refuses %s staging rather than inferring a new approval manifest",
  (kind) => {
    if (kind === "modified")
      fs.writeFileSync(path.join(root, "layouts/stock/ui.html"), "operator modified");
    if (kind === "extra") fs.writeFileSync(path.join(root, "custom.txt"), "user install");
    if (kind === "missing") fs.unlinkSync(path.join(root, "fxmanifest.lua"));
    if (kind === "empty directory") fs.mkdirSync(path.join(root, "unexpected"));
    expect(() => writeMarketplaceReleaseMetadata(options())).toThrow();
    expect(fs.existsSync(path.join(root, ".marketplace-release.json"))).toBe(false);
  }
);
test("requires safe explicit manifest, source revision and bounded staging bytes", () => {
  expect(() =>
    writeMarketplaceReleaseMetadata({ ...options(), sourceRevision: "dirty working tree" })
  ).toThrow();
  expect(() =>
    writeMarketplaceReleaseMetadata({ ...options(), expectedFiles: { "../outside": sha("x") } })
  ).toThrow();
  expect(() => writeMarketplaceReleaseMetadata({ ...options(), expectedFiles: {} })).toThrow();
  expect(() => writeMarketplaceReleaseMetadata({ ...options(), maxTotalBytes: 1 })).toThrow();
});
test("refuses hard-linked staged payload", () => {
  const extra = path.join(root, "link");
  fs.linkSync(path.join(root, "fxmanifest.lua"), extra);
  expect(() =>
    writeMarketplaceReleaseMetadata({
      ...options(),
      expectedFiles: { ...manifest(), link: sha("manifest") },
    })
  ).toThrow();
});
test("failed metadata write leaves approved staging unchanged", () => {
  const write = fs.writeFileSync;
  spyOn(fs, "writeFileSync").mockImplementation((p, data, opts) => {
    if (String(p).endsWith(".tmp")) throw new Error("disk full");
    return write(p, data, opts);
  });
  expect(() => writeMarketplaceReleaseMetadata(options())).toThrow();
  expect(fs.readdirSync(root).sort()).toEqual(["fxmanifest.lua", "layouts"]);
});
test("exclusive metadata publication never replaces a concurrent artifact", () => {
  const link = fs.linkSync;
  spyOn(fs, "linkSync").mockImplementation((from, to) => {
    fs.writeFileSync(to, "concurrent artifact", { flag: "wx" });
    link(from, to);
  });
  expect(() => writeMarketplaceReleaseMetadata(options())).toThrow();
  expect(fs.readFileSync(path.join(root, ".marketplace-release.json"), "utf8")).toBe(
    "concurrent artifact"
  );
  expect(fs.readdirSync(root).some((name) => name.endsWith(".tmp"))).toBe(false);
});
