-- tLib/lua/adapter/ui.lua
-- platform UI abstractions (WebUI / NUI)


local log = Logger.create('tLib/adapter/ui')

if _TLIB_IS_HELIX then
    function Platform.createUI(name, path)
        return WebUI(name, path)
    end

    function Platform.sendUIEvent(ui, evt, data)
        if ui then ui:SendEvent(evt, data) end
    end

    function Platform.onUIEvent(ui, evt, cb)
        if ui then ui:RegisterEventHandler(evt, cb) end
    end

    function Platform.bringUIToFront(ui)
        if ui then ui:BringToFront() end
    end

    function Platform.setInputMode(ui, mode)
        _TLIB_UI_FOCUSED = (mode == 1)
        if ui then ui:SetInputMode(mode) end
    end

    -- Helix WebUI owns its own cursor; there is no separate "keep game input"
    -- mode. Setting input mode 1 already gives the UI focus without freezing
    -- the game. No-op by design.
    function Platform.setKeepInputActive(ui, state) end

    function Platform.destroyUI(ui)
        if ui then ui:Destroy() end
    end

    -- Helix WebUI is synchronous — always ready immediately.
    function Platform.isNUIReady() return true end
    function Platform.onNUIReady(cb) cb() end
elseif _TLIB_IS_FIVEM then
    -- FiveM NUI is global — there is no per-instance handle like Helix's WebUI.
    -- The HTML page is declared in fxmanifest.lua via ui_page; nothing to
    -- construct at runtime.  We return a sentinel table so call-sites can still
    -- do a nil-check without branching on platform.

    -- NUI ready handshake —————————————————————————————————————————————
    -- Lua scripts execute before the NUI browser finishes loading the JS
    -- bundle.  SendNUIMessage is fire-and-forget: messages dispatched before
    -- the JS message listeners exist are silently lost.
    --
    -- To fix this, sendUIEvent buffers all outbound messages until the JS
    -- side posts back a '__tlib_nui_ready' NUI callback.  On receipt the
    -- buffer is flushed in order and all future sends go through directly.
    -- Subsystems that need to defer work (e.g. markReady, HasLoaded) can
    -- register via Platform.onNUIReady(cb).

    local _nuiReady    = false
    local _nuiQueue    = {}
    local _nuiReadyCbs = {}

    -- NUI natives only exist on the client.  This file is a shared_script,
    -- so the handler registration must be guarded — the server never touches
    -- NUI but still loads this branch because _TLIB_IS_FIVEM is true.
    if _TLIB_SIDE == 'client' then
        RegisterNuiCallbackType('__tlib_nui_ready')
        AddEventHandler('__cfx_nui:__tlib_nui_ready', function(_, resultCallback)
            resultCallback(json.encode('ok'))
            if _nuiReady then return end
            _nuiReady = true

            -- Flush queued messages in the order they were enqueued.
            for _, msg in ipairs(_nuiQueue) do
                SendNUIMessage(msg)
            end
            _nuiQueue = {}

            -- Fire ready callbacks.
            for _, cb in ipairs(_nuiReadyCbs) do cb() end
            _nuiReadyCbs = {}
        end)
    end

    function Platform.isNUIReady()
        return _nuiReady
    end

    function Platform.onNUIReady(cb)
        if _nuiReady then cb() else table.insert(_nuiReadyCbs, cb) end
    end
    -- ——————————————————————————————————————————————————————————————————

    function Platform.createUI(name, path)
        return { _fivemNUI = true, name = name, path = path }
    end

    function Platform.sendUIEvent(ui, evt, data)
        -- The JS side (helix.ts useHelixEvent) listens via
        -- window.addEventListener('message', ...) and expects:
        --   event.data = { name: string, args: [payload] }
        -- We must NOT flatten data into the top-level object — wrap it in args[1].
        local msg = { name = evt, args = { data } }
        if _nuiReady then
            SendNUIMessage(msg)
        else
            table.insert(_nuiQueue, msg)
        end
    end

    function Platform.onUIEvent(ui, evt, cb)
        RegisterNuiCallbackType(evt)
        AddEventHandler('__cfx_nui:' .. evt, function(body, resultCallback)
            local data = type(body) == 'string' and json.decode(body) or body
            cb(data)
            resultCallback(json.encode('ok'))
        end)
    end

    function Platform.bringUIToFront(ui)
        -- FiveM NUI layering is controlled via SetNuiFocus / CSS z-index.
        -- No explicit bring-to-front call exists in the native API.
    end

    function Platform.setInputMode(ui, mode)
        -- mode 1 → cursor visible + UI receives input
        -- mode 0 → cursor hidden, game receives input
        _TLIB_NUI_FOCUSED = (mode == 1)
        if mode == 1 then
            SetNuiFocus(true, true)
        else
            SetNuiFocus(false, false)
            -- Clear keep-input too, so a prior setKeepInputActive(true) doesn't
            -- leak gameplay-input-during-UI behaviour into the next focus cycle.
            SetNuiFocusKeepInput(false)
        end
    end

    -- Lets the game receive input (movement, driving, chat) while the NUI
    -- cursor is still visible and interactive. Callers pair this with
    -- DisableControlAction for controls they want suppressed during UI focus
    -- (attack, look, weapon-wheel, etc.). No-op if focus hasn't been granted.
    function Platform.setKeepInputActive(ui, state)
        SetNuiFocusKeepInput(state == true)
    end

    function Platform.destroyUI(ui)
        -- FiveM NUI pages cannot be destroyed at runtime; signal the page to
        -- hide itself so it stops intercepting input.
        SendNUIMessage({ type = '_tlib_destroy' })
    end
else
    Platform.createUI          = Platform._stub('createUI')
    Platform.sendUIEvent       = Platform._stub('sendUIEvent')
    Platform.onUIEvent         = Platform._stub('onUIEvent')
    Platform.bringUIToFront    = Platform._stub('bringUIToFront')
    Platform.setInputMode      = Platform._stub('setInputMode')
    Platform.setKeepInputActive = Platform._stub('setKeepInputActive')
    Platform.destroyUI         = Platform._stub('destroyUI')
    Platform.isNUIReady        = function() return false end
    Platform.onNUIReady        = Platform._stub('onNUIReady')
end
