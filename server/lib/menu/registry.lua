-- The menu engine's authority core: who owns which menu, which rows a player is
-- entitled to see, and what a permission-filtered snapshot looks like.
--
-- Deliberately pure -- no natives, no Platform calls, no events, no timers.
-- Everything from the host arrives through `deps`. Every ACE decision funnels
-- through `allowed` and `itemAllowed`, and with `hasPermission` injected a test
-- can hand those an explicit permission table and assert the exact row bitmap a
-- player receives. That is the only way to prove a revoked ACE removes a row
-- rather than greying it out.

MenuRegistry = {}
local R = MenuRegistry
R.__index = R

local S = MenuSchema

-- Courtesy limits, not safety ones: one resource should not exhaust a screen
-- every resource shares. The real ceiling is the transport, and it is far away --
-- snapshotTransport sends up to 512 KB directly, chunks past that, and refuses
-- only beyond 16 MB. A catalogued owner gets the larger allowance because its
-- menus cost a bitmap per player rather than a descriptor.
--
-- `trusted` exempts an owner from these counts and from nothing else.
R.defaults = {
    cataloguedMenusPerOwner = 240,
    menusPerOwner = 32,
    totalMenus = 300,
    maxDomains = 8,
}

--- `deps` is:
---   hasPermission(source, key) -> boolean   required; the only authority source
---   now() -> ms                             required; drives the rate limiter
---   log(message)                            optional
---   trusted(owner) -> boolean               optional; count limits only, never
---                                           consulted for permission
function R.new(deps)
    assert(type(deps) == 'table', 'MenuRegistry.new requires a dependency table')
    assert(type(deps.hasPermission) == 'function', 'MenuRegistry.new requires hasPermission')
    assert(type(deps.now) == 'function', 'MenuRegistry.new requires now')
    return setmetatable({
        hasPermission = deps.hasPermission,
        now = deps.now,
        log = deps.log or function() end,
        trusted = deps.trusted or function() return false end,
        limits = deps.limits or R.defaults,
        namespaces = {},
        entries = {},
        players = {},
        domains = {},
    }, R)
end

-- A namespace is a resource's declaration of how its corner of the menu behaves.
-- `owner` is the resource name, and its menu IDs must all be `owner:*`.
--
--   ace          root permission; denied means no menus at all
--   catalog      { signature, menus, byId }; enables compact delivery
--   order        local menu name -> sort rank, lower first
--   capabilities flag name -> permission key, resolved per player
function R:defineNamespace(owner, spec)
    if not S.id(owner) or type(spec) ~= 'table' or not S.text(spec.ace, 128) then
        return false, 'A namespace requires an owner and a root permission'
    end
    if self.namespaces[owner] then return false, 'Namespace already defined' end
    if spec.catalog ~= nil and (type(spec.catalog) ~= 'table' or type(spec.catalog.byId) ~= 'table'
        or type(spec.catalog.menus) ~= 'table' or not S.text(spec.catalog.signature, 128)) then
        return false, 'A catalog requires menus, byId and a signature'
    end
    if spec.order ~= nil and type(spec.order) ~= 'table' then return false, 'Order must be a rank table' end
    local capabilities = {}
    for name, key in pairs(spec.capabilities or {}) do
        if not S.id(name) or not S.text(key, 128) then return false, 'Invalid capability declaration' end
        capabilities[name] = key
    end
    local theme
    if spec.theme ~= nil then
        local clean, reason = S.theme(spec.theme)
        if not clean then return false, reason end
        theme = clean
    end
    self.namespaces[owner] = { ace = spec.ace, catalog = spec.catalog, order = spec.order,
        capabilities = capabilities, theme = theme, snapshotHooks = {} }
    return true
end

--- Re-theme after the fact, so a resource can follow a player's own preference
--- rather than only what was baked in at boot.
function R:setNamespaceTheme(owner, theme)
    local ns = self.namespaces[owner]
    if not ns then return false, 'Unknown namespace' end
    if theme == nil then
        ns.theme = nil
        return true
    end
    local clean, reason = S.theme(theme)
    if not clean then return false, reason end
    ns.theme = clean
    return true
end

