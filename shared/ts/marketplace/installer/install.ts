// Install and uninstall: stage the whole payload beside the destination, then
// commit it and its receipt with renames under the target lock.
import * as fs from "node:fs";
import * as path from "node:path";
import { prepareBundle } from "./bundle";
import {
  context,
  failure,
  type InstallOutcome,
  type InstallTarget,
  inventory,
  owned,
  type Receipt,
  type UninstallOutcome,
} from "./core";
import { lockTarget } from "./lock";
import { cleanup, swap } from "./transaction";

export function uninstallItem(target: InstallTarget, slug: string): UninstallOutcome {
  let unlock: (() => void) | undefined;
  try {
    const c = context(target, slug);
    if (!owned(c)) throw new Error(`"${slug}" is not installed`);
    unlock = lockTarget(c, "uninstall");
    const old = owned(c);
    if (!old) throw new Error("install ownership changed before uninstall");
    const transaction = fs.mkdtempSync(path.join(c.base, ".marketplace-transaction-"));
    swap(c, old, transaction);
    return { ok: true };
  } catch (err) {
    return failure(err);
  } finally {
    unlock?.();
  }
}

// Empty hash and zero expectedSize explicitly opt out of those metadata checks.
export function installFromData(
  target: InstallTarget,
  slug: string,
  zipBytes: Buffer,
  expectedHash: string,
  expectedSize: number
): InstallOutcome {
  const { resourceName, type } = target;
  let stage: string | undefined;
  let unlock: (() => void) | undefined;
  try {
    const c = context(target, slug);
    const prepared = prepareBundle(target, c, zipBytes, expectedHash, expectedSize);
    const { destination, bytesWritten } = prepared;
    const fileCount = prepared.files.size;
    owned(c); // Preserve unreceipted-target refusal before creating a lock.
    fs.mkdirSync(c.base, { recursive: true });
    unlock = lockTarget(c, "install");
    const old = owned(c);
    stage = fs.mkdtempSync(path.join(c.base, ".marketplace-transaction-"));
    const payload = path.join(stage, "payload");
    if (prepared.zip) fs.mkdirSync(payload);
    for (const [name, data] of prepared.files) {
      const dest = name ? path.join(payload, name) : payload;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data, { flag: "wx" });
    }
    const receipt: Receipt = {
      version: 1,
      resourceName,
      type,
      slug: c.name,
      destination,
      files: inventory(payload),
    };
    fs.writeFileSync(path.join(stage, "receipt"), JSON.stringify(receipt), { flag: "wx" });
    // Recheck ownership immediately before touching the old install.
    const current = owned(c);
    if (JSON.stringify(current) !== JSON.stringify(old))
      throw new Error("install ownership changed while staging");
    const transaction = stage;
    stage = undefined; // swap owns cleanup; preserve backups if rollback fails.
    swap(c, old, transaction, destination);
    return { ok: true, installedAt: path.join(c.base, destination), fileCount, bytesWritten };
  } catch (err) {
    if (stage) cleanup(stage);
    return failure(err);
  } finally {
    unlock?.();
  }
}
