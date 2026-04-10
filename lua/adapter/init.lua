-- tLib/lua/adapter/init.lua
-- Platform detection — must be the very first adapter file loaded.
-- Establishes the global Platform table and the _isHelix / _isFiveM booleans
-- that every other adapter module reads.  Nothing else belongs here.
--
-- Load order (enforced by package.json / fxmanifest.lua):
--   lua/adapter/init.lua        ← this file (detection)
--   lua/adapter/core.lua        ← threads, timing, events, UI, exports, shutdown
--   lua/adapter/player.lua      ← player / input blocking helpers
--   (future files go here)

Platform = {}

-- ── Platform detection ────────────────────────────────────────────────────────
-- FiveM:  Citizen global + AddEventHandler present
-- Helix:  WebUI constructor + Input table present
-- We probe FiveM first — it is the most unambiguous sentinel.

local _isFiveM = (type(Citizen) == 'table' or type(Citizen) == 'userdata')
    and type(AddEventHandler) == 'function'

local _isHelix = not _isFiveM
    and (type(WebUI) == 'function' or type(WebUI) == 'table')
    and type(Input) == 'table'

-- globals might not be set yet if we're loaded early, try weaker checks
if not _isFiveM and not _isHelix then
    if type(WebUI) == 'function' then
        _isHelix = true
    elseif type(AddEventHandler) == 'function' then
        _isFiveM = true
    end
end

-- Expose as read-only-style globals so adapter sub-modules don't have to
-- re-detect.  Prefixed with _ to signal they are adapter-internal.
_TLIB_IS_FIVEM = _isFiveM
_TLIB_IS_HELIX = _isHelix

if _isFiveM then
    Platform.name = 'fivem'
elseif _isHelix then
    Platform.name = 'helix'
else
    Platform.name = 'unknown'
end

-- ── Package name & execution-side accessors ───────────────────────────────────
-- Platform.getPackageName() and Platform.getSide() are the single unified
-- accessors for these values.  Every sub-module (logger, core, etc.) must call
-- these functions rather than reading _TLIB_PACKAGE / _TLIB_SIDE directly.
--
-- On Helix:
--   __PackageName is a runtime global set before any package script runs.
--   HPlayer is non-nil in the client VM only; its absence means server.
--
-- On FiveM:
--   GetCurrentResourceName() returns the resource folder name.
--   IsDuplicityVersion() returns true in the server runtime only.

--- Returns the name of the current package / resource.
-- Helix: _G.__PackageName  |  FiveM: GetCurrentResourceName()
function Platform.getPackageName()
    if _isHelix then
        return _G.__PackageName
    else
        return GetCurrentResourceName()
    end
end

--- Returns the current execution side: 'client' or 'server'.
-- Helix: presence of HPlayer  |  FiveM: IsDuplicityVersion()
function Platform.getSide()
    if _isHelix then
        return (HPlayer ~= nil) and 'client' or 'server'
    else
        return IsDuplicityVersion() and 'server' or 'client'
    end
end

-- Populate the convenience globals on BOTH platforms so sub-modules and the
-- print override below have stable locals to read without calling the
-- functions repeatedly.
_TLIB_PACKAGE = Platform.getPackageName()
_TLIB_SIDE    = Platform.getSide()



-- ── Convenience predicates ────────────────────────────────────────────────────

function Platform.isHelix() return Platform.name == 'helix' end

function Platform.isFiveM() return Platform.name == 'fivem' end

-- ── Platform.context() ───────────────────────────────────────────────────────
-- Returns a snapshot of the current execution context as a plain table.
-- Useful for consumers that want to branch on package identity or side at
-- runtime, or build their own diagnostic strings.
--
-- Returns:
--   {
--     package  : string  -- "tLib", "tMenu", … (both platforms)
--     side     : string  -- "client" | "server"  (both platforms)
--     platform : string  -- "helix" | "fivem" | "unknown"
--   }
--
-- Example:
--   local ctx = Platform.context()
--   -- ctx.package == "tMenu",  ctx.side == "client"
function Platform.context()
    return {
        package  = Platform.getPackageName(),
        side     = Platform.getSide(),
        platform = Platform.name,
    }
end

-- ── Stub factory (used by sub-modules for unimplemented surfaces) ─────────────

function Platform._stub(name)
    return function(...)
        print('WARN: Platform.' .. name
            .. ' called but platform is "' .. Platform.name .. '" — no-op')
    end
end

-- ── Banner ────────────────────────────────────────────────────────────────────

print('platform=' .. Platform.name)
