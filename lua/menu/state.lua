-- tLib/lua/menu/state.lua
-- Owns all mutable menu data and the helpers that read or derive from it.
-- Exposes setUI, pushMenu, hideUI, patchItem, patchMenu, refreshMenu,
-- refreshItem, serialiseMenu, and the stack/lifecycle helpers used by other menu modules.

-- ── Shared utilities ──────────────────────────────────────────────────────────
-- MenuUtils is defined here (the first module loaded) so that actions.lua,
-- navigation.lua, and exports.lua can all reference it without re-defining it.

MenuUtils = {}

--- Resolve a value that may be a plain value or a zero-argument function.
-- @param v    any   The value or producer function.
-- @param def  any   Fallback when v is nil.
function MenuUtils.resolve(v, def)
    if type(v) == 'function' then return v() end
    return v ~= nil and v or def
end

-- ── Module ────────────────────────────────────────────────────────────────────

MenuState            = {}

local log            = Logger.create('tLib/menu')

local ui             = nil
local menus          = {}
local menuStack      = {}

-- Convenience alias used throughout this file.
local resolve        = MenuUtils.resolve

-- ── Lifecycle ─────────────────────────────────────────────────────────────────

local menuReady      = false
local readyCallbacks = {}

function MenuState.markReady()
    menuReady = true
    for _, cb in ipairs(readyCallbacks) do cb() end
    readyCallbacks = {}
    Platform.TriggerEvent('tLib:menu:ready')
end

function MenuState.isReady()
    return menuReady
end

function MenuState.onReady(callback)
    if type(callback) ~= 'function' then return end
    if menuReady then callback() else table.insert(readyCallbacks, callback) end
end

-- ── UI injection ──────────────────────────────────────────────────────────────

function MenuState.setUI(webui)
    ui = webui
end

-- ── Id generation ─────────────────────────────────────────────────────────────

local _idCounter = 0

function MenuState.generateId()
    _idCounter = _idCounter + 1
    return 'tlib_' .. tostring(_idCounter)
end

-- ── Stack accessors ───────────────────────────────────────────────────────────

function MenuState.getMenus()
    return menus
end

function MenuState.getStack()
    return menuStack
end

