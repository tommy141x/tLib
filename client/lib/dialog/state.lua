-- tLib/client/lib/dialog/state.lua

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
-- Stores the normalized schema; exports attach owner and instance metadata.
-- Only the visible/pending instance remains registered. Callback references stay
-- in exports.lua and are never copied or serialized across the NUI boundary.

function DialogState.register(id, schema)
    _dialogs[id] = { schema = schema }
end

function DialogState.get(id)
    return _dialogs[id]
end

function DialogState.remove(id)
    _dialogs[id] = nil
end
