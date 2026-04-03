-- tLib — Layouts module
-- Layout discovery: scans a resource's directory for layout subfolders.
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

--- Scan a resource directory for layout subfolders containing a marker file.
--- Server-side only (uses io.popen for directory listing).
--- Results are cached per basePath — layouts don't change at runtime.
--- @param basePath string  Path relative to resource root (e.g. "layouts")
--- @param matchFile string File that must exist in each subfolder (e.g. "ui.html")
--- @param resourceName? string  Resource to scan (default: current resource)
--- @return string[] Array of layout names, sorted alphabetically
function layouts.scan(basePath, matchFile, resourceName)
    resourceName = resourceName or GetCurrentResourceName()

    -- Cache key
    layouts._cache = layouts._cache or {}
    local cacheKey = resourceName .. ":" .. basePath .. ":" .. matchFile
    if layouts._cache[cacheKey] then return layouts._cache[cacheKey] end

    local result = {}

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

--- Load a layout file's contents.
--- Works on both client and server.
--- @param basePath string   e.g. "layouts"
--- @param layoutName string e.g. "modern"
--- @param fileName string   e.g. "ui.html"
--- @param resourceName? string  Resource to load from (default: current)
--- @return string|nil File contents, or nil if not found
function layouts.load(basePath, layoutName, fileName, resourceName)
    resourceName = resourceName or GetCurrentResourceName()
    local path = basePath .. "/" .. layoutName .. "/" .. fileName
    return LoadResourceFile(resourceName, path)
end

--- Load a layout file and replace {{KEY}} template placeholders.
--- @param basePath string
--- @param layoutName string
--- @param fileName string
--- @param vars table  { KEY = "value", ... }
--- @param resourceName? string
--- @return string|nil Templated content, or nil if file not found
function layouts.loadTemplate(basePath, layoutName, fileName, vars, resourceName)
    local content = layouts.load(basePath, layoutName, fileName, resourceName)
    if not content then return nil end

    for key, value in pairs(vars) do
        content = content:gsub("{{" .. key .. "}}", tostring(value))
    end
    return content
end

--- Check if a specific layout exists.
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
