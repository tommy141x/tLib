// Read-only classification of what is on disk. Writes nothing, probes nothing,
// and emits no absolute paths — a snapshot, never an authorization.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type Context,
  context,
  DESTINATIONS,
  hash,
  type InstallFailure,
  type InstallTarget,
  MAX_ENTRIES,
  type Receipt,
  safeName,
  stat,
} from "./core";
import { lockPath, type MarketplaceLockOwner } from "./lock";
import { protectedLegacyDestination, snapshotProtectedInventory } from "./protected";

export interface InstallationInspection {
  resourceName: string;
  type: string;
  slug: string;
  status:
    | "managed"
    | "modified"
    | "unverified"
    | "protected"
    | "missing"
    | "unsafe"
    | "unavailable";
  lock: "absent" | "identified" | "unidentified" | "recovery-pending" | "unavailable";
  policyAvailable: boolean;
}
export type InstallationInspectionOutcome =
  | { ok: true; inspection: InstallationInspection }
  | InstallFailure;

class InspectionIssue extends Error {
  constructor(readonly status: "unsafe" | "unavailable") {
    super(status);
  }
}
function inspectionUnsafe(): never {
  throw new InspectionIssue("unsafe");
}
function inspectionUnavailable(): never {
  throw new InspectionIssue("unavailable");
}
const sameFile = (a: fs.Stats, b: fs.Stats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs &&
  !b.isSymbolicLink();

// Never readFileSync a mutable payload: its size can grow after lstat. The extra
// byte detects growth without allocating/reading an unbounded file.
function inspectionRead(file: string, limit: number): Buffer {
  const before = stat(file);
  if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1) inspectionUnsafe();
  if (before.size > limit) inspectionUnavailable();
  const fd = fs.openSync(file, "r");
  try {
    const opened = fs.fstatSync(fd);
    if (!sameFile(before, opened) || !opened.isFile() || opened.nlink !== 1)
      inspectionUnavailable();
    const data = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < data.length) {
      const count = fs.readSync(fd, data, length, data.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = stat(file);
    if (length !== before.size || !after || !sameFile(before, after)) inspectionUnavailable();
    return data.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}

function inspectionNames(dir: string, limit: number): string[] {
  const before = stat(dir);
  if (!before?.isDirectory() || before.isSymbolicLink()) inspectionUnsafe();
  const handle = fs.opendirSync(dir);
  const names: string[] = [];
  try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      if (names.length >= limit) inspectionUnavailable();
      names.push(entry.name);
    }
  } finally {
    handle.closeSync();
  }
  const after = stat(dir);
  if (!after || !sameFile(before, after)) inspectionUnavailable();
  return names;
}

function inspectionLock(c: Context): InstallationInspection["lock"] {
  const dir = lockPath(c);
  if (!stat(dir)) return "absent";
  const names = inspectionNames(dir, 2);
  if (names.some((name) => name !== "owner.json" && name !== "recovery.json")) inspectionUnsafe();
  const pending = names.includes("recovery.json");
  if (pending) inspectionRead(path.join(dir, "recovery.json"), 8192);
  if (!names.includes("owner.json")) return pending ? "recovery-pending" : "unidentified";
  const bytes = inspectionRead(path.join(dir, "owner.json"), 8192);
  let owner: MarketplaceLockOwner;
  try {
    owner = JSON.parse(bytes.toString("utf8"));
  } catch {
    return pending ? "recovery-pending" : "unidentified";
  }
  const valid =
    owner &&
    owner.schema === 1 &&
    typeof owner.ownerId === "string" &&
    /^[a-f0-9-]{36}$/i.test(owner.ownerId) &&
    typeof owner.processInstance === "string" &&
    /^[a-f0-9-]{36}$/i.test(owner.processInstance) &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.hostname === "string" &&
    !!owner.hostname &&
    typeof owner.acquiredAt === "string" &&
    Number.isFinite(Date.parse(owner.acquiredAt)) &&
    owner.resourceName === c.resourceName &&
    owner.type === c.type &&
    owner.slug === c.name &&
    owner.base === c.base &&
    ["install", "uninstall", "adopt"].includes(owner.operation);
  return pending ? "recovery-pending" : valid ? "identified" : "unidentified";
}

/**
 * Read-only snapshot, never authorization. Writes nothing, probes nothing, and
 * emits no absolute paths. A held lock suppresses content classification because
 * a transaction may be in flight.
 */
