# `solid-compat` — the Solid 1 → 2 compatibility layer

One shared copy, kept here in tLib, consumed by five projects.

## What it solves

Solid 2.0 is not a rename away from Solid 1. It moved the DOM runtime out of
the `solid-js` package into `@solidjs/web`, deleted the `solid-js/store`
subpath, removed `onMount`, `splitProps`, `mergeProps`, `Index`, `on()`,
`batch`, `createComputed`, `observable`, `produce` and `createResource`, and
changed the call shape of `createEffect` and the `createStore` setter.

Most Solid UI libraries have not followed yet. `@ark-ui/solid`, `@zag-js/solid`
and several `@tanstack/solid-*` adapters are still published against Solid 1 and
have no Solid 2 release at all, so every one of those removals is a build or
runtime failure in a Solid 2 app that uses them.

This layer makes those packages run unmodified, by intercepting the specifiers
they import and handing them a compatible surface built on top of the real
Solid 2 runtime. **Only they get it.** Application code resolves to the real
packages and is expected to be native Solid 2.

The failures it prevents are overwhelmingly silent, which is why so much of the
source is annotated with the measurement behind it. The three worst recorded
here are a `[REACTIVE_WRITE_IN_OWNED_SCOPE]` throw with no build error; a
`splitProps` multi-group bug that emptied every element of a motion component
while rendering a correct-looking tree; and `createRequire` resolving the shim's
"real" Solid from tLib, which is on Solid 1.9.12 — a build that stayed green
while 40 test files vanished at collection.

## The five modules

| File | Role |
| --- | --- |
| `solid-1-compat-plugin.ts` | **The entry point.** A Vite `resolveId` plugin. Decides who gets redirected where, resolves the `virtual:` specifiers itself, and owns the client/server and dev/prod build selection. |
| `solid-1-compat.ts` | The `solid-js` shim. The core surface: the removed names and the changed call shapes. |
| `solid-1-compat-web.ts` | The `solid-js/web` shim, for the specifier Solid 2 no longer has at all. |
| `solid-1-compat-store.ts` | The `solid-js/store` shim, likewise. Two exports. |
| `solid-1-compat-server-fns.ts` | `@solidjs/web/server-functions/server`. One RC-to-RC rename, not a Solid 1 issue. |

Plus two files that are not shims:

- `solid-1-compat-virtual.d.ts` — ambient types for the `virtual:solid-1-compat-real/*`
  specifiers. Emits nothing; the only file here not bundled into a consumer's output.
- `solid-2-aria-attributes.ts` — an opt-in correction to Solid 2 itself. See below.

## Adopting it in a project

**1. Import the plugin directly, by path.**

```ts
// vite.config.ts  (and vitest.config.ts — both need it)
import { solid1CompatShim } from "../../tLib/shared/ts/solid-compat/solid-1-compat-plugin";
import { VENDOR_PACKAGES } from "./vite/solid-compat-vendors";
```

In-tree projects use a relative path; out-of-tree projects use an absolute one.
**Not an alias** — a vite config is loaded before `resolve.alias` exists, so an
alias cannot name it.

**2. Put it FIRST in `plugins`.**

```ts
plugins: [solid1CompatShim({ vendorPackages: VENDOR_PACKAGES }), UnoCSS(), solidPlugin()],
```

It carries `enforce: "pre"` and has to win the specifier race against
`@solidjs/vite-plugin`'s own `enforce: "pre"` hooks for the same specifiers.
Losing that race disables the whole redirect with **no build error** — it
appears at runtime as `Cannot read properties of undefined (reading 'effect')`
with nothing rendered.

**This is now enforced rather than only documented.** `configResolved` receives
the plugin list already sorted — Vite groups by `enforce` and keeps array order
within a group — so by that point the array *is* the resolution order. If any
plugin named `solid` or `solid:*` precedes the shim, the build throws and names
them.

The matched names are read out of `@solidjs/vite-plugin`'s own dist (`solid`,
`solid:boundary-modules`, `solid:server-functions/compiler`, `solid:diagnostics`,
…) rather than pattern-guessed: a bare `/^solid/` would also match this plugin,
`solid-devtools` and any consumer's own `solid-`-named plugin, and a false throw
here breaks every adopting build — far worse than the silent failure it guards.

