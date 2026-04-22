-- FiveM-idiom polyfill for Helix.
--
-- Consumer resources frequently reach for top-level CFX globals (Citizen,
-- CreateThread, Wait, SetTimeout, GetGameTimer). Rather than rewrite every
-- call site, we polyfill the CFX names on Helix by delegating to Helix's
-- native Timer API. Self-contained — does NOT depend on the Platform global
-- so it can run in any VM (tLib's shared_scripts AND consumer VMs via
-- imports.lua).
--
-- No-op on FiveM (those globals already exist). Safe to load multiple times.

local function isHelix()
    if _TLIB_IS_HELIX == true then return true end
    if _TLIB_IS_FIVEM == true then return false end
    return type(Citizen) ~= 'table' and type(Citizen) ~= 'userdata'
       and (type(WebUI) == 'function' or type(WebUI) == 'table' or type(Timer) == 'table')
end

if not isHelix() then return end
if type(Timer) ~= 'table' then return end  -- Helix Timer API not available yet

-- Citizen namespace + top-level aliases ────────────────────────────────

if type(_G.Citizen) ~= 'table' then _G.Citizen = {} end

if type(Citizen.CreateThread) ~= 'function' then
    Citizen.CreateThread = function(fn) Timer.CreateThread(fn) end
end

if type(Citizen.Wait) ~= 'function' then
    Citizen.Wait = function(ms) Timer.Wait(ms) end
end

-- CFX takes (ms, fn); Helix Timer takes (fn, ms). Flip so the polyfill
-- matches CFX semantics exactly.
if type(Citizen.SetTimeout) ~= 'function' then
    Citizen.SetTimeout = function(ms, fn)
        if type(Timer.SetTimeout) == 'function' then return Timer.SetTimeout(fn, ms) end
    end
end

if type(Citizen.SetInterval) ~= 'function' then
    Citizen.SetInterval = function(ms, fn)
        if type(Timer.SetInterval) == 'function' then return Timer.SetInterval(fn, ms) end
    end
end

if type(Citizen.ClearTimeout) ~= 'function' then
    Citizen.ClearTimeout = function(handle)
        if type(Timer.ClearTimeout) == 'function' then Timer.ClearTimeout(handle) end
    end
end

if type(Citizen.ClearInterval) ~= 'function' then
    Citizen.ClearInterval = function(handle)
        if type(Timer.ClearInterval) == 'function' then Timer.ClearInterval(handle) end
    end
end

-- Top-level aliases (CFX exposes these without the Citizen. prefix too).
if type(_G.CreateThread)  ~= 'function' then _G.CreateThread  = Citizen.CreateThread  end
if type(_G.Wait)          ~= 'function' then _G.Wait          = Citizen.Wait          end
if type(_G.SetTimeout)    ~= 'function' then _G.SetTimeout    = Citizen.SetTimeout    end
if type(_G.SetInterval)   ~= 'function' then _G.SetInterval   = Citizen.SetInterval   end
if type(_G.ClearTimeout)  ~= 'function' then _G.ClearTimeout  = Citizen.ClearTimeout  end
if type(_G.ClearInterval) ~= 'function' then _G.ClearInterval = Citizen.ClearInterval end

-- GetGameTimer (ms since engine start). Helix provides Timer.GetTime.
if type(_G.GetGameTimer) ~= 'function' then
    _G.GetGameTimer = function()
        if type(Timer.GetTime) == 'function' then return Timer.GetTime() end
        return math.floor(os.clock() * 1000)
    end
end
