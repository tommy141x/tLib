// Target exclusion. mkdir is the primitive; an EEXIST never inspects or deletes
// the competitor, and only a positively dead local owner can be recovered.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { hostname } from "node:os";
import * as path from "node:path";
import {
  type Context,
  checkAncestors,
  context,
  failure,
  hash,
  type InstallFailure,
  type InstallTarget,
  stat,
} from "./core";

const activeTargets = new Set<string>();
const processInstance = randomUUID();
export interface MarketplaceLockOwner {
  schema: 1;
  ownerId: string;
  processInstance: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  resourceName: string;
  type: string;
  slug: string;
  base: string;
  operation: "install" | "uninstall" | "adopt";
}
export interface MarketplaceLockInspection {
  ok: true;
  lockPath: string;
  state: "absent" | "identified" | "unidentified" | "recovery-pending";
  owner: MarketplaceLockOwner | null;
  /** Bind confirmation to this exact directory identity and owner.json bytes. */
  fingerprint: string | null;
  ownerStatus: "dead-local-process" | "live-local-process" | "foreign-host" | "unknown";
}
export interface MarketplaceLockRecoveryConfirmation {
  action: "quarantine-dead-owner-lock";
  fingerprint: string;
  ownerId: string;
  /** Operator has inspected receipts/transactions; releasing a lock does not repair them. */
  reviewedRetainedTransactions: true;
}
export const lockPath = (c: Context) => path.join(c.base, `.marketplace-lock-${c.name}`);

function ownerStatus(owner: MarketplaceLockOwner): MarketplaceLockInspection["ownerStatus"] {
  if (owner.hostname !== hostname()) return "foreign-host";
  try {
    process.kill(owner.pid, 0);
    return "live-local-process";
  } catch (err) {
    // EPERM and all unsupported/sandboxed probes are UNKNOWN, never proof of idle.
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? "dead-local-process" : "unknown";
  }
}

function inspectLock(c: Context): MarketplaceLockInspection {
  const key = lockPath(c);
  const dir = stat(key);
  const result: MarketplaceLockInspection = {
    ok: true,
    lockPath: key,
    state: "absent",
    owner: null,
    fingerprint: null,
    ownerStatus: "unknown",
  };
  if (!dir) return result;
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("unsafe marketplace lock");
  const names = fs.readdirSync(key);
  if (names.some((name) => name !== "owner.json" && name !== "recovery.json"))
    throw new Error("unexpected marketplace lock content; manual review required");
  result.state = names.includes("recovery.json") ? "recovery-pending" : "unidentified";
  const p = path.join(key, "owner.json");
  const s = stat(p);
  if (!s) return result; // Includes interrupted mkdir -> owner-file initialization.
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 8192)
    throw new Error("unsafe marketplace lock owner record");
  const data = fs.readFileSync(p);
  let owner: MarketplaceLockOwner;
  try {
    owner = JSON.parse(data.toString("utf8"));
  } catch {
    return result;
  } // Partial initialization cannot establish a dead owner.
  if (
    !owner ||
    owner.schema !== 1 ||
    !/^[a-f0-9-]{36}$/i.test(owner.ownerId) ||
    !/^[a-f0-9-]{36}$/i.test(owner.processInstance) ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.hostname !== "string" ||
    !owner.hostname ||
    typeof owner.acquiredAt !== "string" ||
    !Number.isFinite(Date.parse(owner.acquiredAt)) ||
    owner.resourceName !== c.resourceName ||
    typeof owner.type !== "string" ||
    !owner.type ||
    owner.slug !== c.name ||
    owner.base !== c.base ||
    !["install", "uninstall", "adopt"].includes(owner.operation)
  )
    return result;
  const after = fs.lstatSync(key);
  const fileAfter = fs.lstatSync(p);
  if (
    after.isSymbolicLink() ||
    after.dev !== dir.dev ||
    after.ino !== dir.ino ||
    fileAfter.isSymbolicLink() ||
    fileAfter.dev !== s.dev ||
    fileAfter.ino !== s.ino ||
    fileAfter.size !== s.size ||
    fileAfter.mtimeMs !== s.mtimeMs ||
    fileAfter.ctimeMs !== s.ctimeMs
  )
    throw new Error("lock changed during inspection");
  result.owner = Object.freeze(owner);
  result.fingerprint = hash(Buffer.from(`${dir.dev}:${dir.ino}:${hash(data)}`));
  result.ownerStatus = ownerStatus(owner);
  if (result.state !== "recovery-pending") result.state = "identified";
  return result;
}

/** Read-only diagnostic. Lock age is audit data, NEVER a recovery decision. */
export function inspectMarketplaceLock(
  target: InstallTarget,
  slug: string
): MarketplaceLockInspection | InstallFailure {
  try {
    return inspectLock(context(target, slug));
  } catch (err) {
    return failure(err);
  }
}

/**
 * Maintenance API, not a resource event. Only a positively dead PID on this host
 * qualifies (signal 0 -> ESRCH); live or reused PIDs, foreign hosts, unknown
 * probes, partial owner records and interrupted recoveries all fail closed. A
 * resource stopping does not prove its owner idle.
 *
 * Quarantines the entire old lock and touches no receipt, payload or
 * transaction: this releases exclusion, it does not recover from a crash.
 */
