/**
 * Putting the mode bit back on a shipped binary, on the platform where that is
 * a concept.
 *
 * This is the most likely way a correct release fails on Linux: a zip has no
 * concept of the bit, NTFS can't store one, SFTP transfers contents not
 * permissions — so a release built with `install -m 0755` arrives at 0644, and
 * the operator sees `EACCES` from spawn, which reads like their machine's fault.
 *
 * Lives in tLib, not per-product, because of `loaderDir`: when a bundled loader
 * is present it's the thing exec'd, not the binary the product resolved and
 * chmod'd — a product can't fix the mode of a file it never names. The inner
 * binary itself doesn't need +x: ld.so only opens and maps it, so read
 * permission is enough.
 *
 * Filesystem is injected like `gate.ts`'s `Probes`: this dev machine is
 * Windows, where the function is a no-op and testing it directly proves
 * nothing.
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
  // 0755, not 0700: FXServer often runs under a different account than the
  // one that unpacked the release.
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