Verified in both directions, including the cases that must **not** throw: shim
first → ok; `solid` first → throws; `solid:*` first → throws; `solid-devtools`
before the shim → ok; shim absent from the list → ok (nothing to compare against,
and guessing is worse than not checking); no plugin list at all → ok. Checked
against real builds too: web-next and tCAD both still build, and a false positive
would have failed every one of web-next's 203 test files rather than none.

⚠️ **Requirements 1 and 3 are still unenforced.** A missing
`optimizeDeps.exclude` entry is computable the same way and is the natural next
guard. It was deliberately left out: the client environment's exclude list is
injected by `@solidjs/vite-plugin` rather than written by the consumer, so the
check has to model which environments actually pre-bundle before it can throw
without false positives — and an over-eager throw there would break every
consumer at once.

**3. Exclude the same set from the dependency optimizer.**

```ts
optimizeDeps: { exclude: ["solid-js", "@solidjs/web", ...VENDOR_PACKAGES] },
```

Vite's pre-bundler runs *before* the plugin pipeline, so anything pre-bundled
escapes the redirect entirely and produces a module id the `virtual:` bypass can
never name — which is the two-reactive-runtimes hazard the plugin exists to
prevent. Vite matches these by prefix, so a bare name covers its subpaths.

**4. Do not import the shim modules from application code.** Doing so throws at
resolve time. That is the point; see *Public API* below.

## `vendorPackages`

The one per-project value in the whole layer. Everything else here is shared
verbatim.

It means **"packages whose Solid 1 specifiers must be rewritten"**, which is not
the same set as "packages this project depends on". A transitive dependency that
imports `solid-js/web` belongs on the list even though nothing of yours imports
it; a direct dependency that is already Solid-2-native does not.

**Deriving one:** grep each installed package tree for `"solid-js"`,
`"solid-js/web"` and `"solid-js/store"`, and keep the ones with a real runtime
hit. The lists genuinely differ between projects — measured across the supported
set they run from 2 entries to 12, and only `@ark-ui/solid` and `@zag-js/solid`
appear in every one.

It is a **required argument with no default**, and an empty array throws. A
default would be a list measured against somebody else's `node_modules`, and
both directions of being wrong are hard to read:

- **A missing package** fails as `"./web" is not exported … from package
  …/solid-js`, naming no importer anywhere. Use the debug variables below to
  find the real asker.
- **A spurious package** never matches — the gate tests for a
  `/node_modules/<pkg>/` substring — so it is dead weight that *reads* as a
  supported case. Measured, one consumer's list named four packages it does not
  install.

Keep it in its own module (`vite/solid-compat-vendors.ts`) rather than inline:
`vitest.config.ts` needs the same array, and `optimizeDeps.exclude` has to hold
the same set by construction.

## `ariaAttributeFix`

`solid1CompatShim({ vendorPackages, ariaAttributeFix: true })` redirects bare
`@solidjs/web` to `solid-2-aria-attributes.ts` for **every** importer,
application code included.

That module corrects one behaviour of Solid 2 itself: Solid 2 applies the HTML
boolean-attribute rule to every attribute name, so `aria-pressed={true}` renders
as `aria-pressed=""` (invalid — ARIA requires `"true" | "false" | "mixed"`) and
`aria-pressed={false}` removes the attribute, which to a screen reader means
"not a toggle button" rather than "a toggle button that is off". Solid 1 did not
do this, and neither version special-cases `aria-*`. The change is undocumented
upstream.

**It defaults to `false`, and that is a scope decision rather than a doubt about
the fix.** Enabling it changes rendered output for every importer, and no build,
typecheck or unit test in these projects can observe that change — it is about
the attribute *value* a correct-looking element ends up with. One of the five
consumers enables it today. Turn it on in another together with a check that
reads rendered output.

## Debugging

| Variable | Effect |
| --- | --- |
| `SOLID1_SHIM_DEBUG=1` | Logs `[shim-miss] <specifier> <- <importer>` for every request the plugin declined. |
| `SOLID_COMPAT_DEBUG=1` | Identical. Both spellings are honoured because both are in use; dropping either would make the diagnostic silently print nothing in the projects using the other, which is indistinguishable from "there is nothing to find". |

