-- The hub, on the port players already connect to.
--
-- FXServer routes `http://<host>:<netPort>/tLib/<path>` to this resource's
-- `SetHttpHandler`. That port is open on every server, because it is how the
-- game connects — so this door needs no firewall rule, NAT forward or convar.
-- Additive: the listener binds exactly as before and every existing mount and
-- WebSocket runs the same code path.
--
-- Three facts shape it, all measured on FXServer Enhanced b139; fixtures and
-- the hypotheses that turned out wrong are in
-- `[tScripts]/internal/reference/fxserver-http-ingress-findings.md`.
--
--  * Lua, not JS. A string crossing out of the JS runtime is UTF-8 encoded, so
--    every byte ≥ 0x80 doubles; a Lua string is bytes. Serving `.wasm`, fonts or
--    images from a JS handler would corrupt all of them.
--  * It never speaks HTTP to tLib's own listener. `PerformHttpRequest` to a
--    listener in the same process crashes the server. So `ResolveHttpIngress`
--    (lib/http/ingress.ts) answers with a VALUE: a finished response, or a
--    consumer's loopback address — a separate process, which is safe.
--  * Two things cannot cross: WebSocket (no upgrade surface; ingress.ts answers
--    501 for the realtime mount) and request bodies over 8192 bytes, which
--    FXServer resets before this handler runs — so they cannot even be
--    answered with a 413, only designed around.

-- Set `tlib_http_ingress false` to leave the FiveM server port alone entirely.
if GetConvar('tlib_http_ingress', 'true') == 'false' then
    return
end

--- sv_hostname with FiveM colour codes stripped, for the hub page's title.
--- Passed in so ingress.ts stays free of FiveM globals, as router.ts does.
local function serverName()
    local clean = GetConvar('sv_hostname', '')
        :gsub('%^[0-9%*_~=]', '')
        :gsub('~[a-zA-Z]~', '')
        :gsub('^%s+', '')
        :gsub('%s+$', '')
    if clean == '' then return 'FiveM Server' end
    return clean
end

--- `Host` is dropped because the router selects a mount from the path alone
--- (router.ts: "what separates a router from an open relay"); the rest describe
--- THIS connection, not the relayed one, and Content-Length is the relay's to set.
local DROP_REQUEST = {
    ['host'] = true,
    ['connection'] = true,
    ['keep-alive'] = true,
    ['proxy-authenticate'] = true,
    ['proxy-authorization'] = true,
    ['te'] = true,
    ['trailer'] = true,
    ['transfer-encoding'] = true,
    ['upgrade'] = true,
    ['content-length'] = true,
}

--- FXServer derives Content-Length from the string handed to `send()`; a second,
--- contradicting value is a malformed response.
local DROP_RESPONSE = {
    ['content-length'] = true,
    ['transfer-encoding'] = true,
    ['connection'] = true,
    ['keep-alive'] = true,
}

local function forwardHeaders(headers, address)
    local out = {}
    for k, v in pairs(headers or {}) do
        if not DROP_REQUEST[tostring(k):lower()] then out[tostring(k)] = tostring(v) end
    end
    -- Every relayed request reaches the app from 127.0.0.1; this is the only
    -- way it can rate-limit or log by the real peer.
    if address and address ~= '' then
        out['X-Forwarded-For'] = address
        out['X-Forwarded-Proto'] = 'http'
    end
    return out
end

local function sendInline(res, resolution)
    local headers = {}
    for k, v in pairs(resolution.headers or {}) do headers[tostring(k)] = tostring(v) end
    res.writeHead(resolution.status or 500, headers)
    res.send(resolution.body or '')
end

--- `PerformHttpRequest` does not call back at all when the target refuses the
--- connection, and an unanswered request takes FXServer's whole HTTP listener
--- down. 10 s, not the listener's 30 s: these are loopback hops that complete in
--- milliseconds, and waiting longer buys nothing in the one failure mode that
--- matters.
local UPSTREAM_TIMEOUT_MS = 10000

