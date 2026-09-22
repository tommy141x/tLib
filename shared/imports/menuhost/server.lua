-- Optional navigation hosting, running in the host's VM. The host chooses slots;
-- plugins retain their namespaces/actions and can register only their own targets.
local Host = { version = 1 }
local installed = false
function Host.install(slots)
    assert(not installed, 'Menu host already installed')
    local S, resource, engine = tlib.menu.schema, GetCurrentResourceName(), exports['tLib']
    assert(type(slots) == 'table', 'Host slots required')
    local config = S.copy(slots)
    for id, slot in pairs(config) do
        assert(S.id(id) and type(slot) == 'table' and S.id(slot.menu)
            and slot.menu:sub(1, #resource + 1) == resource .. ':', 'Invalid host slot')
        assert(slot.enabled == nil or type(slot.enabled) == 'boolean', 'Invalid slot enabled flag')
        assert(slot.resources == nil or type(slot.resources) == 'table', 'Invalid slot resource allowlist')
        assert(slot.order == nil or type(slot.order) == 'table', 'Invalid slot order')
        for _, rank in pairs(slot.order or {}) do
            assert(type(rank) == 'number' and rank == rank and math.abs(rank) < math.huge, 'Invalid host order')
        end
    end
    local links = {}
    local function rows(parent, replacement, removeOwner, removeId)
        local result = {}
        for owner, entries in pairs(links) do
            for id, entry in pairs(entries) do
                if entry.parent == parent and not (owner == removeOwner and (removeId == nil or id == removeId)) then
                    result[#result + 1] = entry
                end
            end
        end
        if replacement then result[#result + 1] = replacement end
        table.sort(result, function(a, b)
            if a.rank ~= b.rank then return a.rank < b.rank end
            return a.row.id < b.row.id
        end)
        local output = {}
        for _, entry in ipairs(result) do output[#output + 1] = entry.row end
        return output
    end
    exports('RegisterPluginMenu', function(spec)
        local owner = GetInvokingResource()
        if not owner or owner == resource or not S.id(owner) then return false, 'A plugin resource must call this export' end
        if type(spec) ~= 'table' or type(spec.id) ~= 'string' or not spec.id:match('^[%w_-]+$')
            or not S.text(spec.label, 128) or (spec.description ~= nil and not S.text(spec.description, 512))
            or not S.id(spec.menu) or spec.menu:sub(1, #owner + 1) ~= owner .. ':' then
            return false, 'Invalid plugin link or foreign target'
        end
        local slot = type(spec.slot) == 'string' and config[spec.slot]
        if not slot or slot.enabled == false then return false, 'Host slot unavailable' end
        if slot.resources and slot.resources[owner] ~= true then return false, 'Plugin is not allowed in this slot' end
        local existing = links[owner] and links[owner][spec.id]
        if existing and existing.parent ~= slot.menu then return false, 'Unregister before changing the target page' end
        local entry = { parent = slot.menu, rank = slot.order and slot.order[owner .. ':' .. spec.id] or 1000,
            row = { id = resource .. ':plugin:' .. owner .. ':' .. spec.id, kind = 'submenu',
                menu = spec.menu, label = spec.label, description = spec.description } }
        local updated = rows(slot.menu, entry, owner, spec.id)
        local ok, err = engine:SetMenuLinks(slot.menu, updated)
        if not ok then return false, err end
        links[owner] = links[owner] or {}
        links[owner][spec.id] = entry
        return true
    end)
    exports('UnregisterPluginMenu', function(id)
        local owner = GetInvokingResource()
        local entry = owner and links[owner] and links[owner][id]
        if not entry then return false, 'Unknown plugin link' end
        local updated = rows(entry.parent, nil, owner, id)
        local ok, err = engine:SetMenuLinks(entry.parent, updated)
        if not ok then return false, err end
        links[owner][id] = nil
        if next(links[owner]) == nil then links[owner] = nil end
        return true
    end)
    AddEventHandler('onResourceStop', function(owner)
        if owner == 'tLib' then links = {}; return end
        if not links[owner] then return end
        local parents = {}
        for _, entry in pairs(links[owner]) do parents[entry.parent] = true end
        for parent in pairs(parents) do
            local updated = rows(parent, nil, owner)
            local ok, err = engine:SetMenuLinks(parent, updated)
            if not ok then print(('[%s] Removing plugin links failed: %s'):format(resource, tostring(err))) end
        end
        links[owner] = nil
    end)
    installed = true
    TriggerEvent('tlib:menu:hostReady', resource)
    return true
end
return Host
