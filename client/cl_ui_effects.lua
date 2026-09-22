-- Shared scene-blur leases. Client-only; load after adapter lifecycle/shutdown
-- and before dialog exports. No NUI/CSS blur and no per-frame native calls.
UIEffects = {}

local log = Logger.create('tLib/ui-effects')
local leases, count = {}, 0
local applied, stopped = false, false
local FADE_MS = 200.0

local function supported()
    return _TLIB_IS_FIVEM and _TLIB_SIDE == 'client'
        and type(TriggerScreenblurFadeIn) == 'function'
        and type(TriggerScreenblurFadeOut) == 'function'
end

local function fadeOut(duration)
    if not applied then return end
    local ok, err = pcall(TriggerScreenblurFadeOut, duration)
    if ok and err ~= false then applied = false
    else log('Scene blur fade-out failed: ' .. tostring(err), 3) end
end

-- Internal API: acquireBlur(ownerResource?) -> opaque token, or nil on an
-- unsupported host/shutdown/native failure. Acquire only AFTER granting focus.
-- Each caller retains its token; releasing another caller's token is forbidden.
function UIEffects.acquireBlur(owner)
    if stopped or not supported() then return nil end
    if count == 0 then
        local ok, err = pcall(TriggerScreenblurFadeIn, FADE_MS)
        if not ok or err == false then
            log('Scene blur fade-in failed: ' .. tostring(err), 3)
            return nil
        end
        applied = true
    end
    local token = {}
    leases[token] = { owner = owner }
    count = count + 1
    return token
end

-- Idempotent. Only the final lease fades out, so closing a dialog cannot remove
-- blur held by a layout editor. Unknown/nil tokens do not touch global effects.
function UIEffects.releaseBlur(token)
    if token == nil or leases[token] == nil then return end
    leases[token] = nil
    count = count - 1
    if count == 0 then fadeOut(FADE_MS) end
end

Platform.onResourceStop(function(owner)
    local expired = {}
    for token, lease in pairs(leases) do
        if lease.owner == owner then expired[#expired + 1] = token end
    end
    for _, token in ipairs(expired) do UIEffects.releaseBlur(token) end
end)

Platform.onShutdown(function()
    stopped = true
    leases, count = {}, 0
    -- Finish immediately: no timer/thread can survive resource shutdown.
    fadeOut(0.0)
end)
