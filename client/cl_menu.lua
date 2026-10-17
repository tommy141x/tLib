-- Client menu engine. All wire names live in this file; input.lua emits bare names
-- through a sender installed here.
--
-- Every operation is scoped to this client: the snapshot request is answered to
-- `source` only, and no function here takes a player argument.

if _TLIB_SIDE ~= 'client' then return end

MenuClient = {}
local MC = MenuClient
local S = MenuSchema
local A = MenuActions
local C = MenuContext

-- Outbound: messages to the browser.
local WIRE = {
    visible     = 'menu:visible',
    -- Distinct from visible=false: hiding (cutscene, pause menu) keeps uncommitted
    -- drafts, closing discards them. Collapsing the two loses half-typed input.
    hidden      = 'menu:hidden',
    menu        = 'menu:menu',
    snapshot    = 'menu:snapshot',
    searchIndex = 'menu:searchIndex',
    locale      = 'menu:locale',
    strings     = 'menu:strings',
    branding    = 'menu:branding',
    -- Pushed rather than carried in the snapshot: both change without the tree
    -- changing.
    align       = 'menu:align',
    palettes    = 'menu:palettes',
    selftest    = 'menu:selftest',
}

-- Inbound: NUI callbacks. Prefixed because callback names are global to the page,
-- which the menu shares with the dialog, toast and marketplace surfaces.
local CALLBACK = {
    ready     = 'menu_ready',
    resync    = 'menu_resync',
    close     = 'menu_close',
    sound     = 'menu_sound',
    input     = 'menu_input',
    navigate  = 'menu_navigate',
    highlight = 'menu_highlight',
    action    = 'menu_action',
    selftest  = 'menu_selftest',
    -- The shared feedback dialog tLib's menu injects into every owner's root
    -- page. One callback for every t* resource, because the browser is tLib's
    -- and so is the row.
    feedback  = 'menu_feedback',
}

-- Client-local events, for resources in this player's own Lua runtime.
local EVENTS = {
    opened    = 'tlib:menu:opened',
    closed    = 'tlib:menu:closed',
    highlight = 'tlib:menu:highlight',
}

-- Runs the body on the current frame instead of queueing it for the scheduler's
-- next pass. Used only on the two paths that owe the browser an answer (navigate
-- and action), where the queueing delay was the menu's felt lag. Falls back to the
-- queued form, since the immediate primitive is an optimisation, not a capability.
local function createThreadNow(fn)
    local immediate = Platform.createThreadNow
    if immediate then return immediate(fn) end
    return Platform.createThread(fn)
end

-- Read from replicated convars rather than the interface configuration because
-- RegisterKeyMapping only takes effect while the resource is starting; by the time
-- ConfigureMenuInterface is called the binding list is closed. Owners use `setr`.

local function convar(name, fallback)
    if type(GetConvar) ~= 'function' then return fallback end
    local value = GetConvar(name, fallback)
    return type(value) == 'string' and value ~= '' and value or fallback
end

local function convarNumber(name, fallback, minimum, maximum)
    local value = tonumber(convar(name, ''))
    if type(value) ~= 'number' or value ~= value or value < minimum or value > maximum then return fallback end
    return math.floor(value)
end

-- Every duration convar carries its unit (`_ms`). Three once did not, and the
-- unit-less spellings were read as aliases with a deprecation print. Do not
-- bring that back: the only released tLib is 0.6, which predates all three
-- names, so there has never been a server.cfg carrying one. The alias existed
-- purely to smooth an unreleased rename, and its own message said it went in the
-- next major version — 1.0.0 is that version.

local settings = {
    command          = convar('tlib_menu_command', 'tlibmenu'),
    key              = convar('tlib_menu_key', 'F1'),
    padKey           = convar('tlib_menu_pad_key', 'start_index'),
    label            = convar('tlib_menu_label', 'Open Menu'),
    searchKey        = convar('tlib_menu_search_key', 'F3'),
    keySlots         = convarNumber('tlib_menu_key_slots', 8, 0, 16),
    locale           = convar('tlib_menu_locale', 'en'),
    requestTimeoutMs = convarNumber('tlib_menu_request_timeout_ms', 10000, 1000, 60000),
    refreshMs        = convarNumber('tlib_menu_permission_refresh_ms', 5000, 1000, 60000),
    settleMs         = convarNumber('tlib_menu_highlight_settle_ms', 120, 0, 2000),
}
MC.settings = settings

-- One screen, so one of these. Replaced wholesale by ConfigureMenuInterface, never
-- merged.
local interface = { root = { id = 'main', title = 'Menu' } }

local ui
local visible, ready, stopping, busy, opening = false, false, false, false, false
local epoch, serial, pending = 0, 0, {}
local nuiPending, persistentPending = {}, {}
local empty = function()
    return { version = 1, visible = false, menus = { { id = interface.root.id, title = interface.root.title, items = {} } } }
end
local snapshot = empty()
local rawSnapshot = S.copy(snapshot)
local snapshotIndices, applyingSnapshot = { [interface.root.id] = 1 }, false
local session = tostring(Platform.now()) .. '-' .. tostring(math.random(100000, 999999))
local contextGeneration = 0
local selectedMenuId, leavingMenuId = interface.root.id, interface.root.id
local actionNavigation
local close, refreshContext, clearSnapshotTransfer, openMenu

local function log(message) print('[tLib/menu] ' .. tostring(message)) end
local function send(action, data) Platform.sendUIEvent(ui, action, data) end

-- A provider rather than a catalog, because building one walks thousands of rows
-- and has to yield. Snapshots arriving mid-build wait for it rather than starting
-- a second.

local providers, catalogs, building = {}, {}, {}

local function catalogFor(owner)
    if catalogs[owner] then return catalogs[owner] end
    local provider = providers[owner]
    if not provider then return nil end
    while building[owner] do Platform.wait(0) end
    if catalogs[owner] then return catalogs[owner] end
    building[owner] = true
    local slice = Platform.now()
    local ok, result = pcall(provider, function()
        if Platform.now() - slice >= 2 then Platform.wait(0); slice = Platform.now() end
    end)
    building[owner] = nil
    if not ok then log(('%s failed to build its menu catalog: %s'):format(owner, tostring(result))); return nil end
    catalogs[owner] = result
    return result
end

-- `enter` is scoped to the owner's own pages because it can refuse entry; the rest
-- are notifications every owner hears.

local hooks = {}

local function ownerOf(menuId)
    return type(menuId) == 'string' and menuId:match('^([^:]+):') or nil
end

local function notify(name, ...)
    for owner, spec in pairs(hooks) do
        if S.callable(spec[name]) then
            local ok, err = pcall(spec[name], ...)
            if not ok then log(('%s %s hook failed: %s'):format(owner, name, tostring(err))) end
        end
    end
end

-- Shared with the self-test, so it cannot pass while real navigation is broken.
local function runEntryHooks(menuId, reason, context)
    local spec = hooks[ownerOf(menuId) or '']
    if not spec or not S.callable(spec.enter) then return true end
    local accepted, err = spec.enter(menuId, reason, context)
    if accepted == false then return false, err or 'Menu entry rejected' end
    return true
end

-- The browser posts a highlight per selection change, and a held arrow key repeats
-- at the keyboard's rate. Only the latest is kept, and one event is emitted once
-- the selection holds still for the settle window.

local highlightDesired, highlightSettling, highlightAnnounced = nil, false, nil

--- Project the page a highlighted submenu row points at, before the player asks.
--- Without this, pressing Enter costs a round trip to the game (19ms measured) on
--- every step into the tree.
---
--- Only for placeholder pages whose owner does not gate entry: re-projecting a page
--- the browser already holds would turn a resting cursor into a refresh poll, and a
--- page behind an `enter` hook may be refused after it was painted.
local function prefetchDestination(wanted)
    if not visible or stopping or busy then return end
    local row
    for _, menu in ipairs(snapshot.menus) do
        if menu.id == wanted.menuId then
            for _, item in ipairs(menu.items) do
                if item.id == wanted.itemId then row = item end
            end
        end
    end
    if not row or row.kind ~= 'submenu' or not S.id(row.menu) then return end
    local index = snapshotIndices[row.menu]
    if not index or not snapshot.menus[index].placeholder then return end
    local spec = hooks[ownerOf(row.menu) or '']
    if spec and S.callable(spec.enter) then return end
    -- Emitted through the same per-page channel the 750ms refresh uses, so there is
    -- no separate prefetch message or state.
    refreshContext({ row.menu }, true)
end

