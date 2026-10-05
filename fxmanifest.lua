fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'Tommy Johnston'
author 'TIMMYG Studios'
description 'tLib — shared UI and utility library (FiveM)'
-- 0.15.0 is the shared answer to two cross-cutting duplications a
-- filename-based scan cannot see: Escape ownership, and settings persistence.
--
-- `shared/ts/escape-layer.ts` -- `createEscapeLayer()`, one Escape owner for a
-- page. FIVE resources bound Escape independently across 23 files and three
-- separate mechanisms had been invented for the same question, each knowing
-- something the others did not: tELS's `data-editor-modal` DOM marker (works,
-- but every modal is equally blocking, so a stack cannot say which is on top),
-- tRadio's sample-ownership-on-capture (the one insight neither other had --
-- without it a panel that closes on keydown lets the keyup ALSO hide the radio
-- underneath: one press, two dismissals), and tLib's internal-layer-first plus
-- an `active` gate for a component with two mounts. The registry is all three.
-- `registerEscapeGuard` is the DOM marker's real content, kept because Ark UI's
-- popovers and listboxes handle Escape themselves and can never register.
--
-- The briefing for this work recorded tCAD as a fourth and better model, "Lua
-- owns Escape and the page never binds it". Re-measured: tCAD's own comment
-- says the opposite ("The NUI owns its own Escape handling because it also has
-- to close a dialog without closing the whole CAD") and its page binds Escape
-- in more files than any other resource. There is no fourth model.
--
-- NUI focus release is now ONE sequence. There were three orderings of
-- `SetNuiFocus(false,false)` and `SetNuiFocusKeepInput(false)` in this tree,
-- two of them in `shared/imports/platform/client.lua` itself, with two
-- mutually incompatible comments justifying them -- neither carrying a
-- measurement. Neither can be settled offline: those two natives are not in
-- the native reference at all. So `releaseNuiFocus` clears keepInput on BOTH
-- sides of the release, which is correct under either comment's premise, and
-- `tests/lua/nui-focus-release.lua` proves each two-call form leaks under one
-- of them while the three-call form leaks under neither.
--
-- `platform.releaseCursorDeferred(session, current)` folds in the defer-a-frame
-- release and its session-generation guard -- discovered three times (tELS's
-- editor, tVDJ's menu, warned about in tLib's own cl_layout.lua) and present in
-- no shared helper. Both halves matter: SetNuiFocus from inside a NUI callback
-- can fail silently, and a UI that reopens before the thread resumes has
-- already taken focus synchronously, so an unguarded release revokes the NEW
-- session's.
--
-- `kvp.view(opts)` / `kvp.serverTag()` / `settings`' `serverScoped` -- the
-- settings-persistence half. Two forks existed, each for exactly one missing
-- option, so the options are here now rather than the forks:
--   * tRadio needed per-server key scoping and implemented it TWICE, in
--     `cl_bridge.lua` and again in TypeScript. `serverScoped` is that, and
--     `tests/lua/kvp-views.lua` pins the composed key strings as
--     byte-identical to BOTH forks -- they are persisted on players' machines,
--     so a shared implementation that namespaced them differently would pass
--     every behavioural test and silently reset everyone on upgrade.
--   * tAFK needed a namespace and reads that answer `nil` rather than a type
--     zero, because its prefs are tri-state. `prefix` + `nilWhenUnset`.
-- One safety divergence was resolved to the stricter side while moving:
-- tRadio's tag hashed an unresolved endpoint to `00001505` (djb2's seed), a
-- plausible-looking tag for no server. An empty endpoint now yields no tag and
-- the key stays unscoped, which is what tRadio's TypeScript half already said.
--
-- Additive: `kvp.key(key)` with no options, and every existing accessor, are
-- byte-for-byte what they were. The module's own accessors ARE a no-option
-- view, so `tlib.kvp.getBool` cannot drift from `tlib.kvp.view({}).getBool`.
--
-- 0.15.0 also adds `framerelay` (shared/imports/framerelay/client.lua): the
-- statebag relay that puts a device's finished PICTURE on the props of clients
-- that are not running it. tDetector and tRadar had the whole mechanism each,
-- and a content diff put the two files at 70% with 62 contiguous identical
-- lines: the controller election, the sequence numbering, the heartbeat, the
-- stale expiry, and the withdraw-on-vehicle-change.
--
-- The election is the part that is expensive to rediscover and impossible to
-- notice missing alone: BOTH FRONT-SEAT OCCUPANTS run their own NUI and both
-- have a frame, so two writers on one statebag key alternate two devices'
-- pictures into everyone else's prop. The reader's half is the pair of facts
-- that `seq` and the stale window exist for -- a statebag is not withdrawn when
-- its writer disconnects, and the write only lands while the writer owns the
-- entity, so ownership migration stops it silently.
--
-- What stayed in the consumers is the PAYLOAD, which is genuinely different:
-- tDetector's frame is 27 flat scalars done with two field lists, tRadar's is a
-- nested cells-and-lamps tree walked by shape. `sanitise` and `differs` are
-- therefore parameters. The relay touches exactly three fields of a payload and
-- says so at the top of the file: it writes `seq` and `netId`, and it READS
-- `powered` -- a switched-off device publishes nothing rather than an off frame,
-- because the prop's baked artwork already is the off state.
--
-- `tests/lua/framerelay-election.lua` is the oracle, and the two-client case it
-- drives is the one no resource suite could reach: a correctness regression in
-- the election only manifests with two players in one vehicle.
--
-- 0.15.0 also adds `runtimetxd` (shared/imports/runtimetxd/client.lua): the
-- create-once lifecycle for CREATE_RUNTIME_TXD. That native permanently consumes
-- and pins one of the game's finite `ytd` streaming slots, has no destructor
-- bound in the engine, and is NOT idempotent across resource loads -- a second
-- registration of a name yields a SECOND dictionary and every later
-- AddReplaceTexture silently resolves to the one that does not hold the
-- textures. Measured in tRadar 2026-09-25: the same name handed out handle 20
-- and handle 6, minutes apart.
--
-- That fact was written down twice, in tDetector and tRadar, and the two copies
-- disagreed: tDetector's comment said the dictionary name was "deliberately NOT
-- tokenised" four lines above the code that tokenises it. tRadar's was the one
-- with the measurement, so tRadar's is what moved. `textureName` came with it,
-- because the rule it enforces -- a runtime texture name must carry the per-load
-- tag -- is one a name built by hand can forget.
--
-- 0.14.0 adds `diag.command` (shared/imports/diag/shared.lua): the whole of the
-- `<resource>_diag` console command the config standard's §13 asks every
-- resource for, which EIGHT resources had written by hand -- tDetector, tRadar,
-- tUnit, tAFK, tChirp, tRadio, tCAD and tELS, with tRadio and tCAD sharing 54
-- lines of literal copy-paste including byte-identical `meta()` and
-- `convarSet()` helpers.
--
-- The report CONTENT stays with the consumer and is a callback; it is the half
-- that was never duplicated. What moves here is the half where the copies had
-- drifted apart on SAFETY, and in each case the strictest copy's behaviour is
-- now the default:
--   * Redaction, which only tDetector and tRadio had at all and which tRadar,
--     tUnit, tAFK and tChirp each omitted on the grounds that "this config
--     holds no secrets" -- the exact assumption tDetector's own comment says is
--     unsafe over time. It is DERIVED rather than hand-listed: `harvest` walks
--     the config for values under credential-looking key names and no line
--     carrying one survives, so a config that gains a credential next year is
--     covered without anybody editing anything.
--   * The pcall guard, which only tRadar, tAFK and tELS had -- "a diagnostic
--     that dies mid-report is worse than none" -- and which now also FLUSHES
--     the partial report rather than discarding it.
--   * Spec-derived key listing, which only tDetector had. A hand-listed dump
--     silently omits every key added after it was written.
--   * `RegisterCommand(..., true)`, applied here so copy nine cannot forget it.
-- Routing is the union of the three the copies had, not a pick between them:
-- the server console always (it is the copy that survives the caller
-- disconnecting) and the caller too when there was one.
--
-- 0.14.0 also adds `marketplace.standardTypes` / `registerType` /
-- `soundConflict` (shared/imports/marketplace/server.lua). Four resources --
-- tDetector, tRadar, tELS, tRadio -- each declared the same two item types at
-- the same two install paths inside the same pcall wrapper, then branched a
-- pair of lifecycle handlers on an event name that was nothing but their own
-- resource name with a suffix; tRadio's two halves are 1,100 lines apart in one
-- file. `soundConflict` is the reason it is worth a module rather than a
-- comment: the sound-overwrite warning was fired at `-1` -- every player on the
-- server, about an admin action -- and in three of the four nothing anywhere
-- registered the event. tELS deleted its copy rather than fix it. The targeted
-- send at `meta.src`, and the UNCONDITIONAL server log that has to survive the
-- admin disconnecting mid-install, are now one implementation with
-- tests/lua/marketplace-standard-types.lua pinning both.
--
-- Additive: nothing that worked against 0.13.0 behaves differently. `diag`'s
-- existing wrap/fatal/error/warn/info are untouched, as is marketplace's
-- upsertSound/removeSound/migrateBuiltinSlugs.
--
-- 0.13.0 adds `vehicleprop` (shared/imports/vehicleprop/shared.lua): the whole
-- of the in-vehicle prop -- model registry, placement store, ownership mark and
-- the lifecycle pass -- which tDetector and tRadar each carried as their own
-- 591-line client/cl_props.lua. Normalising only the prefix, the model name and
-- the device noun left 80 differing lines between the two, every one of them
-- comment prose or whitespace. It is `shared.lua` rather than `client.lua`
-- because the registry rules are asked on both sides: the client builds it to
-- decide what to SPAWN, the server to decide what a save may STORE.
--
-- 0.13.0 also adds `ratelimit` (shared/imports/ratelimit/server.lua): the
-- twelve-line per-player floor on request-shaped net events that existed as
-- SEVEN byte-identical copies, in tELS, tRadio, tDetector x2, tRadar x2 and
-- tUnit. The disconnect sweep -- without which every bucket keeps one
-- timestamp per player who has ever connected, for the life of the server --
-- is inside it, because that is the half a hand-written copy forgets.
--
-- And `access.gate` now sweeps itself on playerDropped. Gate:allowed memoises
-- one answer per player it is ever asked about and the TTL only makes an entry
-- stale, so every gate was a slow leak; exactly two resources had noticed and
-- swept their own by hand. That is a BEHAVIOUR change, but only in the
-- direction of a gate re-evaluating sooner for a player who left and came
-- back, which is what it should have done all along.
--
--
-- 0.13.0 also adds `jsonstore` (shared/imports/jsonstore/server.lua): THE
-- writer of a consumer's data.json. tDetector's and tRadar's server/sv_data.lua
-- were identical in all 46 code lines and tUnit had a third copy of the same
-- shape, alongside soundstore writing two sections of the same document --
-- four writers, safe together only because of an invariant restated in prose
-- in two headers and asserted in two suites. `open` memoises per
-- resource-and-file and soundstore now goes through it, so there is one
-- writer, one re-entrancy flag and one queue: the invariant is removed rather
-- than restated. soundstore's own API is unchanged.
--
-- Additive otherwise -- nothing that worked against 0.12.0 behaves differently.
--
-- 0.12.0 adds two things a consumer can need and cannot probe for:
--   * tLib:HasPermissionBatch — resolves many permission keys in ONE export round trip
--     (server/lib/adapter/permission.lua). tRadio was making 40+ consecutive export calls
--     per permission resolution, which a profiler attributed ~5.2 ms to.
--   * the optional `validate` content contract on a marketplace install target
--     (shared/ts/marketplace/installer/core.ts), so a consumer can refuse a bundle that is
--     safe to extract but is not a valid instance of its own item type.
-- Both are additive — nothing that worked against 0.11.0 behaves differently. The bump
-- exists so a consumer can PIN them via tlib_min_version, which is what imports.lua's
-- header calls the real guarantee: a capability probe cannot report its own absence.
version '0.15.0'

