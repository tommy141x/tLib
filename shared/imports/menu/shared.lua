-- Pure validators and catalog builders run in the consumer VM; the stateful
-- engine is accessed through tLib exports. Fail at import, not at first use.
for _, module in ipairs({ { 'schema', 'MenuSchema' }, { 'catalog', 'MenuCatalog' } }) do
    if not _G[module[2]] then
        -- `shared/lib/menu/`, not `client/lib/menu/`. Both files moved there in the
        -- by-VM restructure and fxmanifest's files{} block followed them; this
        -- loader did not. The failure is total and confusing: every consumer that
        -- declares `tlib_module 'menu'` dies at import with "Missing tLib module:
        -- client/lib/menu/schema.lua", and the errors that follow are all knock-on
        -- (TMenuSchema nil, MenuCatalog nil) pointing at the consumer's own files.
        local path = 'shared/lib/menu/' .. module[1] .. '.lua'
        local source = assert(LoadResourceFile('tLib', path), 'Missing tLib module: ' .. path)
        assert(load(source, '@@tLib/' .. path))()
    end
end
return { schema = MenuSchema, catalog = MenuCatalog }
