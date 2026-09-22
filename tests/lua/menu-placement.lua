dofile('shared/lib/menu/schema.lua')
dofile('shared/lib/menu/catalog.lua')
dofile('server/lib/menu/registry.lua')
local denied={}
local r=MenuRegistry.new({now=function() return 0 end,hasPermission=function(_,ace) return not denied[ace] end})
local page={id='camera:main',title='Camera',parent='main',items={{id='camera:run',label='Run',kind='action'}}}
local definition={ace='camera.use',rootVisible=false,actions={['camera:run']={ace='camera.use',clientAction='run'}}}
assert(r:defineNamespace('camera',{ace='camera.open'}))
assert(r:register('camera',page,definition))
local wire=r:snapshot(1)
assert(#wire.rootHidden==1 and wire.rootHidden[1]=='camera:main')
local full=assert(MenuCatalog.hydrate(wire,function() end))
assert(#full.menus==2 and full.menus[1].id=='main' and #full.menus[1].items==0
    and full.menus[2].id=='camera:main' and #full.menus[2].items==1, 'Exact hidden-root shape retains direct page')
assert(r:allowed(1,r.entries['camera:main']), 'Placement does not change authority')
denied['camera.use']=true
local forbidden=r:snapshot(1)
assert(forbidden.rootHidden==nil and #forbidden.menus==0, 'Denied identity not leaked by visibility list')
denied['camera.use']=nil
for _,bad in ipairs({false, {'missing:page'}, {'camera:main','camera:main'}, {bad='camera:main'}}) do
    local copy=MenuSchema.copy(wire); copy.rootHidden=bad
    assert(not MenuCatalog.hydrate(copy,function() end), 'Malformed placement rejected')
end
assert(r:unregister('camera','camera:main'))
definition.rootVisible='false'
assert(not r:register('camera',page,definition), 'String boolean refused')
definition.rootVisible=true
assert(r:register('camera',page,definition))
local visible=assert(MenuCatalog.hydrate(r:snapshot(1),function() end))
assert(#visible.menus==2 and #visible.menus[1].items==1 and visible.menus[1].items[1].menu=='camera:main', 'Exact visible-root shape')
print('PASS menu placement: root visibility independent of permissions, direct access and strict hydration')
