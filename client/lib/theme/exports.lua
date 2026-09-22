-- Lua mirrors the theme registry, so it can validate and answer reads without a
-- UI round trip.

ThemeExports  = {}

local log     = Logger.create('tLib/theme')

local ui      = nil
local _themes = {}

local function assertUI(fname)
    if not ui then
        log(fname .. ': Theme subsystem not initialised (ui is nil)', 4)
        return false
    end
    return true
end

local function assertId(fname, id)
    if type(id) ~= 'string' or id == '' then
        log(fname .. ': id must be a non-empty string', 3)
        return false
    end
    return true
end

local function shallowCopy(t)
    if type(t) ~= 'table' then return t end
    local copy = {}
    for k, v in pairs(t) do copy[k] = v end
    return copy
end

function ThemeExports.register(webui)
    ui = webui

    local function registerExport(name, fn)
        Platform.export('tLib', name, fn)
    end

    -- Register a theme, or replace one with the same id.
    --
    --   opts.cssVars  name -> value, WITHOUT the leading "--":
    --                 { primary = "262 83% 58%", radius = "0.75rem" }
    --   opts.extends  id of a registered theme to inherit from; these cssVars
    --                 overlay its own
    --   opts.font     font-family, sets --font-sans
    --   opts.fontSize percentage, sets the html font-size
    registerExport('AddTheme', function(id, opts)
        if not assertUI('AddTheme') then return false end
        if not assertId('AddTheme', id) then return false end
        if type(opts) ~= 'table' then
            log('AddTheme: opts must be a table', 3)
            return false
        end

        local def = {
            id          = id,
            name        = type(opts.name) == 'string' and opts.name ~= '' and opts.name or id,
            description = type(opts.description) == 'string' and opts.description or nil,
            extends     = type(opts.extends) == 'string' and opts.extends ~= '' and opts.extends or nil,
            font        = type(opts.font) == 'string' and opts.font ~= '' and opts.font or nil,
            fontSize    = type(opts.fontSize) == 'string' and opts.fontSize ~= '' and opts.fontSize or nil,
        }

        -- cssVars must be a flat string -> string map.
        if type(opts.cssVars) == 'table' then
            local vars = {}
            for k, v in pairs(opts.cssVars) do
                if type(k) == 'string' and type(v) == 'string' then
                    vars[k] = v
                else
                    log('AddTheme: cssVars entry "' .. tostring(k) .. '" skipped (key and value must both be strings)', 3)
                end
            end
            def.cssVars = vars
        end

        _themes[id] = def
        Platform.sendUIEvent(ui, 'addTheme', def)

        Platform.TriggerEvent('tLib:theme:added', id)
        return true
    end)

    -- Removing the active theme clears the :root override; store.ts handles that.
    registerExport('RemoveTheme', function(id)
        if not assertUI('RemoveTheme') then return false end
        if not assertId('RemoveTheme', id) then return false end

        if not _themes[id] then
            log('RemoveTheme: theme "' .. id .. '" is not registered', 3)
            return false
        end

        _themes[id] = nil
        Platform.sendUIEvent(ui, 'removeTheme', { id = id })
        Platform.TriggerEvent('tLib:theme:removed', id)
        return true
    end)

    -- Applies the theme's vars to :root, so every component without a theme of
    -- its own inherits them. An empty id reverts to the base vars in global.css.
    registerExport('SetTheme', function(id)
        if not assertUI('SetTheme') then return false end

        if id == '' then
            Platform.sendUIEvent(ui, 'setTheme', { id = '' })
            Platform.TriggerEvent('tLib:theme:set', '')
            return true
        end

        if not assertId('SetTheme', id) then return false end

        if not _themes[id] then
            log('SetTheme: theme "' .. id .. '" is not registered — call AddTheme first', 3)
            return false
        end

        Platform.sendUIEvent(ui, 'setTheme', { id = id })
        Platform.TriggerEvent('tLib:theme:set', id)
        return true
    end)

    registerExport('GetThemes', function()
        local copy = {}
        for id, def in pairs(_themes) do
            copy[id] = shallowCopy(def)
            -- cssVars is nested; copy it too, or callers can mutate the registry.
            if type(def.cssVars) == 'table' then
                copy[id].cssVars = shallowCopy(def.cssVars)
            end
        end
        return copy
    end)

    registerExport('GetTheme', function(id)
        if not assertId('GetTheme', id) then return nil end
        local def = _themes[id]
        if not def then return nil end
        local copy = shallowCopy(def)
        if type(def.cssVars) == 'table' then
            copy.cssVars = shallowCopy(def.cssVars)
        end
        return copy
    end)
end
