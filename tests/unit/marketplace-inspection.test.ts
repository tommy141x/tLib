import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type InstallTarget, inspectInstallation } from "../../shared/ts/marketplace/installer";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const hash = (data: string) => createHash("sha256").update(data).digest("hex");
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "tlib-inspect-"));
  roots.push(root);
  const base = join(root, "layouts");
  fs.mkdirSync(base);
  const target: InstallTarget = {
    resourceName: "consumer",
    resourceRoot: root,
    type: "ui",
    installPath: "layouts",
    maxBundleBytes: 1024,
  };
  const file = (name: string, data = "payload") => {
    fs.mkdirSync(join(base, name, ".."), { recursive: true });
    fs.writeFileSync(join(base, name), data);
  };
  const receipt = (changes: Record<string, unknown> = {}) =>
    file(
      ".marketplace-item.json",
      JSON.stringify({
        version: 1,
        resourceName: "consumer",
        type: "ui",
        slug: "item",
        destination: "item",
        files: { "/": "directory", "ui.html": hash("payload") },
        ...changes,
      })
    );
  const inspect = () => {
    const result = inspectInstallation(target, "item");
    if (!result.ok) throw Error(result.error);
    return result.inspection;
  };
  return { root, base, target, file, receipt, inspect };
}
function snapshot(root: string): unknown[] {
  return fs
    .readdirSync(root)
    .sort()
    .map((name) => {
      const path = join(root, name),
        s = fs.lstatSync(path);
      return [
        name,
        s.mtimeMs,
        s.isDirectory() ? snapshot(path) : fs.readFileSync(path).toString("hex"),
      ];
    });
}
test("managed, modified and unverified statuses preserve all content and receipts", () => {
  const f = fixture();
  f.file("item/ui.html");
  let before = snapshot(f.root);
  expect(f.inspect()).toMatchObject({
    status: "unverified",
    lock: "absent",
    policyAvailable: false,
  });
  expect(snapshot(f.root)).toEqual(before);
  f.receipt();
  before = snapshot(f.root);
  expect(f.inspect().status).toBe("managed");
  expect(snapshot(f.root)).toEqual(before);
  f.file("item/ui.html", "edited");
  before = snapshot(f.root);
  expect(f.inspect().status).toBe("modified");
  expect(snapshot(f.root)).toEqual(before);
  f.file("item/custom.txt", "custom");
  before = snapshot(f.root);
  expect(f.inspect().status).toBe("modified");
  expect(snapshot(f.root)).toEqual(before);
});
test("missing payload with a receipt is modified, not available for installation", () => {
  const f = fixture();
  expect(f.inspect().status).toBe("missing");
  f.receipt();
  expect(f.inspect().status).toBe("modified");
});
test("authoritative policy protects absent built-ins and both destination shapes", () => {
  const f = fixture();
  f.target.protectedInventory = {
    schema: 1,
    resourceName: "consumer",
    releaseHash: "a".repeat(64),
    files: ["layouts/item/ui.html"],
  };
  expect(f.inspect()).toMatchObject({ status: "protected", policyAvailable: true });
  fs.rmdirSync(f.base);
  expect(f.inspect().status).toBe("protected");
  // Any file INSIDE the module's directory protects the module.
  f.target.protectedInventory = {
    ...f.target.protectedInventory,
    files: ["layouts/item/item.wav"],
  };
  expect(f.inspect().status).toBe("protected");
  // And so does the FLAT audio name, because that is the shape a sound takes: a
  // plain `.wav` in `layouts/sounds/`. Both are probed regardless of item type —
  // a target is a target, and refusing more is the safe direction.
  f.target.protectedInventory = {
    ...f.target.protectedInventory,
    files: ["layouts/item.wav"],
  };
  expect(f.inspect().status).toBe("protected");
});
test("a FLAT installed sound with an exact receipt inventory is managed", () => {
  // The shape a sound actually takes on a resource: one audio file, no folder and
  // no manifest. The receipt names the file as its destination and hashes it as a
  // single empty-keyed entry, which is the flat-payload convention.
  const f = fixture();
  f.file("item.ogg");
  f.receipt({ destination: "item.ogg", files: { "": hash("payload") } });
  expect(f.inspect().status).toBe("managed");
});
test("ambiguous destinations and case aliases fail closed", () => {
  const f = fixture();
  f.file("item/ui.html");
  // Two claims on one slug: the module directory AND the flat audio name are both
  // candidate destinations, so a disk holding both is ambiguous and neither may
  // be reported as managed.
  f.file("item.wav");
  expect(f.inspect().status).toBe("unsafe");
  fs.rmSync(join(f.base, "item.wav"));
  // And two entries differing only by case, which is what a case-sensitive
  // filesystem makes possible.
  fs.renameSync(join(f.base, "item"), join(f.base, "Item"));
  expect(f.inspect().status).toBe("unsafe");
});
test("malformed, foreign, oversized and traversal receipt inventories fail closed", () => {
  const f = fixture();
  f.file("item/ui.html");
  f.file(".marketplace-item.json", "{");
  expect(f.inspect().status).toBe("unsafe");
  f.receipt({ resourceName: "other" });
  expect(f.inspect().status).toBe("unsafe");
  f.receipt({ files: [] });
  expect(f.inspect().status).toBe("unsafe");
  f.receipt({ files: { "../other": hash("payload") } });
  expect(f.inspect().status).toBe("unsafe");
  f.file(".marketplace-item.json", "x".repeat(1024 * 1024 + 1));
  expect(f.inspect().status).toBe("unavailable");
});
test("hardlinked payloads and symlinked ancestry are never manageable", () => {
  const f = fixture();
  f.file("item/ui.html");
  fs.linkSync(join(f.base, "item/ui.html"), join(f.root, "linked"));
  expect(f.inspect().status).toBe("unsafe");
  const other = fixture();
  fs.rmdirSync(other.base);
  fs.symlinkSync(f.base, other.base, "junction");
  expect(other.inspect().status).toBe("unsafe");
});
test("payload byte and entry limits return unavailable without reading unbounded data", () => {
  const f = fixture();
  f.file("item/ui.html", "x".repeat(1025));
  expect(f.inspect().status).toBe("unavailable");
  fs.rmSync(join(f.base, "item"), { recursive: true });
  for (let i = 0; i < 1025; i++) f.file(`other-${i}`, "");
  expect(f.inspect().status).toBe("unavailable");
});
test("lock states are sanitized and suppress classification without process probing", () => {
  const f = fixture();
  f.file("item/ui.html");
  f.receipt();
  const lock = join(f.base, ".marketplace-lock-item");
  fs.mkdirSync(lock);
  expect(f.inspect()).toMatchObject({ status: "unavailable", lock: "unidentified" });
  fs.writeFileSync(
    join(lock, "owner.json"),
    JSON.stringify({
      schema: 1,
      ownerId: "a".repeat(36),
      processInstance: "b".repeat(36),
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      resourceName: "consumer",
      type: "ui",
      slug: "item",
      base: resolve(f.base),
      operation: "install",
    })
  );
  expect(f.inspect()).toMatchObject({ status: "unavailable", lock: "identified" });
  fs.writeFileSync(join(lock, "recovery.json"), "{}");
  const before = snapshot(f.root),
    result = f.inspect();
  expect(result.lock).toBe("recovery-pending");
  expect(snapshot(f.root)).toEqual(before);
  expect(Object.keys(result).sort()).toEqual(
    ["resourceName", "type", "slug", "status", "lock", "policyAvailable"].sort()
  );
  expect(JSON.stringify(result)).not.toContain(f.root);
});
test("payload growth during an open read is bounded and returns unavailable", () => {
  const f = fixture();
  f.file("item/ui.html");
  f.receipt();
  const read = fs.readSync;
  let changed = false,
    payloadRead = 0;
  const mocked = spyOn(fs, "readSync").mockImplementation(((...args: any[]) => {
    const count = (read as any)(...args);
    if (args[1].length === 8) {
      payloadRead += count;
      if (!changed) {
        changed = true;
        fs.appendFileSync(join(f.base, "item/ui.html"), "x".repeat(4096));
      }
    }
    return count;
  }) as typeof fs.readSync);
  try {
    expect(f.inspect().status).toBe("unavailable");
    expect(changed).toBe(true);
    expect(payloadRead).toBeLessThanOrEqual(8);
  } finally {
    mocked.mockRestore();
  }
});
test("receipt mutation during payload hashing cannot return managed", () => {
  const f = fixture();
  f.file("item/ui.html");
  f.receipt();
  const read = fs.readSync;
  let changed = false;
  const mocked = spyOn(fs, "readSync").mockImplementation(((...args: any[]) => {
    const count = (read as any)(...args);
    if (!changed && args[1].length === 8) {
      changed = true;
      f.receipt({ resourceName: "other" });
    }
    return count;
  }) as typeof fs.readSync);
  try {
    expect(f.inspect().status).toBe("unavailable");
    expect(changed).toBe(true);
  } finally {
    mocked.mockRestore();
  }
});
test("invalid targets cannot leak filesystem paths", () => {
  const f = fixture();
  expect(inspectInstallation(f.target, "../item")).toEqual({
    ok: false,
    error: "invalid marketplace inspection target",
  });
  f.target.installPath = "../outside";
  const result = f.inspect();
  expect(result.status).toBe("unsafe");
  expect(JSON.stringify(result)).not.toContain(f.root);
});
