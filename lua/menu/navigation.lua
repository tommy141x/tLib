-- tLib/lua/menu/navigation.lua

MenuNavigation = {}

local log          = Logger.create('tLib/menu')

local ui           = nil
local inputLocked  = false

local function fireStackChanged()
    local stack = MenuState.getStack()
    local copy  = {}
    for i, id in ipairs(stack) do copy[i] = id end
    Platform.TriggerEvent('tLib:menu:stack:changed', copy)
end

local function fireTopChanged(previousTop, newTop)
    if previousTop and previousTop ~= newTop then
        Platform.TriggerEvent('tLib:menu:blurred', previousTop)
    end
    if newTop and newTop ~= previousTop then
        Platform.TriggerEvent('tLib:menu:focused', newTop)
    end
end

local function releaseInput()
    if inputLocked then
        Platform.setIgnoreMoveInput(false)
        Platform.setIgnoreLookInput(false)
        inputLocked = false
    end
end

function MenuNavigation.init(webui)
    ui = webui

    local function blocked()
        return #MenuState.getStack() == 0 or Platform.getInputMode() == 1
    end

    -- On FiveM, NUI callbacks (JS → Lua) are unreliable so we compute the
    -- new focused item in Lua and update menu.focusedId immediately.  The UI
    -- still runs its own moveFocus for rendering.
    -- On Helix, ui:SendEvent is synchronous — the focusChanged handler
    -- updates focusedId before the next key handler fires.

    Platform.bindKey('Up', function()
        if blocked() then return end
        if _TLIB_IS_FIVEM then
            local menu = MenuState.currentMenu()
            if menu then
                local newId = MenuState.moveFocus(menu, -1)
                if newId then Platform.TriggerEvent('tLib:item:focused', menu.id, newId) end
            end
        end
        Platform.sendUIEvent(ui, 'navigate', { dir = 'up' })
    end, 'Pressed')

    Platform.bindKey('Down', function()
        if blocked() then return end
        if _TLIB_IS_FIVEM then
            local menu = MenuState.currentMenu()
            if menu then
                local newId = MenuState.moveFocus(menu, 1)
                if newId then Platform.TriggerEvent('tLib:item:focused', menu.id, newId) end
            end
        end
        Platform.sendUIEvent(ui, 'navigate', { dir = 'down' })
    end, 'Pressed')

    Platform.bindKey('Left', function()
        if blocked() then return end
        MenuActions.handleLeft()
    end, 'Pressed')

    Platform.bindKey('Right', function()
        if blocked() then return end
        MenuActions.handleRight()
    end, 'Pressed')

    -- On both platforms, focusedId is always up-to-date by the time Enter
    -- fires: FiveM computes focus in Lua (above), Helix is synchronous.
    Platform.bindKey('Enter', function()
        if blocked() then return end
        MenuActions.handleConfirm()
    end, 'Pressed')

    Platform.bindKey('BackSpace', function()
        if blocked() then return end
        MenuNavigation.closeTop()
    end, 'Pressed')

    -- On Helix this is the primary focus-sync mechanism (synchronous).
    -- On FiveM this is a secondary sync — Lua already computed focus above,
    -- but if the NUI callback arrives it will reconcile any drift.
    Platform.onUIEvent(ui, 'focusChanged', function(data)
        local menu = MenuState.currentMenu()
        if not menu then return end
        if not (data and data.id) then return end
        local prev = menu.focusedId
        menu.focusedId = data.id
        if data.id ~= prev then
            Platform.TriggerEvent('tLib:item:focused', menu.id, data.id)
        end
    end)

    Platform.onUIEvent(ui, 'closeMenu', function()
        MenuNavigation.closeAll()
    end)
end

