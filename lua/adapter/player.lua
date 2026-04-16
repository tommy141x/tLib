-- player input: key binds, input blocking, input mode query

_TLIB_UI_FOCUSED  = false
_TLIB_NUI_FOCUSED = false

local log       = Logger.create('tLib/adapter/player')

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

    local _blockThreadRunning = false

    local function ensureBlockThread()
        if _blockThreadRunning then return end
        _blockThreadRunning = true
        Platform.createThread(function()
            while Platform._blockMove or Platform._blockLook do
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
            end
            _blockThreadRunning = false
        end)
    end

    function Platform.setIgnoreMoveInput(state)
        Platform._blockMove = state == true
        if state then ensureBlockThread() end
    end

    function Platform.setIgnoreLookInput(state)
        Platform._blockLook = state == true
        if state then ensureBlockThread() end
    end
else
    Platform.setIgnoreMoveInput = Platform._stub('setIgnoreMoveInput')
    Platform.setIgnoreLookInput = Platform._stub('setIgnoreLookInput')
end

-- Returns 1 when the player is in a UI/cursor-focused state (key handlers in
-- navigation.lua use this to suppress input), 0 otherwise.

if _TLIB_IS_HELIX then
    function Platform.getInputMode()
        return _TLIB_UI_FOCUSED and 1 or 0
    end
elseif _TLIB_IS_FIVEM then
    function Platform.getInputMode()
        -- Return 1 (UI mode) when either:
        --   • tLib itself has taken NUI cursor focus via Platform.setInputMode
        --   • the game's pause menu is open
        -- This ensures navigation.lua's blocked() correctly suppresses menu
        -- keys while a dialog (or any other tLib UI) owns the cursor.
        if _TLIB_NUI_FOCUSED then return 1 end
        if IsPauseMenuActive and IsPauseMenuActive() then return 1 end
        return 0
    end
else
    function Platform.getInputMode() return 0 end
end
