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

-- The one admin rule, for every marketplace gate.
--
-- This used to be `IsPlayerAceAllowed(src, 'tlib.admin')`, inlined at three
-- call sites (install/uninstall/inspect, the browse read gate, and the
-- inspection re-check on the way back out). That spelling is NOT tLib's admin
-- rule: sv_permission.lua answers `tlib.superadmin` first and treats it as
-- level 2, so `exports.tLib:IsPlayerAdmin` grants a superadmin and the
-- marketplace denied one. A server owner who granted only `tlib.superadmin`
-- had an admin everywhere in tLib except here.
--
-- `shared/imports/permission/` is the consumer-side mirror of this same rule
-- (see its header: it exists because four resources hand-rolled it three ways
-- and drifted). It cannot be used from inside tLib's own VM — fxmanifest ships
-- it in `files{}`, not `server_scripts{}`, because it is loaded by a consumer.
-- So the convergence here is onto the rule it mirrors, which is loaded above
-- this file (fxmanifest server_scripts: sv_permission.lua precedes this one).
--
-- Error text deliberately still names `tlib.admin` — it is the permission an
-- operator is expected to grant, and naming the superadmin alternative in a
-- denial message would only ever be read as advice to escalate.
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
local function reply(p, result)
    if not p.src then return end
    -- Never trust scope supplied by an agent; bind every response to its request.
    TriggerClientEvent('tlib:marketplace:' .. p.action .. 'Result', p.src, {
        ok = result.ok == true, error = result.error,
        slug = p.slug, resource = p.resourceName, resourceName = p.resourceName,
        type = p.itemType, action = p.action, token = p.token,
        requestId = p.requestId, inspection = result.inspection,
        fileCount = result.fileCount, bytesWritten = result.bytesWritten,
        installedAt = result.installedAt,
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

-- ── Demo mode's start-time sweep ────────────────────────────────────────────
--
-- A demo server hands every visitor admin, so anyone can install anything. The
-- promise is that restarting the resource undoes it, and this is where that is
-- kept: on the first type a resource registers after starting, its own agent is
-- asked to uninstall everything it owns.
--
-- Hooked to registration rather than to `onResourceStart` because registration
-- is the point at which the consumer is demonstrably ready -- its Node bundle
-- has loaded and built the agent that receives this, which `onResourceStart`
-- does not guarantee. Once per resource, not once per type: the agent sweeps all
-- of its types in one pass, and a resource registering four types must not
-- trigger four overlapping sweeps of the same directories.
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

    -- ── Cross-product install enforcement ───────────────────────────────────
    --
    -- Everything above proves the CALLER is allowed to install into this
    -- resource. Nothing above proves the ITEM belongs to it. The registry keys
    -- on `resource:type` and writes into that resource's own registered
    -- installPath, so a tELS item could never land in tRadar's directory — but
    -- `tlib:marketplace:install('tRadar', 'ui', '<a-tELS-slug>')` passed every
    -- check and tLib fetched and installed it anyway.
    --
    -- Only install needs this. UNINSTALL AND INSPECT ARE DELIBERATELY NOT
    -- GATED: they act on files already on this server's disk, addressed by the
    -- same `resource:type:slug` tuple that put them there. Gating them would
    -- make a cross-product item installed BEFORE this check existed impossible
    -- to remove, and would put an outbound HTTP call in the way of a local
    -- delete that must keep working when the marketplace is down.
    --
    -- ⚠️ FAILS CLOSED. An unreachable marketplace refuses the install rather
    -- than falling through to it, matching what the bundle-digest check already
    -- does with a missing hash header.
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

-- ── Panel reads: browse and preview ─────────────────────────────────────────
--
-- The panel used to make both of these itself, straight out of CEF, and
-- neither could ever have worked: the marketplace host sends no
-- Access-Control-Allow-Origin, so the browser made each request and then
-- refused to hand a `cfx-nui-tLib` origin the body. Every browse failed, which
-- is why tDetector and tRadar — whose only marketplace UI is that panel —
-- looked like they had no marketplace at all.
--
-- Routing them through here is not only a way around that. It is what lets a
-- request carry the resource secret (see `lib/marketplace/browse.ts`), which is
-- what makes the v2 contract reachable, which is what makes `resource`
-- filtering and `theme` items possible.
--
-- The SOUND preview is deliberately not here. It stays an `<audio>` element
-- pointed at the absolute `preview_url` the listing already carries: an element
-- load is exempt from CORS and needs no credential, and pulling audio bytes
-- through this VM would mean shipping binary across the Lua/JS boundary.
--
-- Read-only, but gated on the same ACE as install: this is an admin panel, and
-- an ungated net event is an outbound request the server pays for on any
-- player's say-so.
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

-- The preview DOCUMENT, as text. The panel reads it rather than just rendering
-- it — it injects the data-hud-* preview script and derives the canvas size
-- from a comment inside the markup — so a cross-origin `<iframe src>` would not
-- do: a frame from another origin cannot be read or scripted by its parent.
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
        -- `src` is the admin who asked for the install, and it is on the payload so
        -- a consumer can TELL them something.
        --
        -- Without it a consumer that needs to report a consequence of the install
        -- -- a sound file being overwritten, say -- has only two options, and all
        -- four consumers picked a different one:
        --
        --   tDetector  TriggerClientEvent(..., -1, ...)  with NO handler anywhere
        --   tRadar     TriggerClientEvent(..., -1, ...)  with NO handler anywhere
        --   tRadio     broadcast to -1, every client filters on its own `isAdmin`
        --   tELS       gave up and logged server-side, with a comment saying why
        --
        -- tELS's comment names the exact cause: retargeting at the installing admin
        -- "is the honest alternative, but `p.src` is known only inside tLib's
        -- sv_marketplace.lua and is not carried on the payload". So the fix belongs
        -- here rather than four times over in the consumers.
        --
        -- May be nil: `:455` clears it when the requesting player disconnects
        -- mid-install. A consumer must treat nil as "nobody to tell" and fall back
        -- to a server log, not broadcast.
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
