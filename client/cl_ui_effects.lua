-- Shared scene-blur leases and the reduced-motion preference. Client-only; load
-- after adapter lifecycle/shutdown and before dialog exports. No NUI/CSS blur
-- and no per-frame native calls.
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

-- REDUCED MOTION
--
-- `@media (prefers-reduced-motion: reduce)` DOES NOT WORK IN A FiveM NUI.
-- CEF reports `no-preference` whatever the host OS is set to — measured — so
-- every such block in this estate was coverage that could never fire. The
-- switch that reaches a player is the `--motion` custom property on :root
-- (shared/css/theme-tokens.css); every shared duration multiplies through it,
-- so one write disables all of them.
--
-- Two inputs, player over server, because the server owner is setting a house
-- default and the player is stating an accessibility need:
--
--   tlib_reduce_motion  (convar, `setr`)   server default, 0 or 1
--   tlib.motion         (KVP)              the player's own answer, if any
--
-- A consumer with its own ui_page owns its own document, so tLib cannot write
-- the property there. It publishes the ANSWER instead and the consumer applies
-- it to its own root: `exports.tLib:GetReduceMotion()` to read it now, and the
-- `tlib:reduceMotion` event for when it changes.

local MOTION_KVP = 'tlib.motion'
local reduceMotion = false

local function readPreference()
    -- KVP first: a player who has answered has answered, and a server owner
    -- flipping the house default must not silently overrule them.
    local stored = GetResourceKvpString and GetResourceKvpString(MOTION_KVP) or nil
    if stored == 'reduce' then return true end
    if stored == 'full' then return false end
    if type(GetConvar) ~= 'function' then return false end
    return GetConvar('tlib_reduce_motion', '0') == '1'
end

local function publish()
    -- tLib's own page. `--motion: 1` is the sheet's default, so the full-motion
    -- case writes it back rather than removing the property: a consumer theme
    -- may have set it, and leaving a stale 0 behind is the failure that is hard
    -- to diagnose from inside the game.
    if type(SendNUIMessage) == 'function' then
        SendNUIMessage({ action = 'setMotion', data = { motion = reduceMotion and 0 or 1 } })
    end
    -- Platform.TriggerEvent, not the global: every other event in this tree goes
    -- through the adapter, and a bare global was the one call that did not.
    if Platform and Platform.TriggerEvent then
        Platform.TriggerEvent('tlib:reduceMotion', reduceMotion)
    end
end

--- Is motion currently reduced for this player?
function UIEffects.getReduceMotion()
    return reduceMotion
end

--- Set the player's own answer, persisted. `nil` clears it back to the convar.
function UIEffects.setReduceMotion(value)
    if value == nil then
        if DeleteResourceKvp then DeleteResourceKvp(MOTION_KVP) end
    elseif SetResourceKvp then
        SetResourceKvp(MOTION_KVP, value and 'reduce' or 'full')
    end
    reduceMotion = readPreference()
    publish()
    return reduceMotion
end

-- Guarded, matching `supported()` above and `readPreference`'s convar check.
-- This module is loaded by several Lua test hosts that provide only the blur
-- surface, and tLib's adapter is also the seam a non-FiveM platform would come
-- in through — so the motion preference degrades to an in-memory value rather
-- than taking the whole file down with it.
if Platform and Platform.wrapExport then
    Platform.wrapExport('tLib', 'GetReduceMotion', function() return reduceMotion end)
    Platform.wrapExport('tLib', 'SetReduceMotion', function(value) return UIEffects.setReduceMotion(value) end)
end

if type(RegisterCommand) == 'function' then RegisterCommand('tlibmotion', function(_, args)
    local arg = args and args[1] and tostring(args[1]):lower() or nil
    if arg == 'on' or arg == 'full' then UIEffects.setReduceMotion(false)
    elseif arg == 'off' or arg == 'reduce' then UIEffects.setReduceMotion(true)
    elseif arg == 'default' then UIEffects.setReduceMotion(nil)
    else UIEffects.setReduceMotion(not reduceMotion) end
    -- Says the resulting state rather than "toggled", so the no-argument form
    -- answers the question the player actually has.
    log(('Interface motion is now %s.'):format(reduceMotion and 'reduced' or 'full'), 1)
end, false) end

if Platform and Platform.createThread then
    Platform.createThread(function()
        reduceMotion = readPreference()
        publish()
    end)
end
