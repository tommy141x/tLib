-- Keyboard and gamepad navigation for the open menu, plus the input suppression
-- that stops navigating a menu from also driving the character.
--
-- Built out of GTA V control IDs, so the whole loop is FiveM-only and every entry
-- point degrades to a no-op elsewhere. It emits protocol-free names -- 'navigate',
-- 'input', 'hidden' -- through a sender the menu client installs, so no NUI wire
-- string appears here.

MenuInput = {}
local I = MenuInput

local visible, typing, generation = false, false, 0
local modal, suppressUntilRelease = false, false
local emit = function() end

--- Installed by the menu client, so the NUI protocol can be renamed without
--- touching a control ID.
function I.bindSender(fn)
    if type(fn) == 'function' then emit = fn end
end

function I.setModal(active)
    modal = active == true
    if not modal then suppressUntilRelease = true end
end

-- Accept and back fire on release: a submenu opening under a still-held Enter
-- must not immediately activate its own first row.
local bindings = {
    { name = 'back', controls = { 177, 202 }, release = true },
    { name = 'accept', controls = { 176, 201, 106 }, release = true },
    -- 181/180 are the scroll wheel: single-frame presses, so they never feed the
    -- hold ladder, and they yield to the weapon wheel below.
    { name = 'up', controls = { 172, 188 }, wheel = { 181 }, repeatable = true },
    { name = 'down', controls = { 173, 187 }, wheel = { 180 }, repeatable = true },
    { name = 'left', controls = { 174, 189 }, repeatable = true },
    { name = 'right', controls = { 175, 190 }, repeatable = true },
}
-- 44/21/22/23/75 share a physical controller button with accept/back; letting
-- them through makes the character jump or leave a vehicle while navigating.
local blocked = { 20, 24, 25, 27, 44, 68, 69, 70, 92, 114, 140, 141, 142, 200, 257, 263, 264 }
-- Only while the player is in a vehicle.
local blockedInVehicle = { 73, 74, 80, 81, 82, 85, 99, 100, 332, 333, 357 }

-- First repeat after 200ms, then accelerating with the run length. A long vehicle
-- or weapon list is unusable at a flat rate.
local function repeatDelay(times)
    if times > 60 then return 25 elseif times > 25 then return 50
    elseif times > 5 then return 100 elseif times > 2 then return 150 end
    return 200
end

local function yes(value) return value == true or value == 1 end

-- The weapon wheel is disabled only for a gamepad sitting on a slider or list row,
-- where left/right would fight it; the browser reports the highlighted row kind.
local valueRow = false
function I.setValueRow(active) valueRow = active == true end

-- Suspension, not closure. A real close resets the browser to the main page and
-- drops every uncommitted selector and slider draft, so the pause menu or a screen
-- fade would throw away a half-dialed row. Suspending stops forwarding and
-- blocking native input and asks the browser to stand down, leaving the session,
-- page and drafts intact.
--
-- Death is not one of these: the state it was configuring no longer exists.
local suspended = false
local function suspend(active)
    if suspended == active then return end
    suspended = active
    -- Text entry holds NUI keyboard focus and the pause menu cannot be used through
    -- it. Conditional because this runs on a frame boundary -- an unconditional
    -- I.text(false) would post a message on every suspension.
    if active and typing then I.text(false) end
    emit('hidden', active)
end
function I.text(active)
    if active and (not visible or modal or (not typing and _TLIB_IS_FIVEM
        and type(IsNuiFocused) == 'function' and yes(IsNuiFocused()))) then return false end
    if typing and not active then suppressUntilRelease = true end
    local hadFocus = typing
    typing = active == true
    if _TLIB_IS_FIVEM and (typing or hadFocus) then
        SetNuiFocus(typing, false)
        SetNuiFocusKeepInput(false)
    end
    emit('input', typing)
    return true
end
function I.isTyping() return typing end

