-- The feedback door: one player's message, on its way to TIMMYG Studios.
--
-- WHY THIS IS LUA AND NOT PART OF server/lib/feedback/index.ts
-- ------------------------------------------------------------
-- The same split sv_telemetry.lua documents. The HTTP call, the charset
-- mapping and the install-id read live in the bundle; this file is the half
-- that needs things only the Lua VM has: `StudioApi.baseUrl()` (the single
-- definition of the studio host and of its normalisation), the menu registry's
-- namespace table, and the per-player clock the limiter runs on.
--
-- IT REGISTERS NO NET EVENT OF ITS OWN. The request arrives through the
-- menu's existing request channel (`kind = 'feedback'` in sv_menu.lua), which
-- already carries correlation ids, a rate limiter, a timeout and a player
-- drop sweep. A second channel would have had to re-derive all four.
--
-- That is still true now that the menu is no longer the only surface: the
-- `SubmitFeedback` export (client/cl_menu.lua) exists for resources whose
-- settings live in a tLib dialog, and it sends down this same channel.

if _TLIB_SIDE ~= 'server' then return end

local log = Logger.create('tLib/feedback')

MenuFeedback = {}
local F = MenuFeedback

--- tWeb's `SUPPORT_MESSAGE_MAX`. A longer body is a 400 there, so it is a
--- refusal here rather than a silent truncation of what somebody wrote.
F.messageMax = 2000

--- One message per player per minute.
---
--- SIZED AGAINST tWeb'S LIMIT, NOT AGAINST A GUESS. That endpoint allows ten
--- a minute PER IP, and for a game server an IP is the whole server — so every
--- player here shares one bucket, and a NAT'd pair of servers shares it with
--- strangers. A per-player minute means it takes ten different players in the
--- same minute to exhaust it, which is a real conversation rather than one
--- person leaning on a key.
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

--- Which resource a message is about.
---
--- THE CLIENT'S CLAIM IS CHECKED, NOT TRUSTED. Neither test is
--- `GetResourceState`, which would accept any unrelated resource on the server.
--- An unrecognised name is DROPPED rather than refused: the message is the
--- product and the attribution is the aid, so a forged name costs the row its
--- resource column and nothing else. That is also tWeb's own stance — the three
--- context fields are optional even when `source` is `game`.
---
--- Two tests, because there are two surfaces. A menu form is opened from a page
--- a resource owns, so its name is in the menu registry. A DIALOG form has no
--- page and no namespace — tRadio is the first — so the second test is the
--- manifest key every consumer already declares, read off the named resource's
--- own manifest. A forged name can therefore still only name another tLib
--- consumer, which is the exposure the paragraph above already accepts.
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
    -- `PerformHttpRequest` HAS NO TIMEOUT, so without this the player's dialog
    -- waits on nothing. It also has to stay UNDER the menu channel's own
    -- timeout (`tlib_menu_request_timeout_ms`, 10s default), or the channel
    -- says "timed out" about a message that may well have been delivered.
    Platform.setTimeout(function() answer({ ok = false, error = 'unreachable' }) end, 9000)

    -- THE REQUEST IS MADE HERE, NOT IN THE BUNDLE, AND THAT IS THE WHOLE
    -- REASON THIS FILE GREW. It used to hand the payload to `fbSubmit` and let
    -- the Node side post it. MEASURED 2026-10-16: `PerformHttpRequest` is not a
    -- global in FXServer's server JS runtime -- `Citizen`, `setTick`, `onNet`,
    -- `emitNet`, `exports` and `GetConvar` all are, that one is not -- so the
    -- bundle's captured handle was nil, calling it threw, and every message
    -- failed as `unreachable` in zero milliseconds. From this VM the same
    -- native returns 201. The bundle still owns what to send and what the
    -- answer meant; it no longer owns the sending.
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
