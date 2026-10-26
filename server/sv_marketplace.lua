-- Coordinates requests only; the consumer's bundled agent owns download/disk I/O.
local log = Logger.create('tLib/marketplace')
local _typeRegistrations, _locks, _pending = {}, {}, {}
local PENDING_MS, INSPECTION_PENDING_MS = 75000, 10000
local _seq = 0
local function newToken()
    _seq = _seq + 1
    return tostring(GetGameTimer()) .. '-' .. _seq
end

local function name(value, limit, pattern)
    return type(value) == 'string' and #value > 0 and #value <= limit and value:match(pattern) ~= nil
end
local function resourceName(value)
    return name(value, 128, '^[%w_][%w_%-%.]*$') and not value:find('..', 1, true)
end
local function itemType(value) return name(value, 64, '^[%w_][%w_%-]*$') end
local function slugName(value) return name(value, 128, '^[a-z0-9][a-z0-9%-_]*$') end
local function callable(value)
    if type(value) == 'function' then return value end
    local mt = type(value) == 'table' and getmetatable(value)
    if type(mt) == 'table' and type(mt.__call) == 'function' then return value end
end
local function safeScope(value, limit)
    return type(value) == 'string' and #value <= limit and value or ''
end

-- The one admin rule, for every marketplace gate. A bare `IsPlayerAceAllowed(src,
-- 'tlib.admin')` denies a `tlib.superadmin`-only grant, since sv_permission.lua
-- answers that first at level 2; `Permission.isPlayerAdmin` is the rule that
-- agrees with the rest of tLib. Error text still names `tlib.admin` -- it's the
-- permission an operator is expected to grant.
local function isAdmin(src)
    if src == nil then return false end
    return Permission.isPlayerAdmin(src)
end
local inspectionStatuses = {
    managed = true, modified = true, unverified = true, protected = true,
    missing = true, unsafe = true, unavailable = true,
}
local inspectionLocks = {
    absent = true, identified = true, unidentified = true,
    ['recovery-pending'] = true, unavailable = true,
}
local function sanitizeInspection(p, result)
    if not result.ok then return { ok = false, error = 'local management inspection unavailable' } end
    local data = result.inspection
    if type(data) ~= 'table' or type(data.status) ~= 'string' or not inspectionStatuses[data.status]
        or type(data.lock) ~= 'string' or not inspectionLocks[data.lock]
        or type(data.policyAvailable) ~= 'boolean' then
        return { ok = false, error = 'invalid management inspection response' }
    end
    return { ok = true, inspection = {
        resourceName = p.resourceName, type = p.itemType, slug = p.slug,
        status = data.status, lock = data.lock, policyAvailable = data.policyAvailable,
    } }
end
-- No `installedAt` (absolute filesystem path) sent to the client -- it would
-- print the server's directory layout into an admin's console for no reader.
-- Still passed on the server-side lifecycle event below, where it never leaves
-- the host. `fileCount`/`bytesWritten` say how much landed, not where.
local function reply(p, result)
    if not p.src then return end
    -- Never trust scope supplied by an agent; bind every response to its request.
    TriggerClientEvent('tlib:marketplace:' .. p.action .. 'Result', p.src, {
        ok = result.ok == true, error = result.error,
        slug = p.slug, resource = p.resourceName, resourceName = p.resourceName,
        type = p.itemType, action = p.action, token = p.token,
        requestId = p.requestId, inspection = result.inspection,
        fileCount = result.fileCount, bytesWritten = result.bytesWritten,
    })
end
local function release(p)
    _pending[p.token] = nil
    if _locks[p.key] == p.token then _locks[p.key] = nil end
end
local function fail(p, message)
    release(p)
    reply(p, { ok = false, error = message })
end

-- Demo's start-time sweep: a demo server hands every visitor admin, so the
-- promise that restarting undoes any install is kept here, on the first type a
-- resource registers after starting. Hooked to registration rather than
-- onResourceStart because registration is when the consumer's Node bundle has
-- actually loaded the agent. Once per resource, not once per type.
local _demoSwept = {}