function I.setVisible(active, onClose)
    generation = generation + 1
    visible = active == true
    I.text(false)
    -- Closing while suspended must not leave the browser hidden, or the next open
    -- draws nothing.
    suspend(false)
    if not visible or not _TLIB_IS_FIVEM then return end
    local current, repeats = generation, {}
    Platform.createThread(function()
        while visible and current == generation do
            if yes(IsEntityDead(PlayerPedId())) then onClose(); break end
            -- A fade means the game is showing the player something else, and no
            -- fade covers the browser's panel. Probed rather than called outright,
            -- like every other optional native here.
            local faded = type(IsScreenFadedOut) == 'function' and yes(IsScreenFadedOut())
            suspend(yes(IsPauseMenuActive()) or faded)
            -- Dialogs and other resources' NUI own their keyboard while focused;
            -- their closing key release is not a menu action.
            local nuiFocused = type(IsNuiFocused) == 'function' and yes(IsNuiFocused())
            if nuiFocused then suppressUntilRelease = true end
            if not suspended and not typing and not modal and not nuiFocused then
                local ped = PlayerPedId()
                local inVehicle = yes(IsPedInAnyVehicle(ped, false))
                local gamepad = not yes(IsInputDisabled(2))
                -- Holding the weapon-select key hands the wheel back to weapon
                -- switching and the menu ignores it.
                local weaponWheel = yes(IsControlPressed(0, 37)) or yes(IsDisabledControlPressed(0, 37))
                for _, control in ipairs(blocked) do DisableControlAction(0, control, true) end
                if inVehicle then
                    for _, control in ipairs(blockedInVehicle) do DisableControlAction(0, control, true) end
                end
                if not weaponWheel then
                    DisableControlAction(0, 16, true); DisableControlAction(0, 17, true)
                end
                if gamepad and valueRow then DisableControlAction(0, 37, true) end
                for _, binding in ipairs(bindings) do
                    for _, control in ipairs(binding.controls) do DisableControlAction(0, control, true) end
                    if binding.wheel and not weaponWheel then
                        for _, control in ipairs(binding.wheel) do DisableControlAction(0, control, true) end
                    end
                end
                -- Controller accept/back must not also jump, sprint or enter a vehicle.
                if gamepad then
                    for _, control in ipairs({ 21, 22, 23, 75 }) do DisableControlAction(0, control, true) end
                end
                -- Suppression lifts on the same frame the held key is released, and
                -- accept/back fire on that edge. Skip the frame or dismissing a
                -- prompt immediately re-activates a row.
                local justLifted = false
                if suppressUntilRelease then
                    local held = false
                    for _, binding in ipairs(bindings) do
                        for _, control in ipairs(binding.controls) do held = held or yes(IsDisabledControlPressed(0, control)) end
                    end
                    if not held then suppressUntilRelease = false; repeats = {}; justLifted = true end
                end
                local now = Platform.now()
                for _, binding in ipairs(bindings) do
                    if suppressUntilRelease or justLifted then break end
                    local pressed, held = false, false
                    for _, control in ipairs(binding.controls) do
                        if binding.release then pressed = pressed or yes(IsDisabledControlJustReleased(0, control))
                        else pressed = pressed or yes(IsDisabledControlJustPressed(0, control)) end
                        held = held or yes(IsDisabledControlPressed(0, control))
                    end
                    -- A wheel notch is a one-frame press with no hold: it moves the
                    -- row once and never enters the ladder below.
                    if binding.wheel and not weaponWheel then
                        for _, control in ipairs(binding.wheel) do
                            pressed = pressed or yes(IsDisabledControlJustPressed(0, control))
                        end
                    end
                    local state = repeats[binding.name]
                    local fire = pressed
                    if pressed then repeats[binding.name] = { due = now + 200, times = 0 }
                    elseif binding.repeatable and held then
                        if state and now >= state.due then
                            fire = true
                            state.times = state.times + 1
                            state.due = now + repeatDelay(state.times)
                        elseif not state then repeats[binding.name] = { due = now + 200, times = 0 } end
                    elseif not held then repeats[binding.name] = nil end
                    if fire then emit('navigate', binding.name); break end
                end
            end
            Platform.wait(0)
        end
    end)
end

--- Bind the search key. The command name comes from whoever configures the
--- interface, since it sits alongside that resource's own open command in the
--- player's keybind list.
function I.bindSearchKey(command, key, label)
    if not _TLIB_IS_FIVEM or type(command) ~= 'string' or command == '' then return false end
    RegisterCommand(command, function()
        if visible then I.text(not typing) end
    end, false)
    RegisterKeyMapping(command, label or 'Search the open menu', 'keyboard', key or 'F3')
    return true
end

function I.cleanup() I.setVisible(false) end

return MenuInput
