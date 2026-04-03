-- tLib/lua/adapter/utils.lua
-- HTTP and other utility platform abstractions.
--
-- Depends on: lua/adapter/init.lua  (_TLIB_IS_HELIX / _TLIB_IS_FIVEM / Platform)
--             lua/adapter/core.lua  (Platform.export)
--             lua/adapter/helix/http.lua  (loaded inline below on Helix — defines Http.fetch)
--
-- Surfaces provided:
--
--   Platform.Fetch(opts, callback)
--     Cross-platform HTTP fetch.
--     opts.url     — string, required
--     opts.method  — string, default 'GET'
--     opts.headers — table,  default {}
--     opts.body    — string, default ''
--     callback(statusCode, body, headers, errorData)

if _TLIB_IS_HELIX then
    function Platform.Fetch(opts, callback)
        Http.fetch(opts, callback)
    end
elseif _TLIB_IS_FIVEM then
    function Platform.Fetch(opts, callback)
        PerformHttpRequest(
            opts.url,
            callback,
            opts.method or 'GET',
            opts.body or '',
            opts.headers or {},
            { followLocation = true }
        )
    end
else
    Platform.Fetch = Platform._stub('Fetch')
end

Platform.export('tLib', 'Fetch', function(opts, callback)
    Platform.Fetch(opts, callback)
end)
