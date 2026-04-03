-- tLib/lua/theme/exports.lua
-- Registers all exports('tLib', ...) for the theme subsystem.
-- Themes are pure UI-side constructs — Lua holds a registry mirror so it can
-- validate ids and answer GetThemes without a round-trip to the WebUI.

ThemeExports  = {}

local log     = Logger.create('tLib/theme')

-- WebUI reference — set once by ThemeExports.register(ui)
local ui      = nil

-- ── Local theme registry (mirrors the UI-side store) ─────────────────────────
-- Keyed by theme id. Stores the full definition table so GetThemes can return
-- a copy without hitting the WebUI.

local _themes = {}

-- ── Validation helpers ────────────────────────────────────────────────────────

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

-- Shallow-copy a table (one level deep) so callers cannot mutate our registry.
local function shallowCopy(t)
    if type(t) ~= 'table' then return t end
    local copy = {}
    for k, v in pairs(t) do copy[k] = v end
    return copy
end

-- ── Export registration ───────────────────────────────────────────────────────

function ThemeExports.register(webui)
    ui = webui

    local function registerExport(name, fn)
        Platform.export('tLib', name, fn)
    end

    -- ── AddTheme ──────────────────────────────────────────────────────────────
    -- Registers a new theme or replaces an existing one with the same id.
    -- The definition is forwarded to the WebUI store immediately.
    --
    -- Parameters
    --   id          string        Required. Unique identifier (e.g. "night", "retro").
    --   opts        table         Theme definition:
    --     name        string        Human-readable display name.
    --     description string|nil   Optional description.
    --     cssVars     table|nil     Map of CSS variable name → HSL value string.
    --                               Keys should NOT include the leading "--".
    --                               Example: { primary = "262 83% 58%", radius = "0.75rem" }
    --     extends     string|nil   Id of another registered theme to inherit from.
    --                               The current theme's cssVars overlay the base vars.
    --     font        string|nil   Font-family string (sets --font-sans).
    --                               Example: '"Press Start 2P", monospace'
    --     fontSize    string|nil   Base font-size percentage (sets html font-size).
    --                               Example: "87.5%"
    --
    -- Returns true on success, false on validation failure.
    registerExport('AddTheme', function(id, opts)
        if not assertUI('AddTheme') then return false end
        if not assertId('AddTheme', id) then return false end
        if type(opts) ~= 'table' then
            log('AddTheme: opts must be a table', 3)
            return false
        end

        -- Build a clean, validated definition.
        local def = {
            id          = id,
            name        = type(opts.name) == 'string' and opts.name ~= '' and opts.name or id,
            description = type(opts.description) == 'string' and opts.description or nil,
            extends     = type(opts.extends) == 'string' and opts.extends ~= '' and opts.extends or nil,
            font        = type(opts.font) == 'string' and opts.font ~= '' and opts.font or nil,
            fontSize    = type(opts.fontSize) == 'string' and opts.fontSize ~= '' and opts.fontSize or nil,
        }

        -- Validate and copy cssVars — must be a flat string→string map.
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

        -- Mirror in Lua registry.
        _themes[id] = def

        -- Forward to the UI store.
        Platform.sendUIEvent(ui, 'addTheme', def)

        Platform.TriggerEvent('tLib:theme:added', id)
        return true
    end)

    -- ── RemoveTheme ───────────────────────────────────────────────────────────
    -- Removes a theme from both the Lua registry and the UI store.
    -- If the theme is currently set as the global active theme the UI will
    -- automatically clear the :root override (handled in store.ts).
    --
    -- Parameters
    --   id  string  The id passed to AddTheme.
    --
    -- Returns true if the theme existed and was removed, false otherwise.
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

    -- ── SetTheme ──────────────────────────────────────────────────────────────
    -- Sets the global active theme, applying its CSS vars to :root in the UI.
    -- This affects the entire NUI — menus, dialogs, and toasts that do not
    -- specify their own per-component theme will inherit these vars.
    --
    -- Pass id = "" (empty string) to clear the global theme override and revert
    -- to the base :root vars defined in global.css.
    --
    -- Parameters
    --   id  string  The id of a registered theme, or "" to clear.
    --
    -- Returns true on success, false if the theme id is unknown.
    registerExport('SetTheme', function(id)
        if not assertUI('SetTheme') then return false end

        -- Allow empty string to clear the global theme.
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

    -- ── GetThemes ─────────────────────────────────────────────────────────────
    -- Returns a copy of all registered theme definitions keyed by id.
    -- This reads from the Lua mirror so no UI round-trip is required.
    --
    -- Returns table  { [id] = { id, name, description, cssVars, extends, font, fontSize }, ... }
    registerExport('GetThemes', function()
        local copy = {}
        for id, def in pairs(_themes) do
            copy[id] = shallowCopy(def)
            -- cssVars is a nested table — copy it too so callers cannot mutate our registry.
            if type(def.cssVars) == 'table' then
                copy[id].cssVars = shallowCopy(def.cssVars)
            end
        end
        return copy
    end)

    -- ── GetTheme ──────────────────────────────────────────────────────────────
    -- Returns the definition of a single theme, or nil if not registered.
    --
    -- Parameters
    --   id  string  Theme id.
    --
    -- Returns table | nil
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
