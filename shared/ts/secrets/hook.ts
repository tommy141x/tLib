/**
 * The one `pre-commit` hook body, and the writer that puts a copy in every
 * resource. Tracked `.githooks/` + `core.hooksPath`, not `.git/hooks`, which
 * is untracked and gone on the next clone — but `core.hooksPath` is still
 * per-clone config, so this layer is a convenience, not the guarantee; the CI
 * assertion on HEAD is what can't be skipped.
 *
 * Refuses rather than strips: silently rewriting the staged blob would leave
 * `git show HEAD:config.lua` disagreeing with the working tree, and the next
 * checkout/pull touching that file overwrites the live value with the
 * committed blank, with no copy anywhere. The value belongs in the gitignored
 * sidecar (`tlib.secrets`) instead, so there's nothing to strip — only a
 * credential typed into the tracked file anyway to refuse, loudly.
 *
 * Written as the same bytes into every repo; `secret-gate-control.ts` asserts
 * that, since eleven hand-edited copies is eleven chances for a stale, silent
 * one.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * POSIX `sh`, no bashisms or PowerShell: these repos run inside Fedora
 * containers as well as on Windows, and Git for Windows runs hooks under its
 * own `sh` anyway.
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
