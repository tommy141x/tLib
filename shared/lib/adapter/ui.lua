-- Platform UI abstractions over FiveM NUI.

local log = Logger.create('tLib/adapter/ui')

if _TLIB_IS_FIVEM then
    -- NUI is global -- there is no per-instance browser handle, and the page is
    -- declared by ui_page in fxmanifest.lua. createUI returns a sentinel so call
    -- sites can still nil-check a handle.

    -- Lua runs before the browser finishes loading the JS bundle, and
    -- SendNUIMessage is fire-and-forget, so anything sent before the JS listeners
    -- exist is lost. sendUIEvent therefore buffers until the page posts
    -- '__tlib_nui_ready', then flushes in order. Subsystems that need to defer
    -- work register through Platform.onNUIReady.
    local _nuiReady    = false
    local _nuiQueue    = {}
    local _nuiReadyCbs = {}

    -- This is a shared_script and the server loads this branch too, but the NUI
    -- natives only exist on the client.
    if _TLIB_SIDE == 'client' then
        RegisterNuiCallbackType('__tlib_nui_ready')
        AddEventHandler('__cfx_nui:__tlib_nui_ready', function(_, resultCallback)
            -- A table, not an encoded string: see onUIRequest below.
            resultCallback({ ok = true })
            if _nuiReady then return end
            _nuiReady = true

            for _, msg in ipairs(_nuiQueue) do
                SendNUIMessage(msg)
            end
            _nuiQueue = {}

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

    function Platform.createUI(name, path)
        return { _fivemNUI = true, name = name, path = path }
    end

    function Platform.sendUIEvent(ui, evt, data)
        -- nui.ts expects { name, args }; the payload must stay wrapped in args[1]
        -- rather than being flattened onto the message.
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
            -- Not encoded: resultCallback serializes its own argument. See
            -- onUIRequest below.
            resultCallback({ ok = true })
        end)
    end

    -- The answering form of onUIEvent. Replies are fire-once because CitizenFX
    -- treats a second resultCallback as an error.
    --
    -- Hand the reply over as a table: resultCallback serializes it itself, so
    -- encoding it here encodes it twice and the browser's response.json()
    -- resolves to a string. Measured against this exact handler form:
    --   resultCallback({ ok = true })              -> body {"ok":true}       object
    --   resultCallback(json.encode({ ok = true })) -> body "{\"ok\":true}"   string
    function Platform.onUIRequest(ui, evt, cb)
        RegisterNuiCallbackType(evt)
        AddEventHandler('__cfx_nui:' .. evt, function(body, resultCallback)
            local data = type(body) == 'string' and json.decode(body) or body
            local answered = false
            cb(data, function(result)
                if answered then return end
                answered = true
                resultCallback(result)
            end)
        end)
    end

    function Platform.bringUIToFront(ui)
        -- No native equivalent; layering is SetNuiFocus plus CSS z-index.
    end

    -- mode 1 shows the cursor and gives the UI input, mode 0 returns it to the game.
    function Platform.setInputMode(ui, mode)
        _TLIB_NUI_FOCUSED = (mode == 1)
        if mode == 1 then
            SetNuiFocus(true, true)
        else
            SetNuiFocus(false, false)
            -- Or a prior setKeepInputActive(true) leaks into the next focus cycle.
            SetNuiFocusKeepInput(false)
        end
    end

    -- Lets the game receive movement, driving and chat while the NUI cursor stays
    -- interactive. Pair with DisableControlAction for anything that should still
    -- be suppressed. No-op until focus has been granted.
    function Platform.setKeepInputActive(ui, state)
        SetNuiFocusKeepInput(state == true)
    end

    function Platform.destroyUI(ui)
        -- Pages cannot be destroyed at runtime; ask it to hide so it stops
        -- intercepting input.
        SendNUIMessage({ type = '_tlib_destroy' })
    end
else
    Platform.createUI          = Platform._stub('createUI')
    Platform.sendUIEvent       = Platform._stub('sendUIEvent')
    Platform.onUIEvent         = Platform._stub('onUIEvent')
    Platform.onUIRequest       = Platform._stub('onUIRequest')
    Platform.bringUIToFront    = Platform._stub('bringUIToFront')
    Platform.setInputMode      = Platform._stub('setInputMode')
    Platform.setKeepInputActive = Platform._stub('setKeepInputActive')
    Platform.destroyUI         = Platform._stub('destroyUI')
    Platform.isNUIReady        = function() return false end
    Platform.onNUIReady        = Platform._stub('onNUIReady')
end
