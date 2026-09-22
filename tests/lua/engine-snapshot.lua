-- Standalone from resource root:
--   bunx --bun --package fengari-node-cli fengari tests/lua/engine-snapshot.lua
--
-- Oracle for what applying a snapshot costs, and what it is allowed to skip.
--
-- Every open of the menu asks the server for a fresh manifest, and must: that
-- request IS the permission check. But the answer is usually the one that came back
-- last time, and rebuilding the tree from an unchanged answer was most of what
-- opening the menu cost -- measured on a 215-page consumer catalog as 24-56ms of
-- hydration, 29-70ms of handing the raw tree to each owner's snapshot hook across
-- an export boundary, and 12-16ms of rebuilding a ~51,000-entry search index, on
-- every single open.
--
-- So an identical manifest reuses the tree it already produced. That is a safe
-- thing to do only because the hydrated tree is a pure function of (manifest, local
-- catalogs) -- the manifest carries each catalog's signature and every server-owned
-- delta -- and it is a correct thing to do only if the three skipped steps really
-- are the ones that describe a CHANGED tree, while everything the browser is owed
-- on every open still happens.
--
-- This suite is exclusive about both halves: exact call counts for what must not
-- repeat, and exact message counts for what must. The failure it exists to catch is
-- the quiet one -- a consumer that registers after the first snapshot and is never
-- told the tree exists, so its rows never get their stored state back.
--
-- Runs the REAL client/cl_menu.lua against a stub host, which is why this file
-- carries a host at all: client.lua is the one engine file that needs one.


-- ── The host ────────────────────────────────────────────────────────────────

_TLIB_SIDE = 'client'
_TLIB_IS_FIVEM = false -- no RegisterCommand/RegisterKeyMapping in this state

local now, timers, threads = 0, {}, {}
local netEvents, uiCallbacks, uiMessages, serverEvents = {}, {}, {}, {}
local exportsRegistered = {}

