-- loads the real Coords table from tLib's shared/sh_coords.lua into this VM.
-- consumer VMs don't share tLib's globals so we load it via LoadResourceFile.
if not Coords then
    local tLibName = 'tLib'
    local source = LoadResourceFile(tLibName, 'shared/sh_coords.lua')
    if source then
        local fn, err = load(source, '@@tLib/shared/sh_coords.lua')
        if fn then fn() end
    end
end

return Coords
