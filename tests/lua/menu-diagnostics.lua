-- A denied namespace, a denied page ACE and a denied ancestor are the same
-- silence from outside the registry. Diagnostics exists to tell them apart, so
-- these assertions pin the layer each denial is reported at -- exactly, not by
-- inclusion, since a diagnostic that over-reports is what sends someone editing
-- the wrong ACE.
dofile('shared/lib/menu/schema.lua')
dofile('shared/lib/menu/catalog.lua')
dofile('server/lib/menu/registry.lua')

local denied = {}
local r = MenuRegistry.new({ now = function() return 0 end,
    hasPermission = function(_, ace) return not denied[ace] end })

assert(r:defineNamespace('camera', { ace = 'camera.open' }))
assert(r:register('camera', { id = 'camera:main', title = 'Camera', parent = 'main',
    items = { { id = 'camera:run', label = 'Run', kind = 'action' },
              { id = 'camera:deep', label = 'Deep', kind = 'submenu', menu = 'camera:child' } } },
    { ace = 'camera.use', actions = { ['camera:run'] = { ace = 'camera.run', clientAction = 'run' } } }))
assert(r:register('camera', { id = 'camera:child', title = 'Child', parent = 'camera:main',
    items = { { id = 'camera:inner', label = 'Inner', kind = 'action' } } },
    { ace = 'camera.child', actions = { ['camera:inner'] = { ace = 'camera.child', clientAction = 'inner' } } }))

local function find(report, id)
    for _, menu in ipairs(report.menus) do if menu.id == id then return menu end end
end

-- Everything granted.
local report = r:diagnostics(1)
assert(#report.namespaces == 1 and report.namespaces[1].owner == 'camera'
    and report.namespaces[1].ace == 'camera.open' and report.namespaces[1].allowed == true,
    'Exact namespace row when granted')
assert(#report.menus == 2, 'Exactly the two registered pages are reported')
local main = find(report, 'camera:main')
assert(main.allowed == true and main.namespaceAllowed == true and main.aceAllowed == true
    and main.ace == 'camera.use' and main.namespaceAce == 'camera.open'
    and main.items == 2 and main.deniedItems == 0 and main.rootVisible == true and main.links == 0,
    'Exact granted page shape')

-- A denied row is counted without hiding the page.
denied['camera.run'] = true
main = find(r:diagnostics(1), 'camera:main')
assert(main.allowed == true and main.items == 2 and main.deniedItems == 1,
    'Row denial is reported per row, not as a page denial')
denied['camera.run'] = nil

-- Namespace denial: reported at the namespace layer, and every page follows.
denied['camera.open'] = true
report = r:diagnostics(1)
assert(report.namespaces[1].allowed == false, 'Namespace denial reported at namespace layer')
for _, id in ipairs({ 'camera:main', 'camera:child' }) do
    local page = find(report, id)
    assert(page.allowed == false and page.namespaceAllowed == false and page.aceAllowed == true,
        'Namespace denial does not masquerade as a page ACE denial: ' .. id)
end
denied['camera.open'] = nil

-- Page's own ACE denied: namespace still fine, so the report points at the page.
denied['camera.use'] = true
report = r:diagnostics(1)
local page = find(report, 'camera:main')
assert(page.allowed == false and page.namespaceAllowed == true and page.aceAllowed == false,
    'Own-ACE denial is distinguishable from namespace denial')
-- The child's own grant is intact; only its ancestor is missing. That is the
-- case a page-level ACE audit alone would call healthy.
local child = find(report, 'camera:child')
assert(child.allowed == false and child.namespaceAllowed == true and child.aceAllowed == true,
    'Ancestry denial leaves both of the child\'s own layers granted')
denied['camera.use'] = nil

-- Diagnostics must never answer differently from the code that builds snapshots.
denied['camera.child'] = true
report = r:diagnostics(1)
for _, entry in ipairs(report.menus) do
    assert(entry.allowed == (r:allowed(1, r.entries[entry.id]) and true or false),
        'Diagnostics agrees with the real authority check for ' .. entry.id)
end
assert(find(report, 'camera:main').deniedItems == 1,
    'Submenu row to an unreachable child counts as a denied row')
denied['camera.child'] = nil

print('PASS menu diagnostics: namespace, page, row and ancestry denials reported at their own layer')
