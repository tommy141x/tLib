-- loads the real Coords table from tLib's lua/coords/shared.lua into this VM.
-- consumer VMs don't share tLib's globals so we load it via LoadResourceFile.
if not Coords then
    local tLibName = 'tLib'
    local source = LoadResourceFile(tLibName, 'lua/coords/shared.lua')
    if source then
        local fn, err = load(source, '@@tLib/lua/coords/shared.lua')
        if fn then fn() end
    end
end

return Coords