export function inspectInstallation(
  target: InstallTarget,
  slug: string
): InstallationInspectionOutcome {
  if (
    !target ||
    typeof target.resourceName !== "string" ||
    !/^[a-z0-9_][a-z0-9_.-]{0,127}$/i.test(target.resourceName) ||
    target.resourceName.includes("..") ||
    typeof target.type !== "string" ||
    !/^[a-z0-9_][a-z0-9_-]{0,63}$/i.test(target.type) ||
    typeof slug !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)
  ) {
    return { ok: false, error: "invalid marketplace inspection target" };
  }
  const inspection: InstallationInspection = {
    resourceName: target.resourceName,
    type: target.type,
    slug,
    status: "unavailable",
    lock: "unavailable",
    policyAvailable: false,
  };
  try {
    if (!Number.isSafeInteger(target.maxBundleBytes) || target.maxBundleBytes <= 0)
      inspectionUnavailable();
    const budget = Math.min(target.maxBundleBytes, 100 * 1024 * 1024);
    const c = context(target, slug);
    if (target.protectedInventory) {
      snapshotProtectedInventory(target.protectedInventory, c.resourceName);
      inspection.policyAvailable = true;
    }
    inspection.lock = inspectionLock(c);
    if (inspection.lock !== "absent") return { ok: true, inspection };
    if (protectedLegacyDestination(target, c)) {
      inspection.status = "protected";
      return { ok: true, inspection };
    }
    if (!stat(c.base)) {
      inspection.status = "missing";
      return { ok: true, inspection };
    }
    // The module directory named after the slug, and the three flat audio names
    // a sound can take — one shared list with core.ts and legacy.ts, so an
    // inspector cannot disagree with the installer about what a target is.
    //
    // The `matches.length > 1` and lowercase checks below stay live: on a
    // case-sensitive filesystem two entries can still match one candidate.
    const candidates = DESTINATIONS(c);
    const baseBefore = stat(c.base)!;
    const names = inspectionNames(c.base, MAX_ENTRIES);
    const matches = names.filter((name) => candidates.includes(name.toLowerCase()));
    const receipts = names.filter(
      (name) => name.toLowerCase() === path.basename(c.receipt).toLowerCase()
    );
    if (
      matches.length > 1 ||
      matches.some((name) => name !== name.toLowerCase()) ||
      receipts.length > 1 ||
      receipts.some((name) => name !== path.basename(c.receipt))
    )
      inspectionUnsafe();
    let receipt: Receipt | undefined;
    let receiptBytes: Buffer | undefined;
    if (receipts.length) {
      receiptBytes = inspectionRead(c.receipt, 1024 * 1024);
      try {
        receipt = JSON.parse(receiptBytes.toString("utf8"));
      } catch {
        inspectionUnsafe();
      }
      if (
        !receipt ||
        receipt.version !== 1 ||
        receipt.resourceName !== c.resourceName ||
        receipt.type !== c.type ||
        receipt.slug !== c.name ||
        !candidates.includes(receipt.destination) ||
        !receipt.files ||
        typeof receipt.files !== "object" ||
        Array.isArray(receipt.files)
      )
        inspectionUnsafe();
      const entries = Object.entries(receipt.files);
      if (!entries.length || entries.length > MAX_ENTRIES) inspectionUnsafe();
      const seen = new Set<string>();
      for (const [name, digest] of entries) {
        const directory = name.endsWith("/");
        const relative = directory ? name.slice(0, -1) : name;
        if (
          (relative && !safeName(relative)) ||
          seen.has(relative.toLowerCase()) ||
          (directory
            ? digest !== "directory"
            : typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
        )
          inspectionUnsafe();
        seen.add(relative.toLowerCase());
      }
      if (matches.length && matches[0] !== receipt.destination) inspectionUnsafe();
    }
    if (!matches.length) {
      inspection.status = receipt ? "modified" : "missing";
      return { ok: true, inspection };
    }
    const actual: Record<string, string> = Object.create(null);
    let count = 0,
      bytes = 0;
    const walk = (file: string, rel: string): void => {
      if (++count > MAX_ENTRIES) inspectionUnavailable();
      const before = stat(file);
      if (!before || before.isSymbolicLink()) inspectionUnsafe();
      if (before.isDirectory()) {
        actual[`${rel}/`] = "directory";
        const names = inspectionNames(file, MAX_ENTRIES - count);
        const seen = new Set<string>();
        for (const name of names) {
          if (!safeName(name) || seen.has(name.toLowerCase())) inspectionUnsafe();
          seen.add(name.toLowerCase());
          walk(path.join(file, name), rel ? `${rel}/${name}` : name);
        }
      } else if (before.isFile() && before.nlink === 1) {
        if (before.size > budget - bytes) inspectionUnavailable();
        bytes += before.size;
        actual[rel] = receipt ? hash(inspectionRead(file, before.size)) : "unverified";
      } else inspectionUnsafe();
      const after = stat(file);
      if (!after || !sameFile(before, after)) inspectionUnavailable();
    };
    walk(path.join(c.base, matches[0]), "");
    inspection.lock = inspectionLock(c);
    const baseAfter = stat(c.base);
    if (inspection.lock !== "absent" || !baseAfter || !sameFile(baseBefore, baseAfter))
      inspectionUnavailable();
    if (receiptBytes && !inspectionRead(c.receipt, 1024 * 1024).equals(receiptBytes))
      inspectionUnavailable();
    inspection.status = !receipt
      ? "unverified"
      : Object.keys(actual).length === Object.keys(receipt.files).length &&
          Object.keys(actual).every((name) => actual[name] === receipt!.files[name])
        ? "managed"
        : "modified";
  } catch (err) {
    inspection.status =
      err instanceof InspectionIssue
        ? err.status
        : err && typeof err === "object" && "code" in err
          ? "unavailable"
          : "unsafe";
  }
  return { ok: true, inspection };
}