local function announceHighlight()
    if highlightSettling then return end
    highlightSettling = true
    Platform.createThread(function()
        local wanted = highlightDesired
        while wanted do
            if settings.settleMs > 0 then Platform.wait(settings.settleMs) end
            if highlightDesired ~= wanted then
                wanted = highlightDesired -- The selection moved again; restart the window.
            else
                highlightDesired = nil
                -- The menu can close inside the settle window, and re-announcing an
                -- already-reported row makes a settled selection look like it moved.
                if visible and not stopping and wanted.signature ~= highlightAnnounced then
                    highlightAnnounced = wanted.signature
                    Platform.TriggerEvent(EVENTS.highlight, wanted.menuId, wanted.itemId, wanted.value)
                end
                -- Outside the signature check: returning to an already-announced row
                -- is still a cursor at rest on a page worth prefetching.
                prefetchDestination(wanted)
                wanted = nil
            end
        end
        highlightSettling = false
    end)
end

local function focus(value)
    local wasVisible = visible
    visible, snapshot.visible = value, value
    rawSnapshot.visible = value
    if value and not wasVisible then
        contextGeneration = contextGeneration + 1
        local generation = contextGeneration
        refreshContext()
        -- The world moves while the menu is open, so the open page is re-presented
        -- on a poll rather than each feature watching for its own changes.
        Platform.createThread(function()
            while visible and not stopping and generation == contextGeneration do
                Platform.wait(750)
                if visible and not stopping and not busy and generation == contextGeneration then refreshContext() end
            end
        end)
    elseif not value then
        contextGeneration = contextGeneration + 1
    end
    MenuInput.setVisible(value, function() close() end)
    send(WIRE.visible, value)
    -- After the game and browser are both told, so a listener that reads menu state
    -- immediately sees the new one.
    if value ~= wasVisible then
        Platform.TriggerEvent(value and EVENTS.opened or EVENTS.closed, value and selectedMenuId or leavingMenuId)
    end
end

