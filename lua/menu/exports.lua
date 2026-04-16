-- tLib/lua/menu/exports.lua

MenuExports   = {}

local log     = Logger.create('tLib/menu')
local resolve = MenuUtils.resolve

local function applyOpts(item, opts)
    if type(opts) ~= 'table' then return end
    if opts.visible ~= nil then item.visible = opts.visible end
    if opts.priority ~= nil then item.priority = tonumber(opts.priority) or MenuState.DEFAULT_PRIORITY end
    if opts.disabled ~= nil then item.disabled = opts.disabled end
    if opts.rightLabel ~= nil then item.rightLabel = opts.rightLabel end
    if opts.icon ~= nil then item.icon = opts.icon end
end

-- Like applyOpts but skips interactive-only fields (separators are never interactive).
local function applyBaseOpts(item, opts)
    if type(opts) ~= 'table' then return end
    if opts.visible ~= nil then item.visible = opts.visible end
    if opts.priority ~= nil then item.priority = tonumber(opts.priority) or MenuState.DEFAULT_PRIORITY end
end

-- Used by both the individual Add* exports and BatchUpdate so item construction
-- logic lives in exactly one place. Returns a fully populated item table or nil
-- on unknown type.
--
-- op fields consumed (mirrors both the export args and the BatchUpdate op shape):
--   type        string   'button'|'checkbox'|'slider'|'list'|'separator'|'submenuButton'
--   itemId      string   Explicit id; auto-generated when absent/empty.
--   label       string
--   description string
--   checked     boolean  (checkbox)
--   min/max/value/step  number (slider)
--   values/index        table/number (list)
--   submenuId   string   (submenuButton)
--   onSelect / onChange / onToggle  functions (stored Lua-side only)
--   opts        table    Passed through to applyOpts / applyBaseOpts.
local function buildItem(menu, op)
    local itemType = op.type
    local itemId   = (op.itemId and op.itemId ~= '') and op.itemId or MenuState.generateId()

    local item     = {
        id          = itemId,
        type        = itemType == 'submenuButton' and 'button' or itemType,
        label       = op.label or '',
        description = op.description or '',
        disabled    = false,
        _order      = MenuState.nextItemOrder(menu),
    }

    if itemType == 'button' then
        item.onSelect = op.onSelect or nil
    elseif itemType == 'submenuButton' then
        item.submenuId = op.submenuId
        item.onSelect  = op.onSelect or nil
    elseif itemType == 'checkbox' then
        item.checked  = op.checked or false
        item.onToggle = op.onToggle or nil
    elseif itemType == 'slider' then
        item.min      = op.min or 0
        item.max      = op.max or 10
        item.value    = op.value or 0
        item.step     = tonumber(op.step) or 1
        item.onChange = op.onChange or nil
        item.onSelect = op.onSelect or nil
    elseif itemType == 'list' then
        item.values   = op.values or {}
        item.index    = op.index or 1
        item.onChange = op.onChange or nil
        item.onSelect = op.onSelect or nil
    elseif itemType == 'separator' then
        item.disabled = true
        applyBaseOpts(item, op.opts)
        return item
    else
        return nil
    end

    applyOpts(item, op.opts)
    return item
end

-- Applies changes to a menu's top-level fields in Lua state, routes UI-visible
-- fields through MenuState.patchMenu, and fires tLib:menu:updated.
-- onOpen/onClose are Lua-only callbacks — never forwarded to the UI.
local function updateMenuImpl(menuId, changes)
    if type(changes) ~= 'table' then return false end
    local allMenus = MenuState.getMenus()
    local menu     = allMenus[menuId]
    if not menu then
        log('UpdateMenu: unknown menuId ' .. tostring(menuId), 4)
        return false
    end

    if changes.onOpen ~= nil then
        menu.onOpen = changes.onOpen or nil
    end
    if changes.onClose ~= nil then
        menu.onClose = changes.onClose or nil
    end

    -- Collect fields that have a UI representation and route them through patchMenu,
    -- which handles both the Lua-state merge and the lightweight UI event.
    local uiChanges = {}
    for _, k in ipairs({ 'title', 'subtitle', 'banner', 'position', 'size', 'inheritLayout', 'theme' }) do
        if changes[k] ~= nil then uiChanges[k] = changes[k] end
    end
    if next(uiChanges) ~= nil then
        MenuState.patchMenu(menuId, uiChanges)
    end

    Platform.TriggerEvent('tLib:menu:updated', menuId, changes)
    return true
