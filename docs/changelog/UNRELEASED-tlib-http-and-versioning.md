<!--
DRAFT, not a changelog entry. Placed here only so integration finds it: it is .md, not .mdx,
so scripts/check-docs.mjs does not scan it. Move the bullets into the tWeb changelog entry for
the next tLib release and delete this file. No version heading is cut here on purpose: the
next release must be at least 1.1.1, because 1.1 already names four different builds.
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

## Added

- `GetHttpStatus` reports `reachedFromOutside` and `reachedAt` once a request from another machine
  has reached a door, and `publicUrlOverride` (`unset`, `used`, `rejected`). The local event
  `tlib:http:remote` fires once, with no address.
- `tlib.healthcheck` steps carry `class` (`ok`, `refused`, `silent`, `wrong-service`),
  `elapsedMs` and `errorData`, and accept `errorMsgs` to choose wording by class. A connection the
  engine reports as 200 with an empty body and no headers is a refused connection.
- Docs: Hosted servers, "Which of these settings do I need?", IPv6, and the web hub status fields.

## For people who build tLib

- `bun run prod` is a release build. It refuses a dirty tree, a version a tag already names on
  different files, a version that is not `X.Y` or `X.Y.Z` (Z above zero), and a `package.json` that
  disagrees with the manifest, then tags `v<version>` once the zip exists. `--dev` skips that and
  stamps the commit `+dirty`. Run `git fetch --tags` first.
