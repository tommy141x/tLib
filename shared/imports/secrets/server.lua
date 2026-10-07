--[[==========================================================================
    tlib.secrets — where a credential actually lives
==============================================================================

    ## The problem this solves, and why it is not a git filter

    Every resource here ships `config.lua` as BOTH the customer's template and
    this machine's live dev config. So the file has to hold working values to
    run the server, and must hold nothing at all in a commit or a release. Those
    two requirements are in direct conflict in one file, and the conflict has
    been resolved the losing way twice: tRadio's `adminPassword` was committed
    as `"141"`, restored in `4ee0c16`, and had drifted back by 2026-09.

    The mechanisms that were considered:

    - **Fix the source file.** Not a fix. It is the thing that keeps coming
      undone, because the file must hold working values for local dev.

    - **A git `clean` filter** (`.gitattributes` + `filter.x.clean`). Closest to
      what was asked for — the working tree keeps the value, the staged blob is
      blank, transparently. Rejected on two counts. (1) `filter.*.clean` is
      PER-CLONE config; a clone without it stages the raw file and says nothing,
      and a gate that silently does not run is worse than one that refuses.
      (2) Fatally: with a blank blob and no `smudge`, the next `git checkout` or
      `git pull` that touches `config.lua` writes the blank OVER the developer's
      credential. There is no copy anywhere. A `smudge` side would have to
      restore the value from somewhere — and that somewhere is this file, at
      which point the filter is pure complexity on top of the real answer.

    - **Strip at commit, with a pre-commit hook.** Same checkout problem, plus
      the developer's `git show HEAD:config.lua` stops matching their own
      working tree, which is its own class of confusion.

    - **This.** The tracked `config.lua` holds blanks PERMANENTLY. The real
      values live in `config.local.lua` beside it, which is gitignored, and this
      module overlays them onto `Config` at server start.

    There is then nothing to strip, because the tracked file never holds a
    value; nothing to restore, because git has never heard of the sidecar; and a
    `git pull` cannot reach the credential for the same reason. A commit and a
    release are blank by construction rather than by a step somebody has to
    remember. The three gates (`.githooks/pre-commit`, the release packager, and
    the CI assertion on HEAD) are then all backstops against a value being typed
    into the tracked file anyway — not the mechanism.

    ## Precedence, and why the convar wins

        convar  >  config.local.lua  >  config.lua

    `config.local.lua` is the DEVELOPER's machine. A convar
    (`set <resource>_<key> "..."` in server.cfg) is PRODUCTION, where the value
    comes from the host's secret store and the files on disk are a deployment
    artifact. Production must be able to override whatever shipped, so the
    convar is last-wins.

    ## Server-only, deliberately

    There is no client half of this module. A credential readable by a game
    client is not a credential — the client's `config.lua` is downloaded to
    every player — and `LoadResourceFile` is a server native besides. Every
    credential in this tree is server-side already: tRadio's `authToken`,
    `adminPassword`, `discord.clientSecret` and `discord.botToken`, tRadar's
    `boloWebhook`, tDB's `Superuser.Password` and `Advanced.S3.*`.

    ## What it does NOT do

    It does not write, create or repair `config.local.lua`. A module that
    generates the file would have to pick a moment to do it, and the only safe
    moment is never: a half-written sidecar that shadows a working config.lua
    with blanks is strictly worse than no sidecar.

    It does not validate. The resource's own config check already reports a
    missing credential properly ("authToken is required"), and it runs after
    this. Reporting it twice, in two voices, helps nobody.

==============================================================================]]

local Secrets = {}

local SIDECAR = 'config.local.lua'

--- Deep-merge `patch` into `target`, in place.
---
--- A table value merges key-by-key rather than replacing, so a sidecar that
--- sets only `discord.botToken` does not erase `discord.clientId` alongside it.
--- That is not a nicety: the nested blocks in these configs mix credentials
--- with plain settings, and whole-table replacement would silently blank every
--- sibling of the one key somebody wanted to override.
---
--- A LIST (`#value > 0`) replaces wholesale instead. Merging a list by index
--- produces a result that is neither value, and no credential is a list.
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
--- Returns `nil, nil` when the file is absent — the common case for a customer
--- and for CI, and not a condition worth a line of output. Returns `nil, err`
--- when it exists and is broken, which IS worth stopping for: a sidecar that
--- fails to parse means the operator believes a credential is set and it is
--- not, and the resource will fail later with a message about the credential
--- rather than about the file.
--- @param resource string
--- @return table|nil, string|nil
function Secrets.read(resource)
    local text = LoadResourceFile(resource, SIDECAR)
    if not text or text == '' then return nil, nil end

    local chunk, err = load(text, ('@@%s/%s'):format(resource, SIDECAR), 't', {})
    if not chunk then
        return nil, ('%s does not parse: %s'):format(SIDECAR, tostring(err))
    end

    -- Loaded with an EMPTY environment: the sidecar is data, and a data file
    -- that can call `os.exit` or reach `Config` directly is a config file with
    -- extra steps. A sidecar that tries gets "attempt to call a nil value",
    -- which is the right answer.
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
--- Derived from `Diag.SECRET_PATTERNS` — the same list the pre-commit hook, the
--- release packager and CI all derive from — so a credential added to a config
--- next year is covered by the convar lookup with no edit here. A hand-written
--- list of key names is the thing this whole mechanism replaces.
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

    -- Convars last: production overrides the file on disk. Only credential-
    -- shaped keys are looked up, so this cannot become a general-purpose config
    -- override surface by accident.
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
            -- NAMES only. This line goes to a console an operator pastes into a
            -- ticket, and the whole point of the module is that the value has
            -- one home.
            print(('^2[%s] tlib.secrets: %d local value(s) applied: %s^0')
                :format(resource, #applied, table.concat(applied, ', ')))
        end
    end

    return { applied = applied, errors = errors, sidecar = patch ~= nil }
end

return Secrets
