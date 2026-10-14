--[[
    tlib.secrets — where a credential actually lives.

    The tracked `config.lua` holds blanks permanently; the real values live in a
    gitignored `config.local.lua` beside it, and this overlays them onto Config
    at server start. A commit and a release are blank by construction, not by a
    step somebody has to remember. Precedence is

        convar  >  config.local.lua  >  config.lua

    Server-only: a credential readable by a game client is not a credential.
    Design notes: docs/internal/secrets-sidecar.md
]]

local Secrets = {}

local SIDECAR = 'config.local.lua'

--- Deep-merge `patch` into `target`, in place.
---
--- @param target table
--- @param patch table
--- @param applied table  dotted names actually written, accumulated
--- @param prefix string|nil
local function merge(target, patch, applied, prefix)
    for key, value in pairs(patch) do
        local name = prefix and (prefix .. '.' .. tostring(key)) or tostring(key)
        if type(value) == 'table' and type(target[key]) == 'table' and #value == 0 then
            merge(target[key], value, applied, name)
        else
            target[key] = value
            applied[#applied + 1] = name
        end
    end
end

--- Read and evaluate the sidecar, if there is one.
---
--- @param resource string
--- @return table|nil, string|nil
function Secrets.read(resource)
    local text = LoadResourceFile(resource, SIDECAR)
    if not text or text == '' then return nil, nil end

    local chunk, err = load(text, ('@@%s/%s'):format(resource, SIDECAR), 't', {})
    if not chunk then
        return nil, ('%s does not parse: %s'):format(SIDECAR, tostring(err))
    end

    local ok, result = pcall(chunk)
    if not ok then
        return nil, ('%s raised while loading: %s'):format(SIDECAR, tostring(result))
    end
    if type(result) ~= 'table' then
        return nil, ('%s must `return { ... }`; it returned %s'):format(SIDECAR, type(result))
    end
    return result, nil
end

--- Every credential-shaped key name in `config`, as dotted paths.
---
--- @param config table
--- @return table list of dotted paths
function Secrets.credentialPaths(config)
    local diag = tlib and tlib.diag
    if type(diag) ~= 'table' or type(diag.isSecretName) ~= 'function' then return {} end

    local paths, seen = {}, {}
    local function walk(tbl, depth, prefix)
        if type(tbl) ~= 'table' or depth > 4 or seen[tbl] then return end
        seen[tbl] = true
        for key, value in pairs(tbl) do
            local name = prefix and (prefix .. '.' .. tostring(key)) or tostring(key)
            if type(value) == 'table' then
                walk(value, depth + 1, name)
            elseif diag.isSecretName(key) then
                paths[#paths + 1] = name
            end
        end
    end
    walk(config, 1, nil)
    table.sort(paths)
    return paths
end

local function assign(config, dotted, value)
    local parts = {}
    for part in dotted:gmatch('[^.]+') do parts[#parts + 1] = part end
    local node = config
    for i = 1, #parts - 1 do
        if type(node[parts[i]]) ~= 'table' then return false end
        node = node[parts[i]]
    end
    node[parts[#parts]] = value
    return true
end

--- Overlay local and production credential sources onto `config`, in place.
---
--- @param config table              the resource's Config table
--- @param opts table|nil            `{ resource = string, convarPrefix = string, quiet = boolean }`
--- @return table  `{ applied = { dotted names }, errors = { strings }, sidecar = boolean }`
function Secrets.overlay(config, opts)
    opts = opts or {}
    local resource = opts.resource or GetCurrentResourceName()
    local prefix = opts.convarPrefix or resource:lower()
    local applied, errors = {}, {}

    if type(config) ~= 'table' then
        return { applied = {}, errors = { 'overlay called with a non-table config' }, sidecar = false }
    end

    local patch, err = Secrets.read(resource)
    if err then errors[#errors + 1] = err end
    if patch then merge(config, patch, applied, nil) end

    for _, dotted in ipairs(Secrets.credentialPaths(config)) do
        local convar = ('%s_%s'):format(prefix, (dotted:gsub('%.', '_')))
        local value = type(GetConvar) == 'function' and GetConvar(convar, '') or ''
        if value ~= '' then
            if assign(config, dotted, value) then
                applied[#applied + 1] = dotted .. ' (convar ' .. convar .. ')'
            end
        end
    end

    table.sort(applied)

    if not opts.quiet then
        for _, message in ipairs(errors) do
            print(('^1[%s] tlib.secrets: %s^0'):format(resource, message))
        end
        if #applied > 0 then
            print(('^2[%s] tlib.secrets: %d local value(s) applied: %s^0')
                :format(resource, #applied, table.concat(applied, ', ')))
        end
    end

    return { applied = applied, errors = errors, sidecar = patch ~= nil }
end

return Secrets