This is the only thing that locates the real asker when a Solid 1 specifier
survives. The build failure for one arrives from a different plugin, blames
`node_modules/solid-js`, and names the importing file nowhere.

## Public API

`shared/ts/package.json` exports exactly two entries:

```json
"./solid-compat/plugin":        "./solid-compat/solid-1-compat-plugin.ts",
"./solid-compat/surface-suite": "./solid-compat/solid-compat-surface-suite.ts"
```

⚠️ The second is the test suite (see *Testing*), and exporting it does **not**
widen the shim surface: it takes the runner and the real Solid imports as
arguments and reads the shim files as *text*. It never imports a shim module, so
it cannot become the supported back door the resolve-time throw exists to forbid.

The shim modules are **deliberately not exported.** They are reachable only
through the plugin's own `resolveId`, which hands them to vendor importers and
throws for anyone else. Exporting them would offer application code a supported
way to do the one thing that resolve-time throw exists to forbid. If you need
the shims' behaviour in application code, you have found a Solid 2 migration
that has not been done — do that instead.

Consumers import the plugin by path rather than through this export, because a
vite config is loaded before any alias resolution exists. The export entry is
for anything else in the monorepo that may want it.

## Testing

`solid-compat-surface-suite.ts` is the shared suite. It enforces the rule under
*Changing anything here* — "every export must have a vendor call site, count it
in `node_modules` or delete it" — which until now was enforced by hand across
165 KB of shim and five consumers. That is how `createResource` survived as ~170
lines of dead code behind a live-looking justification: the counts in its docblock
predated the migration and were never marked historical, so reading it argued
*for* keeping it.

**Adopt it in one file.** Assertions are shared; the tree is yours:

```ts
// scripts/solid-compat-surface.test.ts  (or wherever your test globs reach)
import { describe, expect, test } from "vitest";
import { solidCompatSurfaceSuite } from "<path>/solid-compat/solid-compat-surface-suite";
import { VENDOR_PACKAGES } from "../vite/solid-compat-vendors";

solidCompatSurfaceSuite(
  { describe, test, expect },
  {
    vendorPackages: VENDOR_PACKAGES,
    realSurfaces: {
      "solid-js": () => import("solid-js"),
      "@solidjs/web": () => import("@solidjs/web"),
    },
    undeclaredTypeImports: [],
    exportsWantedOnlyByOtherConsumers: [],
  },
);
```

⛔ **The runner and those two imports are passed in, and both are forced rather
than stylistic.** This file sits inside tLib, so a bare import here resolves
against tLib. Measured in `tLib/shared/ts/node_modules`: `solid-js` **is**
installed there on **1.9.12**, and `vitest` is not installed at all. A bare
`import("solid-js")` would therefore compute every "is this name supplied" answer
against the Solid 1 surface — and *pass*, because Solid 1 has more names than
Solid 2 — while a bare `import "vitest"` would fail to resolve and the suite
could not load. Written at the consumer's call site, both resolve where the real
Solid 2 and the real runner are. Same trap as the one in the plugin header, where
`createRequire` resolving the "real" Solid from tLib kept a build green while 40
of one consumer's test files died at collection.

### ⚠️ "Unused" is a union question — the suite's first run proved it

Run against a second consumer for the first time, it failed on `batch`,
`createComputed` and `observable` as exports with no vendor consumer. All three
are **live elsewhere**, measured in the other consumer's `node_modules`:

```
batch          <- @solid-primitives/rootless, @solid-primitives/static-store, @tanstack/solid-table
createComputed <- @solid-devtools/logger, @solid-primitives/refs, @tanstack/solid-form
observable     <- @tanstack/solid-table
```

⛔ So a strict per-project "unused" verdict is a **false failure for a shared
layer**, and acting on it would have deleted exports the wider consumer needs —
the exact opposite of rule 2 ("re-measure at the union"). Hence
`exportsWantedOnlyByOtherConsumers`, asserted as an **exact set** rather than an
allowlist: a name that becomes locally wanted must be removed from it, a newly
orphaned export must be added, and either way someone has to look. An allowlist
would only grow and would silence the `createResource` case entirely.

