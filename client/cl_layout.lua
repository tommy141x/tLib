-- One editor and layout authority; consumers continue rendering their own HUDs.
HudLayout = {}
local H, S = HudLayout, HudLayoutSchema
local components, callbacks, saved = {}, {}, {}
local ui, active, generation, storageKey = nil, nil, 0, nil
local transitioning, stopped = false, false
-- Heartbeats arrive every 30s. Two missed beats indicate a dead renderer,
-- independently of focus: the generic ready handshake remains true after a crash.
local HEARTBEAT_TIMEOUT_MS, FOCUS_LOSS_GRACE_MS = 65000, 1500
local function yes(value) return value == true or value == 1 end
local function dialogActive()
    return DialogExports and DialogExports.isActive and DialogExports.isActive()
end
local function competingInput()
    return (MenuPrompt and MenuPrompt.active())
        or (MenuInput and MenuInput.isTyping()) or dialogActive()
end
local rendererId
local log = Logger.create('tLib/layout')
local function callable(fn)
    if type(fn) == 'function' then return true end
    if type(fn) ~= 'table' then return false end
    local mt = getmetatable(fn)
    return (type(mt) == 'table' and type(mt.__call) == 'function') or type(fn.__cfx_functionReference) == 'string'
end
local function owner()
    local name = Platform.getInvokingResource()
    if not S.id(name) then return nil end
    return name
end
-- The game resolution is the NUI viewport. Used only when the browser has not
-- supplied its own; the browser's value stays authoritative while editing.
local function screenViewport()
    if type(GetActiveScreenResolution) ~= 'function' then return nil end
    local ok, width, height = pcall(GetActiveScreenResolution)
    if not ok or not S.finite(width, 1, 16384) or not S.finite(height, 1, 16384) then return nil end
    return { width = width, height = height }
end
-- Heal on the way in, not only while editing: a widget saved off-screen at another
-- resolution must come back by itself, because the tool for rescuing it is the one
-- you cannot see to open.
local function heal(layout, component)
    local viewport = screenViewport()
    if not viewport then return layout end
    return S.constrain(layout, component, viewport) or layout
end
local function notify(component, phase)
    local fn = callbacks[component.key]
    if not fn then return end
    local layout = active and active.draft[component.key] or component.layout
    local ok, err = pcall(fn, { id = component.id, layout = S.copy(layout), width = component.width,
        height = component.height, phase = phase, editing = active ~= nil })
    if not ok then log('HUD callback failed for ' .. component.key .. ': ' .. tostring(err), 3) end
