/**
 * The one `pre-commit` hook body, and the writer that puts a copy in every
 * resource.
 *
 * Why a tracked `.githooks/` and not `.git/hooks`
 *
 * `.git/hooks` is not tracked and cannot ship: a hook put there exists on
 * exactly one clone and is gone the next time the repo is cloned. The standard
 * fix is a tracked directory plus `core.hooksPath`, which is what this is.
 *
 * `core.hooksPath` is still PER-CLONE config. A developer who never runs
 * `bun run setup` has no hook, and nothing on their machine says so. That is
 * why this layer is explicitly the convenience and not the guarantee — the CI
 * assertion on HEAD is the layer that cannot be skipped, and `secrets:check`
 * in `verify` plus `--check-hooks` are how a missing hook becomes visible.
 *
 * Why it REFUSES instead of stripping
 *
 * A hook that silently rewrote the staged blob would leave the developer's
 * `git show HEAD:config.lua` disagreeing with their own working tree, and the
 * next `checkout` or `pull` touching that file would overwrite the live value
 * with the committed blank. There is no copy anywhere when that happens.
 *
 * So the value does not belong in the tracked file at all; it belongs in the
 * gitignored sidecar (`tlib.secrets`). With the sidecar in place there is
 * nothing to strip, and the only thing left for a hook to do is say so when
 * somebody types a credential into the tracked file anyway. A refusal with the
 * key name and the fix in it does that; a silent strip hides it.
 *
 * Written as the SAME BYTES into every repo, and `secret-gate-control.ts`
 * asserts that. Eleven hand-edited copies of a shell script is eleven chances
 * for one of them to be the stale one, and the stale one is silent.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * POSIX `sh`. No bashisms, no PowerShell, no per-platform binary: these repos
 * build and run inside Fedora containers as well as on this Windows machine,
 * and Git for Windows runs hooks under its own `sh` anyway.
 */
export const PRE_COMMIT = `#!/bin/sh
# Managed by tLib — shared/ts/secrets/hook.ts writes this file.
# ⛔ Do not edit here. Run \`bun run ../tLib/scripts/secret-gate.ts --write-hooks\`
#    (or \`bun run secrets:install-hooks\`) to refresh it; a control asserts every
#    resource's copy is byte-identical to tLib's.
#
# Layer 1 of 3. Refuses a commit that stages a credential-shaped key with a
# value in a config file. Layer 2 blanks the staged copy of a release; layer 3
# is the CI assertion on HEAD, which is the one that cannot be skipped.
#
# Bypass with \`git commit --no-verify\` if you must — CI will still catch it,
# which is the point of there being three layers rather than one.
set -e

gate=""
if [ -f "scripts/secret-gate.ts" ]; then
  gate="scripts/secret-gate.ts"          # we are tLib
elif [ -f "../tLib/scripts/secret-gate.ts" ]; then
  gate="../tLib/scripts/secret-gate.ts"  # the sibling layout every clone uses
fi

if [ -z "$gate" ]; then
  # Loud, and non-blocking. A missing sibling tLib is a checkout problem, not a
  # secret; blocking every commit on it would get the hook uninstalled, and then
  # there is no layer 1 at all. CI remains the guarantee.
  echo "⚠ secret gate SKIPPED: no ../tLib/scripts/secret-gate.ts found." >&2
  echo "  Clone tLib beside this repo to get the pre-commit check back." >&2
  echo "  CI still asserts HEAD, so this is a convenience you are missing, not a hole." >&2
  exit 0
fi

exec bun run "$gate" --staged
`;

/** Every repo that gets a copy. Resolved relative to the `[tScripts]` root. */
export function hookPathFor(repoRoot: string): string {
  return path.join(repoRoot, ".githooks", "pre-commit");
}

/** Write (or refresh) the hook in one repo. Returns true when bytes changed. */
export function writeHook(repoRoot: string): boolean {
  const target = hookPathFor(repoRoot);
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  if (existing === PRE_COMMIT) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // LF, explicitly. A CRLF shebang line makes `sh` report
  // "/bin/sh^M: bad interpreter" — which on Windows is exactly the hook that
  // looks installed and does nothing.
  fs.writeFileSync(target, PRE_COMMIT, { encoding: "utf8" });
  try {
    fs.chmodSync(target, 0o755);
  } catch {
    // Windows has no execute bit; git's own index bit is what matters and
    // `update-index --chmod=+x` is the caller's job.
  }
  return true;
}

/** Is this repo's tracked hook the current bytes? */
export function hookIsCurrent(repoRoot: string): boolean {
  const target = hookPathFor(repoRoot);
  return fs.existsSync(target) && fs.readFileSync(target, "utf8") === PRE_COMMIT;
}
