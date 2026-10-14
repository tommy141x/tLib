-- Standalone from resource root:
--   bunx --bun --package fengari-node-cli fengari tests/lua/engine-prefetch.lua
--
-- Oracle for what the engine projects, and when.
--
-- The browser is handed rows for exactly ONE page; every other page reaches it as a
-- placeholder carrying navigation metadata only. That is what made stepping into a
-- submenu a round trip the player watched -- 19ms measured, about a frame and a
-- half, between pressing Enter and seeing the next page -- because the rows did not
-- exist anywhere the browser could reach until it asked for them.
--
-- So the engine projects the page a highlighted submenu row points at while the
-- cursor is resting on it, and the browser paints from what it already holds. That
-- is only worth doing if it stays cheap and only honest if it stays true, so this
-- suite is exclusive about BOTH: every projection pass the engine makes is recorded
-- with the exact page list it asked for, and every page push to the browser is
-- counted. A prefetch that fires per row passed over, or one that paints a page an
-- `enter` hook would have refused, both fail here.
--
-- Runs the REAL client/cl_menu.lua against a stub host, as engine-snapshot.lua
-- does, and additionally drives the NUI callbacks -- so the host has to answer the
-- server's snapshot request, because opening the menu IS the permission check and
-- there is no path to `visible` that skips it.


-- The host

_TLIB_SIDE = 'client'
_TLIB_IS_FIVEM = false

local now, timers, threads = 0, {}, {}
local netEvents, uiCallbacks, serverEvents = {}, {}, {}

--- What the browser holds, rebuilt from the messages it is actually sent. Fields
--- are copied out at send time rather than kept by reference: the engine sends its
--- own live snapshot table, and a page it re-projects later would otherwise appear
--- to have been in the message all along.
local browser = {}
local pushed = {}