-- Layout note: the top-level folder is the VM a file is loaded into, matching
-- every other resource here. Where one module spans VMs -- the platform adapter
-- does -- it keeps its own name under each tree's lib/ rather than being split
-- by prefix, so `adapter` stays findable while the manifest below stays the
-- single authority on what runs where.
--
-- imports.lua stays at the root: consumers name it as '@tLib/imports.lua' in
-- their own manifests, so that path is a contract, not a convention.

shared_scripts {
    'shared/lib/adapter/init.lua',
    'shared/lib/logger.lua',
    'shared/lib/adapter/shim.lua',
    'shared/lib/adapter/core.lua',
    'shared/lib/adapter/events.lua',
    'shared/lib/adapter/ui.lua',
    'shared/lib/adapter/shutdown.lua',
    -- Before lifecycle.lua, which wraps it as Platform.isStudioResource. Shared
    -- because a consumer VM loads this exact file via shared/imports/versioncheck.
    'shared/sh_branding.lua',
    -- The one definition of the studio API host and of tmarketplace_base_url's
    -- normalisation. Shared because client/cl_marketplace.lua, server/
    -- sv_marketplace.lua and a consumer VM (via shared/imports/versioncheck)
    -- all need the same answer.
    'shared/sh_api.lua',
    'shared/lib/adapter/lifecycle.lua',
    'shared/sh_utils.lua',
    'shared/sh_coords.lua',
    -- The menu protocol. Shared so a consumer can validate its own definitions
    -- against this exact file via shared/imports/menu/shared.lua.
    'shared/lib/menu/schema.lua',
    -- The client only accepts a snapshot whose signature it can reproduce byte
    -- for byte, so the consumer's VM has to run this exact file too.
    'shared/lib/menu/catalog.lua',
}