end

-- Applies changes to an item, refreshes the UI for that item, and fires
-- tLib:item:updated. Used by all Set* item exports.
local function updateItemImpl(menuId, itemId, changes)
    if type(changes) ~= 'table' then return false end
    local allMenus = MenuState.getMenus()
    local menu     = allMenus[menuId]
    if not menu then
        log('UpdateItem: unknown menuId ' .. tostring(menuId), 4)
        return false
    end
    local item = MenuState.findItemById(menu, itemId)
    if not item then
        log('UpdateItem: unknown itemId ' .. tostring(itemId) .. ' in menu ' .. tostring(menuId), 4)
        return false
    end
    for k, v in pairs(changes) do item[k] = v end
    MenuState.refreshItem(menuId, itemId)
    Platform.TriggerEvent('tLib:item:updated', menuId, itemId, changes)
    return true
end

-- Priority changes reorder the list — that's structural, so we need a full
-- refresh rather than a surgical patchItem.
local function setPriorityImpl(menuId, itemId, priority)
    local allMenus = MenuState.getMenus()
    local menu     = allMenus[menuId]
    if not menu then
        log('SetItemPriority: unknown menuId ' .. tostring(menuId), 4)
        return false
    end
    local item = MenuState.findItemById(menu, itemId)
    if not item then
        log('SetItemPriority: unknown itemId ' .. tostring(itemId) .. ' in menu ' .. tostring(menuId), 4)
        return false
    end
    item.priority = tonumber(priority) or MenuState.DEFAULT_PRIORITY
    Platform.TriggerEvent('tLib:item:updated', menuId, itemId, { priority = item.priority })
    MenuState.refreshMenu(menuId)
    return true
end

