-- tLib/lua/dialog/state.lua

DialogState      = {}

local ui         = nil
local _dialogs   = {}
local _idCounter = 0

-- UI injection

function DialogState.setUI(webui)
    ui = webui
end

function DialogState.getUI()
    return ui
end

-- Id generation

function DialogState.generateId()
    _idCounter = _idCounter + 1
    return 'tlib_dialog_' .. tostring(_idCounter)
end

-- Dialog registry
-- Stores the serialised schema so CloseDialog can guard against unknown ids.
-- No callbacks are stored here — results are delivered via TriggerLocalClientEvent.

function DialogState.register(id, schema)
    _dialogs[id] = { schema = schema }
end

function DialogState.get(id)
    return _dialogs[id]
end

function DialogState.remove(id)
    _dialogs[id] = nil
end
