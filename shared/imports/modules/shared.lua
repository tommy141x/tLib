-- Finds and loads content modules: a folder plus a `module.json` that declares
-- what it is.
--
--   tlib.modules.scan('layouts', 'layout')        -> { 'DRX-330', 'QRX-720' }
--   tlib.modules.scan('layouts/themes', 'theme')  -> { 'basic', 'dark' }
--   tlib.modules.load('layouts', 'QRX-720', 'ui.html')
--
-- Only scan/list/read need a directory listing, which comes from tLib's Node
-- bundle; `load` is a plain LoadResourceFile.
--
-- shared/ts/modules/manifest.ts is the written-out contract; this file is the
-- runtime gate, and tests/unit/module-manifest.test.ts runs both over the same
-- cases so they cannot drift.
--
-- `kind = "sound"` is valid in that contract and is deliberately NOT accepted
-- here. On a FiveM resource a sound is a flat audio file an operator drags in --
-- no folder, no manifest. It is only a module in the studio and the marketplace,
-- whose installer writes the audio flat. So the TypeScript side knows three kinds
-- and this file knows two.
--
-- A folder counts if it holds a `module.json` whose `kind` matches the directory.
-- The two category names are refused by an explicit RESERVED list rather than,
-- as before, by happening to contain no `ui.html`.

local modules = {}

modules.MANIFEST = 'module.json'
modules.SCHEMA = 1
-- The kinds a FiveM resource discovers on disk. `sound` is absent on purpose --
-- see the header. Keep this in step with MODULE_KINDS in
-- shared/ts/modules/manifest.ts, which is a SUPERSET by design.
modules.KINDS = { layout = true, theme = true }

--- Folder names a module may never take: the category directories inside
--- `layouts/`. Explicit so that a module called `themes` is REFUSED by name
--- instead of silently shadowing every theme on the server.
---
modules.RESERVED = { sounds = true, themes = true }

--- Called for every folder that is on disk but is not a usable module.
---
---
--- @param basePath string
--- @param id string
--- @param err string
function modules.onRefusal(basePath, id, err)
    print(('[tLib/modules] skipped %s/%s — %s'):format(basePath, id, err))
end