function MenuExports.register()
    local function registerExport(name, fn)
        Platform.export('tLib', name, fn)
    end
    local function TriggerEvent(...)
        Platform.TriggerEvent(...)
    end

    -- opts table (all optional):
    --   position      string   "top-left" | "top-center" | ... | "bottom-right"
    --   size          string   "sm" | "md" | "lg"
    --   inheritLayout boolean  false = use own layout even when opened as submenu
    --   banner        string | function  URL shown above the title row
    --   blockInput    boolean  true = block player movement and camera while open (default false)
    --   theme         string   Id of a registered tLib theme to scope this menu's appearance.
    --   itemHeight    number   Fixed height in pixels for every item row (default: 40).
    --                          All items in this menu will be rendered at exactly this
    --                          height regardless of type or content.
    registerExport('CreateMenu', function(menuId, title, subtitle, opts, onOpen, onClose)
        if not menuId or menuId == '' then
            menuId = MenuState.generateId()
        end
        local allMenus   = MenuState.getMenus()
        local o          = type(opts) == 'table' and opts or {}
        allMenus[menuId] = {
            id            = menuId,
            title         = title or 'Menu',
            subtitle      = subtitle or '',
            items         = {},
            _itemIndex    = {},
            focusedId     = nil,
            _orderCounter = 0,
            onOpen        = onOpen or nil,
            onClose       = onClose or nil,
            position      = type(o.position) == 'string' and o.position or nil,
            size          = type(o.size) == 'string' and o.size or nil,
            -- nil means "default true"; only explicit false opts out of inheritance.
            inheritLayout = o.inheritLayout,
            banner        = o.banner or nil,
            blockInput    = o.blockInput == true,
            theme         = type(o.theme) == 'string' and o.theme ~= '' and o.theme or nil,
            itemHeight    = type(o.itemHeight) == 'number' and o.itemHeight > 0 and o.itemHeight or nil,
        }
        TriggerEvent('tLib:menu:created', menuId)
        MenuState.preloadBanner(resolve(o.banner, nil))
        return menuId
    end)

    registerExport('OpenMenu', function(menuId)
        MenuNavigation.openMenu(menuId)
    end)

    registerExport('CloseMenu', function(menuId)
        MenuNavigation.closeMenu(menuId)
    end)

    registerExport('CloseAll', function()
        MenuNavigation.closeAll()
    end)

    registerExport('IsOpen', function()
        return #MenuState.getStack() > 0
    end)

    registerExport('CheckMenu', function(menuId)
        local allMenus = MenuState.getMenus()
        return allMenus[menuId] ~= nil
    end)

    registerExport('ClearMenu', function(menuId)
        local allMenus = MenuState.getMenus()
        local menu     = allMenus[menuId]
        if not menu then
            log('ClearMenu: unknown menuId ' .. tostring(menuId), 4)
            return
        end
        MenuState.clearItems(menu)
        TriggerEvent('tLib:menu:cleared', menuId)
    end)

    registerExport('DeleteMenu', function(menuId)
        MenuNavigation.closeMenu(menuId)
        local allMenus   = MenuState.getMenus()
        allMenus[menuId] = nil
        TriggerEvent('tLib:menu:deleted', menuId)
    end)

    -- Merges any top-level menu fields. Accepted keys: title, subtitle, banner,
    -- position, size, inheritLayout, onOpen, onClose. Fires tLib:menu:updated.
    registerExport('UpdateMenu', function(menuId, changes)
        return updateMenuImpl(menuId, changes)
    end)

    registerExport('SetMenuLayout', function(menuId, position, size)
        return updateMenuImpl(menuId, { position = position, size = size })
    end)

    registerExport('SetMenuBanner', function(menuId, banner)
        MenuState.preloadBanner(resolve(banner, nil))
        return updateMenuImpl(menuId, { banner = banner })
    end)

    registerExport('SetMenuTitle', function(menuId, title)
        return updateMenuImpl(menuId, { title = title })
    end)

    registerExport('SetMenuSubtitle', function(menuId, subtitle)
        return updateMenuImpl(menuId, { subtitle = subtitle })
    end)

    -- NOTE: Add* exports write to Lua state only. If the target menu is currently
    -- visible, call RefreshMenu(menuId) after all Add* calls to push the changes
    -- to the UI. Batch additions followed by a single RefreshMenu is the
    -- recommended pattern — do NOT rely on auto-refresh after Add* calls.

    registerExport('AddButton', function(menuId, itemId, label, description, opts, onSelect)
        local allMenus = MenuState.getMenus()
        local menu     = allMenus[menuId]
        if not menu then
            log('AddButton: unknown menuId ' .. tostring(menuId), 4)
            return nil
        end
        local item = buildItem(menu, {
            type        = 'button',
            itemId      = itemId,
            label       = label,
            description = description,
            opts        = opts,
            onSelect    = onSelect,
        })
        MenuState.addItem(menu, item)
        TriggerEvent('tLib:item:added', menuId, item.id)
        return item.id
    end)

    registerExport('AddCheckbox', function(menuId, itemId, label, description, checked, opts, onToggle)
        local allMenus = MenuState.getMenus()
        local menu     = allMenus[menuId]
        if not menu then
            log('AddCheckbox: unknown menuId ' .. tostring(menuId), 4)
            return nil
        end
        local item = buildItem(menu, {
            type        = 'checkbox',
            itemId      = itemId,
            label       = label,
            description = description,
            checked     = checked,
            opts        = opts,
            onToggle    = onToggle,
        })
        MenuState.addItem(menu, item)
        TriggerEvent('tLib:item:added', menuId, item.id)
        return item.id
    end)

    registerExport('AddSlider',
        function(menuId, itemId, label, description, min, max, value, step, opts, onChange, onSelect)
            local allMenus = MenuState.getMenus()
            local menu     = allMenus[menuId]
            if not menu then
                log('AddSlider: unknown menuId ' .. tostring(menuId), 4)
                return nil
            end
            local item = buildItem(menu, {
                type        = 'slider',
                itemId      = itemId,
                label       = label,
                description = description,
                min         = min,
                max         = max,
                value       = value,
                step        = step,
                opts        = opts,
                onChange    = onChange,
                onSelect    = onSelect,
            })
            MenuState.addItem(menu, item)
            TriggerEvent('tLib:item:added', menuId, item.id)
            return item.id
        end)

    registerExport('AddList', function(menuId, itemId, label, description, values, index, opts, onChange, onSelect)
        local allMenus = MenuState.getMenus()
        local menu     = allMenus[menuId]
        if not menu then
            log('AddList: unknown menuId ' .. tostring(menuId), 4)
            return nil
        end
        local item = buildItem(menu, {
            type        = 'list',
            itemId      = itemId,
            label       = label,
            description = description,
            values      = values,
            index       = index,
            opts        = opts,
            onChange    = onChange,
            onSelect    = onSelect,
        })
        MenuState.addItem(menu, item)
        TriggerEvent('tLib:item:added', menuId, item.id)
        return item.id
    end)

    -- Separators only respect visible and priority; other opts are silently ignored.
    registerExport('AddSpacer', function(menuId, itemId, label, description, opts)
        local allMenus = MenuState.getMenus()
        local menu     = allMenus[menuId]
        if not menu then
            log('AddSpacer: unknown menuId ' .. tostring(menuId), 4)
            return nil
        end
        local item = buildItem(menu, {
            type        = 'separator',
            itemId      = itemId,
            label       = label,
            description = description,
            opts        = opts,
        })
        MenuState.addItem(menu, item)
        TriggerEvent('tLib:item:added', menuId, item.id)
        return item.id
    end)

    registerExport('AddSubmenuButton', function(menuId, itemId, submenuId, label, description, opts, onSelect)
        local allMenus = MenuState.getMenus()
        local menu     = allMenus[menuId]
        if not menu then
            log('AddSubmenuButton: unknown menuId ' .. tostring(menuId), 4)
            return nil
        end
        local item = buildItem(menu, {
            type        = 'submenuButton',
            itemId      = itemId,
            submenuId   = submenuId,
            label       = label,
            description = description,
            opts        = opts,
            onSelect    = onSelect,
        })
        MenuState.addItem(menu, item)
        TriggerEvent('tLib:item:added', menuId, item.id)
        return item.id
    end)

    registerExport('RemoveItem', function(menuId, itemId)
        local allMenus = MenuState.getMenus()
        local menu     = allMenus[menuId]
        if not menu then
            log('RemoveItem: unknown menuId ' .. tostring(menuId), 4)
            return
        end
        if not MenuState.removeItem(menu, itemId) then
            log('RemoveItem: itemId ' .. tostring(itemId) .. ' not found in menu ' .. tostring(menuId), 4)
            return
        end
        TriggerEvent('tLib:item:removed', menuId, itemId)
    end)

    registerExport('UpdateItem', function(menuId, itemId, changes)
        return updateItemImpl(menuId, itemId, changes)
    end)

    registerExport('SetItemDisabled', function(menuId, itemId, disabled)
        return updateItemImpl(menuId, itemId, { disabled = disabled })
    end)

    -- Visibility is structural — it adds/removes rows from the serialised list.
    -- refreshItem detects the wasVisible→nowVisible change and escalates to a
    -- full refreshMenu automatically, so updateItemImpl is the correct path here,
    -- exactly as for every other Set* export.
    registerExport('SetItemVisible', function(menuId, itemId, visible)
        return updateItemImpl(menuId, itemId, { visible = visible })
    end)

    registerExport('SetItemLabel', function(menuId, itemId, label)
        return updateItemImpl(menuId, itemId, { label = label })
    end)

    registerExport('SetItemDescription', function(menuId, itemId, desc)
        return updateItemImpl(menuId, itemId, { description = desc })
    end)

    registerExport('SetItemRightLabel', function(menuId, itemId, label)
        return updateItemImpl(menuId, itemId, { rightLabel = label })
    end)

    registerExport('SetItemIcon', function(menuId, itemId, icon)
        return updateItemImpl(menuId, itemId, { icon = icon })
    end)

    -- Priority changes affect sort order — requires a full menu refresh.
    registerExport('SetItemPriority', function(menuId, itemId, priority)
        return setPriorityImpl(menuId, itemId, priority)
    end)

    -- More discoverable alias for SetItemPriority.
    registerExport('SetItemOrder', function(menuId, itemId, priority)
        return setPriorityImpl(menuId, itemId, priority)
    end)

    registerExport('SetCheckboxState', function(menuId, itemId, checked)
        return updateItemImpl(menuId, itemId, { checked = checked })
    end)

    registerExport('SetListOptions', function(menuId, itemId, values, index)
        return updateItemImpl(menuId, itemId, { values = values, index = index or 1 })
    end)

    -- Changes index without touching the values array.
    registerExport('SetListIndex', function(menuId, itemId, index)
        return updateItemImpl(menuId, itemId, { index = index })
    end)

    registerExport('SetSliderValue', function(menuId, itemId, value)
        return updateItemImpl(menuId, itemId, { value = value })
    end)

    registerExport('SetSliderRange', function(menuId, itemId, min, max, value)
        return updateItemImpl(menuId, itemId, { min = min, max = max, value = value or min })
    end)

    registerExport('SetSliderStep', function(menuId, itemId, step)
        return updateItemImpl(menuId, itemId, { step = math.max(1, tonumber(step) or 1) })
    end)

    registerExport('MoveItemToTop', function(menuId, itemId)
        local allMenus = MenuState.getMenus()
        local menu     = allMenus[menuId]
        if not menu then
            log('MoveItemToTop: unknown menuId ' .. tostring(menuId), 4)
            return false
        end
        local item = MenuState.findItemById(menu, itemId)
        if not item then
            log('MoveItemToTop: unknown itemId ' .. tostring(itemId) .. ' in menu ' .. tostring(menuId), 4)
            return false
        end
        local lowest = math.huge
        for _, it in ipairs(menu.items) do
            if it.id ~= itemId then
                local p = it.priority or MenuState.DEFAULT_PRIORITY
                if p < lowest then lowest = p end
            end
        end
        item.priority = (lowest == math.huge) and 0 or math.max(0, lowest - 1)
        TriggerEvent('tLib:item:updated', menuId, itemId, { priority = item.priority })
        MenuState.refreshMenu(menuId)
        return true
    end)

    registerExport('MoveItemToBottom', function(menuId, itemId)
        local allMenus = MenuState.getMenus()
        local menu     = allMenus[menuId]
        if not menu then
            log('MoveItemToBottom: unknown menuId ' .. tostring(menuId), 4)
            return false
        end
        local item = MenuState.findItemById(menu, itemId)
        if not item then
            log('MoveItemToBottom: unknown itemId ' .. tostring(itemId) .. ' in menu ' .. tostring(menuId), 4)
            return false
        end
        local highest = -math.huge
        for _, it in ipairs(menu.items) do
            if it.id ~= itemId then
                local p = it.priority or MenuState.DEFAULT_PRIORITY
                if p > highest then highest = p end
            end
        end
        item.priority = (highest == -math.huge) and 1 or highest + 1
        TriggerEvent('tLib:item:updated', menuId, itemId, { priority = item.priority })
        MenuState.refreshMenu(menuId)
        return true
    end)

    registerExport('RefreshMenu', function(menuId)
        MenuState.refreshMenu(menuId)
    end)

    registerExport('RefreshItem', function(menuId, itemId)
        MenuState.refreshItem(menuId, itemId)
    end)

    registerExport('GetCurrentMenuId', function()
        local stack = MenuState.getStack()
        return stack[#stack] or nil
    end)

    registerExport('GetAllMenuIds', function()
        local allMenus = MenuState.getMenus()
        local ids      = {}
        for id in pairs(allMenus) do table.insert(ids, id) end
        return ids
    end)

    registerExport('GetMenuInfo', function(menuId)
        local allMenus = MenuState.getMenus()
        local menu     = allMenus[menuId]
        if not menu then return nil end
        local info = {
            id        = menu.id,
            title     = resolve(menu.title, 'Menu'),
            subtitle  = resolve(menu.subtitle, ''),
            itemCount = #menu.items,
            position  = menu.position or 'top-left',
            size      = menu.size or 'md',
        }
        local b = resolve(menu.banner, nil)
        if b ~= nil then info.banner = b end
        return info
    end)

    -- Returns a resolved snapshot of an item's current state. Strips callbacks
    -- and internal fields. Shape mirrors the serialised format used by serialiseMenu.
    registerExport('GetItemInfo', function(menuId, itemId)
        local allMenus = MenuState.getMenus()
        local menu     = allMenus[menuId]
        if not menu then return nil end
        local item = MenuState.findItemById(menu, itemId)
        if not item then return nil end

        local info = {
            id          = item.id,
            type        = item.type,
            label       = resolve(item.label, ''),
            description = resolve(item.description, ''),
            disabled    = resolve(item.disabled, false),
        }
        local rl = resolve(item.rightLabel, nil)
        if rl ~= nil then info.rightLabel = rl end
        if item.icon ~= nil then info.icon = item.icon end
        if item.type == 'checkbox' then
            info.checked = item.checked or false
        elseif item.type == 'list' then
            info.values = item.values or {}
            info.index  = item.index or 1
        elseif item.type == 'slider' then
            info.min   = item.min or 0
            info.max   = item.max or 10
            info.value = item.value or 0
            info.step  = item.step or 1
        end
        return info
    end)

    -- Returns a copy of the current stack (bottom → top), pullable on demand.
    -- Same data as the tLib:menu:stack:changed event but synchronous.
    registerExport('GetStackIds', function()
        local stack = MenuState.getStack()
        local copy  = {}
        for i, id in ipairs(stack) do copy[i] = id end
        return copy
    end)

    -- True only when menuId is the topmost menu AND the UI is visible.
    registerExport('IsMenuVisible', function(menuId)
        local stack = MenuState.getStack()
        return #stack > 0 and stack[#stack] == menuId
    end)

    -- Applies all operations to Lua state atomically, then fires a single
    -- refreshMenu per affected visible menu rather than one per operation.
    -- Supported op.type values:
    --   updateMenu, updateItem, removeItem,
    --   addButton, addCheckbox, addSlider, addList, addSpacer, addSubmenuButton
    -- Returns an array of { success=bool, err=string|nil } in op order.
    registerExport('BatchUpdate', function(ops)
        if type(ops) ~= 'table' then return {} end

        local allMenus   = MenuState.getMenus()
        local results    = {}
        local dirtyMenus = {}

        -- Canonical mapping from BatchUpdate op.type to the internal type token
        -- consumed by buildItem. Only the add* variants need this; others are handled
        -- directly.
        local addTypeMap = {
            addButton        = 'button',
            addCheckbox      = 'checkbox',
            addSlider        = 'slider',
            addList          = 'list',
            addSpacer        = 'separator',
            addSubmenuButton = 'submenuButton',
        }

        for i, op in ipairs(ops) do
            local ok, err = false, nil

            if op.type == 'updateMenu' then
                local menu = allMenus[op.menuId]
                if menu and type(op.changes) == 'table' then
                    if op.changes.onOpen ~= nil then
                        menu.onOpen = op.changes.onOpen or nil
                    end
                    if op.changes.onClose ~= nil then
                        menu.onClose = op.changes.onClose or nil
                    end
                    for _, k in ipairs({ 'title', 'subtitle', 'banner', 'position', 'size', 'inheritLayout' }) do
                        if op.changes[k] ~= nil then menu[k] = op.changes[k] end
                    end
                    TriggerEvent('tLib:menu:updated', op.menuId, op.changes)
                    dirtyMenus[op.menuId] = true
                    ok = true
                else
                    err = 'unknown menuId or invalid changes'
                end
            elseif op.type == 'updateItem' then
                local menu = allMenus[op.menuId]
                if menu and type(op.changes) == 'table' then
                    local item = MenuState.findItemById(menu, op.itemId)
                    if item then
                        for k, v in pairs(op.changes) do item[k] = v end
                        TriggerEvent('tLib:item:updated', op.menuId, op.itemId, op.changes)
                        dirtyMenus[op.menuId] = true
                        ok = true
                    else
                        err = 'unknown itemId: ' .. tostring(op.itemId)
                    end
                else
                    err = 'unknown menuId or invalid changes: ' .. tostring(op.menuId)
                end
            elseif op.type == 'removeItem' then
                local menu = allMenus[op.menuId]
                if menu then
                    if MenuState.removeItem(menu, op.itemId) then
                        TriggerEvent('tLib:item:removed', op.menuId, op.itemId)
                        dirtyMenus[op.menuId] = true
                        ok = true
                    else
                        err = 'unknown itemId: ' .. tostring(op.itemId)
                    end
                else
                    err = 'unknown menuId: ' .. tostring(op.menuId)
                end
            elseif addTypeMap[op.type] then
                local menu = allMenus[op.menuId]
                if menu then
                    local item = buildItem(menu, {
                        type        = addTypeMap[op.type],
                        itemId      = op.itemId,
                        label       = op.label,
                        description = op.description,
                        -- checkbox
                        checked     = op.checked,
                        onToggle    = op.onToggle,
                        -- slider
                        min         = op.min,
                        max         = op.max,
                        value       = op.value,
                        step        = op.step,
                        onChange    = op.onChange,
                        -- list
                        values      = op.values,
                        index       = op.index,
                        -- button / submenuButton
                        submenuId   = op.submenuId,
                        onSelect    = op.onSelect,
                        -- shared
                        opts        = op.opts,
                    })
                    if item then
                        MenuState.addItem(menu, item)
                        TriggerEvent('tLib:item:added', op.menuId, item.id)
                        dirtyMenus[op.menuId] = true
                        ok = true
                    else
                        err = 'buildItem returned nil for type: ' .. tostring(op.type)
                    end
                else
                    err = 'unknown menuId: ' .. tostring(op.menuId)
                end
            else
                err = 'unknown op type: ' .. tostring(op.type)
            end

            results[i] = { success = ok, err = err }
        end

        -- One full re-push per dirty menu that is currently on top.
        local stack = MenuState.getStack()
        local topId = stack[#stack]
        if topId and dirtyMenus[topId] then
            MenuState.pushMenu()
        end

        return results
    end)
end
