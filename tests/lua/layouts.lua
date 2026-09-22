-- Layout discovery must never advertise a nonexistent fallback to NUI.
local entries = {}
local files = {}
local failScan = false
GetCurrentResourceName = function() return 'tELS' end
GetResourcePath = function() return '/resources/tELS' end
LoadResourceFile = function(resource, path)
    assert(resource == 'tELS')
    return files[path]
end
io.popen = function()
    if failScan then error('directory listing unavailable') end
    return {
        lines = function()
            local index = 0
            return function()
                index = index + 1
                return entries[index]
            end
        end,
        close = function() end,
    }
end
local layouts = dofile('shared/imports/layouts/shared.lua')
local function scan()
    layouts.clearCache()
    return layouts.scan('layouts', 'ui.html')
end
assert(#scan() == 0, 'empty directory must not invent default')
failScan = true
assert(#scan() == 0, 'unavailable scanner must not invent default')
failScan = false
entries = { 'sounds', 'WCC', 'default' }
files['layouts/WCC/ui.html'] = '<div>WCC</div>'
local found = scan()
assert(#found == 1 and found[1] == 'WCC', 'only layouts with the requested file are discoverable')
files['layouts/default/ui.html'] = '<div>default</div>'
found = scan()
assert(#found == 2 and found[1] == 'WCC' and found[2] == 'default', 'a real default remains supported')
assert(layouts.load('layouts', 'WCC', 'ui.html') == '<div>WCC</div>')
assert(layouts.load('layouts', 'missing', 'ui.html') == nil)
print('PASS: layout discovery returns only existing layouts, never a fabricated default')