function MenuState.currentMenu()
    if #menuStack == 0 then return nil end
    return menus[menuStack[#menuStack]]
end

-- ── Stack mutation helpers ────────────────────────────────────────────────────

function MenuState.pushToStack(menuId)
    table.insert(menuStack, menuId)
end

function MenuState.popFromStack()
    return table.remove(menuStack, #menuStack)
end

function MenuState.clearStack()
    while #menuStack > 0 do table.remove(menuStack) end
end

-- ── Item order counter ────────────────────────────────────────────────────────

function MenuState.nextItemOrder(menu)
    menu._orderCounter = (menu._orderCounter or 0) + 1
    return menu._orderCounter
end

-- ── O(1) item index management ────────────────────────────────────────────────
-- Each menu carries a _itemIndex table (id → item) that is maintained in sync
-- with the items array. All mutation paths (addItem, removeItem, clearItems)
-- must go through these helpers so the index never drifts.

--- Insert an item into both the items array and the O(1) index.
function MenuState.addItem(menu, item)
    table.insert(menu.items, item)
    menu._itemIndex[item.id] = item
end

--- Remove an item from both the items array and the O(1) index.
-- Returns true if the item was found and removed, false otherwise.
function MenuState.removeItem(menu, itemId)
    for i = #menu.items, 1, -1 do
        if menu.items[i].id == itemId then
            table.remove(menu.items, i)
            menu._itemIndex[itemId] = nil
            return true
        end
    end
    return false
end

--- Clear all items and reset the index and order counter.
function MenuState.clearItems(menu)
    menu.items         = {}
    menu._itemIndex    = {}
    menu.focusedId     = nil
    menu._orderCounter = 0
end

--- O(1) item lookup by id.
function MenuState.findItemById(menu, itemId)
    if not menu or not itemId then return nil end
    return menu._itemIndex[itemId]
end

-- ── Serialisation helpers ─────────────────────────────────────────────────────

local function filteredSortedItems(menu)
    local result = {}
    for _, item in ipairs(menu.items) do
        local v = item.visible
        local isVisible
        if type(v) == 'function' then
            isVisible = v()
        elseif v == nil then
            isVisible = true
        else
            isVisible = v ~= false
        end

        if isVisible then table.insert(result, item) end
    end
    table.sort(result, function(a, b)
        local pa, pb = a.priority or 500, b.priority or 500
        if pa ~= pb then return pa < pb end
        return (a._order or 0) < (b._order or 0)
    end)
    return result
end

local function indexOfId(items, itemId)
    for i, item in ipairs(items) do
        if item.id == itemId then return i end
    end
    return 0
end

-- Returns the first non-separator, non-disabled item and its 1-based index.
local function firstFocusable(items)
    for i, item in ipairs(items) do
        if item.type ~= 'separator' and not resolve(item.disabled, false) then
            return item, i
        end
    end
    return nil, 1
end

-- Compute the next focusable item in the given direction (+1 or -1).
-- Updates menu.focusedId and returns the new id, or nil if no focusable item exists.
function MenuState.moveFocus(menu, dir)
    local items = filteredSortedItems(menu)
    local count = #items
    if count == 0 then return nil end

    local cur = indexOfId(items, menu.focusedId)
    if cur == 0 then
        local item = firstFocusable(items)
        if item then menu.focusedId = item.id end
        return menu.focusedId
    end

    for i = 1, count do
        local idx = ((cur - 1 + dir * i) % count) + 1
        local item = items[idx]
        if item.type ~= 'separator' then
            menu.focusedId = item.id
            return item.id
        end
    end
    return menu.focusedId
end

-- Converts a menu table into the plain data shape the WebUI expects.
-- Resolves dynamic fields, filters invisible items, sorts by priority,
-- and computes focusedIndex within the filtered list.
-- Side effect: may update menu.focusedId and menu._visibleIds.
function MenuState.serialiseMenu(menu)
    local visibleItems = filteredSortedItems(menu)

    local focusedIndex = indexOfId(visibleItems, menu.focusedId)
    if focusedIndex == 0 then
        local fallback, fallbackIdx = firstFocusable(visibleItems)
        if fallback then
            menu.focusedId = fallback.id
            focusedIndex   = fallbackIdx
        else
            focusedIndex = 1
        end
    end

    -- Shadow used by refreshItem to detect visibility changes between pushes.
    menu._visibleIds = {}
    for _, item in ipairs(visibleItems) do
        menu._visibleIds[item.id] = true
    end

    local items = {}
    for _, item in ipairs(visibleItems) do
        local s = {
            id          = item.id,
            type        = item.type,
            label       = resolve(item.label, ''),
            description = resolve(item.description, ''),
            disabled    = resolve(item.disabled, false),
        }
        local rl = resolve(item.rightLabel, nil)
        if rl ~= nil then s.rightLabel = rl end
        if item.icon ~= nil then s.icon = item.icon end
        if item.type == 'button' and item.submenuId ~= nil then s.isSubmenu = true end
        if item.type == 'checkbox' then
            s.checked = item.checked or false
        elseif item.type == 'list' then
            s.values = item.values or {}
            s.index  = item.index or 1
        elseif item.type == 'slider' then
            s.min   = item.min or 0
            s.max   = item.max or 10
            s.value = item.value or 0
            s.step  = item.step or 1
        end
        table.insert(items, s)
    end

    -- Inherited layout takes precedence over the menu's own values when a
    -- parent passed its layout down via openMenu's inheritance logic.
    local effectivePosition = menu._inheritedPosition or menu.position or 'top-left'
    local effectiveSize     = menu._inheritedSize or menu.size or 'md'

    local serialised        = {
        id           = menu.id,
        title        = resolve(menu.title, 'Menu'),
        subtitle     = resolve(menu.subtitle, ''),
        items        = items,
        focusedIndex = focusedIndex,
        canGoBack    = #menuStack > 1,
        position     = effectivePosition,
        size         = effectiveSize,
        theme        = menu.theme or nil,
    }

    local b                 = resolve(menu.banner, nil)
    if b ~= nil then serialised.banner = b end

    -- itemHeight is optional; omit the key entirely when not set so the UI
    -- falls back to its built-in default (40 px) without the overhead of
    -- sending a null/nil value on every menu push.
    if type(menu.itemHeight) == 'number' and menu.itemHeight > 0 then
        serialised.itemHeight = menu.itemHeight
    end

    return serialised
end

-- ── WebUI helpers ─────────────────────────────────────────────────────────────

function MenuState.pushMenu()
    local menu = MenuState.currentMenu()
    if not menu then
        log('pushMenu: no current menu', 4)
        return
    end
    Platform.bringUIToFront(ui)
    Platform.sendUIEvent(ui, 'setMenu', MenuState.serialiseMenu(menu))
    Platform.sendUIEvent(ui, 'setVisible', true)
end

function MenuState.hideUI()
    Platform.sendUIEvent(ui, 'setVisible', false)
end

-- Preloads a banner image URL in the WebUI so it is cached before the menu
-- is first shown. Safe to call before the UI is ready — onReady queues it.
function MenuState.preloadBanner(url)
    if type(url) ~= 'string' or url == '' then return end
    MenuState.onReady(function()
        Platform.sendUIEvent(ui, 'preloadBanner', url)
    end)
end

-- ── Granular item update ──────────────────────────────────────────────────────

-- Fields resolved before sending to the UI (may be stored as functions).
local _dynamic = { label = true, description = true, disabled = true, rightLabel = true }
-- Lua-only fields that must never reach the UI.
local _skip    = {
    onSelect = true,
    onChange = true,
    onToggle = true,
    visible  = true,
    priority = true,
    _order   = true,
}

-- Applies changes to Lua state and, if the menu is currently on top,
-- sends a lightweight 'patchItem' event instead of a full setMenu re-push.
function MenuState.patchItem(menuId, itemId, changes)
    local menu = menus[menuId]
    if not menu then
        log('patchItem: unknown menuId ' .. tostring(menuId), 4)
        return
    end
    local item = MenuState.findItemById(menu, itemId)
    if not item then
        log('patchItem: unknown itemId ' .. tostring(itemId) .. ' in menu ' .. tostring(menuId), 4)
        return
    end

    for k, v in pairs(changes) do item[k] = v end

    if menuStack[#menuStack] ~= menuId then return end

    local serialisedChanges = {}
    for k in pairs(changes) do
        if _dynamic[k] then
            serialisedChanges[k] = resolve(item[k], nil)
        elseif not _skip[k] then
            serialisedChanges[k] = item[k]
        end
    end

    if next(serialisedChanges) ~= nil then
        Platform.sendUIEvent(ui, 'patchItem', { itemId = itemId, changes = serialisedChanges })
    end
end

-- ── Menu-level patch ──────────────────────────────────────────────────────────
-- Merges changes into Lua state and, if on top, sends a lightweight 'patchMenu'
-- event so the UI can update reactively without a full setMenu re-push.

-- title/subtitle/banner may be functions and are resolved before sending.
local _menuDynamic = { title = true, subtitle = true, banner = true }
-- Fields that live in Lua only — never forwarded to the UI.
local _menuSkip    = { inheritLayout = true, onOpen = true, onClose = true }

function MenuState.patchMenu(menuId, changes)
    local menu = menus[menuId]
    if not menu then
        log('patchMenu: unknown menuId ' .. tostring(menuId), 4)
        return
    end

    for k, v in pairs(changes) do menu[k] = v end

    if menuStack[#menuStack] ~= menuId then return end

    local resolved = {}
    for k in pairs(changes) do
        if not _menuSkip[k] then
            if _menuDynamic[k] then
                local r = resolve(menu[k], nil)
                if r ~= nil then resolved[k] = r end
            else
                resolved[k] = menu[k]
            end
        end
    end

    if next(resolved) ~= nil then
        Platform.sendUIEvent(ui, 'patchMenu', { changes = resolved })
    end
end

-- ── Refresh helpers ───────────────────────────────────────────────────────────

-- Force a full re-serialisation for the given menu. No-op if not on top.
function MenuState.refreshMenu(menuId)
    if menuStack[#menuStack] ~= menuId then return end
    MenuState.pushMenu()
end

-- Refresh a single item. Falls back to refreshMenu when visibility has changed
-- (structural change), otherwise sends a targeted patchItem.
function MenuState.refreshItem(menuId, itemId)
    if menuStack[#menuStack] ~= menuId then return end

    local menu = menus[menuId]
    if not menu then
        log('refreshItem: unknown menuId ' .. tostring(menuId), 4)
        return
    end
    local item = MenuState.findItemById(menu, itemId)
    if not item then
        log('refreshItem: unknown itemId ' .. tostring(itemId) .. ' in menu ' .. tostring(menuId), 4)
        return
    end

    local v = item.visible
    local nowVisible
    if type(v) == 'function' then
        nowVisible = v()
    elseif v == nil then
        nowVisible = true
    else
        nowVisible = v ~= false
    end

    local visibleIds = menu._visibleIds
    if visibleIds == nil then
        -- No shadow yet; can't determine previous state safely.
        MenuState.refreshMenu(menuId)
        return
    end

    local wasVisible = visibleIds[itemId] == true
    if nowVisible ~= wasVisible then
        MenuState.refreshMenu(menuId)
        return
    end

    if not nowVisible then return end

    local patch = {
        label       = resolve(item.label, ''),
        description = resolve(item.description, ''),
        disabled    = resolve(item.disabled, false),
    }
    local rl = resolve(item.rightLabel, nil)
    if rl ~= nil then patch.rightLabel = rl end
    if item.icon ~= nil then patch.icon = item.icon end
    if item.type == 'checkbox' then
        patch.checked = item.checked or false
    elseif item.type == 'list' then
        patch.values = item.values or {}
        patch.index  = item.index or 1
    elseif item.type == 'slider' then
        patch.min   = item.min or 0
        patch.max   = item.max or 10
        patch.value = item.value or 0
    end

    Platform.sendUIEvent(ui, 'patchItem', { itemId = itemId, changes = patch })
end
