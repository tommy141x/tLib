-- tLib/lua/menu/actions.lua

MenuActions = {}

local log = Logger.create('tLib/menu')

-- Shared with state.lua and exports.lua — see MenuUtils.resolve in state.lua.
local resolve = MenuUtils.resolve

function MenuActions.handleConfirm()
    local menu = MenuState.currentMenu()
    if not menu then return end

    local item = MenuState.findItemById(menu, menu.focusedId)
    if not item then return end
    if resolve(item.disabled, false) then return end

    if item.type == 'button' then
        if item.onSelect then item.onSelect() end
        Platform.TriggerEvent('tLib:item:selected', menu.id, item.id)
        if item.submenuId then
            local allMenus = MenuState.getMenus()
            if allMenus[item.submenuId] then
                MenuNavigation.openMenu(item.submenuId)
            else
                log('handleConfirm: unknown submenuId ' .. tostring(item.submenuId), 4)
            end
        end
    elseif item.type == 'checkbox' then
        MenuState.patchItem(menu.id, item.id, { checked = not item.checked })
        -- Fire event after patchItem so item.checked reflects the new value.
        Platform.TriggerEvent('tLib:item:selected', menu.id, item.id)
        Platform.TriggerEvent('tLib:item:changed', menu.id, item.id, 'checked', item.checked)
        if item.onToggle then item.onToggle(item.checked) end
    elseif item.type == 'list' then
        if item.onSelect then item.onSelect(item.values[item.index], item.index) end
        Platform.TriggerEvent('tLib:item:selected', menu.id, item.id)
    elseif item.type == 'slider' then
        if item.onSelect then item.onSelect(item.value) end
        Platform.TriggerEvent('tLib:item:selected', menu.id, item.id)
    end
end

function MenuActions.handleLeft()
    local menu = MenuState.currentMenu()
    if not menu then return end

    local item = MenuState.findItemById(menu, menu.focusedId)
    if not item then return end
    if resolve(item.disabled, false) then return end

    if item.type == 'list' then
        local count = #item.values
        if count == 0 then return end
        local oldIndex = item.index
        local newIndex = ((item.index - 2) % count) + 1
        MenuState.patchItem(menu.id, item.id, { index = newIndex })
        -- Defer value lookups until after the patch so item.index is final.
        Platform.TriggerEvent('tLib:item:changed', menu.id, item.id, 'index', item.index, oldIndex)
        if item.onChange then item.onChange(item.values[item.index], item.index) end
    elseif item.type == 'slider' then
        local newVal = math.max(item.min, item.value - (item.step or 1))
        if newVal == item.value then return end
        local oldVal = item.value
        MenuState.patchItem(menu.id, item.id, { value = newVal })
        Platform.TriggerEvent('tLib:item:changed', menu.id, item.id, 'value', item.value, oldVal)
        if item.onChange then item.onChange(item.value, oldVal) end
    end
end

function MenuActions.handleRight()
    local menu = MenuState.currentMenu()
    if not menu then return end

    local item = MenuState.findItemById(menu, menu.focusedId)
    if not item then return end
    if resolve(item.disabled, false) then return end

    if item.type == 'list' then
        local count = #item.values
        if count == 0 then return end
        local oldIndex = item.index
        local newIndex = (item.index % count) + 1
        MenuState.patchItem(menu.id, item.id, { index = newIndex })
        -- Defer value lookups until after the patch so item.index is final.
        Platform.TriggerEvent('tLib:item:changed', menu.id, item.id, 'index', item.index, oldIndex)
        if item.onChange then item.onChange(item.values[item.index], item.index) end
    elseif item.type == 'slider' then
        local newVal = math.min(item.max, item.value + (item.step or 1))
        if newVal == item.value then return end
        local oldVal = item.value
        MenuState.patchItem(menu.id, item.id, { value = newVal })
        Platform.TriggerEvent('tLib:item:changed', menu.id, item.id, 'value', item.value, oldVal)
        if item.onChange then item.onChange(item.value, oldVal) end
    end
end
