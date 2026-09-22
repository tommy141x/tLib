dofile('shared/lib/menu/schema.lua')
dofile('server/lib/menu/registry.lua')
local S=MenuSchema
local registry=MenuRegistry.new({now=function() return 0 end,hasPermission=function() return true end})
local api,events,caller={},{},'one'
function GetCurrentResourceName() return 'host' end
function GetInvokingResource() return caller end
function AddEventHandler(name,fn) events[name]=fn end
function TriggerEvent(name,owner) assert(name=='tlib:menu:hostReady' and owner=='host') end
assert(registry:defineNamespace('host',{ace='host.open'}))
assert(registry:register('host',{id='host:renamedPage',title='Tools',parent='main',items={
    {id='host:base',label='Base',kind='action'},
}},{ace='host.use',actions={['host:base']={ace='host.use',clientAction='base'}}}))
exports=setmetatable({tLib={SetMenuLinks=function(_,id,rows) return registry:setMenuLinks('host',id,rows) end}},
    {__call=function(_,name,fn) api[name]=fn end})
tlib={menu={schema=S}}
local host=dofile('shared/imports/menuhost/server.lua')
assert(host.install({
    ['public.tools']={menu='host:renamedPage',order={['one:link']=20}},
    second={menu='host:renamedPage',resources={two=true},order={['two:link']=10}},
    closed={menu='host:renamedPage',enabled=false},
}))
local function mount(slot)
    return api.RegisterPluginMenu({id='link',slot=slot,menu=caller..':page',label=caller})
end
local function exact(ids)
    local items=registry.entries['host:renamedPage'].menu.items
    assert(#items==#ids)
    for i,id in ipairs(ids) do assert(items[i].id==id,'Exact host ordering') end
end
assert(mount('public.tools'))
assert(not mount('second') and not mount('closed'))
caller='two'; assert(mount('second'))
exact({'host:base','host:plugin:two:link','host:plugin:one:link'})
assert(mount('second'))
exact({'host:base','host:plugin:two:link','host:plugin:one:link'})
assert(not api.RegisterPluginMenu({id='foreign',slot='public.tools',menu='one:page',label='Foreign'}))
events.onResourceStop('one')
exact({'host:base','host:plugin:two:link'})
assert(api.UnregisterPluginMenu('link'))
exact({'host:base'})
assert(not api.UnregisterPluginMenu('link'))
assert(not pcall(host.install,{}), 'Only one host adapter per resource')
print('PASS generic host: non-consumer-specific slots, shared-page composition, host ordering, allowlists and cleanup')