end
local function sortedComponents()
    local result = {}
    for _, component in pairs(components) do result[#result + 1] = component end
    table.sort(result, function(a, b) return a.key < b.key end)
    return result
end
local function releaseFocus()
    if not competingInput() then Platform.setInputMode(ui, 0) end
    -- Dialogs share these adapter locks; native menus suppress their own controls.
    if not dialogActive() then
        Platform.setIgnoreMoveInput(false)
        Platform.setIgnoreLookInput(false)
    end
end
local function close(save)
    local session = active
    if not session then return false end
    if save then
        local nextSaved, count = {}, 0
        for key, value in pairs(session.draft) do
            if components[key] and components[key].persist then
                nextSaved[key] = S.copy(value); count = count + 1
            end
        end
        local retained = {}
        for key in pairs(saved) do retained[#retained + 1] = key end
        table.sort(retained)
        for _, key in ipairs(retained) do
            if not nextSaved[key] and count < 256 and (not components[key] or components[key].persist) then
                nextSaved[key] = saved[key]; count = count + 1
            end
        end
        if storageKey then
            local ok, err = pcall(function() SetResourceKvp(storageKey, json.encode({ version = 2, layouts = nextSaved })) end)
            if not ok then log('Could not save HUD layout: ' .. tostring(err), 4); return false end
        end
        saved = nextSaved
        for key, value in pairs(session.draft) do if components[key] then components[key].layout = S.copy(value) end end
    end
    transitioning = true
    active = nil
    for _, timer in pairs(session.pending) do Platform.clearTimeout(timer) end
    Platform.sendUIEvent(ui, 'layoutClose', { session = session.id })
    -- Do not unlock a known tLib successor (including a pending dialog). For
    -- external NUI, releasing our own resource's focus entry does not acquire or
    -- refocus theirs. Never try SetNuiFocus(true) from a watchdog.
    if session.focused then releaseFocus() end
    if session.releaseBlur then session.releaseBlur() end
    for _, component in ipairs(sortedComponents()) do notify(component, save and 'commit' or 'rollback') end
    transitioning = false
    return true
end
function H.isEditing() return active ~= nil or transitioning end
function H.close() return close(false) end

local function register(name, id, options, fn)
    if H.isEditing() then return false, 'Close the layout editor before registering a component' end
    local component = S.component(name, id, options)
    if not component or not callable(fn) then return false, 'Invalid HUD component or callback' end
    local count, ownCount = 0, 0
    for _, existing in pairs(components) do
        count = count + 1
        if existing.owner == name then ownCount = ownCount + 1 end
    end
    if not components[component.key] and (count >= 64 or ownCount >= 16) then return false, 'HUD component limit reached' end
    -- Consumer-owned placement always starts from the supplied state. Retire any
    -- prior tLib record even if this component unregisters before the next Finish,
    -- otherwise the retained-record pass would resurrect the old placement.
    -- Disk cleanup remains transactional: only a successful Finish writes KVP.
    if not component.persist then saved[component.key] = nil end
    component.layout = (component.persist and S.layout(saved[component.key], component)) or S.copy(component.defaults)
    component.layout = heal(component.layout, component)
    components[component.key], callbacks[component.key] = component, fn
    notify(component, 'restore')
    return true
end
local function unregister(key, notifyOwner)
    local component, callback = components[key], callbacks[key]
    if not component then return false end
    components[key], callbacks[key] = nil, nil
    if active then
        active.draft[key] = nil
        if active.pending[key] then Platform.clearTimeout(active.pending[key]); active.pending[key] = nil end
        Platform.sendUIEvent(ui, 'layoutRemove', { session = active.id, key = key })
        if notifyOwner ~= false and callback then
            pcall(callback, { id = component.id, layout = S.copy(component.layout), width = component.width,
                height = component.height, phase = 'rollback', editing = false })
        end
    end
    return true
end
local function addDemo()
    if components['tLib:demo'] then return true end
    return register('tLib', 'demo', { label = 'tLib test HUD', width = 240, height = 90,
        -- Offsets are reference pixels over 1080: 48px in from the bottom-right corner.
        defaults = { x = -48 / 1080, y = -48 / 1080, scale = 1, visible = true, anchor = 'bottom-right' } }, function() end)
end
local function open(name)
    if stopped then return false, 'HUD layout service is stopping' end
    if not _TLIB_IS_FIVEM then return false, 'HUD editing is currently FiveM-only' end
    if H.isEditing() then return false, 'HUD editor is already open; use /tlibhud cancel to discard' end
    if not Platform.isNUIReady() then return false, 'UI is not ready' end
    if (type(IsNuiFocused) == 'function' and yes(IsNuiFocused()))
        or competingInput() then return false, 'Another UI owns or is waiting for input' end
    local list = sortedComponents()
    if #list == 0 then return false, 'No HUD components registered' end
    generation = generation + 1
    active = { id = generation, owner = name, draft = {}, pending = {}, revisions = {}, touched = Platform.now(), focused = false }
    -- Re-heal on open: the resolution may have changed since registration.
    for _, component in ipairs(list) do active.draft[component.key] = heal(component.layout, component) end
    local safezone = type(GetSafeZoneSize) == 'function' and GetSafeZoneSize() or 1
    Platform.sendUIEvent(ui, 'layoutOpen', { session = active.id, components = list,
        safezone = S.finite(safezone, 0.5, 1) and safezone or 1 })
    Platform.setInputMode(ui, 1)
    Platform.setIgnoreMoveInput(true)
    Platform.setIgnoreLookInput(true)
    active.focused = true
    -- The effects service is shared with dialogs; closing the editor releases only its lease.
    if UIEffects and UIEffects.acquireBlur then
        local token = UIEffects.acquireBlur(name)
        active.releaseBlur = function() UIEffects.releaseBlur(token) end
    end
    for _, component in ipairs(list) do notify(component, 'preview') end
    return true
end

function H.init(webui)
    ui = webui
    if _TLIB_IS_FIVEM then
        local profile = GetConvar('tlib_hud_profile', '')
        if profile == '' and type(GetCurrentServerEndpoint) == 'function' then profile = GetCurrentServerEndpoint() or '' end
        if profile ~= '' then
            -- The 'v1' in the key name is historical and is not the payload version;
            -- renaming it would orphan every existing player's saved placement.
            storageKey = 'tlib:hud:v1:' .. tostring(GetHashKey(profile))
            local raw = GetResourceKvpString(storageKey)
            if type(raw) == 'string' and #raw <= 131072 then
                local ok, value = pcall(json.decode, raw)
                local version = type(value) == 'table' and value.version or nil
                if ok and (version == 1 or version == 2) and type(value.layouts) == 'table' then
                    local count = 0
                    for key, layout in pairs(value.layouts) do
                        -- v1 offsets were fractions of viewport width; convert before validating,
                        -- because a converted 16:9 value can legitimately exceed the old +/-1 bound.
                        if version == 1 then layout = S.migrate(layout) end
                        local valid = S.layout(layout, { minScale = 0.1, maxScale = 4, canHide = true, canScale = true })
                        if type(key) == 'string' and #key <= 161 and valid and count < 256 then
                            saved[key] = valid; count = count + 1
                        end
                    end
                end
            end
        else log('HUD layouts are session-only: no server endpoint or tlib_hud_profile is available', 3) end
    end
    register('tLib', 'toasts', { label = 'Notifications', width = 360, height = 160, canHide = false,
        defaults = { x = -24 / 1080, y = 24 / 1080, scale = 1, visible = true, anchor = 'top-right' } }, function(data)
        Platform.sendUIEvent(ui, 'toastLayout', data)
    end)
    Platform.export('tLib', 'GetHudLayoutCapabilities', function()
        -- referenceOffsets marks the v2 unit change: x/y are ratios of a 1080px
        -- reference height, not fractions of the viewport. A consumer that does its
        -- own geometry must check this before trusting a layout it is handed.
        return { consumerPersistence = true, minVisibility = true,
            universalMinVisibility = true, referenceOffsets = true, layoutVersion = 2 }
    end)
    Platform.export('tLib', 'RegisterHudComponent', function(id, options, fn)
        local name = owner()
        if not name then return false, 'Cannot identify calling resource' end
        return register(name, id, options, fn)
    end)
    Platform.export('tLib', 'UnregisterHudComponent', function(id)
        local name = owner()
        if not name or not S.id(id) then return false end
        return unregister(name .. ':' .. id)
    end)
    Platform.export('tLib', 'GetHudLayout', function(id)
        local name = owner()
        local component = name and S.id(id) and components[name .. ':' .. id]
        return component and S.copy(component.layout) or nil
    end)
    Platform.export('tLib', 'OpenHudEditor', function(options)
        local name = owner()
        if not name then return false, 'Cannot identify calling resource' end
        if type(options) == 'table' and options.demo == true then addDemo() end
        return open(name)
    end)
    Platform.export('tLib', 'CloseHudEditor', function()
        local name = owner()
        if not active or active.owner ~= name then return false end
        return close(false)
    end)
    Platform.onUIRequest(ui, 'layoutPreview', function(data, reply)
        if type(data) ~= 'table' or not active or data.session ~= active.id or type(data.key) ~= 'string' then
            return reply({ ok = false })
        end
        local component = components[data.key]
        if not component or not S.finite(data.revision, 1, 1000000000) or data.revision % 1 ~= 0 then
            return reply({ ok = false })
        end
        if data.revision <= (active.revisions[data.key] or 0) then return reply({ ok = true, stale = true }) end
        local layout = S.layout(data.layout, component)
        -- The editor's own viewport is authoritative; fall back to the game
        -- resolution only if it sent none, and refuse rather than guess 1080p.
        if layout then layout = S.constrain(layout, component, data.viewport or screenViewport()) end
        if not layout then return reply({ ok = false }) end
        active.revisions[data.key] = data.revision
        active.draft[data.key], active.touched = layout, Platform.now()
        local session, key = active, data.key
        if not session.pending[key] then
            session.pending[key] = Platform.setTimeout(function()
                session.pending[key] = nil
                if active == session and components[key] == component then notify(component, 'preview') end
            end, 16)
        end
        reply({ ok = true })
    end)
    Platform.onUIRequest(ui, 'layoutFinish', function(data, reply)
        if type(data) ~= 'table' or not active or data.session ~= active.id or type(data.save) ~= 'boolean' then
            return reply({ ok = false })
        end
        reply({ ok = close(data.save) })
    end)
    Platform.onUIRequest(ui, 'layoutReady', function(data, reply)
        if type(data) ~= 'table' or type(data.renderer) ~= 'string' or #data.renderer > 100 then
            return reply({ ok = false })
        end
        if rendererId and rendererId ~= data.renderer then close(false) end
        rendererId = data.renderer
        if components['tLib:toasts'] then notify(components['tLib:toasts'], active and 'preview' or 'restore') end
        reply({ ok = true })
    end)
    Platform.onUIRequest(ui, 'layoutHeartbeat', function(data, reply)
        local valid = type(data) == 'table' and active and data.session == active.id
        if valid then active.touched = Platform.now() end
        reply({ ok = valid == true })
    end)
    local function resourceStopped(name)
        local self = type(GetCurrentResourceName) == 'function' and GetCurrentResourceName() or 'tLib'
        if name == self then stopped = true; close(false); ui = nil end
        if active and active.owner == name then close(false) end
        local remove = {}
        for key, component in pairs(components) do if component.owner == name then remove[#remove + 1] = key end end
        for _, key in ipairs(remove) do unregister(key, false) end
    end
    if _TLIB_IS_FIVEM then
        AddEventHandler('onClientResourceStop', resourceStopped)
        RegisterCommand('tlibhud', function(_, args)
            local action = args and args[1]
            -- Player escape hatch is intentionally not restricted to the export
            -- owner. F8: tlibhud cancel works even when the browser cannot reply.
            if action == 'cancel' or action == 'close' then close(false); return end
            if action and action ~= 'demo' and action ~= 'open' then
                log('Usage: /tlibhud [demo|open|cancel] (no arguments toggles; closing discards)', 3)
                return
            end
            if active and action ~= 'open' then close(false); return end
            if action == 'demo' then addDemo() end
            local ok, err = open('tLib')
            if not ok then log(err, 3) end
        end, false)
        Platform.createThread(function()
            while ui do
                local session, now = active, Platform.now()
                if session then
                    local reason
                    if competingInput() then reason = 'another tLib UI owns input'
                    elseif now - session.touched > HEARTBEAT_TIMEOUT_MS then reason = 'renderer stopped responding'
                    elseif type(IsNuiFocused) == 'function' then
                        if yes(IsNuiFocused()) then session.focusLostAt = nil
                        else
                            session.focusLostAt = session.focusLostAt or now
                            if now - session.focusLostAt >= FOCUS_LOSS_GRACE_MS then reason = 'NUI focus was lost' end
                        end
                    end
                    if reason and active == session then
                        log('HUD editor discarded: ' .. reason .. '. Reopen with /tlibhud.', 3)
                        close(false)
                    end
                end
                Platform.wait(250)
            end
        end)
    end
    Platform.onShutdown(function() stopped = true; close(false); ui = nil end)
end
return H
