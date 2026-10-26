-- Pure validators and catalog builders run in the consumer VM; the stateful
-- engine is accessed through tLib exports. Fail at import, not at first use.
for _, module in ipairs({ { 'schema', 'MenuSchema' }, { 'catalog', 'MenuCatalog' } }) do
    if not _G[module[2]] then
        -- shared/lib/menu/, not client/lib/menu/: fxmanifest's files{} followed
        -- the by-VM restructure move but this loader didn't, so `tlib_module
        -- 'menu'` dies at import and the knock-on errors (TMenuSchema/MenuCatalog
        -- nil) point at the consumer's own files instead.
        local path = 'shared/lib/menu/' .. module[1] .. '.lua'
        local source = assert(LoadResourceFile('tLib', path), 'Missing tLib module: ' .. path)
        assert(load(source, '@@tLib/' .. path))()
    end
end
return { schema = MenuSchema, catalog = MenuCatalog }