AddEventHandler('onResourceStop', function(resource) _demoSwept[resource] = nil end)

local function demoSweep(resource)
    if _demoSwept[resource] then return end
    if not (Demo and Demo.active()) then return end
    _demoSwept[resource] = true
    Demo.sweepMarketplace(resource)
end

Platform.export('tLib', 'RegisterMarketplaceType', function(kind, opts)
    if not itemType(kind) or type(opts) ~= 'table'
        or type(opts.installPath) ~= 'string' or opts.installPath == '' then
        log('RegisterMarketplaceType: invalid type/options', 3)
        return false
    end
    local resource = GetInvokingResource()
    if not resourceName(resource) then
        log('RegisterMarketplaceType: could not resolve invoking resource', 3)
        return false
    end
    local called, ok = pcall(function()
        return exports['tLib']:mpRegisterType(resource, kind, opts.installPath)
    end)
    if not called or not ok then
        log('RegisterMarketplaceType: node bridge rejected registration for "' .. kind .. '"', 3)
        return false
    end
    _typeRegistrations[resource .. ':' .. kind] = {
        resource = resource, onInstall = callable(opts.onInstall), onUninstall = callable(opts.onUninstall),
    }
    demoSweep(resource)
    return true
end)

local function request(action, resource, kind, slug, version, requestId)
    local p = {
        src = source, resourceName = safeScope(resource, 128), itemType = safeScope(kind, 64),
        slug = safeScope(slug, 128), action = action, token = newToken(), ver = version or '',
        requestId = safeScope(requestId, 128),
    }
    if action == 'inspect' and not name(requestId, 128, '^[%w_%-]+$') then
        reply(p, { ok = false, error = 'invalid inspection request identity' })
        return
    end
    if not resourceName(resource) or not itemType(kind) or not slugName(slug)
        or (version ~= nil and (type(version) ~= 'string' or #version > 64
            or (version ~= '' and not version:match('^[a-zA-Z0-9][a-zA-Z0-9%.%-]*$')))) then
        reply(p, { ok = false, error = 'invalid ' .. action .. ' arguments' })
        return
    end
    if not isAdmin(p.src) then
        reply(p, { ok = false, error = 'not authorized (needs tlib.admin ACE)' })
        return
    end
    local regKey = resource .. ':' .. kind
    if not _typeRegistrations[regKey] then
        reply(p, { ok = false, error = 'marketplace resource/type is not registered' })
        return
    end
    p.key = regKey .. ':' .. slug
    if _locks[p.key] then
        reply(p, { ok = false, error = 'marketplace operation already in progress' })
        return
    end
    p.registration = _typeRegistrations[regKey]
    _locks[p.key], _pending[p.token] = p.token, p
    -- Download transport must enforce its 60s absolute deadline. Disk work is
    -- synchronous. This is bookkeeping, NOT cancellation of an old agent's I/O.
    SetTimeout(action == 'inspect' and INSPECTION_PENDING_MS or PENDING_MS, function()
        if _pending[p.token] == p then
            fail(p, action == 'inspect'
                and 'management inspection unavailable; the consumer may need an update'
                or 'marketplace agent timed out after 75 seconds; completion unconfirmed')
        end
    end)
    local payload = { slug = slug, type = kind, token = p.token }
    if action == 'install' then
        -- shared/sh_api.lua, not an inline default: the host and its
        -- normalisation are defined once for every VM.
        local base = StudioApi.baseUrl()
        payload.url = base .. '/api/v1/items/' .. slug .. '/download'
        if p.ver ~= '' then payload.url = payload.url .. '?version=' .. p.ver end
    end
    local agentAction = ({ install = 'Install', uninstall = 'Uninstall', inspect = 'Inspect' })[action]
    local function dispatch()
        -- The ownership check below is asynchronous, so by the time this runs
        -- the request may already have been retired by the pending deadline or
        -- by onResourceStop. Dispatching then would start an install nobody is
        -- waiting for and whose reply would be dropped.
        if _pending[p.token] ~= p then return end
        local ok, err = pcall(TriggerEvent,
            'tlib:marketplace:do' .. agentAction .. ':' .. resource, payload)
        if not ok and _pending[p.token] == p then
            log('marketplace agent dispatch failed: ' .. tostring(err), 3)
            fail(p, 'marketplace agent dispatch failed')
        end
    end

    -- Cross-product install enforcement: everything above proves the caller may
    -- install into this resource, not that the item belongs to it --
    -- `tlib:marketplace:install('tRadar', 'ui', '<a-tLS-slug>')` passed every
    -- other check. Only install needs this; uninstall/inspect act on files
    -- already on disk and must keep working when the marketplace is down.
    -- Fails closed: an unreachable marketplace refuses the install.
    if action ~= 'install' then
        dispatch()
        return
    end
    local asked, askErr = pcall(function()
        exports['tLib']:mpAssertItemResource(resource, slug, function(ok, err)
            if _pending[p.token] ~= p then return end
            if ok then
                dispatch()
                return
            end
            -- Named, not opaque. "Another product owns this" is a refusal an
            -- admin can act on; "marketplace unavailable" is one they retry.
            if err == 'item_resource_mismatch' then
                fail(p, 'marketplace item belongs to another resource; refusing to install it into ' .. resource)
            else
                fail(p, 'could not confirm the marketplace item belongs to ' .. resource
                    .. ' (' .. tostring(err or 'unknown') .. ')')
            end
        end)
    end)
    if not asked and _pending[p.token] == p then
        log('marketplace ownership bridge failed: ' .. tostring(askErr), 3)
        fail(p, 'marketplace ownership check unavailable')
    end
