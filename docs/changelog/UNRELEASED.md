<!--
DRAFT, not a changelog entry. It is .md, not .mdx, so scripts/check-docs.mjs does not scan it.
Move the bullets into the tWeb changelog entry for the next tLib release and delete this file.
No version heading is cut here on purpose: the next release must be at least 1.1.1, because 1.1
already names four different builds, and a resource that uses anything under "Added" needs
`tlib_min_version` raised to it.
-->

## Fixed

- A resource that needs a newer tLib than you have now stops and says so in one boxed message: the
  version it needs, the version and build you have, and the release page, with a reminder to take
  `tLib.zip` and not "Source code". It used to abort one file and leave the resource running
  without tLib.
- `tlib_version` in the server console prints one line to paste into a ticket: tLib's version,
  build, commit and folder, which door the panels use, and a row per resource that needs tLib with
  whether its minimum is met. No IP address is in it.
- tLib checks its own built files at startup and names any that are missing or cut short, so a
  source download or a file damaged by a panel's upload tool is reported by tLib itself.
- Every release now has a version of its own, `1.1`, then `1.1.1`. A release records its commit
  beside its build, and both appear in tLib's banner and in every `_diag` line.
- The marketplace panel opened with nothing in it on the first open of a session, until a tab was
  clicked. It now loads straight away, scoped to the resource that opened it.
- A marketplace list that does not load now says why instead of `Failed to load marketplace` over
  a raw status. A "not found" from the website, an unreachable host, a timeout, a refusal and a
  missing tLib server bundle each get their own explanation and what to check, and an empty
  catalogue reads as "No sounds are published for tDetector yet", not as an error. A tLib server
  bundle that did not start is named at the `No such export mpRegisterType` line, with where to
  look.
- A saved setting stored by an older build no longer stops a resource loading when tLib reads it as
  the wrong type: `tlib.kvp.getFloat` and `getInt` fall back to the default and print one line
  naming the key.
- A server whose game timer wrapped no longer refuses a player's requests until the clock catches
  up. `tlib.ratelimit` restarts the interval instead.
- A `tlib_http_public_url` copied from the docs (`your-server-address`, `example.com`, the
  `203.0.113.x` documentation addresses) is no longer used as the panel's address. tLib quotes
  the value, says it is not usable, and detects your public IP instead.
- The startup banner no longer suggests `set tlib_http_port 7777` on a server that never opened
  that port.
- With `tlib_http_ingress false` and a listener set, tLib says the panels are served only on that
  port and which lines to delete.
- The note that a resource's panel is using long polling on the game port is an info line that says
  what it costs and what to set, no longer a warning.
- Dialogs no longer log authoring warnings (several primary buttons, buttons without a description)
  in the player's NUI. They are logged at DEBUG for the person writing the dialog.
- `tlib.healthcheck` no longer calls a failure `refused` when it took two seconds or more to
  arrive. That is the engine's own connect timeout, which is what a dropped packet looks like, and
  it is reported as `silent`.

## Added

- `tlib.nui.register`: an NUI callback that is always answered, with a structured error on a throw
  and a bound on handler time. Every NUI callback tLib owns now goes through it, so a handler that
  fails no longer leaves the page waiting for `callback "X" did not answer within 10000ms`.
- `@tlib/shared/retry`: `createRetryLoop`, a single-flight backoff with a fast stretch, jitter, a
  cap, `maxAttempts` / `maxElapsedMs`, `onGiveUp` and `resume()`.
- `tlib.ratelimit.tokens`: a per-player token bucket with a cost per call and one refusal line per
  window. tLib's own menu request limit and the feedback form's per-player minute now use it.
- `tlib.item.onUse`: one usable-item registration for ox_inventory, qbx_core, qb-core and
  es_extended.
- `GetHttpStatus` reports `reachedFromOutside` and `reachedAt` once a request from another machine
  has reached a door, and `publicUrlOverride` (`unset`, `used`, `rejected`). The local event
  `tlib:http:remote` fires once, with no address.
- `tlib.healthcheck` steps carry `class` (`ok`, `refused`, `silent`, `wrong-service`),
  `elapsedMs` and `errorData`, and accept `errorMsgs` to choose wording by class. A connection the
  engine reports as 200 with an empty body and no headers is a refused connection.
- A marketplace install reports how long it held the server thread. The in-game log line carries
  it, and an install over 100 ms is named in the server log, so a hitch that coincides with an
  install can be matched to it.
- Docs: Hosted servers, "Which of these settings do I need?", IPv6, the web hub status fields, why a
  marketplace list fails and what to do, and the `lockedmodels` module with its `tlib_locked_models`
  and `tlib_reduce_motion` convars, which were read but not documented.

## For people who build tLib

- `bun run prod` is a release build. It refuses a dirty tree, a version a tag already names on
  different files, a version that is not `X.Y` or `X.Y.Z` (Z above zero), and a `package.json` that
  disagrees with the manifest, then tags `v<version>` once the zip exists. `--dev` skips that and
  stamps the commit `+dirty`. Run `git fetch --tags` first.
- `bun run check:nui` fails on a bare `RegisterNUICallback`, `RegisterNuiCallbackType` or raw
  `__cfx_nui:` handler in tLib-owned code; `--siblings` counts the same in each checked-out
  resource.
- `bun run setup` now installs `internal/shared-ts` when it exists. Without it six test files failed
  to load (`three`) and one more (`react/jsx-dev-runtime`), which read as unrelated breakage.
- `bun test` is hermetic: it needs no network, no global git identity, signing or hooks, and leaves
  nothing in the repo or TEMP. The Lua suites and one test need `fengari-node-cli`, fetched into
  bunx's cache on first use; see `tests/lua/README.md`.
