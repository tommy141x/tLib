-- tLib — Coords module (consumer import)
-- Delegates to the canonical Coords table defined in lua/coords/shared.lua,
-- which is loaded into tLib's own VM via shared_scripts. Consumer VMs access
-- it through this import file, which loads the same source via LoadResourceFile.
--
-- This avoids maintaining two identical copies of the coordinate math.

-- lua/coords/shared.lua is already loaded in tLib's shared_scripts and defines
-- the global Coords table there. For consumer VMs (loaded via imports.lua),
-- we need to load it fresh since they don't share tLib's global scope.
if not Coords then
    local tLibName = 'tLib'
    local source = LoadResourceFile(tLibName, 'lua/coords/shared.lua')
    if source then
        local fn, err = load(source, '@@tLib/lua/coords/shared.lua')
        if fn then fn() end
    end
end

return Coords
