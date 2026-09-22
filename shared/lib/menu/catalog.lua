-- Catalogs and snapshot hydration.
--
-- A catalog is a resource's whole menu tree, built identically on the server and
-- on every client from the same shared definitions, so the server never has to
-- send it: permissions travel as one bit per row against a catalog signature the
-- client already holds, and a 2,000-row menu costs kilobytes rather than a
-- megabyte. The compact wire format is keyed per owner, since more than one
-- resource may publish a catalog and a grant has to say whose it is.
--
-- Pure Lua, like schema.lua: it loads in tLib's VM, in a consumer's VM through
-- imports/menu/shared.lua, and in a bare test host.

MenuCatalog = {}
local K = MenuCatalog
local S = MenuSchema

-- Lua string ordering uses the process locale; protocol indices need raw bytes.
local function stringLess(a, b)
    for index = 1, math.min(#a, #b) do
        local left, right = a:byte(index), b:byte(index)
        if left ~= right then return left < right end
    end
    return #a < #b
end
K.stringLess = stringLess

--- Deterministic content fingerprint, not an authentication token: the server
--- still checks every ACE and dispatch value per request. All this proves is that
--- both sides hold the same definitions, so a grant bitmap lines up with the rows
--- the player is looking at.
---
--- `checkpoint` is called periodically so a caller on a game thread can yield --
--- fingerprinting a large catalog is thousands of table walks.
function K.fingerprint(menus, checkpoint)
    local first, second = 5381.0, 17.0
    local function bytes(text)
        for i = 1, #text do
            first = (first * 33 + text:byte(i)) % 2147483647
            second = (second * 131 + text:byte(i)) % 2147483629
        end
    end
    local nodes = 0
    local function digest(value)
        nodes = nodes + 1
        if checkpoint and nodes % 256 == 0 then checkpoint() end
        local kind = type(value)
        -- Binary scalars avoid locale/CRT number formatting and the
        -- integer-versus-float distinction (1 and 1.0 are one Lua value).
        if kind == 'number' then bytes('n' .. string.pack('>d', value == 0 and 0 or value)); return end
        if kind == 'string' then bytes('s' .. string.pack('>I4', #value) .. value); return end
        if kind == 'boolean' then bytes(value and 't' or 'f'); return end
        assert(kind == 'table', 'Unsupported catalog fingerprint value: ' .. kind)
        bytes('{')
        local keys = {}
        for key in pairs(value) do keys[#keys + 1] = key end
        table.sort(keys, function(a, b)
            if type(a) ~= type(b) then return stringLess(type(a), type(b)) end
            if type(a) == 'string' then return stringLess(a, b) end
            return a < b
        end)
        for _, key in ipairs(keys) do digest(key); digest(value[key]) end
        bytes('}')
    end
    digest(menus)
    return ('c2:%08x:%08x'):format(first, second)
end

--- Turn an ordered list of validated menus into a catalog. The order is the
--- protocol -- a grant names a menu by its index here -- so the same definitions
--- must produce the same sequence on every machine. A caller building its list
--- from a hash table must sort it first; `K.stringLess` is exported for that.
function K.build(menus, checkpoint)
    local catalog = { menus = {}, byId = {} }
    for index, menu in ipairs(menus) do
        if type(menu) ~= 'table' or type(menu.id) ~= 'string' then
            return nil, 'A catalog entry must be a validated menu'
        end
        if catalog.byId[menu.id] then return nil, 'Duplicate catalog menu: ' .. menu.id end
        catalog.menus[index], catalog.byId[menu.id] = menu, index
        if checkpoint then checkpoint() end
    end
    catalog.signature = K.fingerprint(catalog.menus, checkpoint)
    return catalog
end

-- Hydration is deliberately strict: neither a missing index nor a malformed
-- bitstring may widen a local grant, and nothing is applied until the whole packet
-- validates. A rejected snapshot leaves the player with the empty menu.

local function dense(array, maximum)
    if #array > maximum then return false end
    for key in pairs(array) do
        if type(key) ~= 'number' or key % 1 ~= 0 or key < 1 or key > #array then return false end
    end
    return true
end

--- Re-apply a server-owned delta to one catalogued row. Exported because the
--- options event carries the same shape outside a snapshot.
function K.applyDelta(item, changes, owner)
    if type(changes) ~= 'table' then return nil, 'Invalid server state delta' end
    local fields = {}
    for key, value in pairs(changes) do if key ~= 'options' then fields[key] = value end end
    local patch, err = S.patch(fields)
    if not patch then return nil, err end
    local clean = S.copy(item)
    for key, value in pairs(patch) do clean[key] = value end
    if changes.options ~= nil then
        if item.kind ~= 'select' then return nil, 'Options require a selector' end
        clean.options = changes.options
    end
    -- Re-validated as a whole menu, so a delta cannot assemble a row the schema
    -- would have refused at registration.
    local menu, why = S.menu({ id = owner .. ':delta', title = 'State', items = { clean } }, owner, true)
    if not menu then return nil, why end
    return menu.items[1]
end

--- Expand a compact snapshot into the full menu tree.
---
--- @param value    table     the compact snapshot as it arrived
--- @param provide  function  owner -> catalog, or nil if that resource published none
--- @param options  table     { root = { id?, title, description? } }
---
--- Returns the hydrated snapshot, or nil and a message describing what was wrong.
function K.hydrate(value, provide, options)
    options = options or {}
    local root = options.root or {}
    local rootId = root.id or 'main'
    if type(value) ~= 'table' or value.compact ~= 1 or value.version ~= 1 then
        return nil, 'Invalid authorization manifest version'
    end
    if type(value.catalogs) ~= 'table' then return nil, 'Invalid authorization manifest catalogs' end
    if type(value.grants) ~= 'table' then
        return nil, 'Invalid authorization manifest grants: expected table, received ' .. type(value.grants)
    end
    if type(value.menus) ~= 'table' or #value.menus > 255 then return nil, 'Invalid authorization manifest plugin menus' end
    if type(value.capabilities) ~= 'table' then return nil, 'Invalid authorization manifest capabilities' end
    for name, allowed in pairs(value.capabilities) do
        if type(name) ~= 'string' or type(allowed) ~= 'boolean' then
            return nil, 'Invalid authorization manifest capabilities'
        end
    end
    if value.order ~= nil and (type(value.order) ~= 'table' or not dense(value.order, 255)) then
        return nil, 'Invalid authorization manifest order'
    end

    -- A mismatch is reported by name: with several resources publishing catalogs,
    -- "the catalog does not match" does not say which one is out of date.
    local catalogs = {}
    for owner, signature in pairs(value.catalogs) do
        if type(owner) ~= 'string' or not S.text(signature, 128) then
            return nil, 'Invalid authorization manifest catalog signature'
        end
        local catalog = provide and provide(owner)
        if type(catalog) ~= 'table' or type(catalog.menus) ~= 'table' or type(catalog.signature) ~= 'string' then
            return nil, ('No local menu catalog for %s; its client script is missing or failed to load'):format(owner)
        end
        if catalog.signature ~= signature then
            return nil, ('Menu catalog mismatch for %s: server=%s client=%s; shared definitions differ or catalog protocol versions are mixed')
                :format(owner, signature, catalog.signature)
        end
        catalogs[owner] = catalog
    end

    if not dense(value.grants, 255) or not dense(value.menus, 255) then return nil, 'Invalid manifest array' end

    local menus, ids, seen = {}, {}, {}
    for _, grant in ipairs(value.grants) do
        if type(grant) ~= 'table' or type(grant.owner) ~= 'string' then return nil, 'Invalid menu grant' end
        local catalog = catalogs[grant.owner]
        if not catalog or type(grant.menu) ~= 'number' or grant.menu % 1 ~= 0 or not catalog.menus[grant.menu] then
            return nil, 'Invalid menu grant'
        end
        local key = grant.owner .. '\0' .. grant.menu
        if seen[key] then return nil, 'Invalid menu grant' end
        seen[key] = true
        local template = catalog.menus[grant.menu]
        if type(grant.items) ~= 'string' or #grant.items ~= #template.items or grant.items:find('[^01]') then
            return nil, 'Invalid item grants'
        end
        local menu = {}
        for key2, field in pairs(template) do if key2 ~= 'items' then menu[key2] = S.copy(field) end end
        menu.items = {}
        local changes = grant.changes or {}
        if type(changes) ~= 'table' then return nil, 'Invalid state deltas' end
        for index in pairs(changes) do
            if type(index) ~= 'number' or index % 1 ~= 0 or not template.items[index]
                or grant.items:sub(index, index) ~= '1' then return nil, 'Delta outside granted items' end
        end
        for index, item in ipairs(template.items) do
            if grant.items:sub(index, index) == '1' then
                local clean = S.copy(item)
                if changes[index] then
                    local updated, err = K.applyDelta(clean, changes[index], grant.owner)
                    if not updated then return nil, err end
                    clean = updated
                end
                menu.items[#menu.items + 1] = clean
            end
        end
        -- An instruction is a control hint bound to a row. If the row did not
        -- survive filtering, the hint is a lie.
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
        if ids[menu.id] then return nil, 'Duplicate menu identity' end
        ids[menu.id], menus[#menus + 1] = true, menu
    end

    -- Descriptors: pages nobody catalogued, travelling in full. The only rule left
    -- is that no two menus may claim the same id -- refusing descriptors inside a
    -- known namespace would forbid registering a page dynamically.
    for _, menu in ipairs(value.menus) do
        local owner = type(menu) == 'table' and type(menu.id) == 'string' and menu.id:match('^([^:]+):')
        if not owner or ids[menu.id] or menu.id == rootId then return nil, 'Invalid plugin menu identity' end
        local clean, err = S.menu(menu, owner)
        if not clean then return nil, err end
        ids[menu.id], menus[#menus + 1] = true, clean
    end
    if #menus > 255 then return nil, 'Too many menus' end

    -- Only the server knows every namespace's declared order. The ranked id list
    -- costs a few hundred bytes; shipping each namespace's order table instead
    -- would cost more and leak the names of pages the player may not see.
    local rank = {}
    for index, id in ipairs(value.order or {}) do
        if type(id) ~= 'string' or rank[id] then return nil, 'Invalid authorization manifest order' end
        rank[id] = index
    end
    table.sort(menus, function(a, b)
        local left, right = rank[a.id] or math.huge, rank[b.id] or math.huge
        if left ~= right then return left < right end
        return stringLess(a.id, b.id)
    end)

    -- Placement is not authority: an authorized page may be opened directly or
    -- linked without getting an automatic shared-root entry.
    local rootHidden = {}
    if value.rootHidden ~= nil then
        if type(value.rootHidden) ~= 'table' or not dense(value.rootHidden, 255) then
            return nil, 'Invalid root visibility list'
        end
        for _, id in ipairs(value.rootHidden) do
            if type(id) ~= 'string' or not ids[id] or rootHidden[id] then return nil, 'Invalid root visibility identity' end
            rootHidden[id] = true
        end
    end
    local result = { version = 1, visible = false, capabilities = S.copy(value.capabilities), menus = {} }
    -- Themes ride along because they are permission-filtered with the snapshot: a
    -- page the player cannot see never contributes one. Carried verbatim -- the
    -- browser owns the theme contract and drops a push whole if any part fails, so
    -- a second allowlist here would only be a second thing to keep in step.
    if type(value.themes) == 'table' then result.themes = S.copy(value.themes) end
    local rootMenu = { id = rootId, title = S.text(root.title, 128) and root.title or 'Menu',
        description = S.text(root.description, 512) and root.description or nil, items = {} }
    result.menus[1] = rootMenu
    for _, menu in ipairs(menus) do
        result.menus[#result.menus + 1] = menu
        -- A page with no parent, or parented to the root, gets a root row.
        if (not menu.parent or menu.parent == rootId) and not rootHidden[menu.id] then
            rootMenu.items[#rootMenu.items + 1] = { id = menu.id .. ':open',
                label = menu.rootLabel or menu.title, kind = 'submenu', menu = menu.id }
        end
    end
    result.menus = S.pruneMenus(result.menus)
    return result
end

return MenuCatalog
