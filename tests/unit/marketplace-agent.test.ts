import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type ProtectedBuiltinInventory,
  snapshotProtectedInventory,
} from "../../shared/ts/marketplace/installer";

const source = readFileSync(
  new URL("../../shared/ts/marketplace/agent.ts", import.meta.url),
  "utf8"
)
  .replace(/^import\b[^;]*;\r?\n/gm, "")
  .replace(/^export /gm, "");
const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
function fixture(protectedInventory?: ProtectedBuiltinInventory) {
  const events: Record<string, (...args: any[]) => void> = {};
  const results: any[] = [],
    writes: any[] = [],
    inspections: any[] = [];
  let finish!: (data: any) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  let downloads = 0;
  const host = {
    GetCurrentResourceName: () => "consumer",
    GetResourcePath: () => "/resource",
    on: (name: string, fn: any) => {
      events[name] = fn;
    },
    emit: (_: string, data: any) => results.push(data),
  };
  const init = new Function(
    "globalThis",
    "downloadBundle",
    "installFromData",
    "uninstallItem",
    "snapshotProtectedInventory",
    "adoptLegacyInstallationFromData",
    "inspectInstallation",
    `${js}\nreturn createMarketplaceAgent;`
  )(
    host,
    () => {
      downloads++;
      return pending;
    },
    (...args: any[]) => {
      writes.push(args);
      return { ok: true, installedAt: "/resource/layouts/item" };
    },
    (...args: any[]) => {
      writes.push(args);
      return { ok: true };
    },
    snapshotProtectedInventory,
    (...args: any[]) => {
      writes.push(args);
      return { ok: true, payloadBytesWritten: 0 };
    },
    (target: any, slug: string) => {
      inspections.push([target, slug]);
      return {
        ok: true,
        inspection: {
          resourceName: target.resourceName,
          type: target.type,
          slug,
          status: "unverified",
          lock: "absent",
          policyAvailable: !!target.protectedInventory,
        },
      };
    }
  );
  const controller = init({ installTypes: { ui: "layouts", sound: "sounds" }, protectedInventory });
  const send = (action: string, changes: any = {}) =>
    events[`tlib:marketplace:do${action}:consumer`]({
      token: "one",
      slug: "item",
      type: "ui",
      url: "https://marketplace.test/download",
      ...changes,
    });
  return {
    events,
    results,
    writes,
    inspections,
    send,
    controller,
    downloads: () => downloads,
    async finish() {
      finish({ buf: Buffer.from("test"), hash: "a".repeat(64), size: 4 });
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}
test("agent delegates writes to shared installer with own resource target", async () => {
  const f = fixture();
  f.send("Install");
  await f.finish();
  expect(f.writes[0][0]).toEqual({
    resourceName: "consumer",
    resourceRoot: "/resource",
    type: "ui",
    installPath: "layouts",
    maxBundleBytes: 104857600,
  });
  expect(f.results[0]).toMatchObject({
    token: "one",
    ok: true,
    installedAt: "/resource/layouts/item",
  });
});
test("agent serializes install and uninstall for same target", async () => {
  const f = fixture();
  f.send("Install");
  f.send("Uninstall", { token: "two" });
  expect(f.results[0]).toMatchObject({ token: "two", ok: false });
  expect(f.writes).toHaveLength(0);
  await f.finish();
  f.send("Uninstall", { token: "three" });
  expect(f.results.at(-1)).toMatchObject({ token: "three", ok: true });
});
test("consumer stop during download prevents filesystem writes and callbacks", async () => {
  const f = fixture();
  f.send("Install");
  f.events.onResourceStop("consumer");
  await f.finish();
  expect(f.writes).toHaveLength(0);
  expect(f.results).toHaveLength(0);
});
test("rejects malformed arguments and inherited configuration names", () => {
  const f = fixture();
  for (const changes of [{ slug: 4 }, { slug: "../item" }, { type: "toString" }, { url: 7 }])
    f.send("Install", changes);
  expect(f.results).toHaveLength(4);
  expect(f.results.every((r) => r.ok === false)).toBe(true);
  expect(f.downloads()).toBe(0);
});
test("agent snapshots consumer-owned release policy and never accepts policy from event payload", async () => {
  const files = ["layouts/default/ui.html", "sounds/stock.wav"];
  const f = fixture({ schema: 1, resourceName: "consumer", releaseHash: "a".repeat(64), files });
  files.length = 0;
  f.send("Install", { protectedInventory: { files: [] } });
  await f.finish();
  expect(f.writes[0][0].protectedInventory.files).toEqual([
    "layouts/default/ui.html",
    "sounds/stock.wav",
  ]);
  expect(Object.isFrozen(f.writes[0][0].protectedInventory.files)).toBe(true);
  expect(Object.keys(f.events).some((name) => /adopt|migrate/i.test(name))).toBe(false);
});
test("registry preserves detached policy and rejects invalid scope without replacing registration", () => {
  const source = readFileSync(
    new URL("../../server/lib/marketplace/registry.ts", import.meta.url),
    "utf8"
  )
    .replace(/^import\b[^;]*;\r?\n/gm, "")
    .replace(/^export /gm, "");
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  const registry = new Function("snapshotProtectedInventory", `${js}\nreturn { register, get };`)(
    snapshotProtectedInventory
  );
  const files = ["layouts/default/ui.html"];
  registry.register({
    resourceName: "consumer",
    type: "ui",
    installPath: "layouts",
    protectedInventory: { schema: 1, resourceName: "consumer", releaseHash: "a".repeat(64), files },
  });
  files.length = 0;
  expect(registry.get("consumer", "ui").protectedInventory.files).toEqual([
    "layouts/default/ui.html",
  ]);
  expect(Object.isFrozen(registry.get("consumer", "ui"))).toBe(true);
  expect(() =>
    registry.register({
      resourceName: "consumer",
      type: "ui",
      installPath: "layouts",
      protectedInventory: {
        schema: 1,
        resourceName: "other",
        releaseHash: "a".repeat(64),
        files: ["layouts/stock/ui.html"],
      },
    })
  ).toThrow();
  expect(registry.get("consumer", "ui").protectedInventory.files).toEqual([
    "layouts/default/ui.html",
  ]);
  registry.register({ resourceName: "legacy", type: "ui", installPath: "layouts" });
  expect(registry.get("legacy", "ui").protectedInventory).toBeUndefined();
});
test("local-only adoption shares the download lock and delegates authorization unchanged", async () => {
  const f = fixture({
    schema: 1,
    resourceName: "consumer",
    releaseHash: "a".repeat(64),
    files: ["layouts/stock/ui.html"],
  });
  const authorization = {
    action: "adopt-verified-legacy",
    resourceName: "consumer",
    type: "ui",
    slug: "item",
    packageHash: "b".repeat(64),
    protectedReleaseHash: "a".repeat(64),
  };
  const adopt = () =>
    f.controller.adoptLegacyFromData(
      "ui",
      "item",
      Buffer.from("data"),
      "b".repeat(64),
      4,
      authorization
    );
  f.send("Install");
  expect(adopt().ok).toBe(false);
  expect(f.writes).toHaveLength(0);
  await f.finish();
  expect(adopt().ok).toBe(true);
  expect(f.writes.at(-1)[5]).toBe(authorization);
  expect(f.writes.at(-1)[0].resourceName).toBe("consumer");
  f.events.onResourceStop("consumer");
  expect(adopt().ok).toBe(false);
});
test("unconfigured consumers keep local adoption disabled", () => {
  const f = fixture();
  expect(
    f.controller.adoptLegacyFromData("ui", "item", Buffer.from("data"), "b".repeat(64), 4, {}).ok
  ).toBe(false);
  expect(f.writes).toHaveLength(0);
});
test("agent rejects policy scoped to another consumer", () => {
  expect(() =>
    fixture({
      schema: 1,
      resourceName: "other",
      releaseHash: "a".repeat(64),
      files: ["layouts/stock/ui.html"],
    })
  ).toThrow();
});
test("different type uses an independent target lock", async () => {
  const f = fixture();
  f.send("Install");
  f.send("Uninstall", { type: "sound" });
  expect(f.writes[0][0].installPath).toBe("sounds");
  await f.finish();
});
test("inspection correlates read-only results and ignores event-supplied authority", () => {
  const files = ["layouts/stock/ui.html"];
  const f = fixture({ schema: 1, resourceName: "consumer", releaseHash: "a".repeat(64), files });
  files.length = 0;
  f.send("Inspect", {
    token: "inspect-one",
    resourceName: "other",
    resourceRoot: "/other",
    installPath: "other",
    protectedInventory: { files: [] },
  });
  expect(f.results[0]).toEqual({
    token: "inspect-one",
    slug: "item",
    ok: true,
    inspection: {
      resourceName: "consumer",
      type: "ui",
      slug: "item",
      status: "unverified",
      lock: "absent",
      policyAvailable: true,
    },
  });
  expect(f.inspections[0][0]).toMatchObject({
    resourceName: "consumer",
    resourceRoot: "/resource",
    installPath: "layouts",
  });
  expect(f.inspections[0][0].protectedInventory.files).toEqual(["layouts/stock/ui.html"]);
  expect(f.writes).toHaveLength(0);
  expect(f.downloads()).toBe(0);
  expect(f.controller.inspect("sound", "item").ok).toBe(true);
  expect(f.inspections[1][0].installPath).toBe("sounds");
});
test("inspection validates target and token and stops with its consumer", () => {
  const f = fixture();
  for (const changes of [{ token: "" }, { token: 1 }, { token: "a".repeat(129) }])
    f.send("Inspect", changes);
  expect(f.results).toHaveLength(0);
  for (const changes of [{ type: "toString" }, { slug: "../item" }, { slug: 1 }])
    f.send("Inspect", changes);
  expect(f.results).toHaveLength(3);
  expect(f.results.every((r) => !r.ok)).toBe(true);
  expect(f.inspections).toHaveLength(0);
  f.events.onResourceStop("consumer");
  f.send("Inspect");
  expect(f.results).toHaveLength(3);
  expect(f.controller.inspect("ui", "item").ok).toBe(false);
  expect(f.writes).toHaveLength(0);
  expect(f.downloads()).toBe(0);
});
test("inspection does not classify content during a pending mutation", async () => {
  const f = fixture();
  f.send("Install");
  f.send("Inspect", { token: "read" });
  expect(f.results[0]).toMatchObject({
    token: "read",
    inspection: { status: "unavailable", lock: "unavailable" },
  });
  expect(f.inspections).toHaveLength(0);
  await f.finish();
  expect(f.controller.inspect("ui", "item").inspection.status).toBe("unverified");
});
