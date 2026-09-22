import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type InstallTarget,
  inspectMarketplaceLock,
  installFromData,
  type MarketplaceLockOwner,
  type MarketplaceLockRecoveryConfirmation,
  recoverMarketplaceLock,
  uninstallItem,
} from "../../shared/ts/marketplace/installer";

let root: string;
const wav = Buffer.from("RIFF1234WAVEcontent");
const target = (): InstallTarget => ({
  resourceName: "consumer",
  resourceRoot: root,
  type: "sound",
  installPath: "assets",
  maxBundleBytes: 1024,
});
const base = () => path.join(root, "assets");
const lock = () => path.join(base(), ".marketplace-lock-demo");
const install = () => installFromData(target(), "demo", wav, "", 0);
const inspect = () => inspectMarketplaceLock(target(), "demo");
function retained(overrides: Partial<MarketplaceLockOwner> = {}) {
  fs.mkdirSync(lock(), { recursive: true });
  const owner: MarketplaceLockOwner = {
    schema: 1,
    ownerId: randomUUID(),
    processInstance: randomUUID(),
    pid: 2147483000,
    hostname: os.hostname(),
    acquiredAt: "2000-01-01T00:00:00.000Z",
    resourceName: "consumer",
    type: "sound",
    slug: "demo",
    base: base(),
    operation: "install",
    ...overrides,
  };
  fs.writeFileSync(path.join(lock(), "owner.json"), JSON.stringify(owner));
  return owner;
}
function dead() {
  spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("no process"), { code: "ESRCH" });
  });
}
function confirmation(): MarketplaceLockRecoveryConfirmation {
  const state = inspect();
  if (!state.ok || !state.owner || !state.fingerprint) throw new Error("fixture missing identity");
  return {
    action: "quarantine-dead-owner-lock",
    ownerId: state.owner.ownerId,
    fingerprint: state.fingerprint,
    reviewedRetainedTransactions: true,
  };
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-lock-"));
});
afterEach(() => {
  mock.restore();
  fs.rmSync(root, { recursive: true, force: true });
});
test("inspection is read-only and absent locks are not created", () => {
  expect(inspect()).toMatchObject({ ok: true, state: "absent", owner: null });
  expect(fs.readdirSync(root)).toEqual([]);
});
test("normal operations record owner and operation while holding the lock, then clean it", () => {
  const write = fs.writeFileSync;
  let checked = false;
  spyOn(fs, "writeFileSync").mockImplementation((p, data, opts) => {
    if (path.basename(String(p)) === "payload") {
      const state = inspect();
      expect(state).toMatchObject({
        ok: true,
        state: "identified",
        ownerStatus: "live-local-process",
        owner: {
          pid: process.pid,
          hostname: os.hostname(),
          resourceName: "consumer",
          slug: "demo",
          operation: "install",
        },
      });
      checked = true;
    }
    return write(p, data, opts);
  });
  expect(install().ok).toBe(true);
  expect(checked).toBe(true);
  expect(inspect()).toMatchObject({ ok: true, state: "absent" });
  expect(uninstallItem(target(), "demo").ok).toBe(true);
});
test("existing locks block install/uninstall without modifying their record", () => {
  expect(install().ok).toBe(true);
  retained();
  const before = fs.readFileSync(path.join(lock(), "owner.json"));
  expect(install().ok).toBe(false);
  expect(uninstallItem(target(), "demo").ok).toBe(false);
  expect(fs.readFileSync(path.join(lock(), "owner.json"))).toEqual(before);
  expect(fs.readFileSync(path.join(base(), "demo.wav"))).toEqual(wav);
});
test("operator-confirmed dead local owner is quarantined without touching receipts or transactions", () => {
  expect(install().ok).toBe(true);
  const receipt = fs.readFileSync(path.join(base(), ".marketplace-demo.json"));
  retained();
  dead();
  fs.mkdirSync(path.join(base(), ".marketplace-transaction-retained"));
  fs.writeFileSync(
    path.join(base(), ".marketplace-transaction-retained/backup"),
    "recovery evidence"
  );
  const result = recoverMarketplaceLock(target(), "demo", confirmation());
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(fs.existsSync(path.join(result.quarantinedAt, "owner.json"))).toBe(true);
    expect(fs.existsSync(path.join(result.quarantinedAt, "recovery.json"))).toBe(true);
  }
  expect(fs.existsSync(lock())).toBe(false);
  expect(fs.readFileSync(path.join(base(), ".marketplace-demo.json"))).toEqual(receipt);
  expect(
    fs.readFileSync(path.join(base(), ".marketplace-transaction-retained/backup"), "utf8")
  ).toBe("recovery evidence");
  expect(install().ok).toBe(true);
});
test.each(["live", "permission denied", "foreign"])(
  "never recovers %s owner merely because lock is old",
  (kind) => {
    retained(kind === "foreign" ? { hostname: "other-host" } : {});
    if (kind === "live") spyOn(process, "kill").mockImplementation(() => true);
    else if (kind === "permission denied")
      spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      });
    else dead();
    expect(recoverMarketplaceLock(target(), "demo", confirmation()).ok).toBe(false);
    expect(fs.existsSync(lock())).toBe(true);
    expect(fs.existsSync(path.join(lock(), "recovery.json"))).toBe(false);
  }
);
test("real exited local process supplies positive idle evidence without age heuristics", async () => {
  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await child.exited).toBe(0);
  retained({ pid: child.pid, acquiredAt: new Date().toISOString() });
  expect(inspect()).toMatchObject({ ok: true, ownerStatus: "dead-local-process" });
  expect(recoverMarketplaceLock(target(), "demo", confirmation()).ok).toBe(true);
});
test("confirmation is bound to inspected identity and explicit transaction review", () => {
  retained();
  dead();
  const approved = confirmation();
  expect(
    recoverMarketplaceLock(target(), "demo", {
      ...approved,
      reviewedRetainedTransactions: false,
    } as unknown as MarketplaceLockRecoveryConfirmation).ok
  ).toBe(false);
  fs.writeFileSync(
    path.join(lock(), "owner.json"),
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(path.join(lock(), "owner.json"), "utf8")),
      ownerId: randomUUID(),
    })
  );
  expect(recoverMarketplaceLock(target(), "demo", approved).ok).toBe(false);
  expect(fs.existsSync(lock())).toBe(true);
});
test.each(["empty", "partial", "pending"])(
  "unidentified or interrupted %s lock fails closed",
  (kind) => {
    retained();
    dead();
    if (kind === "empty") fs.unlinkSync(path.join(lock(), "owner.json"));
    if (kind === "partial") fs.writeFileSync(path.join(lock(), "owner.json"), "{");
    if (kind === "pending")
      fs.writeFileSync(path.join(lock(), "recovery.json"), "interrupted claim");
    const state = inspect();
    expect(state.ok).toBe(true);
    if (state.ok)
      expect(state.state).toBe(kind === "pending" ? "recovery-pending" : "unidentified");
    expect(
      recoverMarketplaceLock(target(), "demo", {
        action: "quarantine-dead-owner-lock",
        ownerId: "none",
        fingerprint: "none",
        reviewedRetainedTransactions: true,
      }).ok
    ).toBe(false);
  }
);
test("liveness change during recovery preserves lock and cleans only its own claim", () => {
  retained();
  dead();
  const approved = confirmation();
  let calls = 0;
  spyOn(process, "kill").mockImplementation(() => {
    if (++calls === 1) throw Object.assign(new Error("dead"), { code: "ESRCH" });
    return true;
  });
  expect(recoverMarketplaceLock(target(), "demo", approved).ok).toBe(false);
  expect(fs.existsSync(lock())).toBe(true);
  expect(fs.readdirSync(lock())).toEqual(["owner.json"]);
});
test("concurrent recovery claim is never overwritten or removed", () => {
  retained();
  dead();
  const approved = confirmation();
  const open = fs.openSync;
  let injected = false;
  spyOn(fs, "openSync").mockImplementation((p, flags, mode) => {
    if (!injected && String(p) === path.join(lock(), "recovery.json") && flags === "wx") {
      injected = true;
      fs.writeFileSync(p, "other recovery", { flag: "wx" });
    }
    return open(p, flags, mode);
  });
  expect(recoverMarketplaceLock(target(), "demo", approved).ok).toBe(false);
  expect(fs.readFileSync(path.join(lock(), "recovery.json"), "utf8")).toBe("other recovery");
});
test("unsafe linked owner records and symlinked locks are never recovered", () => {
  retained();
  dead();
  fs.linkSync(path.join(lock(), "owner.json"), path.join(root, "owner-hardlink"));
  expect(inspect().ok).toBe(false);
  fs.unlinkSync(path.join(root, "owner-hardlink"));
  const approved = confirmation();
  fs.renameSync(lock(), path.join(root, "outside"));
  fs.symlinkSync(path.join(root, "outside"), lock(), "junction");
  expect(recoverMarketplaceLock(target(), "demo", approved).ok).toBe(false);
  expect(fs.readdirSync(path.join(root, "outside"))).toEqual(["owner.json"]);
});
test("quarantine rename failure leaves lock/owner in place and removes own claim", () => {
  retained();
  dead();
  const approved = confirmation();
  spyOn(fs, "renameSync").mockImplementation(() => {
    throw new Error("denied");
  });
  expect(recoverMarketplaceLock(target(), "demo", approved).ok).toBe(false);
  expect(fs.readdirSync(lock())).toEqual(["owner.json"]);
  expect(fs.readdirSync(base())).toEqual([".marketplace-lock-demo"]);
});
test("failed owner write cleans acquisition before payload writes", () => {
  const write = fs.writeFileSync;
  spyOn(fs, "writeFileSync").mockImplementation((p, data, opts) => {
    if (typeof p === "number") throw new Error("owner metadata disk full");
    return write(p, data, opts);
  });
  expect(install().ok).toBe(false);
  expect(fs.readdirSync(base())).toEqual([]);
});
test("release directory-removal failure retains owner evidence without changing committed result", () => {
  const rmdir = fs.rmdirSync;
  spyOn(fs, "rmdirSync").mockImplementation((p, opts) => {
    if (String(p) === lock()) throw new Error("injected release failure");
    return rmdir(p, opts);
  });
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  expect(install().ok).toBe(true);
  expect(warning).toHaveBeenCalled();
  expect(inspect()).toMatchObject({
    ok: true,
    state: "identified",
    ownerStatus: "live-local-process",
  });
  expect(install().ok).toBe(false);
});
