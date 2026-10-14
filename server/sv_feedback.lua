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
-- drop sweep. A second channel would have had to re-derive all four, and the
-- menu is the only surface this is reachable from.

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
--- THE CLIENT'S CLAIM IS CHECKED, NOT TRUSTED. The dialog is only ever opened
--- from a page a resource owns, so the only legitimate value is a resource that
--- has declared a menu namespace — checked against the registry rather than
--- against `GetResourceState`, which would also accept any unrelated resource on
--- the server. An unrecognised name is DROPPED rather than refused: the message
--- is the product and the attribution is the aid, so a forged name costs the row
--- its resource column and nothing else. That is also tWeb's own stance — the
--- three context fields are optional even when `source` is `game`.
local function attributedResource(claimed)
    if type(claimed) ~= 'string' or claimed == '' then return nil end
    local registry = MenuEngine and MenuEngine.registry
    if not registry or not registry.namespaces[claimed] then return nil end
    return claimed
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
    -- A backstop between the bundle's 8s and the menu channel's 10s: a callback
    -- that never arrives would otherwise leave the player's dialog waiting on
    -- nothing, and answering before the channel gives up is what makes the
    -- reason the player reads the feedback vocabulary rather than the channel's
    -- own 'Server request timed out'.
    Platform.setTimeout(function() answer({ ok = false, error = 'unreachable' }) end, 9000)

    local ok, err = pcall(function()
        exports['tLib']:fbSubmit(payload, function(sent, failure)
            if sent then answer({ ok = true }); return end
            answer({ ok = false, error = type(failure) == 'string' and failure or 'unreachable' })
        end)
    end)
    if not ok then
        log('feedback could not be submitted: ' .. tostring(err), 4)
        answer({ ok = false, error = 'unreachable' })
    end
end

return MenuFeedback
