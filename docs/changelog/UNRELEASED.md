Draft for the next tLib release. Integration places these under the version heading.

- `tlib.nui.register`: an NUI callback that is always answered, with a structured error on a throw and a bound on handler time. `bun run check:nui` fails on a bare `RegisterNUICallback` in tLib; every tLib-owned callback now goes through it.
- `@tlib/shared/retry`: `createRetryLoop`, a single-flight backoff with a fast stretch, jitter, a cap, `maxAttempts`/`maxElapsedMs`, `onGiveUp` and `resume()`.
- `tlib.ratelimit.tokens`: a per-player token bucket with a cost per call and one refusal line per window.
- `tlib.item.onUse`: one usable-item registration for ox_inventory, qbx_core, qb-core and es_extended.
- `tlib.kvp`: `getFloat` and `getInt` no longer raise on a key stored as another type, and a mistyped read prints one line naming the key.
- A resource that uses any of these needs `tlib_min_version` raised to the release that ships them.