end

RegisterNetEvent('tlib:marketplace:install', function(resource, kind, slug, version)
    request('install', resource, kind, slug, version)
end)
RegisterNetEvent('tlib:marketplace:uninstall', function(resource, kind, slug)
    request('uninstall', resource, kind, slug)
end)
RegisterNetEvent('tlib:marketplace:inspect', function(resource, kind, slug, requestId)
    request('inspect', resource, kind, slug, nil, requestId)
end)

-- Panel reads: browse and preview. A direct NUI fetch of these from CEF is
-- CORS-blocked -- the marketplace host sends no Access-Control-Allow-Origin, so
-- the browser refuses `cfx-nui-tLib` the body. That's why tDetector/tRadar, whose
-- only marketplace UI is this panel, looked like they had no marketplace at all.
-- Routing through here also lets the request carry the resource secret (see
-- `lib/marketplace/browse.ts`), which is what makes `resource` filtering and
-- `theme` items reachable. Sound preview stays an `<audio>` element pointed at
-- the listing's `preview_url` instead -- element loads are CORS-exempt. Gated on
-- the same ACE as install: an ungated net event is an outbound request paid for on any player's say-so.
local READ_MAX_IN_FLIGHT = 3
local _reads = {}

local function readReply(src, action, requestId, payload)
    if not src then return end
    payload.requestId = requestId
    TriggerClientEvent('tlib:marketplace:' .. action .. 'Result', src, payload)
end

-- The shared gate for both reads. Returns a one-shot `settle`, or nil once it
-- has already answered the caller itself.
local function beginRead(src, action, opts)
    if type(opts) ~= 'table' then return end

    -- Without an addressable id the reply cannot be matched to its request, and
    -- answering anyway would let a stale result overwrite a newer one.
    local requestId = safeScope(opts.requestId, 128)
    if not name(requestId, 128, '^[%w_%-]+$') then return end

    if not isAdmin(src) then
        readReply(src, action, requestId, { ok = false, error = 'not authorized (needs tlib.admin ACE)' })
        return
    end

    -- The panel debounces search and discards superseded replies by requestId,
    -- so overlapping requests are normal and must not be refused outright. The
    -- cap exists only so this cannot be used to make the server issue unbounded
    -- outbound requests.
    local inFlight = _reads[src] or 0
    if inFlight >= READ_MAX_IN_FLIGHT then
        readReply(src, action, requestId, { ok = false, error = 'too many marketplace requests in flight' })
        return
    end
    _reads[src] = inFlight + 1

    local settled = false
    return function(payload)
        if settled then return end
        settled = true
        _reads[src] = math.max(0, (_reads[src] or 1) - 1)
        readReply(src, action, requestId, payload)
    end