Platform = {
    now = function() return now end,
    -- Parked as a coroutine: the engine's loops open with a wait, and running one
    -- inline against a wait that returns would never come back.
    createThread = function(fn)
        local co = coroutine.create(fn)
        threads[#threads + 1] = co
        coroutine.resume(co)
    end,
    wait = function(ms) return coroutine.yield(ms) end,
    setTimeout = function(fn, ms) timers[#timers + 1] = { fn = fn, at = now + ms } end,
    TriggerEvent = function() end,
    AddEventHandler = function() end,
    AddNetEventHandler = function(name, fn) netEvents[name] = fn end,
    TriggerServerEvent = function(name, ...) serverEvents[#serverEvents + 1] = { name = name, ... } end,
    export = function(_, name, fn) exportsRegistered[name] = fn end,
    onShutdown = function() end,
    onResourceStop = function() end,
    getInvokingResource = function() return nil end,
    sendUIEvent = function(_, action, data) uiMessages[#uiMessages + 1] = { action = action, data = data } end,
    onUIRequest = function(_, name, fn) uiCallbacks[name] = fn end,
}

assert(loadfile('shared/lib/menu/schema.lua', 't', _G),
    'shared/lib/menu/schema.lua not found -- run this suite from the tLib resource root')()
assert(loadfile('shared/lib/menu/catalog.lua', 't', _G))()
assert(loadfile('client/lib/menu/actions.lua', 't', _G))()
for _, path in ipairs({ 'client/lib/menu/input.lua', 'client/lib/menu/context.lua',
    'client/lib/menu/prompts.lua', 'client/cl_menu.lua' }) do
    assert(loadfile(path, 't', _G))()
end

--- Nothing here advances time on its own, so parked threads are resumed explicitly
--- at the points where a frame would have happened.
local function pump()
    for index = #threads, 1, -1 do
        local co = threads[index]
        if coroutine.status(co) == 'dead' then
            table.remove(threads, index)
        else
            local ok, err = coroutine.resume(co)
            if not ok then error('a queued thread failed: ' .. tostring(err), 0) end
        end
    end
end

local S, K, MC = MenuSchema, MenuCatalog, MenuClient
MC.init({})

local checks = 0
local function fail(message) error('FAIL: ' .. message, 0) end
local function check(condition, message)
    checks = checks + 1
    if not condition then fail(message) end
end
local function equal(actual, expected, message)
    checks = checks + 1
    if actual ~= expected then
        fail(('%s: expected %s, got %s'):format(message, tostring(expected), tostring(actual)))
    end
end
local function ordered(list, field, expected, message)
    equal(#list, #expected, message .. ': count')
    for index, want in ipairs(expected) do
        equal(list[index] and list[index][field], want, ('%s: [%d]'):format(message, index))
    end
end

-- ── The fixture ─────────────────────────────────────────────────────────────

local function menu(spec)
    local clean, err = S.menu(spec, 'alpha', true)
    if not clean then fail(('fixture %s is not valid: %s'):format(tostring(spec.id), tostring(err))) end
    return clean
end

local definitions = {
    menu({ id = 'alpha:one', title = 'One', items = {
        { id = 'alpha:a', label = 'A', kind = 'action' },
        { id = 'alpha:b', label = 'B', kind = 'toggle', value = false },
        { id = 'alpha:d', label = 'D', kind = 'select', index = 1,
            options = { { value = 'x', label = 'X' }, { value = 'y', label = 'Y' } } },
    } }),
    menu({ id = 'alpha:two', title = 'Two', parent = 'alpha:one', items = {
        { id = 'alpha:c', label = 'C', kind = 'action' },
    } }),
}
local catalog = assert(K.build(definitions))
local built = 0
assert(MC.registerCatalogProvider('alpha', function() built = built + 1; return catalog end))

--- The manifest as the server sends it. `bits` is the grant bitmap for page one,
--- which is how a permission change is expressed in this format.
local function manifest(bits)
    return {
        version = 1, compact = 1,
        catalogs = { alpha = catalog.signature },
        capabilities = {},
        grants = {
            { owner = 'alpha', menu = 1, items = bits or '111' },
            { owner = 'alpha', menu = 2, items = '1' },
        },
        menus = {},
    }
end

local refresh = netEvents[S.events.refresh]
check(refresh ~= nil, 'the engine listens for a pushed snapshot')

-- The catalog is built at registration rather than at the first snapshot, so the
-- first open does not pay for walking the consumer's whole catalog. The warm-up is
-- queued rather than immediate, because a provider is allowed to yield.
equal(built, 0, 'registering a catalog provider does not build it inline')
pump()
equal(built, 1, 'it is built on the next frame instead, before any snapshot needs it')

-- ── What an unchanged manifest must not repeat ──────────────────────────────

local snapshots, syncs = 0, 0
assert(MC.registerHooks('alpha', { snapshot = function() snapshots = snapshots + 1 end }))
MC.actions('alpha') -- a dispatcher, so permission syncs are observable
local dispatcher = MenuActions.get('alpha')
local realSync = dispatcher.syncPermissions
dispatcher.syncPermissions = function(self, value) syncs = syncs + 1; return realSync(self, value) end

local function messagesOf(action)
    local found = {}
    for _, message in ipairs(uiMessages) do
        if message.action == action then found[#found + 1] = message end
    end
    return found
end

uiMessages = {}
refresh(manifest())
equal(snapshots, 1, 'the first manifest tells the owner its tree arrived')
equal(syncs, 1, 'and syncs the dispatcher that owns its rows')
equal(built, 1, 'and does not rebuild a catalog it already holds')
local firstIndex = messagesOf('menu:searchIndex')
equal(#firstIndex, 1, 'the browser is sent a search index')
equal(#messagesOf('menu:snapshot'), 1, 'and the tree')

uiMessages = {}
refresh(manifest())
equal(snapshots, 1, 'an identical manifest does NOT re-announce a tree that did not change')
equal(syncs, 1, 'nor re-sync permissions that did not change')
local secondIndex = messagesOf('menu:searchIndex')
equal(#secondIndex, 1, 'the browser is still sent an index on every apply, because it is entitled to one')
check(secondIndex[1].data == firstIndex[1].data,
    'but it is the index already built rather than ~51,000 entries walked again')
equal(#messagesOf('menu:snapshot'), 1, 'and the tree is sent again, because opening is a new session for the browser')

-- ── What a changed manifest must do ─────────────────────────────────────────

uiMessages = {}
refresh(manifest('101'))
equal(snapshots, 2, 'a manifest that grants different rows announces the new tree')
equal(syncs, 2, 'and re-syncs permissions against it')
local narrowed = messagesOf('menu:snapshot')[1].data
ordered(narrowed.menus, 'id', { 'main', 'alpha:one', 'alpha:two' }, 'the pages are still there')
local rebuilt = messagesOf('menu:searchIndex')
check(rebuilt[1].data ~= firstIndex[1].data, 'and the search index is rebuilt rather than reused')
-- `alpha:one:open` is the row the root page gets for a parentless page; the rows
-- under it are the ones the grant bitmap decides. B is gone because this manifest
-- did not grant it.
ordered(rebuilt[1].data, 'i', { 'alpha:one:open', 'alpha:a', 'alpha:d', 'alpha:c' },
    'against the rows the new manifest actually granted')

-- Back to the original grant: this is a DIFFERENT manifest from the one standing,
-- so it must rebuild -- reuse is keyed on the manifest in hand, not on any manifest
-- ever seen.
uiMessages = {}
refresh(manifest())
equal(snapshots, 3, 'returning to an earlier grant is itself a change, and is announced')
ordered(messagesOf('menu:searchIndex')[1].data, 'i',
    { 'alpha:one:open', 'alpha:a', 'alpha:b', 'alpha:d', 'alpha:c' },
    'with the restored row back in the index')

-- ── A consumer that arrives late ────────────────────────────────────────────
--
-- The quiet failure this whole mechanism could cause: a resource restarts,
-- registers its hooks again, and is never told about a tree that has not changed
-- since -- so its stored settings are never restored and its rows look dead.

local lateSnapshots = 0
assert(MC.registerHooks('bravo', { snapshot = function() lateSnapshots = lateSnapshots + 1 end }))
refresh(manifest())
equal(lateSnapshots, 1, 'a hook registered after the tree arrived is told about it on the next apply')
equal(snapshots, 4, 'and so is everybody else, because the announcement is not per listener')

refresh(manifest())
equal(lateSnapshots, 1, 'and then settles: the manifest is unchanged again')
equal(snapshots, 4, 'for every listener')

-- ── A row that moved underneath the manifest ────────────────────────────────
--
-- A server-owned delta arrives outside a manifest. One that changes a row has moved
-- the tree away from the manifest that built it, so the tree can no longer stand in
-- for the next identical manifest. One that changes nothing has moved nothing --
-- and a resource re-pushing the same per-player list on every snapshot is the
-- common case, not an edge case.

local patch = netEvents[S.events.patch]
check(patch ~= nil, 'the engine listens for a row patch')

patch({ menuId = 'alpha:one', itemId = 'alpha:a', changes = { label = 'A' } })
refresh(manifest())
equal(snapshots, 4, 'a delta that changes nothing does not cost the next apply a rebuild')

patch({ menuId = 'alpha:one', itemId = 'alpha:a', changes = { label = 'Moved' } })
refresh(manifest())
equal(snapshots, 5, 'a delta that changes a row does: the tree no longer matches its manifest')
ordered(messagesOf('menu:snapshot')[1].data.menus, 'id', { 'main', 'alpha:one', 'alpha:two' },
    'and the rebuilt tree is the manifest\'s, not the patched copy')

-- ── A per-player option list ────────────────────────────────────────────────
--
-- The same rule, on the path resources actually use most: a snapshot hook that
-- pushes the player's own list of choices into a selector. It runs on every
-- snapshot, and almost every time it pushes what is already there.

local pushOptions = netEvents[S.events.options]
check(pushOptions ~= nil, 'the engine listens for a pushed option list')

local sameList = { { value = 'x', label = 'X' }, { value = 'y', label = 'Y' } }
pushOptions({ menuId = 'alpha:one', itemId = 'alpha:d', changes = { options = sameList } })
refresh(manifest())
equal(snapshots, 5, 're-pushing the same option list does not cost the next open a rebuild')

pushOptions({ menuId = 'alpha:one', itemId = 'alpha:d', changes = {
    options = { { value = 'x', label = 'X' }, { value = 'z', label = 'Z' } },
} })
refresh(manifest())
equal(snapshots, 6, 'pushing a different one does')

-- ── The other inputs to hydration ───────────────────────────────────────────
--
-- The tree is a function of (manifest, catalogs, root page). Reuse is only sound
-- while all three are the ones that produced the standing tree, and a listener that
-- has never been told anything is a fourth reason to re-announce.

refresh(manifest())
equal(snapshots, 6, 'settled')

assert(MC.configure('alpha', { root = { id = 'main', title = 'Renamed' } }))
refresh(manifest())
equal(snapshots, 7, 'renaming the root page rebuilds: the root is an input to hydration')

assert(MC.registerCatalogProvider('alpha', function() built = built + 1; return catalog end))
pump()
refresh(manifest())
equal(snapshots, 8, 'a re-registered catalog rebuilds, even when its signature is unchanged')

MC.actions('charlie')
refresh(manifest())
equal(snapshots, 9, 'a dispatcher that has never been permission-synced rebuilds, so that it is')

MC.dropOwner('bravo')
refresh(manifest())
equal(snapshots, 10, 'dropping an owner rebuilds: its rows are gone from the tree')

-- ── A manifest that cannot be hydrated ──────────────────────────────────────
--
-- A refusal must not leave a reusable tree behind, or the refusal would be
-- forgotten the moment the same bad manifest arrived twice.

local realPrint = print
print = function() end
local broken = manifest()
broken.catalogs = { alpha = 'c2:not-the-signature' }
refresh(broken)
print = realPrint
refresh(manifest())
equal(snapshots, 11, 'the tree is rebuilt after a refusal rather than reused across one')

print(('PASS engine snapshot: %d checks, manifest reuse / late listeners / deltas / refusal'):format(checks))
