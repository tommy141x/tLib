/**
 * Putting the mode bit back on a shipped binary, on the platform where that is
 * a concept.
 *
 * Not defensiveness, and not tLib being helpful: it is the most likely way a
 * correct release fails on Linux, and every route a customer takes to their
 * server drops the bit. A zip has no concept of one, NTFS cannot store one, and
 * SFTP clients transfer contents rather than permissions — so the release is
 * built with `install -m 0755` and arrives at 0644 anyway. What the operator
 * sees is `EACCES` from spawn, which reads like a problem with their machine
 * rather than a missing `+x` on one file.
 *
 * It lives in tLib rather than only in each product because of what the gate
 * does with `loaderDir`: when a bundled loader is present, **the thing exec'd is
 * the loader**, not the binary the product resolved and chmod'd. A product
 * cannot fix the mode of a file it never names — it names a *program*, and tLib
 * resolves every path — so the chmod has to happen where the exec does. The
 * inner binary does not need it: ld.so opens and maps its target, so read
 * permission is sufficient, which is the long-known way to run a file that has
 * no execute bit at all.
 *
 * The filesystem is injected for the same reason `gate.ts` injects `Probes`:
 * this development machine is Windows, where the whole function is a no-op and
 * a test of it would prove nothing about the platform that needs it.
 */

import { accessSync, chmodSync, constants } from "node:fs";

/** The three filesystem facts this needs, so both branches can be driven. */
export interface ModeBits {
  /** `win32` short-circuits everything below. */
  platform: string;
  /** Must throw when the file is not executable by this process. */
  canExecute(target: string): void;
  makeExecutable(target: string): void;
}

export const REAL_MODE_BITS: ModeBits = {
  platform: process.platform,
  canExecute: (target) => accessSync(target, constants.X_OK),
  // 0755 and not 0700: FXServer is routinely run under a different account from
  // the one that unpacked the release, and a binary only its owner may run is
  // the same EACCES one step further along.
  makeExecutable: (target) => chmodSync(target, 0o755),
};

/**
 * Best effort, and deliberately silent on failure.
 *
 * A `chmod` that cannot be done — a read-only mount, a file owned by another
 * user — is left to the spawn, which fails with the file name and the syscall in
 * it. Reporting it here would mean a refusal from tLib *instead of* the real
 * error, and the real error is the better message.
 */
export function ensureExecutable(target: string, fs: ModeBits = REAL_MODE_BITS): void {
  if (fs.platform === "win32") return;
  try {
    fs.canExecute(target);
    return;
  } catch {
    // Not executable, or not readable at all. Either way, try.
  }
  try {
    fs.makeExecutable(target);
  } catch {
    // Left to the spawn, which names the file and the syscall.
  }
}