end

-- The Node side aborts at 10s; this is the backstop for a callback that never
-- arrives at all, so a panel is never left spinning forever.
local function readBackstop(settle)
    SetTimeout(20000, function()
        settle({ ok = false, error = 'marketplace request timed out' })
    end)
end

-- The marketplace's like endpoint de-duplicates on (item, license); that only
-- works if the license is resolved here, server-side, from `source`, via the
-- native -- never from the NUI payload, a convar, or an export argument.
-- `GetPlayerIdentifierByType` is used over walking `GetNumPlayerIdentifiers`
-- because the loop form string-matches prefixes and could return `license2:`/`ip:`.
--
-- This does NOT make the claim verifiable by the marketplace: the outbound
-- request's only credential is the shared resource secret (public by design,
-- identifies a server not a person), so whoever runs the server can bypass this
-- and POST any license. Resistant to a player, not to an operator -- and every
-- reader here goes through `beginRead` (`tlib.admin` ACE), so the population
-- that CAN like in game is the same population that could forge. tWeb's
-- src/lib/marketplace/like-identity.ts carries the design that would close
-- this (Cfx.re account-link, an identity proven at the website's own origin).
local function playerLicense(src)
    if src == nil then return nil end
    local ok, identifier = pcall(GetPlayerIdentifierByType, src, 'license')
    if not ok or type(identifier) ~= 'string' then return nil end
    -- Native answers `license:<40 hex>`; prefix stripped so the backend namespaces
    -- it once as `fivem:<hex>` rather than tolerating two spellings of one player.
    local license = identifier:match('^license:(%x+)$')
    if not license then return nil end
    return license:lower()
end

RegisterNetEvent('tlib:marketplace:browse', function(opts)
    local src = source
    local settle = beginRead(src, 'browse', opts)
    if not settle then return end

    local resource = type(opts.resource) == 'string' and opts.resource or nil
    if resource ~= nil and not resourceName(resource) then
        settle({ ok = false, error = 'invalid browse resource' })
        return
    end
    local kind = type(opts.type) == 'string' and opts.type or nil
    if kind ~= nil and not itemType(kind) then
        settle({ ok = false, error = 'invalid browse type' })
        return
    end
    local limit = type(opts.limit) == 'number' and math.floor(opts.limit) or 50
    if limit < 1 then limit = 1 elseif limit > 100 then limit = 100 end
    local cursor = type(opts.cursor) == 'number' and math.floor(opts.cursor) or 0
    if cursor < 0 then cursor = 0 end

    local params = {
        resource = resource,
        type = kind,
        -- Truncated rather than rejected: a long query is a typo, not an
        -- attack, and refusing it mid-keystroke reads as the panel breaking.
        search = type(opts.search) == 'string' and opts.search:sub(1, 128) or nil,
        sort = opts.sort == 'created_at' and 'created_at' or 'downloads',
        limit = limit,
        cursor = cursor,
        -- Resolved from `src`, never from `opts` (the NUI payload) -- see `playerLicense`.
        -- Lets each item's `liked` flag be this player's own. nil here is
        -- harmless: catalogue and like counts still come back, only `liked` is absent.
        identity = playerLicense(src),
    }

    local dispatched, dispatchErr = pcall(function()
        exports['tLib']:mpBrowse(json.encode(params), function(ok, err, resultJson)
            if not ok then
                settle({ ok = false, error = tostring(err or 'marketplace unavailable') })
                return
            end
            local decoded, parsed = pcall(json.decode, resultJson or '')
            if not decoded or type(parsed) ~= 'table' or type(parsed.items) ~= 'table' then
                settle({ ok = false, error = 'unexpected marketplace response' })
                return
            end
            settle({
                ok = true,
                items = parsed.items,
                total = parsed.total,
                nextCursor = parsed.nextCursor,
                hasMore = parsed.hasMore == true,
            })
        end)
    end)
    if not dispatched then
        log('marketplace browse bridge failed: ' .. tostring(dispatchErr), 3)
        settle({ ok = false, error = 'marketplace bridge unavailable' })
        return
    end
    readBackstop(settle)
end)

-- Like/un-like one item, as the requesting player. Goes through `beginRead`
-- despite being a write, deliberately: it supplies the `tlib.admin` ACE (a
-- weaker gate here would be the one way into an admin-only panel), the
-- requestId binding, and the in-flight cap.
--
-- `next` is the state being asked for, not a toggle -- a retry after the 20s
-- backstop can't invert anything, since the NUI always sends the state it wants.
RegisterNetEvent('tlib:marketplace:like', function(opts)
    local src = source
    local settle = beginRead(src, 'like', opts)
    if not settle then return end

    local slug = type(opts.slug) == 'string' and opts.slug or nil
    if not slugName(slug) then
        settle({ ok = false, error = 'invalid item slug' })
        return
    end

    -- From `src`, not `opts` -- see `playerLicense` for why a payload license defeats de-duplication.
    local license = playerLicense(src)
    if not license then
        -- No fallback id: a synthetic one (server id, name hash) would be new on every
        -- reconnect, turning "one like per person" into "one like per session".
        settle({ ok = false, error = 'no FiveM identity for this player' })
        return
    end

    local dispatched, dispatchErr = pcall(function()
        exports['tLib']:mpLike(slug, license, opts.next == true, function(ok, err, stateJson)
            if not ok then
                settle({ ok = false, error = tostring(err or 'marketplace unavailable') })
                return
            end
            local decoded, parsed = pcall(json.decode, stateJson or '')
            if not decoded or type(parsed) ~= 'table' or type(parsed.likes) ~= 'number' then
                settle({ ok = false, error = 'unexpected marketplace response' })
                return
            end
            settle({
                ok = true,
                slug = slug,
                -- The server's numbers, untouched -- the panel renders these rather
                -- than its own ±1, so the count can't drift from the truth.
                likes = parsed.likes,
                liked = parsed.liked == true,
            })
        end)
    end)
    if not dispatched then
        log('marketplace like bridge failed: ' .. tostring(dispatchErr), 3)
        settle({ ok = false, error = 'marketplace bridge unavailable' })
        return
    end
    readBackstop(settle)
end)

-- The preview document, as text: the panel injects the data-hud-* preview
-- script and derives canvas size from markup, so a cross-origin `<iframe src>`
-- won't do -- a frame from another origin can't be read or scripted by its parent.
RegisterNetEvent('tlib:marketplace:preview', function(opts)
    local src = source
    local settle = beginRead(src, 'preview', opts)
    if not settle then return end

    local slug = type(opts.slug) == 'string' and opts.slug or ''
    if not slugName(slug) then
        settle({ ok = false, error = 'invalid preview slug' })
        return
    end

    local dispatched, dispatchErr = pcall(function()
        exports['tLib']:mpPreviewHtml(slug, function(ok, err, html)
            if not ok or type(html) ~= 'string' then
                settle({ ok = false, error = tostring(err or 'preview unavailable') })
                return
            end
            settle({ ok = true, slug = slug, html = html })
        end)
    end)
    if not dispatched then
        log('marketplace preview bridge failed: ' .. tostring(dispatchErr), 3)
        settle({ ok = false, error = 'marketplace bridge unavailable' })
        return
    end
    readBackstop(settle)
end)

-- The published definition of a `theme` item, as JSON text. A separate read
-- from the preview document above, not a mode of it: a UI document is parsed
-- and rewritten, a theme definition is handed verbatim to tRadio's offline
-- panel, applied through the same code an install does.
RegisterNetEvent('tlib:marketplace:themeJson', function(opts)
    local src = source
    local settle = beginRead(src, 'themeJson', opts)
    if not settle then return end

    local slug = type(opts.slug) == 'string' and opts.slug or ''
    if not slugName(slug) then
        settle({ ok = false, error = 'invalid theme slug' })
        return
    end

    local dispatched, dispatchErr = pcall(function()
        exports['tLib']:mpThemeJson(slug, function(ok, err, json)
            if not ok or type(json) ~= 'string' then
                settle({ ok = false, error = tostring(err or 'theme preview unavailable') })
                return
            end
            settle({ ok = true, slug = slug, json = json })
        end)
    end)
    if not dispatched then
        log('marketplace themeJson bridge failed: ' .. tostring(dispatchErr), 3)
        settle({ ok = false, error = 'marketplace bridge unavailable' })
        return
    end
    readBackstop(settle)
end)

-- Local-only event: never RegisterNetEvent. GetInvokingResource is a runtime
-- stack lookup, not a payload identity. Some local bridges have no invoking VM;
-- nil can only be correlated by pending token, not authenticated as a producer.
AddEventHandler('tlib:marketplace:agentResult', function(result)
    if type(result) ~= 'table' or type(result.token) ~= 'string' or type(result.ok) ~= 'boolean' then return end
    local p = _pending[result.token]
    if not p then return end
    local invoking = GetInvokingResource()
    if invoking ~= nil and invoking ~= p.resourceName then return end
    if p.action == 'inspect' then
        result = sanitizeInspection(p, result)
        if p.src and not isAdmin(p.src) then
            result = { ok = false, error = 'not authorized (needs tlib.admin ACE)' }
        end
    end
    release(p) -- retire before callbacks: duplicate/reentrant results are stale
    local reg = p.registration
    if result.ok and p.action ~= 'inspect' then
        local cb = p.action == 'install' and reg.onInstall or nil
        if p.action == 'uninstall' then cb = reg.onUninstall end
        local meta = { type = p.itemType, version = p.ver, installedAt = result.installedAt }
        if cb then
            local ok, err = pcall(cb, p.slug, meta)
            if not ok then log('marketplace callback errored: ' .. tostring(err), 3) end
        end
        -- `src` (the installing admin) is on the payload so a consumer can tell them
        -- something about a side effect, e.g. an overwritten sound file. Before this,
        -- tDetector/tRadar broadcast to -1 with no handler, tRadio broadcast and
        -- filtered client-side, and tLS gave up and logged server-side -- four
        -- consumers, four workarounds, because `p.src` wasn't on the payload.
        -- May be nil if the requesting player disconnects mid-install; a consumer
        -- must treat nil as "nobody to tell" and fall back to a server log.
        if p.action == 'install' then
            TriggerEvent(p.resourceName .. ':marketplace:installed', p.itemType, p.slug, {
                version = p.ver, installedAt = result.installedAt, src = p.src,
            })
        else
            TriggerEvent(p.resourceName .. ':marketplace:uninstalled', p.itemType, p.slug, {
                src = p.src,
            })
        end
    end
    reply(p, result)
end)

AddEventHandler('onResourceStop', function(stopped)
    for key, reg in pairs(_typeRegistrations) do
        if reg.resource == stopped then _typeRegistrations[key] = nil end
    end
    for _, p in pairs(_pending) do
        if p.resourceName == stopped or stopped == GetCurrentResourceName() then
            fail(p, 'marketplace resource stopped; completion unconfirmed')
        end
    end
end)
AddEventHandler('playerDropped', function()
    local dropped = source
    -- Otherwise the in-flight count leaks a slot per disconnect, and a recycled
    -- player ID inherits someone else's exhausted budget.
    _reads[dropped] = nil
    for _, p in pairs(_pending) do
        -- A disconnect cannot cancel the agent. Keep the lock until result or
        -- deadline, but never send the result to a recycled player ID.
        if p.src == dropped then p.src = nil end
    end
end)
