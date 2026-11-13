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

    -- tLib's own VM has no `tlib` global, so it loads the same module a consumer
    -- gets as tlib.nui. Lazily: this file also runs on the server, which has no
    -- NUI natives and no use for it.
    local nuiModule
    function Platform.registerNUICallback(name, handler, opts)
        nuiModule = nuiModule or load(
            LoadResourceFile(GetCurrentResourceName(), 'shared/imports/nui/client.lua'),
            '@@tLib/shared/imports/nui/client.lua'
        )()
        return nuiModule.register(name, handler, opts)
    end

    -- This is a shared_script and the server loads this branch too, but the NUI
    -- natives only exist on the client.
    if _TLIB_SIDE == 'client' then
        Platform.registerNUICallback('__tlib_nui_ready', function(_, reply)
            -- A table, not an encoded string: see onUIRequest below.
            reply({ ok = true })
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
        Platform.registerNUICallback(evt, function(body, reply)
            local data = type(body) == 'string' and json.decode(body) or body
            cb(data)
            -- Not encoded: the reply serializes its own argument. See
            -- onUIRequest below.
            reply({ ok = true })
        end)
    end

    -- The answering form of onUIEvent. `cb` may answer later, so it is deferred;
    -- the bound is a net above the engine's own watchdogs (the menu's action
    -- timeout is 90 s), there to answer a handler that threw or forgot.
    --
    -- Hand the reply over as a table: resultCallback serializes it itself, so
    -- encoding it here encodes it twice and the browser's response.json()
    -- resolves to a string. Measured against this exact handler form:
    --   resultCallback({ ok = true })              -> body {"ok":true}       object
    --   resultCallback(json.encode({ ok = true })) -> body "{\"ok\":true}"   string
    function Platform.onUIRequest(ui, evt, cb)
        Platform.registerNUICallback(evt, function(body, reply)
            local data = type(body) == 'string' and json.decode(body) or body
            cb(data, reply)
        end, { deferred = true, timeoutMs = 120000 })
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
            -- keepInput is cleared on BOTH sides of the release because it is
            -- unknown which side matters: SetNuiFocusKeepInput is not in the
            -- native reference and there is no offline oracle for NUI focus.
            -- Clearing twice is idempotent. Same in `releaseNuiFocus` in
            -- `shared/imports/platform/client.lua`.
            SetNuiFocusKeepInput(false)
            SetNuiFocus(false, false)
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
    Platform.registerNUICallback = Platform._stub('registerNUICallback')
    Platform.bringUIToFront    = Platform._stub('bringUIToFront')
    Platform.setInputMode      = Platform._stub('setInputMode')
    Platform.setKeepInputActive = Platform._stub('setKeepInputActive')
    Platform.destroyUI         = Platform._stub('destroyUI')
    Platform.isNUIReady        = function() return false end
    Platform.onNUIReady        = Platform._stub('onNUIReady')
end
