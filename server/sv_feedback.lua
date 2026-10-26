-- The feedback door: one player's message, on its way to TIMMYG Studios.
--
-- Lua, not part of server/lib/feedback/index.ts (same split sv_telemetry.lua
-- documents): the HTTP call and charset mapping live in the bundle, but this
-- file needs `StudioApi.baseUrl()`, the menu registry's namespace table, and
-- the per-player clock the limiter runs on.
--
-- Registers no net event of its own -- requests arrive through the menu's
-- existing request channel (`kind = 'feedback'` in sv_menu.lua), reusing its
-- correlation ids, rate limiter, timeout and drop sweep. The `SubmitFeedback`
-- export (client/cl_menu.lua), for resources whose settings live in a tLib
-- dialog, sends down this same channel.

if _TLIB_SIDE ~= 'server' then return end

local log = Logger.create('tLib/feedback')

MenuFeedback = {}
local F = MenuFeedback

--- tWeb's `SUPPORT_MESSAGE_MAX`. A longer body is a 400 there, so it is a
--- refusal here rather than a silent truncation of what somebody wrote.
F.messageMax = 2000

--- One message per player per minute. Sized against tWeb's limit: that endpoint
--- allows ten/minute PER IP, and for a game server an IP is the whole server --
--- a per-player minute means it takes ten different players in one minute to
--- exhaust it, not one person leaning on a key.
F.perPlayerMs = 60000

--- And a server-wide ceiling under tWeb's ten, so a full lobby cannot spend the
--- operator's whole allowance in one burst and leave the next person's message
--- rejected by a limiter they cannot see.
F.perServerPerMinute = 6

local lastByPlayer = {}
local windowStartedAt, windowCount = 0, 0

Platform.onPlayerDropped(function(src)
    if src then lastByPlayer[src] = nil end
end)

--- Which resource a message is about. The client's claim is checked, not
--- trusted (neither test is `GetResourceState`, which would accept any
--- unrelated resource). An unrecognised name is dropped rather than refused --
--- the message is the product, attribution is the aid, so a forged name only
--- costs the row its resource column. Two tests because there are two
--- surfaces: a menu form's name is in the menu registry; a dialog form (no
--- page, no namespace -- tRadio is the first) is checked against the manifest
--- key every consumer declares. A forged name can therefore only name another tLib consumer.
local function attributedResource(claimed)
    if type(claimed) ~= 'string' or claimed == '' then return nil end
    local registry = MenuEngine and MenuEngine.registry
    if registry and registry.namespaces[claimed] then return claimed end
    local ok, pinned = pcall(GetResourceMetadata, claimed, 'tlib_min_version', 0)
    if ok and type(pinned) == 'string' and pinned ~= '' then return claimed end
    return nil
end

local function versionOf(resource)
    if not resource then return nil end
    local ok, value = pcall(GetResourceMetadata, resource, 'version', 0)
    if ok and type(value) == 'string' and value ~= '' then return value end
    return nil
end

--- Returns false plus a reason key when the send was not even attempted.
---
--- Every reason is one of the keys the NUI has copy for. A reason string
--- invented here would reach the dialog untranslated and read as a crash.
local function admit(src)
    local now = Platform.now()
    local last = lastByPlayer[src]
    if last and now >= last and (now - last) < F.perPlayerMs then return false, 'rate-limited' end
    if now - windowStartedAt >= 60000 then
        windowStartedAt, windowCount = now, 0
    end
    if windowCount >= F.perServerPerMinute then return false, 'rate-limited' end
    -- Stamped on ADMISSION, which is also what stops a second press racing the
    -- first while the HTTP call is still out.
    lastByPlayer[src] = now
    windowCount = windowCount + 1
    return true
end

--- `finish` is called exactly once with `{ ok = boolean, error = reasonKey }`.
---
--- Nothing identifying is assembled here. Not the player's name, not a
--- licence, not a Steam or Discord id, not the server's name or endpoint. The
--- bundle attaches the per-install id if one exists and nothing else; see the
--- header of server/lib/feedback/index.ts.
function F.submit(src, body, finish)
    if type(body) ~= 'table' or type(body.message) ~= 'string' then
        finish({ ok = false, error = 'invalid' }); return
    end
    local message = body.message
    if #message == 0 or #message > F.messageMax then
        finish({ ok = false, error = 'invalid' }); return
    end

    local allowed, reason = admit(src)
    if not allowed then
        finish({ ok = false, error = reason }); return
    end

    local resource = attributedResource(body.resource)
    local payload = json.encode({
        baseUrl = StudioApi.baseUrl(),
        message = message,
        resource = resource,
        resourceVersion = versionOf(resource),
    })

    local answered = false
    local function answer(result)
        if answered then return end
        answered = true
        finish(result)
    end
    -- `PerformHttpRequest` has no timeout; this backstop must stay under the
    -- menu channel's own timeout (`tlib_menu_request_timeout_ms`, 10s default).
    Platform.setTimeout(function() answer({ ok = false, error = 'unreachable' }) end, 9000)

    -- The request is made here, not in the bundle: `PerformHttpRequest` is not
    -- a global in FXServer's server JS runtime (`Citizen`/`setTick`/`onNet`/
    -- `emitNet`/`exports`/`GetConvar` are; that one is not), so the bundle's
    -- captured handle was nil and every message failed as `unreachable`
    -- instantly. The bundle still owns what to send and how to read the
    -- answer; it no longer owns the sending.
    local ok, err = pcall(function()
        local prepared = json.decode(exports['tLib']:fbPrepare(payload))
        if type(prepared) ~= 'table' or type(prepared.url) ~= 'string' then
            answer({ ok = false, error = type(prepared) == 'table' and prepared.error or 'invalid' })
            return
        end
        PerformHttpRequest(prepared.url, function(status)
            local reason = exports['tLib']:fbClassify(status)
            if reason == nil then answer({ ok = true }); return end
            answer({ ok = false, error = reason })
        end, 'POST', prepared.body, prepared.headers)
    end)
    if not ok then
        log('feedback could not be submitted: ' .. tostring(err), 4)
        answer({ ok = false, error = 'unreachable' })
    end
end
