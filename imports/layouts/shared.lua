-- scans a resource's directory for layout subfolders.
--
-- Usage (server-side — directory scanning requires io.popen):
--   local names = tlib.layouts.scan('layouts', 'ui.html')
--   -- Returns: { 'default', 'modern', 'minimal' }
--
-- Usage (client or server — check if a specific layout file exists):
--   local html = tlib.layouts.load('layouts', 'modern', 'ui.html')
--   -- Returns file contents or nil
--
-- Usage (client or server — load and template a layout):
--   local html = tlib.layouts.loadTemplate('layouts', 'modern', 'ui.html', {
--       TITLE = 'My HUD',
--       VERSION = '1.0',
--   })
--   -- Replaces {{TITLE}}, {{VERSION}} in the HTML with values

local layouts = {}

--- @param basePath string
--- @param matchFile string
--- @param resourceName? string
--- @return string[]
function layouts.scan(basePath, matchFile, resourceName)
    resourceName = resourceName or GetCurrentResourceName()

    -- Cache key
    layouts._cache = layouts._cache or {}
    local cacheKey = resourceName .. ":" .. basePath .. ":" .. matchFile
    if layouts._cache[cacheKey] then return layouts._cache[cacheKey] end

    local result = {}

    if not basePath:match("^[%w%-%_/\\%.]+$") then
        return {}
    end

    -- Try io.popen (server-side directory listing)
    local resourcePath = GetResourcePath(resourceName)
    if resourcePath then
        local fullPath = resourcePath .. "/" .. basePath
        local isWindows = os.getenv("OS") == "Windows_NT"
        local cmd = isWindows
            and ('dir /b /ad "' .. fullPath:gsub("/", "\\") .. '" 2>nul')
            or  ('ls -1 "' .. fullPath .. '" 2>/dev/null')

        local ok, handle = pcall(io.popen, cmd)
        if ok and handle then
            for name in handle:lines() do
                name = name:match("^%s*(.-)%s*$")
                if name ~= "" then
                    local check = LoadResourceFile(resourceName, basePath .. "/" .. name .. "/" .. matchFile)
                    if check then
                        result[#result + 1] = name
                    end
                end
            end
            handle:close()
        end
    end

    if #result == 0 then result = { "default" } else table.sort(result) end
    layouts._cache[cacheKey] = result
    return result
end

--- Clear the scan cache (e.g. if layouts are added at runtime).
function layouts.clearCache()
    layouts._cache = {}
end

--- @param basePath string
--- @param layoutName string
--- @param fileName string
--- @param resourceName? string
--- @return string|nil
function layouts.load(basePath, layoutName, fileName, resourceName)
    resourceName = resourceName or GetCurrentResourceName()
    local path = basePath .. "/" .. layoutName .. "/" .. fileName
    return LoadResourceFile(resourceName, path)
end

--- @param basePath string
--- @param layoutName string
--- @param fileName string
--- @param vars table
--- @param resourceName? string
--- @return string|nil
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

--- @param basePath string
--- @param layoutName string
--- @param matchFile string
--- @param resourceName? string
--- @return boolean
function layouts.exists(basePath, layoutName, matchFile, resourceName)
    resourceName = resourceName or GetCurrentResourceName()
    local path = basePath .. "/" .. layoutName .. "/" .. matchFile
    local content = LoadResourceFile(resourceName, path)
    return content ~= nil
end

return layouts
