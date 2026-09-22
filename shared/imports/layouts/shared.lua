-- Finds and loads a resource's layout subfolders.
--
--   tlib.layouts.scan('layouts', 'ui.html')          -> { 'default', 'modern' }
--   tlib.layouts.load('layouts', 'modern', 'ui.html')
--   tlib.layouts.loadTemplate('layouts', 'modern', 'ui.html', { TITLE = 'My HUD' })
--
-- loadTemplate substitutes {{TITLE}} and friends. Only scan is server-only; it
-- needs a directory listing, which comes from tLib's Node bundle.

local layouts = {}

--- Folder names directly under basePath, newest mechanism first.
---
--- FiveM's server Lua sandbox cannot enumerate a directory at all: io.popen is
--- nil and io.readdir returns an empty list for every path, including the
--- resource's own root (measured on a Windows FiveM server). A scan built on
--- either one therefore reports zero layouts and every consumer quietly falls
--- back to whatever names it hardcoded — which is exactly the bug this exists
--- to remove. The listing comes from tLib's Node bundle instead, where
--- fs.readdirSync works.
---
--- io.popen is kept as a second chance rather than deleted: this file is also
--- loaded by test harnesses and by any runtime where the export is absent, and
--- there it is the only option. Note the platform test is `OS ~= nil`, not
--- `OS == "Windows_NT"` — the FiveM server reports "Windows", so the old
--- equality check sent a `ls` to cmd.exe.
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
        for name in handle:lines() do
            names[#names + 1] = name
        end
        handle:close()
    end
    return names
end

--- True when `<basePath>/<name>/<matchFile>` is on disk.
---
--- LoadResourceFile answers from the resource's file index, which is built when
--- the resource starts. A layout dropped in afterwards — a marketplace install,
--- or a folder the server owner copied in without a `refresh` — is on disk but
--- not in that index, so the index check alone hides it until a restart. Fall
--- through to the real directory listing before deciding it is not there.
local function hasMarker(resourceName, basePath, name, matchFile)
    if LoadResourceFile(resourceName, basePath .. "/" .. name .. "/" .. matchFile) then
        return true
    end
    local ok, encoded = pcall(function()
        return exports.tLib:ListResourceFiles(resourceName, basePath .. "/" .. name)
    end)
    if not ok or type(encoded) ~= "string" then return false end
    local decodeOk, files = pcall(function() return json.decode(encoded) end)
    if not decodeOk or type(files) ~= "table" then return false end
    for _, file in ipairs(files) do
        if file == matchFile then return true end
    end
    return false
end

function layouts.scan(basePath, matchFile, resourceName)
    resourceName = resourceName or GetCurrentResourceName()

    layouts._cache = layouts._cache or {}
    local cacheKey = resourceName .. ":" .. basePath .. ":" .. matchFile
    if layouts._cache[cacheKey] then return layouts._cache[cacheKey] end

    local result = {}

    if not basePath:match("^[%w%-%_/\\%.]+$") then
        return {}
    end

    -- A folder only counts as a layout if it actually contains the marker file,
    -- so `layouts/sounds` and any stray directory drop out on their own and
    -- nothing has to be named anywhere.
    for _, name in ipairs(listDirs(resourceName, basePath)) do
        name = tostring(name):match("^%s*(.-)%s*$")
        if name ~= "" and hasMarker(resourceName, basePath, name, matchFile) then
            result[#result + 1] = name
        end
    end

    -- An empty result stays empty: consumers own their fallback, and inventing
    -- 'default' here makes NUI fetch a file that was never shipped (tELS ships
    -- WCC, not default).
    table.sort(result)
    -- Only a non-empty answer is cached. A consumer whose server VM starts
    -- before tLib's bundle has registered the export gets an empty list once;
    -- caching that would freeze the resource at zero layouts until a restart.
    if #result > 0 then layouts._cache[cacheKey] = result end
    return result
end

--- Clear the scan cache, for layouts added at runtime.
function layouts.clearCache()
    layouts._cache = {}
end

function layouts.load(basePath, layoutName, fileName, resourceName)
    resourceName = resourceName or GetCurrentResourceName()
    local path = basePath .. "/" .. layoutName .. "/" .. fileName
    return LoadResourceFile(resourceName, path)
end

function layouts.loadTemplate(basePath, layoutName, fileName, vars, resourceName)
    local content = layouts.load(basePath, layoutName, fileName, resourceName)
    if not content then return nil end

    for key, value in pairs(vars) do
        local escaped_key = key:gsub("([%%%.%+%-%*%?%[%]%^%$%(%)%{%}])", "%%%1")
        local escaped_value = tostring(value):gsub("%%", "%%%%")
        content = content:gsub("{{" .. escaped_key .. "}}", escaped_value)
    end
    return content
end

function layouts.exists(basePath, layoutName, matchFile, resourceName)
    resourceName = resourceName or GetCurrentResourceName()
    local path = basePath .. "/" .. layoutName .. "/" .. matchFile
    local content = LoadResourceFile(resourceName, path)
    return content ~= nil
end

return layouts
