// Staged swap with rollback. Backup and stage live on the destination filesystem
// so the commit is a rename, and a failed rollback retains its recovery dir.
import * as fs from "node:fs";
import * as path from "node:path";
import { type Context, checkAncestors, type Receipt } from "./core";

export function cleanup(p: string): void {
  // Cleanup failure must not convert a committed install into a reported failure.
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[tLib/marketplace] retained transaction ${p}: ${String(err)}`);
  }
}

// Backup and stage are on the destination filesystem. On a rename failure restore
// both old payload and receipt. If rollback itself fails, retain the recovery dir.
export function swap(c: Context, old: Receipt | null, transaction: string, next?: string): void {
  const moves: [string, string][] = [];
  const move = (from: string, to: string) => {
    fs.renameSync(from, to);
    moves.push([from, to]);
  };
  try {
    checkAncestors(c.base);
    if (old) {
      move(path.join(c.base, old.destination), path.join(transaction, "backup"));
      move(c.receipt, path.join(transaction, "backup-receipt"));
    }
    if (next) {
      move(path.join(transaction, "payload"), path.join(c.base, next));
      move(path.join(transaction, "receipt"), c.receipt);
    }
  } catch (err) {
    try {
      for (const [from, to] of moves.reverse()) fs.renameSync(to, from);
    } catch (rollback) {
      throw new Error(
        `${String(err)}; rollback failed: ${String(rollback)}; recovery retained at ${transaction}`
      );
    }
    cleanup(transaction);
    throw err;
  }
  cleanup(transaction);
}