client_scripts {
    'client/lib/adapter/player.lua',
    'client/lib/adapter/vehicle.lua',
    'client/lib/adapter/world.lua',
    'client/cl_permission.lua',
    'client/lib/theme/exports.lua',
    'client/cl_theme.lua',
    -- Client-only: handlers are functions living in the consumer's client VM and
    -- the effect scheduler is a client thread. Before cl_menu.lua, which hands
    -- it the item resolver and the publisher.
    'client/lib/menu/actions.lua',
    -- Built from GTA V control IDs, but always loaded: its entry points are what
    -- the menu client calls, and they degrade to no-ops rather than going missing.
    'client/lib/menu/input.lua',
    -- After actions.lua: context walks every dispatcher on each pass.
    'client/lib/menu/context.lua',
    'client/lib/menu/prompts.lua',
    -- Last of the engine: installs the item resolver into actions, the sender into
    -- input, and the client API. Before cl_main.lua, which hands it the UI handle.
    'client/cl_menu.lua',
    'client/lib/toast/exports.lua',
    'client/cl_toast.lua',
    'client/cl_ui_effects.lua',
    'client/lib/dialog/state.lua',
    'client/lib/dialog/exports.lua',
    'client/cl_dialog.lua',
    'client/lib/layout/schema.lua',
    'client/cl_layout.lua',
    'client/cl_marketplace.lua',
    -- After the adapters and Logger (it uses both), and before cl_main so the
    -- ReportKeybind export exists by the time a consumer resource starts binding.
    'client/cl_keybinds.lua',
    'client/cl_main.lua',
}

server_scripts {
    'server/dist/bundle.js',
    'server/lib/adapter/utils.lua',
    'server/lib/adapter/permission.lua',
    -- Before sv_permission.lua and sv_marketplace.lua: both consult `Demo`, and
    -- in demo mode its answer replaces theirs rather than being consulted late.
    'server/sv_demo.lua',
    'server/sv_probe_fsperm.lua',
    'server/sv_discovery.lua',
    'server/sv_permission.lua',
    -- Server-only: holds the authority state and the action handlers, neither of
    -- which may exist in a VM a consumer can reach. Before sv_menu.lua, which
    -- instantiates it.
    'server/lib/menu/registry.lua',
    'server/sv_menu.lua',
    'server/sv_serversettings.lua',
    'server/sv_marketplace.lua',
    'server/sv_community_configs.lua',
    'server/sv_main.lua',
}

files {
    'imports.lua',
    -- Read by a consumer's versioncheck module via LoadResourceFile.
    'shared/sh_branding.lua',
    -- Same: a consumer VM loads this to resolve tmarketplace_base_url.
    'shared/sh_api.lua',
    'shared/imports/**/*.lua',
    'client/ui/index.html',
    'client/ui/assets/**/*',
}

ui_page 'client/ui/index.html'
