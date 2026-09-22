-- Player input: key binds, input blocking, input mode.

_TLIB_NUI_FOCUSED = false

local log       = Logger.create('tLib/adapter/player')

-- cb is either a function, fired on eventType ('Pressed' unless 'Released' is
-- asked for), or a { press, release } pair sharing one key mapping.
local function _normalizePair(cb, eventType)
    if type(cb) == 'table' then
        return cb.press or cb.onPress or cb[1],
               cb.release or cb.onRelease or cb[2]
    end
    if eventType == 'Released' then
        return nil, cb
    end
    return cb, nil
end

if _TLIB_IS_FIVEM then
    -- Friendly names to the FiveM key strings RegisterKeyMapping expects. Players
    -- rebind these in Settings > Controls > FiveM.
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

    local function cmdName(resourceName, key)
        return (resourceName .. '_key_' .. key):gsub('[^%w_]', '_')
    end

    local _resourceName = GetCurrentResourceName()

    -- Per-key, so two listeners on 'Enter' get distinct command tokens.
    local _bindCount    = {}

    function Platform.bindKey(key, cb, eventType, bindingId, label)
        local pressCb, releaseCb = _normalizePair(cb, eventType)
        local token

        if type(bindingId) == 'string' and bindingId ~= '' then
            -- An explicit id is its own entry on the keybind screen, so two
            -- resources can bind the same key and both stay rebindable.
            token = bindingId:gsub('[^%w_]', '_')
        else
            local count     = (_bindCount[key] or 0) + 1
            _bindCount[key] = count
            local base      = cmdName(_resourceName, key)
            token           = count == 1 and base or (base .. '_' .. count)
        end

        -- Shown on the keybind screen; the token humanises poorly, so an
        -- explicit label is worth passing.
        local displayLabel = (type(label) == 'string' and label ~= '' and label)
            or token:gsub('_', ' ')

        -- '+token' on key-down, '-token' on key-up. Both are always registered,
        -- a missing callback as a no-op, so the engine has a matched pair.
        RegisterCommand('+' .. token, function()
            if pressCb then pressCb() end
        end, false)
        RegisterCommand('-' .. token, function()
            if releaseCb then releaseCb() end
        end, false)

        -- An unrecognised name is passed through as a FiveM one (Q, NUMPAD_8,
        -- LMENU). Falling back to an empty default instead leaves the binding
        -- unset, which breaks per-key mappings meant to work out of the box.
        local defaultKey = _keyDefaults[key] or key or ''
        RegisterKeyMapping('+' .. token, displayLabel, 'keyboard', defaultKey)
    end
else
    Platform.bindKey = Platform._stub('bindKey')
end

if _TLIB_IS_FIVEM then
    -- There is no single "block movement" native, so each control has to be
    -- disabled every frame for as long as blocking is on.
    Platform._blockMove = false
    Platform._blockLook = false

    local _moveControls = { 30, 31, 21, 22, 32, 44, 45, 71, 72 }
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

-- 1 while something owns the cursor -- tLib's own NUI focus or the pause menu.
-- Key handlers suppress input on this, so a dialog does not also drive the menu.
if _TLIB_IS_FIVEM then
    function Platform.getInputMode()
        if _TLIB_NUI_FOCUSED then return 1 end
        if IsPauseMenuActive and IsPauseMenuActive() then return 1 end
        return 0
    end
else
    Platform.getInputMode = Platform._stub('getInputMode')
end
