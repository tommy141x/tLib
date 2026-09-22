-- Pure validators and catalog builders run in the consumer VM; the stateful
-- engine is accessed through tLib exports. Fail at import, not at first use.
for _, module in ipairs({ { 'schema', 'MenuSchema' }, { 'catalog', 'MenuCatalog' } }) do
    if not _G[module[2]] then
        local path = 'client/lib/menu/' .. module[1] .. '.lua'
        local source = assert(LoadResourceFile('tLib', path), 'Missing tLib module: ' .. path)
        assert(load(source, '@@tLib/' .. path))()
    end
end
return { schema = MenuSchema, catalog = MenuCatalog }
