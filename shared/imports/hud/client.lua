-- Load this in the consumer VM with '@tLib/shared/imports/hud/client.lua'.
-- Its own NUI keeps rendering; this bridge only transports shared layout state.
tLibHud = {}
local definitions, latest, committed = {}, {}, {}
local ready = false
local function send(data)
    latest[data.id] = data
    if data.phase == 'restore' or data.phase == 'commit' or data.phase == 'rollback' then committed[data.id] = data end
    if ready then SendNUIMessage({ tlibHud = data }) end
end
local function install(id, definition)
    if GetResourceState('tLib') ~= 'started' then return false, 'tLib is not started' end
    return exports['tLib']:RegisterHudComponent(id, definition, function(data) send(data) end)
end
function tLibHud.register(id, definition)
    if type(id) ~= 'string' or type(definition) ~= 'table' then return false, 'Invalid HUD definition' end
    local ok, err = install(id, definition)
    if ok or GetResourceState('tLib') ~= 'started' then definitions[id] = definition end
    return ok, err
end
function tLibHud.unregister(id)
    local ok = false
    if GetResourceState('tLib') == 'started' then ok = exports['tLib']:UnregisterHudComponent(id) end
    definitions[id], latest[id], committed[id] = nil, nil, nil
    return ok
end
function tLibHud.edit()
    if GetResourceState('tLib') ~= 'started' then return false, 'tLib is not started' end
    return exports['tLib']:OpenHudEditor()
end
RegisterNUICallback('__tlib_hud_ready', function(_, cb)
    ready = true
    for _, data in pairs(latest) do SendNUIMessage({ tlibHud = data }) end
    cb({ ok = true })
end)
AddEventHandler('onClientResourceStart', function(name)
    if name ~= 'tLib' then return end
    for id, definition in pairs(definitions) do install(id, definition) end
end)
AddEventHandler('onClientResourceStop', function(name)
    if name ~= 'tLib' then return end
    -- A hard stop must not leave the consumer in preview/input-suspended mode.
    for id, data in pairs(committed) do
        local restored = { id = id, layout = data.layout, width = data.width, height = data.height,
            phase = 'rollback', editing = false }
        send(restored)
    end
end)