local function receive(action, data)
    if action == 'menu:snapshot' then
        browser = {}
        for _, menu in ipairs(data.menus or {}) do
            browser[menu.id] = { id = menu.id, placeholder = menu.placeholder,
                contextKey = menu.contextKey, rows = #menu.items }
        end
    elseif action == 'menu:menu' then
        browser[data.id] = { id = data.id, placeholder = data.placeholder,
            contextKey = data.contextKey, rows = #data.items }
        pushed[#pushed + 1] = data.id
    end
end

Platform = {
    now = function() return now end,
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
    export = function() end,
    onShutdown = function() end,
    onResourceStop = function() end,
    getInvokingResource = function() return nil end,
    sendUIEvent = function(_, action, data) receive(action, data) end,
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

--- Nothing here advances time on its own. One pump is one frame: every parked
--- thread gets exactly one resume, NEWEST FIRST -- which is the order the settle
--- window and the 750ms refresh poll are observed in below.
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

local S, K, C, MC = MenuSchema, MenuCatalog, MenuContext, MenuClient

-- Every projection pass, with the exact page list it was asked for. This is the
-- cost being controlled: a pass copies and decorates each page it names, and used
-- to hand the whole tree across an export boundary per presenter.
local passes = {}
local realPresent = C.present
C.present = function(raw, requested)
    passes[#passes + 1] = requested and table.concat(requested, ',') or '<all>'
    return realPresent(raw, requested)
end

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
local function list(actual, expected, message)
    equal(#actual, #expected, message .. ': count (got ' .. table.concat(actual, ' | ') .. ')')
    for index, want in ipairs(expected) do equal(actual[index], want, ('%s: [%d]'):format(message, index)) end
end

--- Drain, so every assertion is about the step that produced it rather than about
--- everything since the suite started.
local function drainPushed() local value = pushed; pushed = {}; return value end
local function drainPasses() local value = passes; passes = {}; return value end

-- The fixture
--
-- Two owners. `alpha` gates nothing, so its pages are prefetchable; `gamma` has an
-- `enter` hook, which is the one thing that makes a page unsafe to paint early --
-- the hook may refuse, and a page shown and then taken away is worse than one that
-- took a frame to arrive.

local function menu(owner, spec)
    local clean, err = S.menu(spec, owner, true)
    if not clean then fail(('fixture %s is not valid: %s'):format(tostring(spec.id), tostring(err))) end
    return clean
end

local alpha = assert(K.build({
    menu('alpha', { id = 'alpha:one', title = 'One', items = {
        { id = 'alpha:a', label = 'A', kind = 'action' },
        { id = 'alpha:go2', label = 'Two', kind = 'submenu', menu = 'alpha:two' },
        { id = 'alpha:go3', label = 'Three', kind = 'submenu', menu = 'alpha:three' },
        { id = 'alpha:go4', label = 'Four', kind = 'submenu', menu = 'alpha:four' },
    } }),
    menu('alpha', { id = 'alpha:two', title = 'Two', parent = 'alpha:one', items = {
        { id = 'alpha:c', label = 'C', kind = 'action' },
    } }),
    menu('alpha', { id = 'alpha:three', title = 'Three', parent = 'alpha:one', items = {
        { id = 'alpha:e', label = 'E', kind = 'action' },
    } }),
    menu('alpha', { id = 'alpha:four', title = 'Four', parent = 'alpha:one', items = {
        { id = 'alpha:f', label = 'F', kind = 'action' },
    } }),
}))
local gamma = assert(K.build({
    menu('gamma', { id = 'gamma:one', title = 'Gamma', items = {
        { id = 'gamma:g', label = 'G', kind = 'action' },
    } }),
}))

assert(MC.registerCatalogProvider('alpha', function() return alpha end))
assert(MC.registerCatalogProvider('gamma', function() return gamma end))
local entries = 0
assert(MC.registerHooks('gamma', { enter = function() entries = entries + 1; return true end }))
pump() -- the catalogs are built on the frame after registration

--- The manifest as the server sends it: every page, every row granted. Grants are
--- generated from the catalogs rather than written out, so adding a fixture row
--- cannot silently change which rows this suite is really about.
local function manifest()
    local grants = {}
    for _, catalog in ipairs({ { 'alpha', alpha }, { 'gamma', gamma } }) do
        for index, page in ipairs(catalog[2].menus) do
            grants[#grants + 1] = { owner = catalog[1], menu = index, items = ('1'):rep(#page.items) }
        end
    end
    return { version = 1, compact = 1, capabilities = {}, menus = {}, grants = grants,
        catalogs = { alpha = alpha.signature, gamma = gamma.signature } }
end

--- Answer the snapshot request the engine just made. This is the permission check;
--- there is no open path around it, so the host has to play the server to get the
--- menu visible at all.
local function answerSnapshot()
    local request = serverEvents[#serverEvents]
    check(request ~= nil and request.name == S.events.request and type(request[2]) == 'table'
        and request[2].kind == 'snapshot', 'opening the menu asks the server for the player\'s own tree')
    netEvents[S.events.response](request[1], { ok = true, snapshot = manifest() })
end

local highlight = uiCallbacks['menu_highlight']
local navigate = uiCallbacks['menu_navigate']
check(uiCallbacks['menu_ready'] ~= nil and highlight ~= nil and navigate ~= nil,
    'the engine exposes the browser callbacks this suite drives')

--- Put the cursor on a row and let the settle window elapse. Two pumps, because the
--- window restarts whenever the selection moves and one pump is one frame.
local function rest(menuId, itemId, frames)
    local answered
    highlight({ menuId = menuId, itemId = itemId, contextKey = browser[menuId] and browser[menuId].contextKey },
        function(result) answered = result end)
    check(answered ~= nil and answered.ok == true,
        ('the cursor may rest on %s'):format(tostring(itemId)))
    for _ = 1, frames or 1 do pump() end
end

-- Opening

uiCallbacks['menu_ready'](nil, function() end)
answerSnapshot()
drainPushed(); drainPasses()

local opened = select(1, MC.open())
answerSnapshot()
check(opened ~= false, 'the menu opens')
check(MC.isVisible(), 'and the game considers it visible')
equal(browser['main'].placeholder, nil, 'the page the player landed on is real')
equal(browser['main'].rows, 2, 'with a row for each owner\'s top-level page')
equal(browser['alpha:one'].placeholder, true, 'every other page is a marked placeholder')
equal(browser['alpha:two'].placeholder, true, 'including the ones a level down')
equal(browser['gamma:one'].placeholder, true, 'and the gated one')
equal(browser['alpha:one'].rows, 0, 'a placeholder carries navigation metadata and no rows')

-- A cursor at rest on a gated page
--
-- First, because it is the case that must NOT happen: `gamma` may refuse entry, so
-- its page keeps costing the round trip and keeps arriving only once the game has
-- agreed to the navigation.

drainPushed(); drainPasses()
rest('main', 'gamma:one:open', 2)
list(drainPushed(), {}, 'a page whose owner gates entry is never projected early')
equal(browser['gamma:one'].placeholder, true, 'and stays a placeholder until the game says otherwise')
equal(entries, 0, 'the entry hook is not consulted either: prefetch does not pre-ask permission')
list(drainPasses(), { 'main', 'main' }, 'the frames cost only the 750ms refresh of the open page')

-- A cursor at rest on a page worth having

drainPasses()
rest('main', 'alpha:one:open', 2)
list(drainPushed(), { 'alpha:one' }, 'a resting cursor projects the page its row points at, once')
equal(browser['alpha:one'].placeholder, nil, 'the browser now holds a real page')
equal(browser['alpha:one'].rows, 4, 'with the rows the manifest granted')
-- Newest thread first: the settle window resolves on the first frame, ahead of the
-- refresh poll, which runs on both.
list(drainPasses(), { 'alpha:one', 'main', 'main' },
    'and costs exactly one extra pass, for exactly the one page')

-- Stepping into it
--
-- The navigation still happens, and still projects both pages: the browser painting
-- from what it holds is an optimism the game confirms, never a substitute for it.

local result
navigate({ menuId = 'alpha:one', fromMenuId = 'main', contextKey = browser['main'].contextKey,
    reason = 'enter' }, function(value) result = value end)
check(result ~= nil and result.ok == true, 'entering the page the browser already painted succeeds')
list(drainPasses(), { 'main,alpha:one', 'main,alpha:one' },
    'projecting source and target: once to validate the context, once after entry hooks')
list(drainPushed(), {}, 'and pushes nothing, because the reply carries the pages')

drainPasses()
pump()
list(drainPasses(), { 'alpha:one' }, 'the refresh poll follows the player: one page, the open one')
list(drainPushed(), {}, 'and pushes nothing while that page is unchanged')

-- A row that leads nowhere to prefetch

rest('alpha:one', 'alpha:a', 2)
list(drainPushed(), {}, 'a row that is not a submenu projects nothing')
list(drainPasses(), { 'alpha:one', 'alpha:one' }, 'and costs only the poll')

-- A held arrow key
--
-- The reason this runs on the settle window at all: a walk down a list touches
-- every row on the way, and a projection per row passed over is precisely the cost
-- prefetching exists to remove.

drainPasses()
highlight({ menuId = 'alpha:one', itemId = 'alpha:go3', contextKey = browser['alpha:one'].contextKey }, function() end)
highlight({ menuId = 'alpha:one', itemId = 'alpha:go4', contextKey = browser['alpha:one'].contextKey }, function() end)
pump(); pump()
list(drainPushed(), { 'alpha:four' }, 'only the row the cursor stopped on is projected')
equal(browser['alpha:three'].placeholder, true, 'the row it passed over is still a placeholder')

drainPasses(); drainPushed()
rest('alpha:one', 'alpha:go4', 2)
list(drainPushed(), {}, 'returning to a row whose page the browser already holds projects nothing again')
list(drainPasses(), { 'alpha:one', 'alpha:one' }, 'so a resting cursor is not a second refresh poll')

-- The window outliving the menu
--
-- The settle window is long enough for the menu to have closed inside it, and a
-- page projected into a browser that is no longer showing anything is work done for
-- nobody. What this pins is the abandonment: closing clears the pending selection,
-- so the window that outlives the session resolves to nothing at all. (The `visible`
-- test inside prefetchDestination is a second lock on the same door -- it is not
-- separately reachable, and deliberately not claimed here.)

highlight({ menuId = 'alpha:one', itemId = 'alpha:go2', contextKey = browser['alpha:one'].contextKey }, function() end)
pump()
uiCallbacks['menu_close'](nil, function() end)
check(not MC.isVisible(), 'the menu closed inside the settle window')
drainPushed(); drainPasses()
pump(); pump()
list(drainPushed(), {}, 'a window that resolves after the close projects nothing')
list(drainPasses(), {}, 'and the refresh poll has stopped with the session')

-- And again on the next session
--
-- Nothing about the close may leave prefetching switched off: reuse of an unchanged
-- manifest means the second open runs against the tree the first one built.

MC.open()
answerSnapshot()
check(MC.isVisible(), 'the menu opens again')
equal(browser['alpha:two'].placeholder, true, 'and every page is a placeholder again for the new session')
navigate({ menuId = 'alpha:one', fromMenuId = 'main', contextKey = browser['main'].contextKey,
    reason = 'enter' }, function(value) result = value end)
check(result.ok == true, 'the player walks back in')
drainPushed(); drainPasses()
rest('alpha:one', 'alpha:go2', 2)
list(drainPushed(), { 'alpha:two' }, 'and the cursor still buys the next page a frame ahead')
equal(browser['alpha:two'].rows, 1, 'with its rows')

print(('PASS engine prefetch: %d checks, settle-window projection / gating / pass cost'):format(checks))