--- Folder names directly under basePath.
---
--- FiveM's server Lua sandbox cannot enumerate a directory at all: io.popen is
--- nil and io.readdir returns an empty list for every path, including the
--- resource's own root. So the listing comes from tLib's Node bundle. io.popen is
--- kept as a second chance for a test harness or a runtime with no export; note
--- the platform test is `OS ~= nil`, because the FiveM server reports "Windows"
--- and an equality check against "Windows_NT" sent a `ls` to cmd.exe.
local function listDirs(resourceName, basePath)
    local ok, encoded = pcall(function()
        return exports.tLib:ListResourceDirs(resourceName, basePath)
    end)
    if ok and type(encoded) == "string" then
        local decoded = json and json.decode(encoded)
        if type(decoded) == "table" then return decoded end
    end

    local resourcePath = GetResourcePath(resourceName)
    if not resourcePath then return {} end
    local fullPath = resourcePath .. "/" .. basePath
    local cmd = os.getenv("OS")
        and ('dir /b /ad "' .. fullPath:gsub("/", "\\") .. '" 2>nul')
        or  ('ls -1 "' .. fullPath .. '" 2>/dev/null')

    local names = {}
    local popened, handle = pcall(io.popen, cmd)
    if popened and handle then
        local iterated = pcall(function()
            for name in handle:lines() do
                names[#names + 1] = name
            end
        end)
        pcall(function() handle:close() end)
        if not iterated then return {} end
    end
    return names
end

--- Read a file from a resource, seeing writes made since the resource started.
---
--- LoadResourceFile answers from the index built when the resource started, so a
--- module dropped in afterwards is on disk but invisible until a restart. That
--- live-scan property IS the drop-in install mechanism, so fall through to tLib's
--- Node bundle before deciding the module is not there.
local function readFile(resourceName, relPath)
    local contents = LoadResourceFile(resourceName, relPath)
    if contents and contents ~= '' then return contents end
    local ok, encoded = pcall(function()
        return exports.tLib:ReadResourceFile(resourceName, relPath)
    end)
    if ok and type(encoded) == "string" and encoded ~= '' then return encoded end
    return nil
end

local function isText(value, max)
    return type(value) == 'string' and value:match('%S') ~= nil and #value <= max
end

--- The subdirectory a theme module's font files live in. Mirrors
--- MODULE_THEME_FONT_DIR in shared/ts/modules/manifest.ts.
modules.THEME_FONT_DIR = 'fonts'

--- Most faces a theme may declare. Mirrors MAX_THEME_FONTS.
local MAX_THEME_FONTS = 32

--- Mirror of `^\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$`.
---
--- Spelled out in steps rather than as one Lua pattern: Lua patterns have no
--- optional groups and no alternation, and the loose `^%d+%.%d+` this started as
--- accepted `1.2.3.4.5` and `1.2abc`, which the TypeScript side refuses. Two
--- validators that disagree about what a version is are two validators.
local function isVersion(value)
    if not isText(value, 64) then return false end
    local core, prerelease = value:match('^([^%-]+)%-(.*)$')
    if not core then core = value end
    if not (core:match('^%d+%.%d+$') or core:match('^%d+%.%d+%.%d+$')) then return false end
    if prerelease and not prerelease:match('^[0-9A-Za-z][0-9A-Za-z%.%-]*$') then return false end
    return true
end

--- Mirror of `^(?:[1-9]\d{0,2}|1000)(?: (?:[1-9]\d{0,2}|1000))?$` — a
--- `font-weight`, or a variable range like `100 800`. 1..1000, css-fonts-4's
--- range, with leading zeros refused.
---
--- Spelled out for the same reason isVersion is: a loose `^%d+` accepts `0`,
--- `99999` and `400 400 400`, all of which the TypeScript side refuses.
local function isFontWeight(value)
    if not isText(value, 32) then return false end
    local function one(part)
        if not part:match('^[1-9]%d*$') then return false end
        local n = tonumber(part)
        return n ~= nil and n >= 1 and n <= 1000
    end
    local lo, hi = value:match('^(%d+) (%d+)$')
    if lo then return one(lo) and one(hi) end
    return one(value)
end

--- Mirror of FONT_FAMILY_FORBIDDEN. A declared family is ONE name: a comma would
local function isFontFamily(value)
    if not isText(value, 120) then return false end
    if value:find('[\'"{};,\\]') then return false end
    if value:match('^%s') or value:match('%s$') then return false end
    return true
end

--- Mirror of bareFileName: a filename inside this folder, not a path.
local function isBareFile(value)
    if not isText(value, 255) then return false end
    if value:find('/', 1, true) or value:find('\\', 1, true) then return false end
    if value:sub(1, 1) == '.' then return false end
    return true
end

--- Mirror of themeFacts in shared/ts/modules/manifest.ts, field for field.
---
--- @return boolean ok, string|nil err
--- Validated here, unlike `sound`, and the asymmetry is not an inconsistency: a
--- theme manifest is read on a LIVE SERVER, and `theme.fonts` becomes @font-face
--- rules -- a malformed declaration registers a font under the wrong name or not
--- at all, which is invisible at render time. The gate that sees the file has to
--- be the one that refuses it.
local function validateThemeFacts(raw)
    if type(raw) ~= 'table' then return false, 'module.json: "theme" must be an object' end
    local fonts = raw.fonts
    if type(fonts) ~= 'table' or #fonts < 1 or #fonts > MAX_THEME_FONTS then
        return false, ('module.json: "theme.fonts" must be 1..%d font declarations')
            :format(MAX_THEME_FONTS)
    end

    local seen = {}
    for index, font in ipairs(fonts) do
        local at = index - 1 -- the messages are 0-indexed, as the TypeScript's are
        if type(font) ~= 'table' then
            return false, ('module.json: "theme.fonts[%d]" must be an object'):format(at)
        end
        if not isText(font.family, 120) then
            return false, ('module.json: "theme.fonts[%d].family" must be a non-empty string of at most 120 chars')
                :format(at)
        end
        if not isFontFamily(font.family) then
            return false, ('module.json: "theme.fonts[%d].family" is "%s"; a family name is one name — no quotes, commas, braces, semicolons or surrounding space')
                :format(at, font.family)
        end
        if not isText(font.file, 255) then
            return false, ('module.json: "theme.fonts[%d].file" must be a non-empty string of at most 255 chars')
                :format(at)
        end
        if not isBareFile(font.file) then
            return false, ('module.json: "theme.fonts[%d].file" must be a bare filename inside this folder')
                :format(at)
        end
        if not font.file:lower():match('%.woff2$') then
            return false, ('module.json: "theme.fonts[%d].file" must end in .woff2'):format(at)
        end
        if not isText(font.license, 255) then
            return false, ('module.json: "theme.fonts[%d].license" must be a non-empty string of at most 255 chars')
                :format(at)
        end
        if not isBareFile(font.license) then
            return false, ('module.json: "theme.fonts[%d].license" must be a bare filename inside this folder')
                :format(at)
        end
        if font.weight ~= nil and not isFontWeight(font.weight) then
            return false, ('module.json: "theme.fonts[%d].weight" must be a weight like "400" or a variable range like "100 800", not "%s"')
                :format(at, tostring(font.weight))
        end
        if font.style ~= nil and font.style ~= 'normal' and font.style ~= 'italic' then
            return false, ('module.json: "theme.fonts[%d].style" must be "normal" or "italic"'):format(at)
        end

        local key = ('%s|%s|%s'):format(
            font.family, font.weight or '400', font.style or 'normal')
        if seen[key] then
            return false, ('module.json: "theme.fonts" declares "%s" at weight %s %s twice; one of the two files would never be used')
                :format(font.family, font.weight or '400', font.style or 'normal')
        end
        seen[key] = true
    end

    return true
end

--- Validate one decoded manifest. Returns the manifest, or nil plus a message
--- written for the server owner who will read it in the console.
---
--- @param raw table
--- @param id string folder name the manifest was read from
--- @param kind string|nil kind this directory holds, when the caller knows it
function modules.validate(raw, id, kind)
    if type(raw) ~= 'table' then return nil, 'module.json: expected a JSON object' end
    if raw.schema ~= modules.SCHEMA then
        return nil, ('module.json: declares schema %s; this tLib understands %d')
            :format(tostring(raw.schema), modules.SCHEMA)
    end
    if type(raw.kind) ~= 'string' or not modules.KINDS[raw.kind] then
        return nil, 'module.json: "kind" must be one of layout, theme'
    end
    if kind and raw.kind ~= kind then
        return nil, ('module.json: "%s" declares kind "%s" but this directory holds %s modules')
            :format(id, raw.kind, kind)
    end
    if not isText(raw.id, 120) then
        return nil, 'module.json: "id" must be a non-empty string of at most 120 chars'
    end
    if raw.id ~= id then
        return nil, ('module.json: "id" is "%s" but the folder is "%s"; they must match exactly')
            :format(raw.id, id)
    end
    if modules.RESERVED[raw.id] then
        return nil, ('module.json: "%s" is a reserved directory name and cannot be a module id')
            :format(raw.id)
    end
    if not isText(raw.name, 120) then
        return nil, 'module.json: "name" must be a non-empty string of at most 120 chars'
    end
    if not isVersion(raw.version) then
        return nil, ('module.json: "version" must look like 1.2.3, not "%s"'):format(tostring(raw.version))
    end
    for field, max in pairs({ author = 120, license = 120, description = 2048, slug = 120 }) do
        local value = raw[field]
        if value ~= nil and not isText(value, max) then
            return nil, ('module.json: "%s" must be a non-empty string of at most %d chars')
                :format(field, max)
        end
    end
    if raw.slug ~= nil and not raw.slug:match('^[a-z0-9][a-z0-9_%-]*$') then
        return nil, ('module.json: "slug" must match ^[a-z0-9][a-z0-9_-]*$, not "%s"'):format(raw.slug)
    end

    -- Not a sound rule -- those live only in manifest.ts, since nothing on a
    -- FiveM resource reads a sound manifest. This is a rule about layouts and
    -- themes: a field that does nothing is a field someone will eventually
    -- trust, and a skin author who pastes a `sound` block in and hears nothing
    -- deserves to be told why.
    if raw.sound ~= nil then
        return nil, ('module.json: a "%s" module must not carry "sound"'):format(raw.kind)
    end

    -- `theme` is OPTIONAL on a theme: one that merely selects a family the app
    -- already bundles ships no font and declares no block, which is four of the
    -- five dispatch themes. On any other kind it is refused.
    if raw.theme ~= nil then
        if raw.kind ~= 'theme' then
            return nil, ('module.json: a "%s" module must not carry "theme"'):format(raw.kind)
        end
        local ok, err = validateThemeFacts(raw.theme)
        if not ok then return nil, err end
    end

    return raw
end

--- Read and validate one module's manifest.
--- @return table|nil manifest, string|nil err
function modules.read(basePath, id, kind, resourceName)
    resourceName = resourceName or GetCurrentResourceName()
    if modules.RESERVED[id] then
        return nil, ('"%s" is a reserved directory name and cannot be a module'):format(id)
    end
    local raw = readFile(resourceName, basePath .. '/' .. id .. '/' .. modules.MANIFEST)
    if not raw then return nil, 'no ' .. modules.MANIFEST end
    local ok, decoded = pcall(function() return json.decode(raw) end)
    if not ok or type(decoded) ~= 'table' then return nil, modules.MANIFEST .. ' is not valid JSON' end
    return modules.validate(decoded, id, kind)
end

--- Every usable module of `kind` under basePath, as `{ id = , manifest = }`.
---
--- A folder that is on disk but unusable — reserved name, no manifest, wrong
function modules.list(basePath, kind, resourceName)
    resourceName = resourceName or GetCurrentResourceName()

    if type(kind) ~= 'string' or not modules.KINDS[kind] then
        error('tlib.modules: kind must be one of layout, theme', 2)
    end
    if not basePath:match('^[%w%-%_/\\%.]+$') then return {} end

    modules._cache = modules._cache or {}
    local cacheKey = resourceName .. ':' .. basePath .. ':' .. kind
    local cached = modules._cache[cacheKey]
    if cached then return cached end

    local found = {}
    for _, name in ipairs(listDirs(resourceName, basePath)) do
        local id = tostring(name):match('^%s*(.-)%s*$')
        if id ~= '' and not modules.RESERVED[id] then
            local manifest, err = modules.read(basePath, id, kind, resourceName)
            if manifest then
                found[#found + 1] = { id = id, manifest = manifest }
            elseif err ~= 'no ' .. modules.MANIFEST then
                modules.onRefusal(basePath, id, err)
            end
        end
    end

    table.sort(found, function(a, b) return a.id < b.id end)
    if #found > 0 then modules._cache[cacheKey] = found end
    return found
end

--- Just the ids, sorted.
---
function modules.scan(basePath, kind, resourceName)
    local ids = {}
    for _, entry in ipairs(modules.list(basePath, kind, resourceName)) do
        ids[#ids + 1] = entry.id
    end
    return ids
end

--- Clear the scan cache, for modules added at runtime.
function modules.clearCache()
    modules._cache = {}
end

--- Read one file out of a module folder.
function modules.load(basePath, id, fileName, resourceName)
    resourceName = resourceName or GetCurrentResourceName()
    return LoadResourceFile(resourceName, basePath .. '/' .. id .. '/' .. fileName)
end

--- Whether a module ships a given file, seeing files added since start.
---
function modules.hasFile(basePath, id, fileName, resourceName)
    resourceName = resourceName or GetCurrentResourceName()
    if LoadResourceFile(resourceName, basePath .. '/' .. id .. '/' .. fileName) then
        return true
    end
    local ok, encoded = pcall(function()
        return exports.tLib:ListResourceFiles(resourceName, basePath .. '/' .. id)
    end)
    if not ok or type(encoded) ~= 'string' then return false end
    local decodeOk, files = pcall(function() return json.decode(encoded) end)
    if not decodeOk or type(files) ~= 'table' then return false end
    for _, file in ipairs(files) do
        if file == fileName then return true end
    end
    return false
end

return modules