close = function()
    if clearSnapshotTransfer then clearSnapshotTransfer() end
    local closingId = selectedMenuId
    notify('close', closingId, { reason = 'close', isActive = function() return false end })
    if MenuPrompt then MenuPrompt.release() end
    leavingMenuId = selectedMenuId
    selectedMenuId = interface.root.id
    actionNavigation = nil
    -- Clearing the announced signature too means reopening on the same row
    -- announces it again, which a listener rebuilding state on open needs.
    highlightDesired, highlightAnnounced = nil, nil
    notify('page', nil, closingId)
    epoch = epoch + 1
    focus(false)
    local old = pending
    pending = {}
    for id, request in pairs(old) do
        if persistentPending[id] and not stopping then pending[id] = request
        else request({ ok = false, error = 'Menu closed' }) end
    end
    local outstanding = {}
    for finish, name in pairs(nuiPending) do
        if stopping or name == CALLBACK.action or name == CALLBACK.navigate then outstanding[#outstanding + 1] = finish end
    end
    for _, finish in ipairs(outstanding) do finish({ ok = false, error = 'Menu closed' }) end
end

refreshContext = function(ids, emit)
    ids = ids or { selectedMenuId }
    local nextSnapshot = C.present(rawSnapshot, ids)
    for _, menu in ipairs(nextSnapshot.menus) do
        local index = snapshotIndices[menu.id]
        if index then
            local previous = snapshot.menus[index]
            snapshot.menus[index] = menu
            if emit ~= false and not C.equal(menu, previous) then send(WIRE.menu, menu) end
        end
    end
    return nextSnapshot.menus
end

-- Cross-menu search index. The browser holds items for one page only, so without
-- this its filter sees just the page the player is standing on.
--
-- Ships text rather than exposing a query callback because the locale dictionaries
-- live in the UI bundle: a Lua-side matcher could only compare source strings and
-- would return nothing for a player on any other locale.
--
-- Built once per snapshot, never per refresh.
local function buildSearchIndex()
    local array = { __jsontype = 'array' }
    local entries = setmetatable({}, array)
    for _, menu in ipairs(rawSnapshot.menus) do
        for _, item in ipairs(menu.items) do
            -- Headings are not navigable, so they are not findable either.
            if item.kind ~= 'status' and not item.hidden then
                local entry = { m = menu.id, i = item.id, l = item.label,
                    d = item.description, r = item.rightLabel, g = item.groupLabel }
                if type(item.options) == 'table' and #item.options > 0 then
                    local labels = setmetatable({}, array)
                    for _, option in ipairs(item.options) do labels[#labels + 1] = option.label end
                    entry.o = labels
                end
                entries[#entries + 1] = entry
            end
        end
    end
    return entries
end

local lastSnapshotError
local pushBranding

-- The hydrated tree is a pure function of (manifest, local catalogs), so an
-- identical manifest reuses the tree it already produced and skips the permission
-- sync, the `snapshot` hook and the search index rebuild. On tMenu's catalog (215
-- pages, ~51,000 rows) those cost 24-56ms, 29-70ms and 12-16ms of a 114-142ms open.
--
-- The server RPC still runs on every open: it is the ACE check.
local appliedManifest, appliedSearchIndex

--- Drop the reuse. Anything that changes what a manifest would hydrate into must
--- call this, since the manifest alone would still compare equal.
local function forgetManifest()
    appliedManifest, appliedSearchIndex = nil, nil
end

local function applySnapshot(value)
    -- Settled before anything is touched: `value` becomes the tree already standing.
    local unchanged = appliedManifest ~= nil and type(value) == 'table' and value.compact ~= nil
        and C.equal(value, appliedManifest)
    if unchanged then
        value = rawSnapshot
    elseif type(value) == 'table' and value.compact ~= nil then
        local hydrated, err = MenuCatalog.hydrate(value, catalogFor, { root = interface.root })
        if not hydrated then
            -- Once per distinct reason: a signature mismatch repeats on every
            -- refresh and would bury the line naming the out-of-date resource.
            if err ~= lastSnapshotError then log(err) end
            lastSnapshotError = err
            forgetManifest()
            rawSnapshot = empty()
            for _, dispatcher in pairs(A.dispatchers()) do dispatcher:syncPermissions(rawSnapshot) end
            snapshot = S.copy(rawSnapshot)
            send(WIRE.snapshot, snapshot)
            if visible then close() end
            return false
        end
        -- Themes travel in the snapshot because they are permission-filtered with
        -- it, but reach the browser through the branding push at the end of this
        -- function, once the tree they belong to has been accepted.
        appliedManifest, appliedSearchIndex = value, nil
        value = hydrated
    else
        -- A tree handed over directly: no manifest describes what is now standing.
        forgetManifest()
    end
    if type(value) ~= 'table' or value.version ~= 1 or type(value.menus) ~= 'table' then return false end
    -- CitizenFX's JSON encoder honors __jsontype; empty item lists must be [] rather than {}.
    local array = { __jsontype = 'array' }
    setmetatable(value.menus, array)
    for _, menu in ipairs(value.menus) do
        if type(menu.items) ~= 'table' then return false end
        setmetatable(menu.items, array)
        for _, item in ipairs(menu.items) do
            if type(item.options) == 'table' then setmetatable(item.options, array) end
        end
    end
    lastSnapshotError = nil
    rawSnapshot = value
    -- Both of these mean "the authorized tree changed", so neither may run for a
    -- tree that did not move. The hook is also where the raw tree crosses an export
    -- boundary into every owning resource, the most expensive step of an open.
    if not unchanged then
        applyingSnapshot = true
        for _, dispatcher in pairs(A.dispatchers()) do dispatcher:syncPermissions(rawSnapshot) end
        notify('snapshot', rawSnapshot)
        applyingSnapshot = false
    end
    C.invalidate()
    snapshot = { version = 1, visible = visible, capabilities = S.copy(value.capabilities), menus = setmetatable({}, array) }
    snapshotIndices = {}
    -- Inactive pages carry navigation metadata only; their options are built on
    -- entry rather than serialized on every refresh.
    for index, menu in ipairs(rawSnapshot.menus) do
        -- Marked, not merely empty: a page with no visible rows is still a real
        -- page, and the browser has to tell the two apart.
        local placeholder = { id = menu.id, title = menu.title, subtitle = menu.subtitle,
            description = menu.description, parent = menu.parent, placeholder = true,
            items = setmetatable({}, array) }
        snapshot.menus[index], snapshotIndices[menu.id] = placeholder, index
    end
    if not snapshotIndices[selectedMenuId] then selectedMenuId = interface.root.id end
    refreshContext({ selectedMenuId }, false)
    -- Only this page was contextualized. Without it the browser renders a
    -- placeholder as a real page and cannot navigate off it.
    snapshot.menuId = selectedMenuId
    send(WIRE.snapshot, snapshot)
    -- After the snapshot, so a browser that rejected it never applies an index for
    -- a catalog it did not accept. Rebuilt only when the tree moved.
    appliedSearchIndex = appliedSearchIndex or buildSearchIndex()
    send(WIRE.searchIndex, appliedSearchIndex)
    -- Themes are permission-filtered, so they change with the snapshot.
    pushBranding()
    return true
end

local function patch(data)
    if type(data) ~= 'table' or type(data.changes) ~= 'table' then return end
    local changes = S.patch(data.changes)
    if not changes then return end
    for _, menu in ipairs(rawSnapshot.menus) do
        if menu.id == data.menuId then
            for _, item in ipairs(menu.items) do
                if item.id == data.itemId then
                    -- Only a delta that actually moves the row invalidates the reuse.
                    for k, v in pairs(changes) do
                        if not C.equal(item[k], v) then forgetManifest(); break end
                    end
                    for k, v in pairs(changes) do item[k] = S.copy(v) end
                    if changes.disabled ~= nil then
                        for _, dispatcher in pairs(A.dispatchers()) do dispatcher:syncPermissions(rawSnapshot) end
                    end
                    if visible and not busy then refreshContext() end
                    return
                end
            end
        end
    end
end

local function options(data)
    if stopping or type(data) ~= 'table' or not S.id(data.menuId) or not S.id(data.itemId) then return end
    local owner = ownerOf(data.itemId)
    if not owner then return end
    for _, menu in ipairs(rawSnapshot.menus) do
        if menu.id == data.menuId then
            for index, item in ipairs(menu.items) do
                if item.id == data.itemId then
                    local updated = MenuCatalog.applyDelta(item, data.changes, owner)
                    if not updated then return end
                    -- Only a delta that actually moves the row invalidates the reuse.
                    -- Re-pushing an identical per-player list on every snapshot is
                    -- the common case and must not cost the next open a rebuild.
                    if not C.equal(updated, item) then forgetManifest() end
                    menu.items[index] = updated
                    for _, dispatcher in pairs(A.dispatchers()) do dispatcher:syncPermissions(rawSnapshot) end
                    if visible and not busy then refreshContext() end
                    return
                end
            end
        end
    end
end

local function request(body, callback, keepOnClose)
    serial = serial + 1
    local id, done = session .. '-' .. serial, false
    local function finish(result)
        if done then return end
        done, pending[id], persistentPending[id] = true, nil, nil
        callback(result)
    end
    pending[id], persistentPending[id] = finish, keepOnClose
    Platform.setTimeout(function() finish({ ok = false, error = 'Server request timed out' }) end, settings.requestTimeoutMs)
    Platform.TriggerServerEvent(S.events.request, id, body)
end

local function receiveResponse(id, result)
    if stopping or type(id) ~= 'string' or type(result) ~= 'table' or type(result.ok) ~= 'boolean' then return end
    if pending[id] then pending[id](result) end
end

local function receiveRefresh(value)
    if stopping then return end
    applySnapshot(value)
    if visible and #snapshot.menus <= 1 then close() end
end

Platform.AddNetEventHandler(S.events.response, receiveResponse)
Platform.AddNetEventHandler(S.events.refresh, receiveRefresh)
Platform.AddNetEventHandler(S.events.patch, patch)
Platform.AddNetEventHandler(S.events.options, options)

local receiveChunk
receiveChunk, clearSnapshotTransfer = S.snapshotTransport.receiver(function(event, id, value)
    if event == S.events.response then receiveResponse(id, value)
    elseif event == S.events.options then options(value)
    else receiveRefresh(value) end
end, function(expire) Platform.setTimeout(expire, settings.requestTimeoutMs) end, function(event, id)
    return not stopping and (event ~= S.events.response or pending[id] ~= nil)
end)
Platform.AddNetEventHandler(S.events.chunk, receiveChunk)

-- An effect outlives the row that started it, so its grant is re-checked while it
-- runs: `remove_ace` raises no event and nothing else would notice. One request
-- covers every owner's running effects, keyed by full item ID.

local checkingPermissions = false

local function permissionSweep()
    local requested, byOwner = {}, {}
    for owner, dispatcher in pairs(A.dispatchers()) do
        local names = dispatcher:effectNames()
        if #names > 0 then
            byOwner[owner] = names
            for _, name in ipairs(names) do requested[#requested + 1] = owner .. ':' .. name end
        end
    end
    return requested, byOwner
end

local function startPermissionWatch()
    if checkingPermissions then return end
    checkingPermissions = true
    Platform.createThread(function()
        while A.anyEffects() and not stopping do
            Platform.wait(settings.refreshMs)
            if not A.anyEffects() or stopping then break end
            local requested, byOwner = permissionSweep()
            local completed = false
            request({ kind = 'permissions', actions = requested }, function(result)
                completed = true
                if stopping then return end
                for owner, names in pairs(byOwner) do
                    local dispatcher = A.get(owner)
                    if dispatcher then
                        if not result.ok then
                            dispatcher:stopEffects()
                        else
                            local allowed = {}
                            for _, name in ipairs(names) do
                                allowed[name] = type(result.allowed) == 'table' and result.allowed[owner .. ':' .. name] == true
                            end
                            dispatcher:applyPermissions(allowed, names)
                        end
                    end
                end
            end, true)
            -- Avoid overlapping refreshes; the request has its own bounded deadline.
            while not completed and not stopping and A.anyEffects() do Platform.wait(100) end
        end
        checkingPermissions = false
    end)
end

-- The browser owns the dictionaries and validates tags against them, so this side
-- checks tag shape only. Precedence is player, then server, then the default.

local LOCALE_KEY = 'tLib:Menu:locale'
local currentLocale

-- Returns the normalized tag; callers must use the return value, not the input.
-- The lowercasing is required: the browser's tag test is case-sensitive
-- (`/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/` in client/web/src/menu/locales/index.ts) where
-- `%a` is not, so `FR` passed here, persisted, and was then dropped by the page.
local function localeTag(value)
    if type(value) ~= 'string' then return nil end
    value = value:lower()
    if value:match('^%a%a%a?$') then return value end
    local language, region = value:match('^(%a%a%a?)%-(%a%a)$')
    if language then return language .. '-' .. region end
    return nil
end

local function resolveLocale()
    local saved = type(GetResourceKvpString) == 'function' and localeTag(GetResourceKvpString(LOCALE_KEY))
    if saved then return saved end
    -- Replicated convar, so this is the server owner's default rather than
    -- something a player can set from their own console.
    return localeTag(interface.locale) or localeTag(settings.locale) or 'en'
end

local function pushLocale()
    currentLocale = resolveLocale()
    send(WIRE.locale, currentLocale)
end

function MC.setLocale(tag)
    local clean = localeTag(tag)
    if not clean then return false, 'Invalid locale tag' end
    if type(SetResourceKvpString) == 'function' then SetResourceKvpString(LOCALE_KEY, clean) end
    currentLocale = clean
    send(WIRE.locale, clean)
    return true
end

function MC.getLocale() return currentLocale or resolveLocale() end

-- The browser validates this contract and drops the whole push on any failure, so
-- there is no second allowlist here. Empty values are omitted rather than sent:
-- Lua cannot distinguish an empty table from an empty array, so a push with no keys
-- arrives as [] and is rejected outright.

pushBranding = function()
    local branding = interface.branding
    local payload, configured = {}, false
    if type(branding) == 'table' then
        if type(branding.accent) == 'string' then payload.accent, configured = branding.accent, true end
        if type(branding.banner) == 'table' and next(branding.banner) ~= nil then
            payload.banner, configured = S.copy(branding.banner), true
        end
    end
    local themes = rawSnapshot.themes
    if type(themes) == 'table' and next(themes) ~= nil then
        payload.themes, configured = S.copy(themes), true
    end
    if configured then send(WIRE.branding, payload) end
end

-- Held outside the snapshot so a browser reload gets them back. Anchor names are
-- checked here because the browser drops an unknown one silently.

local ANCHORS = {
    ['top-left'] = true, ['top-center'] = true, ['top-right'] = true,
    ['middle-left'] = true, ['middle-center'] = true, ['middle-right'] = true,
    ['bottom-left'] = true, ['bottom-center'] = true, ['bottom-right'] = true,
    -- Legacy public wire values from the Right Align Menu toggle.
    left = true, right = true,
}

local anchor, palettes
local strings = {}

function MC.registerStrings(owner, dictionaries)
    if type(dictionaries) ~= 'table' then return false, 'Strings must be locale dictionaries' end
    local bytes, locales = 0, 0
    -- Re-keyed by the normalized tag rather than the caller's spelling: the page
    -- rejects the whole `menu:strings` message if any key fails its case-sensitive
    -- tag test, so one dictionary under `FR` took every other language with it.
    local normalized = {}
    for tag, dictionary in pairs(dictionaries) do
        locales = locales + 1
        local clean = localeTag(tag)
        if not clean or type(dictionary) ~= 'table' or locales > 32 then return false, 'Invalid locale dictionary' end
        -- `fr` and `FR` in one call are the same language twice; refuse rather than
        -- keeping whichever `pairs` reached last.
        if normalized[clean] then return false, 'Duplicate locale dictionary: ' .. clean end
        local count = 0
        for source, translated in pairs(dictionary) do
            count = count + 1
            if not S.text(source, 4096) or not S.text(translated, 4096) or count > 4096 then return false, 'Invalid translation' end
            bytes = bytes + #source + #translated
            if bytes > 2097152 then return false, 'Translation budget exceeded' end
        end
        normalized[clean] = dictionary
    end
    strings[owner] = S.copy(normalized)
    send(WIRE.strings, { owner = owner, dictionaries = strings[owner] })
    return true
end

function MC.setAnchor(value)
    if type(value) ~= 'string' or not ANCHORS[value] then return false, 'Unknown menu anchor' end
    anchor = value
    send(WIRE.align, value)
    return true
end

local function validSwatches(list)
    if list == nil then return true end
    -- Exactly 64, the count the game's own colour panel holds.
    if type(list) ~= 'table' or #list ~= 64 then return false end
    for index = 1, 64 do
        if type(list[index]) ~= 'string' or not list[index]:match('^%x%x%x%x%x%x$') then return false end
    end
    return true
end

function MC.setPalettes(value)
    if type(value) ~= 'table' then return false, 'Palettes must be a table' end
    for key in pairs(value) do
        if key ~= 'hair' and key ~= 'makeup' then return false, 'Unknown palette: ' .. tostring(key) end
    end
    if not validSwatches(value.hair) or not validSwatches(value.makeup) then
        return false, 'A palette must be 64 six-digit hex colours'
    end
    palettes = S.copy(value)
    send(WIRE.palettes, palettes)
    return true
end

local function pushScreen()
    for owner, dictionaries in pairs(strings) do send(WIRE.strings, { owner = owner, dictionaries = dictionaries }) end
    if anchor then send(WIRE.align, anchor) end
    if palettes then send(WIRE.palettes, palettes) end
end

-- Every callback gets a once-only completion and its own watchdog, including when
-- the handler throws: a browser awaiting a promise that never settles is a menu
-- that has silently stopped working.

local function nui(name, handler)
    Platform.onUIRequest(ui, name, function(data, callback)
        local done = false
        local function finish(result)
            if done then return end
            done = true
            nuiPending[finish] = nil
            callback(result)
        end
        nuiPending[finish] = name
        local function active() return not done and not stopping end
        Platform.setTimeout(function() finish({ ok = false, error = 'Action timed out' }) end,
            name == CALLBACK.action and 90000 or settings.requestTimeoutMs + 1000)
        local ok, err = pcall(handler, data, finish, active)
        if not ok then
            log(('NUI %s failed: %s'):format(name, tostring(err)))
            finish({ ok = false, error = 'Runtime error' })
        end
    end)
end

local function installCallbacks()
    nui(CALLBACK.ready, function(_, finish, active)
        ready = true
        close() -- A browser reload must not inherit stale focus or pending actions.
        -- A reloaded browser is back at its own defaults, so these are re-pushed
        -- here rather than only at start-up.
        pushLocale()
        pushBranding()
        pushScreen()
        request({ kind = 'snapshot' }, function(result)
            if not active() then return end
            if result.ok and applySnapshot(result.snapshot) then finish({ ok = true, snapshot = snapshot })
            else finish({ ok = false, error = result.error or 'Invalid snapshot' }) end
        end)
    end)

    -- Recovery, not a handshake: unlike `ready` this must not close the menu, which
    -- mid-session would leave the page drawn while the game believes it is shut.
    nui(CALLBACK.resync, function(_, finish, active)
        if not ready then finish({ ok = false, error = 'Menu is closed' }); return end
        request({ kind = 'snapshot' }, function(result)
            if not active() then return end
            if result.ok and applySnapshot(result.snapshot) then finish({ ok = true, snapshot = snapshot })
            else finish({ ok = false, error = result.error or 'Invalid snapshot' }) end
        end)
    end)

    nui(CALLBACK.close, function(_, finish)
        close()
        finish({ ok = true })
    end)

    -- The game's own frontend audio, not a web asset. The browser reports what
    -- happened; the allowlist stops it naming an arbitrary sound.
    local frontendSounds = { nav = 'NAV_UP_DOWN', cycle = 'NAV_LEFT_RIGHT', select = 'SELECT', back = 'BACK', error = 'ERROR' }
    nui(CALLBACK.sound, function(data, finish)
        finish({ ok = true })
        local name = type(data) == 'table' and frontendSounds[data.sound]
        if name and visible and not stopping and _TLIB_IS_FIVEM then
            PlaySoundFrontend(-1, name, 'HUD_FRONTEND_DEFAULT_SOUNDSET', false)
        end
    end)

    -- THE OWNING RESOURCE IS RESOLVED HERE, NOT TAKEN FROM THE BROWSER.
    -- `selectedMenuId` is the page the game believes it is on, and the owner is
    -- its `owner:` prefix -- so the attribution on a message cannot be chosen by
    -- whoever is talking to the NUI callback. The server checks the name against
    -- the registry again anyway, which is where a stale page is caught.
    nui(CALLBACK.feedback, function(data, finish, active)
        if not visible or not ready then finish({ ok = false, error = 'Menu is closed' }); return end
        if type(data) ~= 'table' or type(data.message) ~= 'string' or data.message == '' then
            finish({ ok = false, error = 'invalid' }); return
        end
        request({ kind = 'feedback', message = data.message, resource = ownerOf(selectedMenuId) },
            function(result)
                if not active() then return end
                finish(result)
            end)
    end)

    nui(CALLBACK.input, function(data, finish)
        if type(data) ~= 'table' or type(data.active) ~= 'boolean' then
            finish({ ok = false, error = 'Invalid input mode' }); return
        end
        local ok = MenuInput.text(data.active)
        finish({ ok = ok, error = not ok and 'Menu is closed' or nil })
    end)

    -- Entry hooks are trusted local preparation, not a permission authority.
    nui(CALLBACK.navigate, function(data, finish, active)
        if not visible or not ready then finish({ ok = false, error = 'Menu is closed' }); return end
        if busy then finish({ ok = false, error = 'An action is already running' }); return end
        if type(data) ~= 'table' or not S.id(data.menuId)
            or (data.fromMenuId ~= nil and not S.id(data.fromMenuId))
            or (data.contextKey ~= nil and not S.text(data.contextKey, 256))
            or (data.reason ~= nil and data.reason ~= 'enter' and data.reason ~= 'back') then
            finish({ ok = false, error = 'Invalid navigation' }); return
        end
        refreshContext({ data.fromMenuId or selectedMenuId, data.menuId }, false)
        local function findMenu(menus, id)
            for _, menu in ipairs(menus) do if menu.id == id then return menu end end
        end
        local target = findMenu(snapshot.menus, data.menuId)
        local sourceMenu = findMenu(snapshot.menus, data.fromMenuId or selectedMenuId)
        if not target or not findMenu(rawSnapshot.menus, data.menuId) then
            finish({ ok = false, error = 'Menu unavailable' }); return
        end
        if not sourceMenu or sourceMenu.contextKey ~= data.contextKey then
            finish({ ok = false, error = 'Menu context changed' }); return
        end
        local generation = epoch
        local sourceKey, targetKey = sourceMenu.contextKey, target.contextKey
        local function isActive() return active() and visible and epoch == generation end
        local context = { isActive = isActive, fromMenuId = sourceMenu.id, contextKey = targetKey,
            reason = data.reason or 'enter', menu = S.copy(target) }
        actionNavigation = nil
        busy = true
        createThreadNow(function()
            local projectedMenus, announce
            local ok, success, failure = pcall(function()
                if not isActive() then return false, 'Navigation cancelled' end
                local entered, entryError = runEntryHooks(data.menuId, data.reason, context)
                if not entered then return false, entryError end
                if not isActive() then return false, 'Navigation cancelled' end
                C.invalidate()
                projectedMenus = refreshContext({ sourceMenu.id, data.menuId }, false)
                local currentSource = findMenu(snapshot.menus, sourceMenu.id)
                local currentTarget = findMenu(snapshot.menus, data.menuId)
                if not currentTarget or not currentSource or currentSource.contextKey ~= sourceKey
                    or currentTarget.contextKey ~= targetKey then return false, 'Menu context changed' end
                -- Recorded, not delivered: dispatched after the browser's reply.
                announce = { previous = selectedMenuId }
                selectedMenuId = data.menuId
                return true
            end)
            busy = false
            if not ok then log('Menu entry failed: ' .. tostring(success)) end
            local route = actionNavigation
            actionNavigation = nil
            local menus = ok and success and projectedMenus or nil
            if route then menus = refreshContext({ sourceMenu.id, route }, false) end
            finish({ ok = ok and success == true, error = not ok and tostring(success) or failure,
                nextMenu = route, menus = menus })

            -- The reply goes first because a hook that yields costs a frame (~20ms),
            -- and `projectedMenus` is computed above, before either hook runs.
            -- Consequence: `leave` and `page` run outside the busy window, so a route
            -- set by NavigateMenu from one of them is not picked up -- that call is
            -- for action handlers. Entry hooks stay ahead of the reply; they gate it.
            if announce then
                notify('leave', announce.previous, { isActive = isActive, toMenuId = data.menuId, reason = context.reason })
                if announce.previous ~= data.menuId then notify('page', data.menuId, announce.previous) end
            end
        end)
    end)

    -- A highlight never grants a permission or runs the highlighted action;
    -- disabled rows are valid highlights.
    nui(CALLBACK.highlight, function(data, finish)
        if not visible or not ready or type(data) ~= 'table' or not S.id(data.menuId) or not S.id(data.itemId)
            or (data.value ~= nil and not S.scalar(data.value))
            or (data.contextKey ~= nil and not S.text(data.contextKey, 256)) then
            finish({ ok = false, error = 'Invalid highlight' }); return
        end
        local matched, kind = false, nil
        for _, menu in ipairs(snapshot.menus) do
            if menu.id == data.menuId and menu.contextKey == data.contextKey then
                for _, item in ipairs(menu.items) do
                    if item.id == data.itemId and not item.hidden and item.kind ~= 'status' then
                        kind = item.kind
                        if item.kind == 'select' then
                            for _, option in ipairs(item.options or {}) do
                                if option.value == data.value then matched = true end
                            end
                        else matched = data.value == nil end
                    end
                end
            end
        end
        if not matched then finish({ ok = false, error = 'Highlight unavailable' }); return end
        -- Left and right belong to the row on a slider or list, so the weapon wheel
        -- is suppressed there and only there.
        MenuInput.setValueRow(kind == 'select' or kind == 'slider')
        notify('selection', data.menuId, data.itemId, data.value)
        -- After the match check, so a row that does not exist or is not selectable
        -- is never announced.
        highlightDesired = { menuId = data.menuId, itemId = data.itemId, value = data.value,
            signature = data.menuId .. '\0' .. data.itemId .. '\0' .. tostring(data.value) }
        announceHighlight()
        finish({ ok = true })
    end)

    nui(CALLBACK.action, function(data, finish, active)
        -- Read before the permission round trip, and from the game rather than from
        -- browser data, which cannot supply a native modifier.
        local ctrl = false
        if _TLIB_IS_FIVEM then
            local pressed = IsControlPressed and IsControlPressed(0, 36)
            local disabledPressed = IsDisabledControlPressed and IsDisabledControlPressed(0, 36)
            ctrl = pressed == true or pressed == 1 or disabledPressed == true or disabledPressed == 1
        end
        if not visible or not ready then finish({ ok = false, error = 'Menu is closed' }); return end
        if busy then finish({ ok = false, error = 'An action is already running' }); return end
        if type(data) ~= 'table' or not S.id(data.menuId) or not S.id(data.itemId)
            or (data.event ~= nil and data.event ~= 'change' and data.event ~= 'activate')
            or (data.value ~= nil and not S.scalar(data.value))
            or (data.contextKey ~= nil and not S.text(data.contextKey, 256)) then
            finish({ ok = false, error = 'Invalid action' }); return
        end
        refreshContext({ data.menuId }, false)
        local function contextMatches()
            for _, menu in ipairs(snapshot.menus) do
                if menu.id == data.menuId then return data.contextKey == menu.contextKey end
            end
            return false
        end
        if not contextMatches() then
            finish({ ok = false, error = 'Action context changed; select the object again' }); return
        end
        local selected, canonical
        for _, menu in ipairs(rawSnapshot.menus) do
            if menu.id == data.menuId then
                for _, item in ipairs(menu.items) do if item.id == data.itemId then canonical = item; break end end
            end
        end
        for _, menu in ipairs(snapshot.menus) do
            if menu.id == data.menuId then
                for _, item in ipairs(menu.items) do if item.id == data.itemId then selected = item; break end end
            end
        end
        if not canonical or canonical.disabled or not S.value(canonical, data.value)
            or not selected or selected.disabled or not S.value(selected, data.value, true) then
            finish({ ok = false, error = 'Invalid or unavailable action' }); return
        end
        local actionEvent = data.event or (selected.apply == 'change' and 'change' or 'activate')
        if (actionEvent == 'change' and selected.apply ~= 'change' and selected.apply ~= 'both')
            or (actionEvent == 'activate' and selected.apply == 'change') then
            finish({ ok = false, error = 'Invalid action event' }); return
        end
        busy = true
        local generation = epoch
        local function isActive() return active() and epoch == generation and visible end
        actionNavigation = nil
        local function complete(result)
            result.nextMenu = actionNavigation
            if result.ok or actionNavigation then
                result.menus = refreshContext({ data.menuId, actionNavigation or data.menuId }, false)
            end
            actionNavigation = nil
            busy = false
            finish(result)
        end
        request({ kind = 'action', menuId = data.menuId, itemId = data.itemId, value = data.value }, function(result)
            -- Immediate, not queued: the browser has already waited a server round
            -- trip, and a handler needs a coroutine only because it may yield.
            createThreadNow(function()
                local ok, err = pcall(function()
                    if not isActive() then complete({ ok = false, error = 'Action cancelled' }); return end
                    if not result.ok then complete({ ok = false, error = result.error or 'Action rejected' }); return end
                    if result.clientAction then
                        -- The context key is absent from the server request above,
                        -- so this is the only check that RPC latency has not
                        -- retargeted the effect.
                        refreshContext({ data.menuId }, false)
                        if not contextMatches() then
                            complete({ ok = false, error = 'Action context changed; select the object again' }); return
                        end
                        local success, failure = A.execute(result.owner, result.clientAction, result.value, {
                            isActive = isActive, event = actionEvent, ctrl = ctrl,
                            capabilities = type(result.capabilities) == 'table' and result.capabilities or {},
                        })
                        if not success then complete({ ok = false, error = failure }); return end
                        if not isActive() then complete({ ok = false, error = 'Action cancelled' }); return end
                        local dispatcher = A.get(result.owner)
                        local name = data.itemId:sub(#result.owner + 2)
                        if dispatcher and (selected.kind == 'select' or selected.kind == 'slider'
                            or (selected.kind == 'toggle' and dispatcher:state(name) == nil)) then
                            dispatcher:publish(name, { value = data.value })
                        end
                    elseif result.patch then patch(result.patch) end
                    C.invalidate()
                    complete({ ok = true })
                end)
                if not ok then
                    log('Action failed: ' .. tostring(err))
                    complete({ ok = false, error = 'Runtime action error' })
                end
            end)
        end)
    end)
end

-- A deep link walks the same entry hooks and presentation as browser navigation,
-- because a listed page is not necessarily an openable one: entry hooks refuse on
-- situation and presentation can drop a page. Run before focus is taken, so a
-- failure opens nothing rather than drawing a half-built page.
local function landOn(menuId)
    if not snapshotIndices[menuId] then return false, 'Menu unavailable' end
    local raw
    for _, menu in ipairs(rawSnapshot.menus) do if menu.id == menuId then raw = menu end end
    if not raw then return false, 'Menu unavailable' end
    local context = { isActive = function() return true end, fromMenuId = interface.root.id,
        reason = 'enter', menu = S.copy(raw) }
    local ok, entered, entryError = pcall(runEntryHooks, menuId, 'enter', context)
    if not ok then return false, tostring(entered) end
    if not entered then return false, entryError or 'Menu entry rejected' end
    C.invalidate()
    local page
    for _, candidate in ipairs(refreshContext({ menuId }, false)) do
        if candidate.id == menuId then page = candidate end
    end
    if not page then return false, 'Menu unavailable' end
    local previous = selectedMenuId
    selectedMenuId = menuId
    if previous ~= menuId then notify('page', menuId, previous) end
    return true
end

-- Every way into the menu funnels through here: the command, both keybinds, the
-- per-page slots and the OpenMenu export. The snapshot request is the permission
-- check, since the server answers it with the asking player's ACE-filtered tree.
openMenu = function(menuId, onResult)
    local function report(ok, err)
        if onResult then onResult(ok, err) end
        return ok, err
    end
    if visible then close(); return report(false, 'Menu is already open') end
    if not ready or opening or busy or stopping then return report(false, 'Menu is not ready') end
    opening = true
    local generation = epoch
    request({ kind = 'snapshot' }, function(result)
        opening = false
        if stopping or generation ~= epoch then report(false, 'Menu closed'); return end
        if not result.ok then
            log(tostring(result.error or 'Cannot open menu'))
            report(false, result.error or 'Cannot open menu'); return
        end
        if not applySnapshot(result.snapshot) then report(false, 'Invalid snapshot'); return end
        if menuId then
            local landed, err = landOn(menuId)
            if not landed then
                log(('Cannot open %s: %s'):format(menuId, tostring(err)))
                report(false, err); return
            end
            -- The same anchoring applySnapshot does; without it the browser renders
            -- a placeholder as a real page.
            snapshot.menuId = menuId
            send(WIRE.snapshot, snapshot)
        end
        focus(true)
        report(true)
    end)
    return true
end

-- Per-page keybinds ("F6 opens Vehicle Options"). Because RegisterKeyMapping only
-- takes effect while the resource is starting, a binding cannot be created on
-- demand: every slot is declared here at load with an empty default key, and
-- BindMenuKey assigns only its target afterwards. Labels are fixed at start for the
-- same reason, so a claimed slot reads as a numbered slot.
--
-- The target is an id, not a grant: pressing the key runs openMenu, which re-checks
-- against a fresh ACE-filtered snapshot.

local menuKeySlots = {}

local function installCommands()
    if not _TLIB_IS_FIVEM then return end
    RegisterCommand(settings.command, function()
        -- The interface may refuse an open without saying why; only the configuring
        -- resource can judge which binding fired.
        if not visible and S.callable(interface.canOpen) then
            local ok, allowed = pcall(interface.canOpen)
            if ok and allowed == false then return end
        end
        openMenu()
    end, false)
    RegisterKeyMapping(settings.command, settings.label, 'keyboard', settings.key)
    -- Without a pad mapping a controller player cannot open the menu at all.
    RegisterKeyMapping(settings.command, settings.label .. ' (Controller)', 'pad_digitalbuttonany', settings.padKey)
    MenuInput.bindSearchKey(settings.command .. '_search', settings.searchKey, 'Search the open menu')

    for slot = 1, settings.keySlots do
        menuKeySlots[slot] = false
        local command = ('%s_page%d'):format(settings.command, slot)
        RegisterCommand(command, function()
            local target = menuKeySlots[slot]
            -- An unclaimed slot does nothing rather than falling back to the root
            -- menu, which would make every spare slot a second open key.
            if target then openMenu(target.menu) end
        end, false)
        RegisterKeyMapping(command, ('Open a menu page (slot %d)'):format(slot), 'keyboard', '')
    end
end

function MC.bindKey(owner, menuId)
    if not S.id(menuId) then return false, 'Invalid menu ID' end
    for slot = 1, #menuKeySlots do
        local target = menuKeySlots[slot]
        if target and target.menu == menuId then return false, 'Menu is already bound' end
    end
    for slot = 1, #menuKeySlots do
        if not menuKeySlots[slot] then
            menuKeySlots[slot] = { menu = menuId, owner = owner }
            return true, ('%s_page%d'):format(settings.command, slot)
        end
    end
    return false, 'No spare key binding slots'
end

-- Walks every authorized page through the real entry and presentation path, then
-- lets the browser judge each one with its production validator. Nothing is
-- activated; this only enters pages.

local selftesting, selftestPending = false, nil

-- Owners raise deliberate refusals with error(message, 0), which carries no
-- "file:line:" prefix. Anything that does is a crash, not a situation.
local function selftestRefusal(err)
    return tostring(err):match('^.-%.lua:%d+:') == nil
end

local function selftestStatic(report)
    local rootId = interface.root.id
    local byId, reachable, missing = {}, { [rootId] = true }, {}
    local rows = {}
    for _, menu in ipairs(rawSnapshot.menus) do
        byId[menu.id] = menu
        for _, item in ipairs(menu.items) do rows[item.id] = menu.id end
    end
    local function walk(start)
        if reachable[start] and start ~= rootId then return end
        reachable[start] = true
        local queue = { start }
        while #queue > 0 do
            local menu = byId[table.remove(queue)]
            for _, item in ipairs(menu and menu.items or {}) do
                local target = item.menu or item.nextMenu
                if target then
                    if not byId[target] then
                        if not missing[menu.id .. item.id] then
                            missing[menu.id .. item.id] = true
                            report[#report + 1] = ('%s: item %s points at missing menu %s'):format(menu.id, item.id, target)
                        end
                    elseif not reachable[target] then
                        reachable[target] = true
                        queue[#queue + 1] = target
                    end
                end
            end
        end
    end
    walk(rootId)
    -- Some pages are opened by a button rather than a submenu link, declared by
    -- their owner through `openedBy`. The declaration is still checked: the named
    -- row must exist and be reachable. Repeated until the set stops growing, since
    -- one such page can carry the button for another.
    local declared = {}
    for _, spec in pairs(hooks) do
        for menuId, itemId in pairs(spec.openedBy or {}) do declared[menuId] = itemId end
    end
    local progressed = true
    while progressed do
        progressed = false
        for id, row in pairs(declared) do
            if rows[row] and reachable[rows[row]] and byId[id] then
                declared[id] = nil; progressed = true; walk(id)
            end
        end
    end
    for id, row in pairs(declared) do
        if not byId[id] then
            report[#report + 1] = ('%s: declared as opened by %s but is not a registered menu'):format(id, row)
        elseif not rows[row] then
            report[#report + 1] = ('%s: declared as opened by %s, which is not on any page'):format(id, row)
        else
            report[#report + 1] = ('%s: opened by %s, which is itself unreachable'):format(id, row)
        end
    end
    for _, menu in ipairs(rawSnapshot.menus) do
        if not reachable[menu.id] then
            report[#report + 1] = ('%s: authorized but not reachable from the root menu'):format(menu.id)
        end
    end
end

local function installSelftest()
    if not _TLIB_IS_FIVEM then return end
    RegisterCommand('tlib_menu_selftest', function()
        if selftesting then log('Self-test is already running'); return end
        if visible then log('Close the menu before running the self-test'); return end
        if not ready or busy or stopping then log('Menu is busy; try again in a moment'); return end
        selftesting = true
        local generation = epoch
        request({ kind = 'snapshot' }, function(result)
            if stopping or generation ~= epoch then selftesting = false; return end
            if not result.ok or not applySnapshot(result.snapshot) then
                selftesting = false
                log('Self-test could not load your permissions: ' .. tostring(result.error or 'invalid snapshot'))
                return
            end
            Platform.createThread(function()
                local problems, skipped, checked, slice = {}, {}, 0, Platform.now()
                selftestStatic(problems)
                for _, menu in ipairs(rawSnapshot.menus) do
                    local id = menu.id
                    local context = { isActive = function() return true end, fromMenuId = interface.root.id,
                        reason = 'enter', menu = S.copy(menu) }
                    local entered, entryError = pcall(runEntryHooks, id, 'enter', context)
                    if not entered then
                        if selftestRefusal(entryError) then
                            skipped[#skipped + 1] = ('%s: %s'):format(id, tostring(entryError))
                        else
                            problems[#problems + 1] = ('%s: entry crashed: %s'):format(id, tostring(entryError))
                        end
                    elseif entryError == false then
                        skipped[#skipped + 1] = ('%s: %s'):format(id, 'entry refused')
                    else
                        C.invalidate()
                        local ok, presented = pcall(refreshContext, { id }, false)
                        if not ok then
                            problems[#problems + 1] = ('%s: presentation crashed: %s'):format(id, tostring(presented))
                        else
                            local page
                            for _, candidate in ipairs(presented) do if candidate.id == id then page = candidate end end
                            if not page then
                                -- Authorized and reachable, but presentation drops
                                -- it: opening it in game gives "Menu unavailable".
                                problems[#problems + 1] = ('%s: listed in the menu but cannot be opened'):format(id)
                            else
                                checked = checked + 1
                                send(WIRE.selftest, { menu = page, done = false })
                            end
                        end
                    end
                    if Platform.now() - slice >= 4 then Platform.wait(0); slice = Platform.now() end
                end
                selftestPending = { problems = problems, skipped = skipped, checked = checked }
                send(WIRE.selftest, { done = true })
                -- Bounded window, so a closed or broken UI still produces a report.
                Platform.setTimeout(function()
                    if selftestPending then
                        selftestPending = nil
                        selftesting = false
                        log('Self-test: the interface did not respond; only static checks ran')
                        for _, line in ipairs(problems) do log('  ' .. line) end
                        for _, line in ipairs(skipped) do log('  skipped ' .. line) end
                    end
                end, 15000)
            end)
        end)
    end, false)

    nui(CALLBACK.selftest, function(data, finish)
        finish({ ok = true })
        local state = selftestPending
        if not state then return end
        selftestPending = nil
        selftesting = false
        local problems = state.problems
        for _, entry in ipairs(type(data) == 'table' and data.results or {}) do
            if type(entry) == 'table' and type(entry.error) == 'string' then
                problems[#problems + 1] = tostring(entry.error)
            end
        end
        log(('Self-test: %d menus presented, %d problem(s)'):format(state.checked, #problems))
        for _, line in ipairs(problems) do log('  ' .. line) end
        if #problems == 0 then log('Every authorized menu is reachable and renders validly.') end
        -- Not failures: these pages depend on where the player is standing.
        if #state.skipped > 0 then
            log(('%d page(s) need a different situation to test:'):format(#state.skipped))
            for _, line in ipairs(state.skipped) do log('  ' .. line) end
        end
    end)
end

--- Configure the one interface. Last caller wins: menu namespaces are per owner,
--- but there is a single screen, so the root title, branding and locale cannot be.
function MC.configure(owner, spec)
    if type(spec) ~= 'table' then return false, 'An interface configuration must be a table' end
    local root = type(spec.root) == 'table' and spec.root or {}
    if root.id ~= nil and (type(root.id) ~= 'string' or root.id == '' or root.id:find(':', 1, true)) then
        return false, 'The root menu id must be a bare name'
    end
    if root.title ~= nil and not S.text(root.title, 128) then return false, 'Invalid root title' end
    if root.description ~= nil and not S.text(root.description, 512) then return false, 'Invalid root description' end
    if spec.locale ~= nil and not localeTag(spec.locale) then return false, 'Invalid locale tag' end
    if spec.canOpen ~= nil and not S.callable(spec.canOpen) then return false, 'canOpen must be a function' end
    if spec.branding ~= nil and type(spec.branding) ~= 'table' then return false, 'Branding must be a table' end
    local previousRoot = interface.root.id
    interface = {
        owner = owner,
        root = { id = root.id or 'main', title = root.title or 'Menu', description = root.description },
        locale = spec.locale,
        branding = spec.branding,
        canOpen = spec.canOpen,
    }
    -- The empty tree is built from the root, so a rename with no snapshot in hand
    -- has to move the placeholder the client currently holds.
    if rawSnapshot.menus[1] and rawSnapshot.menus[1].id == previousRoot then
        rawSnapshot.menus[1].id = interface.root.id
        rawSnapshot.menus[1].title = interface.root.title
    end
    if selectedMenuId == previousRoot then selectedMenuId = interface.root.id end
    -- The root page is an input to hydration, so the same manifest now hydrates
    -- differently.
    forgetManifest()
    pushLocale()
    pushBranding()
    return true
end

--- Publish a resource's catalog builder. Called with a checkpoint function the
--- builder should call periodically so it can yield.
function MC.registerCatalogProvider(owner, provider)
    if not S.callable(provider) then return false, 'A catalog provider must be a function' end
    providers[owner], catalogs[owner] = provider, nil
    -- A catalog is the other input to hydration, so a resource restarting with an
    -- identical catalog must not be handed the tree built by its previous copy.
    forgetManifest()
    -- Built during start-up rather than inside the player's first open, where it
    -- measured 570ms of a 650ms open on tMenu's catalog. Queued rather than
    -- immediate so it does not borrow the owning resource's own start-up frame.
    Platform.createThread(function()
        Platform.wait(0)
        catalogFor(owner)
    end)
    return true
end

function MC.registerHooks(owner, spec)
    if type(spec) ~= 'table' then return false, 'Menu hooks must be a table' end
    for _, field in ipairs({ 'enter', 'leave', 'close', 'page', 'selection', 'snapshot' }) do
        if spec[field] ~= nil and not S.callable(spec[field]) then
            return false, 'hooks.' .. field .. ' must be a function'
        end
    end
    if spec.openedBy ~= nil and type(spec.openedBy) ~= 'table' then return false, 'hooks.openedBy must be a table' end
    hooks[owner] = spec
    -- A restarted consumer has never been told about the tree, even if it has not
    -- changed since the previous resource of this name heard about it.
    forgetManifest()
    return true
end

--- Navigate from inside a running action handler. The page must be one the player
--- already holds, so this can route but never widen.
function MC.navigate(menuId)
    if not busy or not S.id(menuId) then return false end
    for _, menu in ipairs(rawSnapshot.menus) do
        if menu.id == menuId then actionNavigation = menuId; return true end
    end
    return false
end

function MC.isVisible() return visible end

--- The pages this player currently holds, in listed order. Lets a resource discover
--- what is registered without being handed the rows.
function MC.stackIds()
    local ids = {}
    for _, menu in ipairs(rawSnapshot.menus) do ids[#ids + 1] = menu.id end
    return ids
end

--- Programmatic open, so an in-world interaction can put the player straight on its
--- own page.
---
--- Returns whether the request was accepted. The open itself needs a server round
--- trip; a later rejection shows up as the console line in openMenu and the opened
--- event never firing.
function MC.open(menuId)
    if menuId ~= nil and not S.id(menuId) then return false, 'Invalid menu ID' end
    -- Unlike the command, this does not toggle.
    if visible then return false, 'Menu is already open' end
    if not ready or opening or busy or stopping then return false, 'Menu is not ready' end
    -- A fast answer for the ordinary mistakes, not the authority: openMenu re-checks
    -- against a fresh snapshot, since a grant can be revoked in between.
    if menuId and not snapshotIndices[menuId] then return false, 'Menu unavailable' end
    return openMenu(menuId)
end

--- The counterpart to MC.open, running the same teardown as the close key rather
--- than a second way out with its own rules. Does not toggle: closing a menu that
--- is not open is a no-op.
---
--- `busy` deliberately does not block here. An action in flight is when the close
--- key is needed most, and close() answers every outstanding request with
--- 'Menu closed' rather than leaving it hanging.
function MC.close()
    if not visible then return false, 'Menu is not open' end
    if stopping then return false, 'Menu is not ready' end
    close()
    return true
end

--- Release a stopped resource's slot, hooks, catalog, presenter and dispatcher.
--- Without this, reloading one during development consumes a key slot each time and
--- leaves its effects ticking against handlers that no longer exist.
function MC.dropOwner(name)
    for slot = 1, #menuKeySlots do
        local target = menuKeySlots[slot]
        if target and target.owner == name then menuKeySlots[slot] = false end
    end
    hooks[name], providers[name], catalogs[name] = nil, nil, nil
    forgetManifest()
    if strings[name] then
        strings[name] = nil
        send(WIRE.strings, { owner = name })
    end
    C.unregister(name)
    A.dropOwner(name)
end

function MC.init(handle)
    ui = handle
    -- input.lua speaks in bare names so protocol strings stay in this file.
    MenuInput.bindSender(function(name, value)
        send(WIRE[name] or ('menu:' .. name), value)
    end)
    -- An effect's lifecycle needs the kind of row that owns it: publishing a boolean
    -- onto a list would overwrite the selected option.
    A.setItemResolver(function(owner, name)
        local itemId = owner .. ':' .. name
        for _, menu in ipairs(rawSnapshot.menus) do
            for _, item in ipairs(menu.items) do
                if item.id == itemId then return item end
            end
        end
        return nil
    end)
    installCallbacks()
    installCommands()
    installSelftest()
    MC.registerApi()

    Platform.onResourceStop(function(name) MC.dropOwner(name) end)
    Platform.onShutdown(function()
        stopping = true
        close()
        A.cleanupAll()
        MenuInput.cleanup()
        if MenuPrompt then MenuPrompt.release() end
    end)
end

-- Every dispatcher shares one publisher and one effects watcher, because both are
-- about the screen rather than the owner.
local function bindDispatcher(dispatcher)
    dispatcher:bindPublisher(function()
        -- Refresh once after an action publishes all its fields, and never render a
        -- hidden page for a closed-menu effect or snapshot reconciliation.
        if visible and not busy and not applyingSnapshot then refreshContext() end
    end)
    dispatcher:onEffectsChanged(function(active)
        if active then startPermissionWatch() end
    end)
    return dispatcher
end

--- The action dispatcher for one resource, wired to this screen.
function MC.actions(owner)
    local existing = A.get(owner)
    if existing then return existing end
    -- A new dispatcher has not had its permissions synced, and that sync happens
    -- when a tree is applied.
    forgetManifest()
    return bindDispatcher(A.forOwner(owner))
end

-- Ownership is taken from the host where it knows the caller, from the caller where
-- it does not, and a mismatch is refused rather than corrected.
--
-- Everything here crosses an export boundary, which on FiveM copies tables and
-- passes functions by reference. Hence the presenter returning its projection
-- rather than mutating one, the catalog provider returning a catalog rather than
-- filling one in, and rows being patched by name.

--- True for a plain function and for the callable table a function becomes once
--- it has crossed an export boundary. See the note in `SubmitFeedback` below.
local function isCallable(value)
    if type(value) == 'function' then return true end
    local mt = getmetatable(value)
    return type(mt) == 'table' and mt.__call ~= nil
end

local function ownerOf(declared)
    local invoking = Platform.getInvokingResource and Platform.getInvokingResource()
    if invoking then
        if declared ~= nil and declared ~= invoking then return nil, 'Declared owner does not match the calling resource' end
        return invoking
    end
    if type(declared) == 'string' and declared ~= '' then return declared end
    return nil, 'This platform cannot identify the caller; pass the owning resource name explicitly'
end

local function api(name, fn)
    Platform.export('tLib', name, fn)
end

function MC.registerApi()
    api('ConfigureMenuInterface', function(spec, declaredOwner)
        local owner, err = ownerOf(declaredOwner)
        if not owner then return false, err end
        return MC.configure(owner, spec)
    end)

    api('RegisterMenuStrings', function(dictionaries, declaredOwner)
        local owner, err = ownerOf(declaredOwner)
        if not owner then return false, err end
        return MC.registerStrings(owner, dictionaries)
    end)

    api('RegisterMenuCatalogProvider', function(provider, declaredOwner)
        local owner, err = ownerOf(declaredOwner)
        if not owner then return false, err end
        return MC.registerCatalogProvider(owner, provider)
    end)

    api('RegisterMenuHooks', function(spec, declaredOwner)
        local owner, err = ownerOf(declaredOwner)
        if not owner then return false, err end
        return MC.registerHooks(owner, spec)
    end)

    api('RegisterMenuPresenter', function(spec, declaredOwner)
        local owner, err = ownerOf(declaredOwner)
        if not owner then return false, err end
        return C.register(owner, spec)
    end)

    api('UnregisterMenuPresenter', function(declaredOwner)
        local owner, err = ownerOf(declaredOwner)
        if not owner then return false, err end
        return C.unregister(owner)
    end)

    --- Client-side action handlers as a table of name -> function, registered in one
    --- call so a resource with two hundred rows does not make two hundred export
    --- calls at boot. All or nothing: the table is validated before any of it is
    --- installed, so a typo halfway down leaves nothing half-registered.
    api('RegisterMenuActions', function(handlers, declaredOwner)
        local owner, err = ownerOf(declaredOwner)
        if not owner then return false, err end
        if type(handlers) ~= 'table' then return false, 'Action handlers must be a table' end
        local dispatcher = MC.actions(owner)
        for name, handler in pairs(handlers) do
            if type(name) ~= 'string' or name == '' or not S.callable(handler) then
                return false, 'Every action handler must be a named function'
            end
            if dispatcher:has(name) then return false, 'Duplicate action: ' .. name end
        end
        for name, handler in pairs(handlers) do dispatcher:register(name, handler) end
        return true
    end)

    --- Start or stop an effect: a handler that keeps running after its row was
    --- activated. Called from inside that row's handler, and re-checked against the
    --- player's grants for as long as it runs.
    api('SetMenuEffect', function(name, enabled, definition, declaredOwner)
        local owner, err = ownerOf(declaredOwner)
        if not owner then return false, err end
        if type(name) ~= 'string' or name == '' then return false, 'Invalid effect name' end
        local ok, failure = pcall(function() MC.actions(owner):setEffect(name, enabled == true, definition) end)
        return ok, not ok and tostring(failure) or nil
    end)

    api('PublishMenuItem', function(name, changes, declaredOwner)
        local owner, err = ownerOf(declaredOwner)
        if not owner then return false, err end
        if type(name) ~= 'string' or name == '' then return false, 'Invalid action name' end
        local ok, failure = pcall(function() MC.actions(owner):publish(name, changes) end)
        return ok, not ok and tostring(failure) or nil
    end)

    api('GetMenuItemState', function(name, declaredOwner)
        local owner = ownerOf(declaredOwner)
        if not owner or type(name) ~= 'string' then return nil end
        return MC.actions(owner):state(name)
    end)

    -- Shares the dispatcher with approved menu actions but makes no server request
    -- and grants no ACE; the owning feature gates its own local invocation.
    api('ExecuteMenuAction', function(name, value, context, declaredOwner)
        local owner, err = ownerOf(declaredOwner)
        if not owner then return false, err end
        return MC.actions(owner):execute(name, value, context)
    end)

    api('SetMenuItemState', function(name, value, declaredOwner)
        local owner, err = ownerOf(declaredOwner)
        if not owner then return false, err end
        if type(name) ~= 'string' or name == '' then return false, 'Invalid action name' end
        if type(value) ~= 'boolean' and type(value) ~= 'string' and type(value) ~= 'number' then
            return false, 'Invalid state value'
        end
        MC.actions(owner):state(name, value)
        return true
    end)

    api('OnMenuActionsCleanup', function(fn, declaredOwner)
        local owner, err = ownerOf(declaredOwner)
        if not owner then return false, err end
        if not S.callable(fn) then return false, 'A cleanup handler must be a function' end
        MC.actions(owner):onCleanup(fn)
        return true
    end)

    api('OnMenuActionsPersist', function(fn, declaredOwner)
        local owner, err = ownerOf(declaredOwner)
        if not owner then return false, err end
        if not S.callable(fn) then return false, 'A persist handler must be a function' end
        MC.actions(owner):onPersist(fn)
        return true
    end)

    --- Claim a spare key-binding slot for a page. Returns the command name the slot
    --- runs under, which is how the player's keybind list shows it.
    api('BindMenuKey', function(menuId, declaredOwner)
        local owner, err = ownerOf(declaredOwner)
        if not owner then return false, err end
        return MC.bindKey(owner, menuId)
    end)

    -- For a resource whose settings live in a tLib DIALOG rather than a menu, and
    -- which therefore never gets the row the menu injects into an owner's root
    -- page. tRadio's /tradio is the first.
    --
    -- IT GOES THROUGH THE MENU'S CHANNEL ON PURPOSE. That channel already carries
    -- the correlation id, the rate limiter, the timeout and the drop sweep, and
    -- re-deriving all four behind a second net event is exactly what
    -- server/sv_feedback.lua's header declines to do. `request` has never been
    -- gated on the menu being visible -- the visibility check lives in the NUI
    -- callback, not here -- so nothing had to be loosened for this.
    --
    -- The owner is the CALLING resource, not an argument, so a message cannot be
    -- attributed to a resource that did not ask for it.
    api('SubmitFeedback', function(message, callback, declaredOwner)
        local owner, err = ownerOf(declaredOwner)
        if not owner then return false, err end
        if type(message) ~= 'string' or message == '' then return false, 'A message is required' end
        -- NOT `type(callback) == 'function'`. MEASURED on a live server: a
        -- function passed across a FiveM export boundary arrives as a callable
        -- TABLE with a `__call` metamethod, not as a function, so that test
        -- rejected every real caller while the value was perfectly callable --
        -- and the caller got a refusal it had no reason to expect. The paragraph
        -- above says functions cross "by reference", which is true and is not
        -- the same as crossing as a `function`.
        if not isCallable(callback) then return false, 'A callback is required' end
        request({ kind = 'feedback', message = message, resource = owner }, callback)
        return true
    end)

    -- Unscoped: these act on the screen, which belongs to the player, and none can
    -- widen what that player may see. OpenMenu re-checks against a fresh snapshot.
    api('OpenMenu', function(menuId) return MC.open(menuId) end)
    api('CloseMenu', function() return MC.close() end)
    api('IsMenuVisible', function() return MC.isVisible() end)
    api('GetMenuStackIds', function() return MC.stackIds() end)
    api('NavigateMenu', function(menuId) return MC.navigate(menuId) end)
    api('SetMenuLocale', function(tag) return MC.setLocale(tag) end)
    api('GetMenuLocale', function() return MC.getLocale() end)
    api('SetMenuAnchor', function(value) return MC.setAnchor(value) end)
    api('SetMenuPalettes', function(value) return MC.setPalettes(value) end)
    api('InvalidateMenuContext', function() C.invalidate(); return true end)

    --- Ask the player to type something using the game's onscreen keyboard. Blocks
    --- until they commit or cancel, so it is callable only from inside an action
    --- handler; `context` is the one that handler was given.
    api('PromptMenuText', function(title, initial, maximum, context)
        local ok, result = pcall(MenuPrompt.text, title, initial, maximum, context)
        if not ok then return nil, tostring(result) end
        return result
    end)
end

return MenuClient
