dofile('shared/lib/menu/schema.lua')
dofile('shared/lib/menu/catalog.lua')
dofile('server/lib/menu/registry.lua')
local S, K = MenuSchema, MenuCatalog
local denied = {}
local registry = MenuRegistry.new({ now = function() return 0 end,
    hasPermission = function(_, ace) return not denied[ace] end })
local base = { id = 'host:tools', title = 'Tools', parent = 'main', items = {
    { id = 'host:run', label = 'Run', kind = 'action' },
} }
local catalog = assert(K.build({ base }))
assert(registry:defineNamespace('host', { ace = 'host.open', catalog = catalog }))
assert(registry:defineNamespace('plugin', { ace = 'plugin.open' }))
assert(registry:register('host', base, { ace = 'host.tools', actions = {
    ['host:run'] = { ace = 'host.run', clientAction = 'run' },
} }))
assert(registry:register('plugin', { id = 'plugin:camera', title = 'Camera', parent = 'main', items = {
    { id = 'plugin:start', label = 'Start', kind = 'action' },
} }, { ace = 'plugin.use', actions = { ['plugin:start'] = { ace = 'plugin.use', clientAction = 'start' } } }))
local link = { id = 'host:plugin:camera', label = 'Camera', kind = 'submenu', menu = 'plugin:camera' }
local function page()
    local snapshot = registry:snapshot(1)
    local hydrated = assert(K.hydrate(snapshot, function(owner) return owner == 'host' and catalog or nil end))
    for _, menu in ipairs(hydrated.menus) do if menu.id == base.id then return menu, snapshot end end
end
local function rows(expected)
    local menu = assert(page())
    assert(#menu.items == #expected, 'Exact row count')
    for i, id in ipairs(expected) do assert(menu.items[i].id == id, 'Exact row order') end
end
rows({ 'host:run' })
assert(not registry:setMenuLinks('plugin', base.id, { link }), 'Foreign callers cannot mutate host')
assert(not registry:setMenuLinks('host', base.id, { { id = 'host:evil', label = 'Evil', kind = 'action' } }))
assert(not registry:setMenuLinks('host', base.id, { bad = link }))
assert(registry:setMenuLinks('host', base.id, { link }))
rows({ 'host:run', 'host:plugin:camera' })
local _, snapshot = page()
assert(#snapshot.grants == 0 and #snapshot.menus == 2, 'Linked catalog page uses descriptor, never an extra grant bit')
assert(#catalog.menus[1].items == 1, 'Static catalog remains immutable')
assert(registry.entries[base.id].actions['host:run'].clientAction == 'run', 'Dispatch retained')
assert(not registry:setMenuLinks('host', base.id, { link, link }), 'Duplicate links rejected atomically')
assert(not registry:setMenuLinks('host', base.id, { { id = 'host:run', label = 'Collision', kind = 'submenu', menu = 'plugin:camera' } }))
rows({ 'host:run', 'host:plugin:camera' })
assert(registry:setMenuLinks('host', base.id, { link }), 'Idempotent replacement')
rows({ 'host:run', 'host:plugin:camera' })
denied['plugin.use'] = true
rows({ 'host:run' })
denied['host.run'] = true
-- The denied action cannot leak through the descriptor fallback.
assert(page() == nil, 'Empty denied host page is pruned entirely')
denied['plugin.use'], denied['host.run'] = nil, nil
denied['host.open'] = true
local independent = assert(K.hydrate(registry:snapshot(1), function() return catalog end))
assert(#independent.menus == 2 and independent.menus[1].id == 'main' and independent.menus[2].id == 'plugin:camera',
    'Plugin remains independently usable without host namespace access')
denied['host.open'] = nil
assert(registry:patchItem('host', base.id, 'host:run', { label = 'Changed' }))
assert(page().items[1].label == 'Changed', 'Patched base row retained in descriptor')
local tooMany = {}
for i = 1, 100 do tooMany[i] = { id = 'host:link' .. i, label = 'Link', kind = 'submenu', menu = 'plugin:camera' } end
assert(not registry:setMenuLinks('host', base.id, tooMany), 'Ordinary descriptor wire bound is validated')
rows({ 'host:run', 'host:plugin:camera' })
assert(registry:unregisterOwner('plugin'))
rows({ 'host:run' })
assert(registry:setMenuLinks('host', base.id, {}))
rows({ 'host:run' })
local restored, compact = page()
assert(#compact.grants == 1 and #compact.menus == 0, 'Clearing restores compact catalog transport')
assert(restored.items[1].label == 'Changed', 'Base patches survive link removal')
print('PASS menu links: exact rows, ownership, filtering, catalog hydration, replacement and cleanup')