**An export is only dead when it appears in every consumer's list.** That is the
delete signal, and no single repo can see it.

### Status

| Consumer | Adopted | `undeclaredTypeImports` | Exports wanted only elsewhere |
| --- | --- | --- | --- |
| tWeb | its own local copy, 402 lines | `JSXElement` | — (widest tree) |
| web-next | ✅ shared suite, 9 tests | *(none)* | `batch`, `createComputed`, `observable` |

tWeb's local copy is the original and still passes; it is worth retiring in favour
of the shared one so both trees are checked by the same assertions. The two
`undeclaredTypeImports` values differing is not a discrepancy — web-next depends
on none of `@tanstack/solid-form`, `@tanstack/solid-table` or `lucide-solid`,
which are what still import `JSXElement`.

⚠️ **Verified to fail closed**, because a check that cannot fail is worse than no
check: given a bogus `undeclaredTypeImports` entry and an emptied
`exportsWantedOnlyByOtherConsumers`, both exact-set assertions fail.

### What it asserts

- **every shim export is wanted by a vendor somewhere** — the rule above, now
  mechanical rather than hand-counted
- **every name a vendor imports is actually supplied** — the dangerous
  direction, and the silent one: a missing VALUE resolved to `undefined` once
  (`Index`, imported from `"solid-js/web"` by two `@ark-ui/solid` chunks and
  re-exported by neither the shim nor real `@solidjs/web`), surfacing as a JSX
  call on a non-function nowhere near the import at fault
- **the vendor-only gate is real, in both directions** — application code asking
  for a dropped specifier throws, asking for bare `solid-js` is left alone, a
  vendor importer gets the shim, a build-tooling importer does not, and
  `@solidjs/web` follows `ariaAttributeFix`
- **a control that the vendor scan found imports at all**, so a silent empty walk
  cannot pass every assertion beneath it

⚠️ Two details worth keeping if this is ever rewritten. The type/value split is
read off the **import position**, not off the package: deciding it by scanning
installed `.d.ts` reported seven false positives as missing values (`Accessor`,
`JSX`, `JSXElement`, `Component`, `ComponentProps`, `Context`, `ParentProps`),
every one sourced from a declaration file where nothing has a runtime. And the
vendor file used to prove "a vendor importer gets the shim" is **discovered by
walking**, not pinned — a hashed path like `@ark-ui/solid/dist/chunk/EIZK5ZYY.js`
is correct for one installed version and then silently tests nothing, because the
walk returns `[]` for an absent path and the assertion is skipped rather than
failed.

## Formatting

`tLib/biome.json` excludes this directory. biome and the consumers' formatter
(oxfmt, via `vp fmt`) disagree on import order and line breaking here —
measured, biome wants to rewrite all seven files — and the churn would bury the
annotations that are the only record of why each shim is the shape it is. Keep
the exclusion.

**Nothing formats or lints this directory today, and that is a gap rather than a
design.** It was previously documented as covered by the consumers, on the
reasoning that each reaches these files through its vite config. Measured, that
is not true: every consumer's `fmt` and `lint` scripts name only its own `src`
and config files, and `vp fmt` rejects any path containing `..`, so a consumer
cannot be pointed here even by hand.

So: match the surrounding style when you edit, and do not read a green
`vp fmt --check` in a consumer as saying anything about these files. Closing the
gap properly means either a tLib-side formatter configured to agree with oxfmt,
or a per-consumer check that can address an out-of-tree path.

## Changing anything here

1. **Re-measure before you trust a number.** A count taken mid-migration keeps
   reading as current long after it stops being true; that is how
   `createResource` survived as dead code with a live-looking justification.
2. **Re-measure at the union**, across every consumer's installed tree — not at
   the one project in front of you. A fix beats the absence of one; measured
   evidence beats assertion.
3. **Every export must have a vendor call site.** Count it in `node_modules`, or
   delete it. "A project of ours uses it" is not a reason for anything here to
   exist — application code is native Solid 2.
4. **Verify with a consumer's build *and* its typecheck.** They see different
   defects: a wildcard re-export satisfies the bundler while `tsc` reports
   TS2305 on the same line.