function MenuNavigation.closeTop()
    local stack = MenuState.getStack()
    if #stack == 0 then return end

    local menu    = MenuState.currentMenu()
    local prevTop = stack[#stack]

    MenuState.popFromStack()

    if menu and menu.onClose then menu.onClose() end
    if menu then Platform.TriggerEvent('tLib:menu:closed', menu.id) end

    local newStack = MenuState.getStack()
    local newTop   = newStack[#newStack] or nil
    fireTopChanged(prevTop, newTop)
    fireStackChanged()

    if #MenuState.getStack() > 0 then
        MenuState.pushMenu()
    else
        releaseInput()
        MenuState.hideUI()
    end
end

function MenuNavigation.closeAll()
    local stack = MenuState.getStack()
    if #stack == 0 then return end

    local prevTop = stack[#stack]

    while #MenuState.getStack() > 0 do
        local menu = MenuState.currentMenu()
        MenuState.popFromStack()
        if menu and menu.onClose then menu.onClose() end
        if menu then Platform.TriggerEvent('tLib:menu:closed', menu.id) end
    end

    fireTopChanged(prevTop, nil)
    fireStackChanged()
    releaseInput()
    MenuState.hideUI()
end

-- Close a specific menu and everything stacked on top of it.
-- No-op (with no side-effects) when menuId is not present in the stack.
function MenuNavigation.closeMenu(menuId)
    local stack = MenuState.getStack()

    -- Find the target index first so we never fire events if the id is absent.
    local targetIdx = nil
    for i = #stack, 1, -1 do
        if stack[i] == menuId then
            targetIdx = i
            break
        end
    end

    if not targetIdx then
        log('closeMenu: menuId "' .. tostring(menuId) .. '" is not in the stack — no-op', 3)
        return
    end

    local prevTop = stack[#stack]

    -- Pop everything from the top down to (and including) targetIdx.
    while #MenuState.getStack() >= targetIdx do
        local m = MenuState.currentMenu()
        MenuState.popFromStack()
        if m and m.onClose then m.onClose() end
        if m then Platform.TriggerEvent('tLib:menu:closed', m.id) end
    end

    local newStack = MenuState.getStack()
    local newTop   = newStack[#newStack] or nil
    fireTopChanged(prevTop, newTop)
    fireStackChanged()

    if #MenuState.getStack() > 0 then
        MenuState.pushMenu()
    else
        releaseInput()
        MenuState.hideUI()
    end
end

-- Push a menu onto the stack. If it's already on top, only refreshes the UI.
--
-- blockInput design note:
--   Input locking is a root-menu concern only. The flag is checked exclusively
--   when prevTop is nil (i.e. the stack was empty before this push). Submenus
--   never acquire or release the lock — the root menu that opened first owns
--   the lock for the entire stack lifetime, and it is released when the stack
--   drains back to empty (closeTop / closeAll / closeMenu reaching depth 0).
--   This means a submenu with blockInput = true has no effect; set blockInput
--   on the root menu instead.
function MenuNavigation.openMenu(menuId)
    local allMenus = MenuState.getMenus()
    local stack    = MenuState.getStack()
    local menu     = allMenus[menuId]

    if not menu then
        log('openMenu: unknown id ' .. tostring(menuId), 4)
        return
    end

    local prevTop      = stack[#stack]
    local alreadyOnTop = (prevTop == menuId)

    if not alreadyOnTop then
        -- Inherit position/size from the parent unless the submenu opts out.
        -- inheritLayout == nil means "default true"; only false opts out.
        if menu.inheritLayout ~= false and prevTop then
            local parent = allMenus[prevTop]
            if parent then
                -- Carry forward the parent's effective (possibly also inherited) values.
                menu._inheritedPosition = parent._inheritedPosition or parent.position
                menu._inheritedSize     = parent._inheritedSize or parent.size
            end
        else
            -- Explicit opt-out or root menu: use this menu's own values.
            menu._inheritedPosition = nil
            menu._inheritedSize     = nil
        end

        MenuState.pushToStack(menuId)

        -- Only lock input when opening from an empty stack (root menu).
        -- See blockInput design note above.
        if prevTop == nil and menu.blockInput then
            Platform.setIgnoreMoveInput(true)
            Platform.setIgnoreLookInput(true)
            inputLocked = true
        end

        if menu.onOpen then menu.onOpen() end
        Platform.TriggerEvent('tLib:menu:opened', menuId)
        fireTopChanged(prevTop, menuId)
        fireStackChanged()
    end

    MenuState.pushMenu()
end