--- One relay, deliberately. A `node:http` fast path for text was built and
--- removed: it cut the in-Lua hop from 20 ms to 1–7 ms, but a request through
--- this port costs ~15–20 ms at the wall whatever the handler does — even a
--- synchronous send — so the Socket.IO round trip did not move. Not worth a
--- second code path and a double fetch of every binary.
local function relayToUpstream(req, res, resolution, body)
    local target = ('http://%s:%d%s'):format(resolution.host, resolution.port, resolution.path)

    -- Exactly one answer, whichever path lands first: a second writeHead on a
    -- finished response is its own way to break the listener.
    local answered = false
    local function answerOnce(fn)
        if answered then return end
        answered = true
        pcall(fn)
    end
    local function fail(status, text)
        answerOnce(function()
            res.writeHead(status, { ['Content-Type'] = 'text/plain; charset=utf-8' })
            res.send(text)
        end)
    end

    CreateThread(function()
        Wait(UPSTREAM_TIMEOUT_MS)
        if not answered then
            print(('[tLib/http] ingress: %s did not answer in %d ms'):format(target, UPSTREAM_TIMEOUT_MS))
        end
        fail(504, 'tLib: the application behind this path did not respond in time.\n')
    end)

    -- Four callback arguments: for a non-2xx status the body is `errorData`
    -- and `data` is nil. Checking `data` alone turned every upstream 404, 400
    -- and 401 into a 502 wearing tLib's text — found through tDB's admin UI.
    PerformHttpRequest(target, function(status, data, headers, errorData)
        local ok, err = pcall(function()
            if data == nil or data == '' then data = errorData end
            -- A refused connection reports status 200, an empty body and an EMPTY
            -- header table — the only answer with no headers at all, since even a
            -- 204 carries Date. The body alone cannot identify it: `errorData`
            -- arrives as "" and would read as a live, empty 200.
            local dead = headers == nil or next(headers) == nil
            if not status or status <= 0 or ((data == nil or data == '') and dead) then
                return fail(502, 'tLib: the application behind this path is not responding.\n')
            end
            -- Seeded, never empty: `writeHead(status, {})` crashes the server.
            -- An empty Lua table marshals as an empty array, not an object, and
            -- a refused upstream is exactly how one would arrive here.
            local out = { ['X-Proxied-By'] = 'tLib' }
            for k, v in pairs(headers) do
                if not DROP_RESPONSE[tostring(k):lower()] then out[tostring(k)] = tostring(v) end
            end
            answerOnce(function()
                res.writeHead(status, out)
                -- One send, never write(): `response.write` REPLACES the body
                -- rather than appending, so chunking would serve the last chunk.
                res.send(data or '')
            end)
        end)
        if not ok then
            print(('[tLib/http] ingress relay failed for %s: %s'):format(target, tostring(err)))
            fail(502, 'tLib: ingress relay failure\n')
        end
    end, req.method or 'GET', body or '', forwardHeaders(req.headers, req.address))
end

local function handle(req, res, body)
    -- FXServer strips `/<resource>` before handing over the path; the router's
    -- absolute paths go back under it or every link and redirect leaves the
    -- namespace.
    local resolved = exports[GetCurrentResourceName()]:ResolveHttpIngress(
        req.method or 'GET', req.path or '/', serverName(),
        '/' .. GetCurrentResourceName()
    )
    -- Absent until the bundle has installed the bridge.
    if type(resolved) ~= 'table' then
        res.writeHead(503, { ['Content-Type'] = 'text/plain; charset=utf-8' })
        res.send('tLib: the HTTP router is not ready yet.\n')
        return
    end
    if resolved.kind == 'upstream' then
        relayToUpstream(req, res, resolved, body)
    else
        sendInline(res, resolved)
    end
end

local function failed(res, method, path, err)
    print(('[tLib/http] ingress error on %s %s: %s'):format(tostring(method), tostring(path), tostring(err)))
    pcall(function()
        res.writeHead(500, { ['Content-Type'] = 'text/plain; charset=utf-8' })
        res.send('tLib: ingress failure\n')
    end)
end

--- `setDataHandler` only for methods that carry a body: on a GET its callback
--- may never fire, and a request never answered is a dead listener.
local HAS_BODY = { POST = true, PUT = true, PATCH = true, DELETE = true }

SetHttpHandler(function(req, res)
    local ok, err = pcall(function()
        if HAS_BODY[(req.method or 'GET'):upper()] then
            req.setDataHandler(function(body)
                local inner, innerErr = pcall(handle, req, res, body)
                if not inner then failed(res, req.method, req.path, innerErr) end
            end)
        else
            handle(req, res, nil)
        end
    end)
    if not ok then failed(res, req.method, req.path, err) end
end)

-- The URL is printed by lib/http/index.ts: it needs the resolved public address,
-- which arrives after IP detection, and `ingressUrlFrom` knows when it must not
-- be guessed at.
