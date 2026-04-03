-- tLib/lua/adapter/player.lua
-- Player-related platform abstractions: input blocking, input mode query,
-- and key bindings.
--
-- Depends on: lua/adapter/init.lua  (_TLIB_IS_HELIX / _TLIB_IS_FIVEM / Platform)
--             lua/adapter/core.lua  (Platform.createThread / Platform.wait)
--
-- Surfaces provided:
--
--   Platform.bindKey(key, cb, eventType, bindingId)
--     Bind a callback to a key press (or release).
--     eventType:  "Pressed" (default) | "Released"
--     bindingId:  optional human-readable identifier used as the console
--                 command token and the label shown in GTA V Settings >
--                 Controls > FiveM.  Must be alphanumeric + underscores only.
--                 When omitted a unique token is generated automatically.
--                 On FiveM, providing an explicit id is recommended when the
--                 same key is bound from multiple resources so each binding
--                 has a clear, stable name in the keybind settings screen.
--
--   Platform.setIgnoreMoveInput(bool)
--     Block or unblock player movement controls.
--
--   Platform.setIgnoreLookInput(bool)
--     Block or unblock player camera/look controls.
--
--   Platform.getInputMode()
--     Returns 1 when the player is in a UI/cursor mode (i.e. key handlers
--     should be suppressed), 0 otherwise.

-- Tracks whether the UI currently has input focus (set by Platform.setInputMode).
-- _tLibUIFocused  — used by Platform.getInputMode() on Helix.
-- _tLibNUIFocused — used by Platform.getInputMode() on FiveM; mirrors the
--                   SetNuiFocus state that Platform.setInputMode manages so that
--                   navigation.lua's blocked() check correctly suppresses menu
--                   keys while a dialog (or any other UI) has cursor focus.
--
-- Load order: logger.lua (shared_scripts) → core.lua (shared_scripts) →
--             player.lua (client_scripts).  Both globals are initialised here
--             at file scope.  Platform.setInputMode (defined in core.lua) only
--             ever writes to them in response to a runtime call — it is never
--             invoked between core.lua loading and player.lua loading — so
--             there is no window where they could be nil when accessed.
_tLibUIFocused  = false
_tLibNUIFocused = false

local log       = Logger.create('tLib/adapter/player')

-- ── Key bindings ──────────────────────────────────────────────────────────────

if _TLIB_IS_HELIX then
    function Platform.bindKey(key, cb, eventType, bindingId)
        Input.BindKey(key, cb, eventType or 'Pressed')
    end
elseif _TLIB_IS_FIVEM then
    -- Maps common Helix key names → FiveM default keyboard key strings for
    -- RegisterKeyMapping. The player can rebind any of these in
    -- GTA V Settings > Controls > FiveM.
    -- Keys not present in this map get an empty default (user must bind manually).
    local _keyDefaults = {
        Up        = 'UP',
        Down      = 'DOWN',
        Left      = 'LEFT',
        Right     = 'RIGHT',
        Enter     = 'RETURN',
        BackSpace = 'BACK',
        E         = 'E',
        G         = 'G',
        H         = 'H',
        M         = 'M',
        F1        = 'F1',
        F2        = 'F2',
        F3        = 'F3',
        F5        = 'F5',
        F6        = 'F6',
        Tab       = 'TAB',
    }

    -- Sanitise a key name into a valid console command token (alphanumeric + _).
    local function cmdName(resourceName, key)
        return (resourceName .. '_key_' .. key):gsub('[^%w_]', '_')
    end

    local _resourceName = GetCurrentResourceName()

    -- Counter used to give each binding a unique command name when the same
    -- key is bound more than once (e.g. two listeners on 'Enter').
    local _bindCount    = {}

    function Platform.bindKey(key, cb, eventType, bindingId)
        local et = eventType or 'Pressed'
        local token

        if type(bindingId) == 'string' and bindingId ~= '' then
            -- Caller supplied an explicit id — sanitise it and use as-is.
            -- Two resources can safely bind the same key with different ids
            -- and each will appear as a separate entry in GTA V's keybind
            -- settings screen under its own name.
            token = bindingId:gsub('[^%w_]', '_')
        else
            -- Auto-generate a unique token: <resource>_key_<key>[_N].
            -- The per-key counter ensures multiple bindKey calls within the
            -- same resource on the same key never produce duplicate tokens.
            local count     = (_bindCount[key] or 0) + 1
            _bindCount[key] = count
            local base      = cmdName(_resourceName, key)
            token           = count == 1 and base or (base .. '_' .. count)
        end

        -- Label shown in GTA V Settings > Controls > FiveM.
        local label = token:gsub('_', ' ')

        if et == 'Released' then
            -- RegisterKeyMapping fires '+token' on key-down and '-token' on
            -- key-up. For a Released binding we want the '-token' callback.
            RegisterCommand('-' .. token, function() cb() end, false)
            -- No-op '+token' so the engine has a matched pair.
            RegisterCommand('+' .. token, function() end, false)
        else
            -- Pressed (default): fire on '+token' (key-down).
            RegisterCommand('+' .. token, function() cb() end, false)
            -- No-op '-token' for key-up.
            RegisterCommand('-' .. token, function() end, false)
        end

        local defaultKey = _keyDefaults[key] or ''
        RegisterKeyMapping('+' .. token, label, 'keyboard', defaultKey)
    end