export function recoverMarketplaceLock(
  target: InstallTarget,
  slug: string,
  confirmation: MarketplaceLockRecoveryConfirmation
): { ok: true; quarantinedAt: string } | InstallFailure {
  let marker: string | undefined;
  let markerIdentity: fs.Stats | undefined;
  let quarantine: string | undefined;
  try {
    const c = context(target, slug);
    const before = inspectLock(c);
    if (
      !confirmation ||
      confirmation.action !== "quarantine-dead-owner-lock" ||
      confirmation.reviewedRetainedTransactions !== true ||
      before.state !== "identified" ||
      !before.owner ||
      confirmation.ownerId !== before.owner.ownerId ||
      confirmation.fingerprint !== before.fingerprint
    )
      throw new Error("explicit confirmation of the inspected identified lock required");
    if (
      activeTargets.has(before.lockPath.toLowerCase()) ||
      before.ownerStatus !== "dead-local-process"
    )
      throw new Error("lock owner is not verified dead and idle");
    const markerPath = path.join(before.lockPath, "recovery.json");
    const fd = fs.openSync(markerPath, "wx", 0o600); // Concurrent recoverers cannot share a claim.
    marker = markerPath;
    markerIdentity = fs.fstatSync(fd);
    try {
      fs.writeFileSync(
        fd,
        JSON.stringify({
          recoveryId: randomUUID(),
          pid: process.pid,
          hostname: hostname(),
          fingerprint: before.fingerprint,
        })
      );
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const current = inspectLock(c);
    if (
      current.state !== "recovery-pending" ||
      current.fingerprint !== before.fingerprint ||
      current.ownerStatus !== "dead-local-process"
    )
      throw new Error("lock identity or owner liveness changed during recovery");
    quarantine = fs.mkdtempSync(path.join(c.base, ".marketplace-lock-quarantine-"));
    const destination = path.join(quarantine, "retained-lock");
    checkAncestors(c.base);
    const final = inspectLock(c);
    if (final.fingerprint !== before.fingerprint || final.ownerStatus !== "dead-local-process")
      throw new Error("lock changed before quarantine");
    fs.renameSync(before.lockPath, destination);
    marker = undefined; // Audit marker and owner metadata stay in quarantine.
    quarantine = undefined;
    return { ok: true, quarantinedAt: destination };
  } catch (err) {
    return failure(err);
  } finally {
    if (marker && markerIdentity) {
      try {
        const current = stat(marker);
        if (
          current &&
          !current.isSymbolicLink() &&
          current.dev === markerIdentity.dev &&
          current.ino === markerIdentity.ino
        )
          fs.unlinkSync(marker);
      } catch (err) {
        console.warn(`[tLib/marketplace] retained recovery claim ${marker}: ${String(err)}`);
      }
    }
    if (quarantine) {
      try {
        fs.rmdirSync(quarantine);
      } catch {
        /* Never recursively delete recovery evidence. */
      }
    }
  }
}

// Shared by install/uninstall/adopt across every alias of type that resolves to
// the same base and slug. mkdir is the exclusion primitive and EEXIST never
// inspects or deletes the competitor. A failed acquisition removes only this
// attempt's own owner file and empty directory; release validates identity and
// exact owner bytes, and a cleanup failure is warned and retained rather than
// turning a committed payload operation into a reported failure.
export function lockTarget(c: Context, operation: MarketplaceLockOwner["operation"]): () => void {
  const key = lockPath(c);
  if (activeTargets.has(key.toLowerCase()))
    throw new Error("marketplace operation already in progress");
  checkAncestors(c.base);
  try {
    fs.mkdirSync(key);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`marketplace operation already in progress or retained lock; inspect ${key}`);
    throw err;
  }
  const identity = fs.lstatSync(key);
  const owner: MarketplaceLockOwner = {
    schema: 1,
    ownerId: randomUUID(),
    processInstance,
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
    resourceName: c.resourceName,
    type: c.type,
    slug: c.name,
    base: c.base,
    operation,
  };
  const data = Buffer.from(JSON.stringify(owner));
  const ownerFile = path.join(key, "owner.json");
  let ownerIdentity: fs.Stats | undefined;
  try {
    const fd = fs.openSync(ownerFile, "wx", 0o600);
    ownerIdentity = fs.fstatSync(fd);
    try {
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    try {
      const record = stat(ownerFile);
      if (
        record &&
        ownerIdentity &&
        !record.isSymbolicLink() &&
        record.dev === ownerIdentity.dev &&
        record.ino === ownerIdentity.ino
      )
        fs.unlinkSync(ownerFile);
      fs.rmdirSync(key);
    } catch (cleanupError) {
      console.warn(
        `[tLib/marketplace] retained failed lock acquisition ${key}: ${String(cleanupError)}`
      );
    }
    throw err;
  }
  activeTargets.add(key.toLowerCase());
  return () => {
    activeTargets.delete(key.toLowerCase());
    try {
      const current = fs.lstatSync(key);
      const record = fs.lstatSync(ownerFile);
      if (
        current.isSymbolicLink() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        !record.isFile() ||
        record.isSymbolicLink() ||
        record.nlink !== 1 ||
        record.size !== data.length ||
        record.dev !== ownerIdentity!.dev ||
        record.ino !== ownerIdentity!.ino ||
        fs.readdirSync(key).join() !== "owner.json" ||
        !fs.readFileSync(ownerFile).equals(data)
      )
        throw new Error("lock identity/content changed");
      fs.unlinkSync(ownerFile);
      try {
        fs.rmdirSync(key);
      } catch (err) {
        // Preserve recoverable ownership evidence if directory removal fails.
        try {
          fs.writeFileSync(ownerFile, data, { flag: "wx", mode: 0o600 });
        } catch {
          /* No overwrite of another owner. */
        }
        throw err;
      }
    } catch (err) {
      console.warn(`[tLib/marketplace] retained lock ${key}: ${String(err)}`);
    }
  };
}