--- Runs before a snapshot is built, so per-player rows travel inside it rather
--- than arriving as a second event the client has to reconcile.
function R:onSnapshot(owner, hook)
    local ns = self.namespaces[owner]
    if not ns or not S.callable(hook) then return false, 'Unknown namespace or invalid hook' end
    ns.snapshotHooks[#ns.snapshotHooks + 1] = hook
    return true
end

-- Authority domains are the vocabulary of contested surfaces a framework bridge
-- may veto over (health, vehicle, money). An owner declares the domains its rows
-- can be tagged with; the union is what authorities may claim.
function R:registerDomains(owner, names)
    if not self.namespaces[owner] then return false, 'Unknown namespace' end
    if type(names) ~= 'table' then return false, 'Domains must be an array' end
    for _, name in ipairs(names) do
        if not S.id(name) then return false, 'Invalid domain name' end
        if self.domains[name] and self.domains[name] ~= owner then
            return false, 'Domain already declared by ' .. self.domains[name]
        end
        self.domains[name] = owner
    end
    return true
end

function R:isDomain(name)
    return name ~= nil and self.domains[name] ~= nil
end

-- A menu is reachable only if the player holds its namespace's root ACE, its own
-- ACE, and transitively everything up to its parent. Link cycles are legal in a
-- menu graph, so the visited set is what keeps one from overflowing the stack.
function R:allowed(source, entry, visited)
    local ns = self.namespaces[entry.owner]
    if not ns or not self.hasPermission(source, ns.ace) then return false end
    if not self.hasPermission(source, entry.ace) then return false end
    local parent = entry.menu.parent
    if not parent or parent == 'main' then return true end
    visited = visited or {}
    if visited[entry.menu.id] then return false end
    visited[entry.menu.id] = true
    local target = self.entries[parent]
    return target ~= nil and self:allowed(source, target, visited)
end

function R:itemAllowed(source, entry, item)
    -- `hidden` is server state rather than permission: a page rebuilt from a saved
    -- list must not show a row with nothing behind it. Absent, not greyed out.
    if entry.hidden and entry.hidden[item.id] then return false end
    if item.kind == 'status' then return true end
    if item.kind == 'submenu' then
        local target = self.entries[item.menu]
        return target ~= nil and self:allowed(source, target)
    end
    local action = entry.actions[item.id]
    return action ~= nil and self.hasPermission(source, action.ace)
end

function R:capabilities(source)
    local result = {}
    for _, ns in pairs(self.namespaces) do
        for name, key in pairs(ns.capabilities) do
            result[name] = self.hasPermission(source, key)
        end
    end
    return result
end

-- Read-only answer to "what would this player see, and why not?". A denied
-- namespace ACE and a denied page ACE both just make the page absent, so one
-- missing grant reads as two unrelated bugs; this separates the layers.
--
-- It calls the same allowed/itemAllowed the snapshot does. A diagnostic that
-- re-derives authority eventually disagrees with it, which is worse than none.
function R:diagnostics(source)
    local result = { namespaces = {}, menus = {} }
    for owner, ns in pairs(self.namespaces) do
        result.namespaces[#result.namespaces + 1] = {
            owner = owner, ace = ns.ace,
            allowed = self.hasPermission(source, ns.ace) and true or false,
        }
    end
    table.sort(result.namespaces, function(a, b) return a.owner < b.owner end)
    for _, id in ipairs(self:sortedIds()) do
        local entry = self.entries[id]
        local ns = self.namespaces[entry.owner]
        local items, denied = 0, 0
        for _, item in ipairs(entry.menu.items) do
            items = items + 1
            if not self:itemAllowed(source, entry, item) then denied = denied + 1 end
        end
        result.menus[#result.menus + 1] = {
            id = id, owner = entry.owner, ace = entry.ace, parent = entry.menu.parent,
            namespaceAce = ns and ns.ace or nil,
            namespaceAllowed = (ns and self.hasPermission(source, ns.ace)) and true or false,
            aceAllowed = self.hasPermission(source, entry.ace) and true or false,
            allowed = self:allowed(source, entry) and true or false,
            items = items, deniedItems = denied,
            rootVisible = entry.rootVisible ~= false,
            links = entry.linkIds and #entry.linkIds or 0,
        }
    end
    return result
end

-- Menus sort by their namespace's rank, then lexically. Unranked ones all share
-- the same high rank, so adding a resource never reshuffles another's pages.
function R:rankOf(id)
    local owner, name = id:match('^([^:]+):(.+)$')
    local ns = owner and self.namespaces[owner]
    local rank = ns and ns.order and ns.order[name]
    return type(rank) == 'number' and rank or 1000
end

function R:sortedIds()
    local ids = {}
    for id in pairs(self.entries) do ids[#ids + 1] = id end
    local ranks = {}
    for _, id in ipairs(ids) do ranks[id] = self:rankOf(id) end
    table.sort(ids, function(a, b)
        if ranks[a] ~= ranks[b] then return ranks[a] < ranks[b] end
        return a < b
    end)
    return ids
end

--- The permission-filtered view of the whole registry for one player.
---
--- Catalogued menus travel as a grant -- a catalog index plus one character per
--- row -- so a 256-row page costs 256 bytes rather than a descriptor. Everything
--- else travels as a pruned descriptor. `order` is the ranked id list, sent as
--- ids so a page the player cannot see never appears in the message at all.
function R:snapshot(source)
    local result = { version = 1, compact = 1, catalogs = {}, order = {},
        capabilities = self:capabilities(source), grants = {}, menus = {} }
    for owner, ns in pairs(self.namespaces) do
        if ns.catalog then result.catalogs[owner] = ns.catalog.signature end
    end
    local state = self.players[source]
    local overrides = state and state.overrides or {}
    -- Overrides are pinned to the entry they were recorded against: a menu
    -- re-registered underneath a player drops them rather than replaying them
    -- onto rows that may no longer mean the same thing.
    for id, saved in pairs(overrides) do
        if self.entries[id] ~= saved.entry then overrides[id] = nil end
    end
    -- Themes are collected inside the allowed loop: one for a page the player
    -- cannot see is both wasted bytes and a hint that the page exists.
    local themeOwners, themeMenus, anyTheme = {}, {}, false
    for _, id in ipairs(self:sortedIds()) do
        local entry = self.entries[id]
        if self:allowed(source, entry) then
            result.order[#result.order + 1] = id
            if entry.rootVisible == false then
                result.rootHidden = result.rootHidden or {}
                result.rootHidden[#result.rootHidden + 1] = id
            end
            local ns = self.namespaces[entry.owner]
            if ns and ns.theme and not themeOwners[entry.owner] then
                themeOwners[entry.owner] = ns.theme
                anyTheme = true
            end
            if entry.theme then
                themeMenus[id] = entry.theme
                anyTheme = true
            end
            if entry.catalogIndex and not entry.linkIds then
                local grant, bits = { menu = entry.catalogIndex, owner = entry.owner }, {}
                for index, item in ipairs(entry.menu.items) do
                    local approved = self:itemAllowed(source, entry, item)
                    bits[index] = approved and '1' or '0'
                    if approved then
                        local saved = overrides[id] and overrides[id].items[item.id]
                        if entry.patches[item.id] or saved then
                            local changes = S.copy(entry.patches[item.id] or {})
                            for key, value in pairs(saved or {}) do changes[key] = S.copy(value) end
                            grant.changes = grant.changes or {}
                            grant.changes[index] = changes
                        end
                    end
                end
                grant.items = table.concat(bits)
                result.grants[#result.grants + 1] = grant
            else
                local menu = S.copy(entry.menu)
                menu.items = {}
                for _, item in ipairs(entry.menu.items) do
                    if self:itemAllowed(source, entry, item) then
                        local clean = S.copy(item)
                        local saved = overrides[id] and overrides[id].items[item.id]
                        for k, v in pairs(saved or {}) do clean[k] = v end
                        menu.items[#menu.items + 1] = clean
                    end
                end
                -- An instruction is a control hint bound to a row; if the row
                -- did not survive filtering, the hint is a lie.
                if menu.instructions then
                    local instructions = {}
                    for _, instruction in ipairs(menu.instructions) do
                        for _, item in ipairs(menu.items) do
                            if item.id == instruction.itemId and not item.disabled then
                                instructions[#instructions + 1] = instruction
                                break
                            end
                        end
                    end
                    menu.instructions = instructions
                end
                result.menus[#result.menus + 1] = menu
            end
        end
    end
    -- Omitted rather than sent empty: an empty Lua table crosses the wire as [],
    -- and a themes object arriving as an array is malformed, not absent.
    if anyTheme then result.themes = { owners = themeOwners, menus = themeMenus } end
    return result
end

function R:runSnapshotHooks(source)
    for _, ns in pairs(self.namespaces) do
        for _, hook in ipairs(ns.snapshotHooks) do
            local ok, err = pcall(hook, source)
            if not ok then self.log('snapshot hook failed: ' .. tostring(err)) end
        end
    end
end

--- `definition` is:
---   ace      the menu's own permission
---   actions  item ID -> { ace, run?, clientAction?, cooldown?, fixedValue?, domain? }
function R:register(owner, menu, definition)
    local ns = self.namespaces[owner]
    if not ns then return false, 'Register a namespace before registering menus' end
    if type(definition) ~= 'table' or not S.text(definition.ace, 128)
        or type(definition.actions) ~= 'table' then return false, 'Menu ACE and actions are required' end
    if definition.rootVisible ~= nil and type(definition.rootVisible) ~= 'boolean' then
        return false, 'Root visibility must be a boolean'
    end
    local catalogued = ns.catalog ~= nil and ns.catalog.byId[menu and menu.id] ~= nil
    local clean, err = S.menu(menu, owner, catalogued)
    if not clean then return false, err end
    local theme
    if definition.theme ~= nil then
        local cleanTheme, reason = S.theme(definition.theme)
        if not cleanTheme then return false, reason end
        theme = cleanTheme
    end
    if self.entries[clean.id] then return false, 'Menu already registered; unregister before replacing' end
    local count, total = 0, 0
    for _, entry in pairs(self.entries) do
        total = total + 1
        if entry.owner == owner then count = count + 1 end
    end
    -- Not cached: an owner that stops being trusted mid-session should stop being
    -- exempt at once, and `trusted` is cheap.
    if not self.trusted(owner) then
        local ownerLimit = catalogued and self.limits.cataloguedMenusPerOwner or self.limits.menusPerOwner
        if count >= ownerLimit then return false, ('Maximum %d menus per resource'):format(ownerLimit) end
        if total >= self.limits.totalMenus then
            return false, ('Maximum %d registered menus'):format(self.limits.totalMenus)
        end
    end
    local actions = {}
    for _, item in ipairs(clean.items) do
        if item.kind ~= 'submenu' and item.kind ~= 'status' then
            -- Every actionable row needs a permission and somewhere to go. A
            -- client action is safe to allow because the handler name is scoped
            -- to the owner, so no resource can name another's handler.
            local action = definition.actions[item.id]
            if type(action) ~= 'table' or not S.text(action.ace, 128) then
                return false, 'Every action requires an ACE'
            end
            if not S.callable(action.run) and not S.id(action.clientAction) then
                return false, 'Every action requires a server handler or a client action'
            end
            if action.domain ~= nil and not self:isDomain(action.domain) then
                return false, 'Unknown authority domain: ' .. tostring(action.domain)
            end
            if action.cooldown ~= nil and (type(action.cooldown) ~= 'number'
                or action.cooldown ~= action.cooldown or action.cooldown < 0 or action.cooldown > 3600000
                or action.cooldown % 1 ~= 0) then return false, 'Invalid action cooldown' end
            if action.cooldownKey ~= nil and (not S.id(action.cooldownKey) or action.cooldown == nil) then
                return false, 'A cooldown key requires a valid cooldown'
            end
            actions[item.id] = { ace = action.ace, run = action.run, clientAction = action.clientAction,
                cooldown = action.cooldown, cooldownKey = action.cooldownKey,
                fixedValue = action.fixedValue, domain = action.domain }
        end
    end
    self.entries[clean.id] = { owner = owner, menu = clean, ace = definition.ace, actions = actions,
        theme = theme, rootVisible = definition.rootVisible, catalogIndex = catalogued and ns.catalog.byId[clean.id] or nil, patches = {} }
    return true
end

--- Re-theme a single page after registration. Passing nil clears the override and
--- the page falls back to its namespace theme.
function R:setMenuTheme(owner, menuId, theme)
    local entry = self.entries[menuId]
    if not entry or entry.owner ~= owner then return false, 'Unknown menu' end
    if theme == nil then
        entry.theme = nil
        return true
    end
    local clean, reason = S.theme(theme)
    if not clean then return false, reason end
    entry.theme = clean
    return true
end

function R:unregister(owner, menuId)
    if not S.id(menuId) then return false, 'Invalid ID' end
    local entry = self.entries[menuId]
    if not owner or not entry or entry.owner ~= owner then return false, 'Not menu owner' end
    self.entries[menuId] = nil
    return true
end

--- Drop everything a stopped resource owned. Returns whether anything changed, so
--- the caller can skip a broadcast that would tell every player nothing.
function R:unregisterOwner(owner)
    local changed = self.namespaces[owner] ~= nil
    self.namespaces[owner] = nil
    for id, entry in pairs(self.entries) do
        if entry.owner == owner then self.entries[id], changed = nil, true end
    end
    for name, declaredOwner in pairs(self.domains) do
        if declaredOwner == owner then self.domains[name] = nil end
    end
    return changed
end


--- Replace the owning page's dynamic submenu links without changing its actions.
--- A linked catalog page travels as a descriptor: an extra grant bit cannot add a
--- row to the immutable catalog already loaded by clients.
function R:setMenuLinks(owner, menuId, links)
    local entry = self.entries[menuId]
    if not owner or not entry or entry.owner ~= owner then return false, 'Not menu owner' end
    if type(links) ~= 'table' then return false, 'Links must be an array' end
    for key, link in pairs(links) do
        if type(key) ~= 'number' or key % 1 ~= 0 or key < 1 or key > #links
            or type(link) ~= 'table' or link.kind ~= 'submenu' then
            return false, 'Links must be an array of submenu rows'
        end
    end
    local candidate, ids = S.copy(entry.menu), {}
    candidate.items = {}
    for _, item in ipairs(entry.menu.items) do
        if not (entry.linkIds and entry.linkIds[item.id]) then
            candidate.items[#candidate.items + 1] = S.copy(item)
        end
    end
    for _, link in ipairs(links) do
        candidate.items[#candidate.items + 1] = S.copy(link)
        ids[link.id or false] = true
    end
    -- Descriptor pages use the schema's ordinary wire limit, even if the base
    -- page was catalogued. Clearing links restores the original catalog budget.
    local clean, err = S.menu(candidate, owner, #links == 0 and entry.catalogIndex ~= nil)
    if not clean then return false, err end
    for id in pairs(entry.linkIds or {}) do
        entry.patches[id] = nil
        if entry.hidden then entry.hidden[id] = nil end
    end
    entry.menu, entry.linkIds = clean, #links > 0 and ids or nil
    return true
end

--- Patch a live row. Returns `true, nil, targets`, where `targets` is the list
--- of sources entitled to see the change; the caller owns the send.
function R:patchItem(owner, menuId, itemId, changes)
    if not S.id(menuId) or not S.id(itemId) then return false, 'Invalid ID' end
    local entry = self.entries[menuId]
    if not owner or not entry or entry.owner ~= owner then return false, 'Not menu owner' end
    local clean, err = S.patch(changes)
    if not clean then return false, err end
    for _, item in ipairs(entry.menu.items) do
        if item.id == itemId then
            if clean.value ~= nil and not S.value(item, clean.value) then return false, 'Invalid item value' end
            for k, v in pairs(clean) do item[k] = v end
            if entry.catalogIndex then
                -- The row itself never travels for a catalogued page, so the
                -- change must be replayed into every later snapshot.
                entry.patches[itemId] = entry.patches[itemId] or {}
                for key, value in pairs(clean) do entry.patches[itemId][key] = S.copy(value) end
            end
            local targets = {}
            for source, state in pairs(self.players) do
                local saved = state.overrides and state.overrides[menuId]
                -- A per-player override of a field just set globally is stale.
                if saved and saved.items[itemId] then
                    for k in pairs(clean) do saved.items[itemId][k] = nil end
                end
                if self:allowed(source, entry) and self:itemAllowed(source, entry, item) then
                    targets[#targets + 1] = source
                end
            end
            return true, nil, targets, clean
        end
    end
    return false, 'Unknown item'
end

--- Locate the menu holding one of the owner's actions -- owners address rows by
--- item ID and should not have to track which page one lives on.
function R:findItem(owner, itemId)
    for menuId, entry in pairs(self.entries) do
        if entry.owner == owner and entry.actions[itemId] then return menuId, entry end
    end
    return nil
end

--- Hide or restore a row for everyone, returning `true, nil, changed`. Only a
--- real change reports as one, so hiding a page's surplus rows at boot costs a
--- single refresh rather than one per row.
function R:setItemVisible(owner, itemId, visible)
    if not S.id(itemId) then return false, 'Invalid ID' end
    local _, entry = self:findItem(owner, itemId)
    if not entry then return false, 'Unknown action' end
    entry.hidden = entry.hidden or {}
    local before = entry.hidden[itemId] or false
    entry.hidden[itemId] = visible == false or nil
    return true, nil, before ~= (entry.hidden[itemId] or false)
end

--- Replace one player's option list on a select row. Validated by running it back
--- through the full menu validator, so a per-player list can never be looser than
--- a registered one.
function R:setPlayerOptions(owner, source, itemId, options)
    local state = self.players[source]
    if not state or not S.id(itemId) or type(options) ~= 'table' then
        return false, 'Unknown player or invalid options'
    end
    local menuId, entry = self:findItem(owner, itemId)
    if not entry then return false, 'Unknown action' end
    if not self:allowed(source, entry) then return false, 'Permission denied' end
    for _, item in ipairs(entry.menu.items) do
        if item.id == itemId and item.kind == 'select' and self:itemAllowed(source, entry, item) then
            local candidate = S.copy(item)
            candidate.options, candidate.value = options, nil
            local valid, err = S.menu({ id = menuId, title = entry.menu.title, items = { candidate } }, owner)
            if not valid then return false, err end
            state.overrides = state.overrides or {}
            local saved = state.overrides[menuId]
            if not saved or saved.entry ~= entry then
                saved = { entry = entry, items = {} }
                state.overrides[menuId] = saved
            end
            saved.items[itemId] = { options = valid.items[1].options, value = valid.items[1].options[1].value }
            return true, nil, menuId, saved.items[itemId]
        end
    end
    return false, 'Unknown select row'
end


function R:playerState(source)
    local state = self.players[source]
    if not state then
        state = { bucket = {} }
        self.players[source] = state
    end
    return state
end

function R:dropPlayer(source)
    self.players[source] = nil
end

function R:eachPlayer()
    return pairs(self.players)
end

--- Resolve an action request to a dispatchable action, applying every gate in
--- order: menu reachability, row existence, per-player overrides, row type, row
--- permission, value bounds. Returns `entry, item, action` or `nil, error`.
function R:resolveAction(source, menuId, itemId, value)
    if not S.id(menuId) or not S.id(itemId) then return nil, 'Invalid request' end
    local entry = self.entries[menuId]
    if not entry or not self:allowed(source, entry) then return nil, 'Permission denied' end
    local item
    for _, candidate in ipairs(entry.menu.items) do
        if candidate.id == itemId then item = candidate; break end
    end
    local state = self.players[source]
    local saved = state and state.overrides and state.overrides[menuId]
    if item and saved and saved.entry == entry and saved.items[item.id] then
        item = S.copy(item)
        for k, v in pairs(saved.items[item.id]) do item[k] = v end
    end
    if not item or item.disabled or item.kind == 'submenu' or item.kind == 'status'
        or not self:itemAllowed(source, entry, item) then
        return nil, 'Action unavailable or permission denied'
    end
    if not S.value(item, value) then return nil, 'Invalid action value' end
    return entry, item, entry.actions[item.id]
end

--- May this player use these rows right now, by item ID -- for client code that
--- greys out its own affordances without opening the menu.
function R:grantsFor(source, names)
    local grants = {}
    for _, itemId in ipairs(names) do
        grants[itemId] = false
        for _, entry in pairs(self.entries) do
            if entry.actions[itemId] and self:allowed(source, entry) then
                for _, item in ipairs(entry.menu.items) do
                    if item.id == itemId and not item.disabled then
                        grants[itemId] = self:itemAllowed(source, entry, item)
                        break
                    end
                end
            end
        end
    end
    return grants
end

--- Record a per-player patch from an action handler, so the value it settled on
--- survives the next snapshot for this player alone.
function R:recordOverride(source, menuId, entry, itemId, patch)
    local state = self.players[source]
    if not state then return end
    state.overrides = state.overrides or {}
    local saved = state.overrides[menuId]
    if not saved or saved.entry ~= entry then
        saved = { entry = entry, items = {} }
        state.overrides[menuId] = saved
    end
    saved.items[itemId] = saved.items[itemId] or {}
    for k, v in pairs(patch) do saved.items[itemId][k] = v end
end

return MenuRegistry