else
    Platform.bindKey = Platform._stub('bindKey')
end

-- ── Player input blocking ──────────────────────────────────────────────────────

if _TLIB_IS_HELIX then
    function Platform.setIgnoreMoveInput(state)
        if HPlayer and HPlayer.SetIgnoreMoveInput then
            HPlayer:SetIgnoreMoveInput(state)
        else
            log('setIgnoreMoveInput called but HPlayer is unavailable', 3)
        end
    end

    function Platform.setIgnoreLookInput(state)
        if HPlayer and HPlayer.SetIgnoreLookInput then
            HPlayer:SetIgnoreLookInput(state)
        else
            log('setIgnoreLookInput called but HPlayer is unavailable', 3)
        end
    end
elseif _TLIB_IS_FIVEM then
    -- FiveM has no single "block movement" call; we must disable individual
    -- control actions every frame while blocking is active.
    Platform._blockMove = false
    Platform._blockLook = false

    -- Movement: steer, sprint, jump, crouch, etc.
    local _moveControls = { 30, 31, 21, 22, 32, 44, 45, 71, 72 }
    -- Camera / look controls.
    local _lookControls = { 1, 2, 3, 4, 220, 221 }

    -- Single shared thread — only burns CPU when at least one flag is set.
    Platform.createThread(function()
        while true do
            if Platform._blockMove or Platform._blockLook then
                Platform.wait(0)
                if Platform._blockMove then
                    for _, ctrl in ipairs(_moveControls) do
                        DisableControlAction(0, ctrl, true)
                    end
                end
                if Platform._blockLook then
                    for _, ctrl in ipairs(_lookControls) do
                        DisableControlAction(0, ctrl, true)
                    end
                end
            else
                Platform.wait(100)
            end
        end
    end)

    function Platform.setIgnoreMoveInput(state)
        Platform._blockMove = state == true
    end

    function Platform.setIgnoreLookInput(state)
        Platform._blockLook = state == true
    end
else
    Platform.setIgnoreMoveInput = Platform._stub('setIgnoreMoveInput')
    Platform.setIgnoreLookInput = Platform._stub('setIgnoreLookInput')
end

-- ── Input mode query ──────────────────────────────────────────────────────────
-- Returns 1 when the player is in a UI/cursor-focused state (key handlers in
-- navigation.lua use this to suppress input), 0 otherwise.

if _TLIB_IS_HELIX then
    function Platform.getInputMode()
        return _tLibUIFocused and 1 or 0
    end
elseif _TLIB_IS_FIVEM then
    function Platform.getInputMode()
        -- Return 1 (UI mode) when either:
        --   • tLib itself has taken NUI cursor focus via Platform.setInputMode
        --   • the game's pause menu is open
        -- This ensures navigation.lua's blocked() correctly suppresses menu
        -- keys while a dialog (or any other tLib UI) owns the cursor.
        if _tLibNUIFocused then return 1 end
        if IsPauseMenuActive and IsPauseMenuActive() then return 1 end
        return 0
    end
else
    function Platform.getInputMode() return 0 end
end
