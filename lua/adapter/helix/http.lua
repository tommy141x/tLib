-- tLib/lua/adapter/helix/http.lua
-- Logger is available here because server.lua requires logger before http.
local log = Logger.create('tLib/http')
-- Non-blocking HTTP/HTTPS fetch for server-side Lua.
-- HTTPS requires ssl.dll (Windows x64, LuaSec 1.3.2) beside this file.
-- If LuaSec is unavailable, https:// requests fail immediately with a clear error.
-- Http.fetch(opts, callback)  →  callback(err, status, body)
--
-- All TCP I/O uses settimeout(0) (non-blocking). Each operation that returns
-- 'timeout' / 'wantread' / 'wantwrite' yields the coroutine via Timer.Wait(0)
-- and retries after socket.select confirms readiness. This prevents stalling
-- the Lua VM during slow or failed connections — the maximum observable freeze
-- per Timer.Wait(0) tick is one scheduler frame, not the full timeout window.

Http = {}

-- LuaSec probe — runs once at require-time so individual fetches pay no cost.
-- ssl will be nil if LuaSec is unavailable; sslErr holds the reason.
-- ssl.dll lives beside this file; we locate it via debug.getinfo and inject
-- all submodules plus the ssl module itself into package.preload manually.

local ssl, sslErr = nil, nil
do
    -- Locate the tLib package root by scanning package.path for a path segment
    -- that contains tLib's known directory structure. Helix adds the tLib root
    -- to package.path, so one of the entries will look like:
    --   …/tLib/?.lua  or  …/tLib/?/init.lua
    -- We strip the template suffix to get the bare root directory.
    local function findTLibRoot()
        for entry in (package.path .. ';'):gmatch('([^;]+);') do
            local root = entry:match('^(.+[/\\])%?')
            if root then
                -- Normalise to forward slashes.
                root = root:gsub('\\', '/')
                -- Confirm this looks like the tLib root by checking for a known file.
                local f = io.open(root .. 'lua/adapter/helix/http.lua', 'r')
                if f then
                    f:close()
                    return root
                end
            end
        end
        return nil
    end

    local tLibRoot   = findTLibRoot()
    -- ssl.dll sits at lua/adapter/helix/ssl.dll relative to the tLib root.
    local sslDllPath = nil
    do
        local candidates = {
            tLibRoot and (tLibRoot .. 'lua/adapter/helix/ssl.dll') or nil,
        }
        for _, candidate in ipairs(candidates) do
            if candidate then
                local ok, result = pcall(package.loadlib, candidate, 'luaopen_ssl_core')
                if ok and type(result) == 'function' then
                    sslDllPath = candidate
                    break
                end
            end
        end
    end

    -- Register each DLL entry point in package.preload (skip if already loaded).
    if sslDllPath then
        local submodules = {
            { name = 'ssl.core',    entry = 'luaopen_ssl_core' },
            { name = 'ssl.context', entry = 'luaopen_ssl_context' },
            { name = 'ssl.config',  entry = 'luaopen_ssl_config' },
            { name = 'ssl.x509',    entry = 'luaopen_ssl_x509' },
        }
        for _, mod in ipairs(submodules) do
            if not package.preload[mod.name] then
                local ok, result = pcall(package.loadlib, sslDllPath, mod.entry)
                if ok and type(result) == 'function' then
                    package.preload[mod.name] = result
                end
            end
        end
        log('ssl submodules registered from ' .. sslDllPath, 1)
    end

    -- Inline the ssl module (previously ssl/init.lua) so require('ssl') resolves
    -- without touching package.path or the filesystem for a .lua file.
    if sslDllPath and not package.preload['ssl'] then
        package.preload['ssl'] = function()
            local core     = require('ssl.core')
            local context  = require('ssl.context')
            local x509     = require('ssl.x509')
            local config   = require('ssl.config')

            local unpack   = table.unpack or unpack

            -- We must prevent the contexts to be collected before the connections,
            -- otherwise the C registry will be cleared.
            local registry = setmetatable({}, { __mode = 'k' })

            local function optexec(func, param, ctx)
                if param then
                    if type(param) == 'table' then
                        return func(ctx, unpack(param))
                    else
                        return func(ctx, param)
                    end
                end
                return true
            end

            local function array2wireformat(array)
                local str = ''
                for k, v in ipairs(array) do
                    if type(v) ~= 'string' then return nil end
                    local len = #v
                    if len == 0 then
                        return nil, 'invalid ALPN name (empty string)'
                    elseif len > 255 then
                        return nil, 'invalid ALPN name (length > 255)'
                    end
                    str = str .. string.char(len) .. v
                end
                if str == '' then return nil, 'invalid ALPN list (empty)' end
                return str
            end

            local function wireformat2array(str)
                local i = 1
                local array = {}
                while i < #str do
                    local len = str:byte(i)
                    array[#array + 1] = str:sub(i + 1, i + len)
                    i = i + len + 1
                end
                return array
            end

            local function newcontext(cfg)
                local succ, msg, ctx
                ctx, msg = context.create(cfg.protocol)
                if not ctx then return nil, msg end
                succ, msg = context.setmode(ctx, cfg.mode)
                if not succ then return nil, msg end
                local certificates = cfg.certificates
                if not certificates then
                    certificates = {
                        { certificate = cfg.certificate, key = cfg.key, password = cfg.password }
                    }
                end
                for _, certificate in ipairs(certificates) do
                    if certificate.key then
                        if certificate.password and
                            type(certificate.password) ~= 'function' and
                            type(certificate.password) ~= 'string'
                        then
                            return nil, 'invalid password type'
                        end
                        succ, msg = context.loadkey(ctx, certificate.key, certificate.password)
                        if not succ then return nil, msg end
                    end
                    if certificate.certificate then
                        succ, msg = context.loadcert(ctx, certificate.certificate)
                        if not succ then return nil, msg end
                        if certificate.key and context.checkkey then
                            succ = context.checkkey(ctx)
                            if not succ then return nil, 'private key does not match public key' end
                        end
                    end
                end
                if cfg.cafile or cfg.capath then
                    succ, msg = context.locations(ctx, cfg.cafile, cfg.capath)
                    if not succ then return nil, msg end
                end
                if cfg.ciphers then
                    succ, msg = context.setcipher(ctx, cfg.ciphers)
                    if not succ then return nil, msg end
                end
                if cfg.ciphersuites then
                    succ, msg = context.setciphersuites(ctx, cfg.ciphersuites)
                    if not succ then return nil, msg end
                end
                succ, msg = optexec(context.setverify, cfg.verify, ctx)
                if not succ then return nil, msg end
                succ, msg = optexec(context.setoptions, cfg.options, ctx)
                if not succ then return nil, msg end
                if cfg.depth then
                    succ, msg = context.setdepth(ctx, cfg.depth)
                    if not succ then return nil, msg end
                end
                if cfg.dhparam then
                    if type(cfg.dhparam) ~= 'function' then
                        return nil, 'invalid DH parameter type'
                    end
                    context.setdhparam(ctx, cfg.dhparam)
                end
                if (not config.algorithms.ec) and (cfg.curve or cfg.curveslist) then
                    return false, 'elliptic curves not supported'
                end
                if config.capabilities.curves_list and cfg.curveslist then
                    succ, msg = context.setcurveslist(ctx, cfg.curveslist)
                    if not succ then return nil, msg end
                elseif cfg.curve then
                    succ, msg = context.setcurve(ctx, cfg.curve)
                    if not succ then return nil, msg end
                end
                if cfg.verifyext and ctx.setverifyext then
                    succ, msg = optexec(ctx.setverifyext, cfg.verifyext, ctx)
                    if not succ then return nil, msg end
                end
                if cfg.mode == 'server' and cfg.alpn then
                    if type(cfg.alpn) == 'function' then
                        local alpncb = cfg.alpn
                        succ, msg = context.setalpncb(ctx, function(str)
                            local protocols = alpncb(wireformat2array(str))
                            if type(protocols) == 'string' then
                                protocols = { protocols }
                            elseif type(protocols) ~= 'table' then
                                return nil
                            end
                            return (array2wireformat(protocols))
                        end)
                        if not succ then return nil, msg end
                    elseif type(cfg.alpn) == 'table' then
                        local protocols = cfg.alpn
                        succ, msg = array2wireformat(protocols)
                        if not succ then return nil, msg end
                        succ, msg = context.setalpncb(ctx, function()
                            return (array2wireformat(protocols))
                        end)
                        if not succ then return nil, msg end
                    else
                        return nil, 'invalid ALPN parameter'
                    end
                elseif cfg.mode == 'client' and cfg.alpn then
                    local alpn
                    if type(cfg.alpn) == 'string' then
                        alpn, msg = array2wireformat({ cfg.alpn })
                    elseif type(cfg.alpn) == 'table' then
                        alpn, msg = array2wireformat(cfg.alpn)
                    else
                        return nil, 'invalid ALPN parameter'
                    end
                    if not alpn then return nil, msg end
                    succ, msg = context.setalpn(ctx, alpn)
                    if not succ then return nil, msg end
                end
                if config.capabilities.psk and cfg.psk then
                    if cfg.mode == 'client' then
                        if type(cfg.psk) ~= 'function' then
                            return nil, 'invalid PSK configuration'
                        end
                        succ = context.setclientpskcb(ctx, cfg.psk)
                        if not succ then return nil, msg end
                    elseif cfg.mode == 'server' then
                        if type(cfg.psk) == 'function' then
                            succ, msg = context.setserverpskcb(ctx, cfg.psk)
                            if not succ then return nil, msg end
                        elseif type(cfg.psk) == 'table' then
                            if type(cfg.psk.hint) == 'string' and type(cfg.psk.callback) == 'function' then
                                succ, msg = context.setpskhint(ctx, cfg.psk.hint)
                                if not succ then return succ, msg end
                                succ = context.setserverpskcb(ctx, cfg.psk.callback)
                                if not succ then return succ, msg end
                            else
                                return nil, 'invalid PSK configuration'
                            end
                        else
                            return nil, 'invalid PSK configuration'
                        end
                    end
                end
                if config.capabilities.dane and cfg.dane then
                    if type(cfg.dane) == 'table' then
                        context.setdane(ctx, unpack(cfg.dane))
                    else
                        context.setdane(ctx)
                    end
                end
                return ctx
            end

            local function wrap(sock, cfg)
                local ctx, msg
                if type(cfg) == 'table' then
                    ctx, msg = newcontext(cfg)
                    if not ctx then return nil, msg end
                else
                    ctx = cfg
                end
                local s, msg = core.create(ctx)
                if s then
                    core.setfd(s, sock:getfd())
                    sock:setfd(core.SOCKET_INVALID)
                    registry[s] = ctx
                    return s
                end
                return nil, msg
            end

            local function info(ssl, field)
                local str, comp, err, protocol
                comp, err = core.compression(ssl)
                if err then return comp, err end
                if field == 'compression' then return comp end
                local info = { compression = comp }
                str, info.bits, info.algbits, protocol = core.info(ssl)
                if str then
                    info.cipher, info.protocol, info.key,
                    info.authentication, info.encryption, info.mac =
                        string.match(str,
                            '^(%S+)%s+(%S+)%s+Kx=(%S+)%s+Au=(%S+)%s+Enc=(%S+)%s+Mac=(%S+)')
                    info.export = (string.match(str, '%sexport%s*$') ~= nil)
                end
                if protocol then info.protocol = protocol end
                if field then return info[field] end
                return ((next(info)) and info)
            end

            core.setmethod('info', info)

            return {
                _VERSION        = '1.3.2',
                _COPYRIGHT      = core.copyright(),
                config          = config,
                loadcertificate = x509.load,
                newcontext      = newcontext,
                wrap            = wrap,
            }
        end
        log('ssl module inlined into package.preload', 1)
    end

    local ok, result = pcall(require, 'ssl')
    if ok and type(result) == 'table' and type(result.wrap) == 'function' then
        ssl = result
        log('LuaSec loaded — https:// requests are supported', 1)
    elseif ok then
        -- require() succeeded but ssl.wrap is absent — ssl.dll likely failed to initialise.
        sslErr = 'ssl module loaded but ssl.wrap is missing — ssl.dll likely failed to initialise'
        log('LuaSec not available: ' .. sslErr, 3)
    else
        sslErr = tostring(result)
        log('LuaSec not available: ' .. sslErr, 3)
    end
end

local function parseUrl(url)
    if type(url) ~= 'string' then
        return nil, nil, nil, nil, 'url must be a string'
    end

    -- Extract scheme
    local scheme, rest = url:match('^([Hh][Tt][Tt][Pp][Ss]?)://(.+)$')
    if not scheme then
        return nil, nil, nil, nil, 'url must begin with http:// or https:// (got: ' .. url .. ')'
    end
    scheme = scheme:lower()

    local defaultPort = scheme == 'https' and 443 or 80

    -- Split authority from path
    local authority, path = rest:match('^([^/]+)(/.*)$')
    if not authority then
        authority = rest
        path      = '/'
    end

    -- Split host from optional port
    local host, portStr = authority:match('^(.+):(%d+)$')
    if not host then
        host    = authority
        portStr = tostring(defaultPort)
    end

    local port = tonumber(portStr)
    if not port or port < 1 or port > 65535 then
        return nil, nil, nil, nil, 'invalid port: ' .. tostring(portStr)
    end

    return scheme, host, port, path, nil
end

-- Decodes a chunked-transfer-encoded body per RFC 7230 §4.1.
-- Each chunk is prefixed with a hex size line (optionally followed by chunk
-- extensions separated by ';'). A zero-length chunk terminates the stream.
-- Chunk extensions and trailing headers are silently discarded.
local function decodeChunked(body)
    local chunks = {}
    local pos    = 1
    local len    = #body

    while pos <= len do
        -- Find the end of the chunk-size line.
        local lineEnd = body:find('\r\n', pos, true)
        if not lineEnd then break end

        -- Size is the leading hex digits; ignore any chunk extensions (';…').
        local hexSize = body:sub(pos, lineEnd - 1):match('^%x+')
        if not hexSize then break end

        local chunkSize = tonumber(hexSize, 16)
        if not chunkSize or chunkSize == 0 then break end

        local dataStart = lineEnd + 2
        local dataEnd   = dataStart + chunkSize - 1

        if dataEnd > len then
            -- Truncated response — accept whatever arrived.
            table.insert(chunks, body:sub(dataStart, len))
            break
        end

        table.insert(chunks, body:sub(dataStart, dataEnd))

        -- Advance past chunk data + trailing \r\n.
        pos = dataEnd + 3
    end

    return table.concat(chunks)
end

local function parseResponse(raw)
    local statusCode = tonumber(raw:match('^HTTP/%S+%s+(%d+)'))
    local headerEnd  = raw:find('\r\n\r\n', 1, true)
    local body

    if headerEnd then
        local headers = raw:sub(1, headerEnd)
        body          = raw:sub(headerEnd + 4)

        -- Decode chunked transfer encoding when the server uses it instead of
        -- Content-Length.  Without decoding, hex-length framing bytes end up
        -- silently included in the body string, corrupting JSON / binary data.
        if headers:lower():find('transfer%-encoding:%s*chunked', 1, false) then
            body = decodeChunked(body)
        end
    else
        -- Fallback: no CRLF separator found, treat everything as body.
        body = raw
    end

    return statusCode or 0, body or ''
end

local function buildRequest(method, host, path, headers, body)
    local lines = {
        method .. ' ' .. path .. ' HTTP/1.1',
        'Host: ' .. host,
        'Connection: close',
        'User-Agent: tLib/1.0',
    }

    -- Only inject body-related headers when there is actually a body to send.
    -- Sending Content-Length: 0 + Content-Type on an empty-body POST causes
    -- some servers (e.g. strict REST APIs) to reject the request.
    if method == 'POST' and #body > 0 then
        table.insert(lines, 'Content-Length: ' .. #body)
        if not headers['Content-Type'] and not headers['content-type'] then
            table.insert(lines, 'Content-Type: application/x-www-form-urlencoded')
        end
    end

    for k, v in pairs(headers) do
        table.insert(lines, k .. ': ' .. tostring(v))
    end

    -- Blank line terminates headers, then optional body
    table.insert(lines, '')
    table.insert(lines, body)

    return table.concat(lines, '\r\n')
end

--
-- Both helpers accept the socket module (`sockmod`) rather than a global so
-- they work whether called for a plain TCP socket or a LuaSec TLS connection
-- (both expose getfd() which socket.select uses internally).
--
-- `deadline` is a wall-clock timestamp produced by sockmod.gettime().
-- Timer.Wait(0) cooperatively yields this coroutine to the Helix scheduler
-- on each poll cycle, so no other coroutine is starved while we wait.

-- Yields until `sock` is readable or `deadline` passes.
-- Returns true when ready, or nil + 'timed out' on deadline.
local function waitReadable(sockmod, sock, deadline)
    while sockmod.gettime() < deadline do
        local r = sockmod.select({ sock }, nil, 0)
        if r and r[1] then return true end
        Timer.Wait(0)
    end
    return nil, 'timed out'
end

-- Yields until `sock` is writable or `deadline` passes.
-- Returns true when ready, or nil + 'timed out' on deadline.
local function waitWritable(sockmod, sock, deadline)
    while sockmod.gettime() < deadline do
        local _, w = sockmod.select(nil, { sock }, 0)
        if w and w[1] then return true end
        Timer.Wait(0)
    end
    return nil, 'timed out'
end

-- Non-blocking send + receive over an already-connected `conn`.
-- `sockmod`  — the socket module (required inside the thread).
-- `deadline` — sockmod.gettime() epoch value for the overall timeout.
-- Calls callback(err, status, body) exactly once.
local function sendAndReceive(conn, request, sockmod, deadline, callback)
    -- conn:send(data, i) tries to send from byte i to end.
    -- On full success it returns the index of the last byte sent (= #data).
    -- On a partial non-blocking send it returns nil, 'timeout', lastByteIndex.
    -- We advance sentBytes past whatever was accepted and retry after the
    -- socket becomes writable again.

    local sentBytes = 0
    local reqLen    = #request

    while sentBytes < reqLen do
        local n, sendErr, partial = conn:send(request, sentBytes + 1)
        if n then
            -- All remaining bytes were accepted in this call.
            sentBytes = n
        elseif sendErr == 'timeout' then
            -- Partial send (or nothing yet); advance past whatever was sent.
            sentBytes = partial or sentBytes
            local ready = waitWritable(sockmod, conn, deadline)
            if not ready then
                conn:close()
                callback('send timed out', 0, nil)
                return
            end
        else
            conn:close()
            callback('send failed: ' .. tostring(sendErr), 0, nil)
            return
        end
    end

    -- We poll for readability before every receive call so the coroutine
    -- yields between chunks rather than blocking the VM.
    -- 'closed'              → clean end-of-stream, stop collecting.
    -- 'timeout'/'wantread'  → non-blocking "not ready yet", wait and retry.
    -- anything else         → real transport error, abort.
    -- LuaSec often delivers the last TLS record as (nil, 'closed', partial),
    -- so we always flush `partial` into chunks before acting on the error.

    local chunks = {}

    while true do
        -- Wait until the socket has data available (or deadline expires).
        local ready = waitReadable(sockmod, conn, deadline)
        if not ready then
            -- Treat deadline expiry as end-of-stream; parse whatever we have.
            break
        end

        local chunk, recvErr, partial = conn:receive(4096)

        if chunk then
            table.insert(chunks, chunk)
        elseif partial and #partial > 0 then
            table.insert(chunks, partial)
        end

        if recvErr == 'closed' then
            -- Orderly shutdown — response is complete.
            break
        elseif recvErr == 'timeout' or recvErr == 'wantread' then
            -- select() said readable but receive wasn't ready (EAGAIN / TLS
            -- record not yet complete). Yield and loop back to select again.
            Timer.Wait(0)
        elseif recvErr then
            conn:close()
            callback('receive failed: ' .. tostring(recvErr), 0, nil)
            return
        elseif not chunk and not partial then
            -- nil error with no data: clean EOF from the far end.
            break
        end
    end

    conn:close()

    local status, body = parseResponse(table.concat(chunks))
    callback(nil, status, body)
end

function Http.fetch(opts, callback)
    assert(type(opts) == 'table', '[tLib/http] fetch: opts must be a table')
    assert(type(callback) == 'function', '[tLib/http] fetch: callback must be a function')
    assert(type(opts.url) == 'string', '[tLib/http] fetch: opts.url must be a string')

    local method                             = (opts.method and opts.method:upper()) or 'GET'
    local body                               = opts.body or ''
    local timeout                            = opts.timeout or 10
    local headers                            = opts.headers or {}
    local verify                             = opts.verify or false

    local scheme, host, port, path, parseErr = parseUrl(opts.url)
    if parseErr then
        callback(parseErr, 0, nil)
        return
    end

    -- Reject https:// early if LuaSec is not available.
    if scheme == 'https' and not ssl then
        callback(
            'https:// is not supported — LuaSec (ssl) could not be loaded: ' .. tostring(sslErr),
            0, nil
        )
        return
    end

    Timer.CreateThread(function()
        local sockmod = require('socket')
        local deadline = sockmod.gettime() + timeout

        local tcp = sockmod.tcp()
        tcp:settimeout(0)

        local ok, connErr = tcp:connect(host, port)

        if not ok and connErr ~= 'timeout' then
            -- Immediate hard failure (e.g. ECONNREFUSED on loopback).
            tcp:close()
            callback('connection failed: ' .. tostring(connErr), 0, nil)
            return
        end

        if not ok then
            -- connErr == 'timeout': async connect in progress.
            -- The socket becomes writable once the OS three-way handshake
            -- completes (or fails). Any actual connect error will surface as
            -- a send/receive error in the next step.
            local ready = waitWritable(sockmod, tcp, deadline)
            if not ready then
                tcp:close()
                callback('connection failed: timed out', 0, nil)
                return
            end
        end

        local conn

        if scheme == 'https' then
            local tlsParams = {
                mode     = 'client',
                protocol = 'any',
                verify   = verify and 'peer' or 'none',
                options  = { 'all', 'no_sslv2', 'no_sslv3' },
            }

            local tlsConn, wrapErr = ssl.wrap(tcp, tlsParams)
            if not tlsConn then
                tcp:close()
                callback('TLS wrap failed: ' .. tostring(wrapErr), 0, nil)
                return
            end

            tlsConn:settimeout(0)

            -- dohandshake() with settimeout(0) returns nil+'wantread' or
            -- nil+'wantwrite' when the handshake needs more I/O. We yield
            -- via the appropriate select direction until it completes.
            while true do
                local hsOk, hsErr = tlsConn:dohandshake()
                if hsOk then
                    break
                elseif hsErr == 'wantread' then
                    local ready = waitReadable(sockmod, tlsConn, deadline)
                    if not ready then
                        tlsConn:close()
                        callback('TLS handshake timed out', 0, nil)
                        return
                    end
                elseif hsErr == 'wantwrite' then
                    local ready = waitWritable(sockmod, tlsConn, deadline)
                    if not ready then
                        tlsConn:close()
                        callback('TLS handshake timed out', 0, nil)
                        return
                    end
                else
                    tlsConn:close()
                    callback('TLS handshake failed: ' .. tostring(hsErr), 0, nil)
                    return
                end
            end

            conn = tlsConn
        else
            conn = tcp
        end

        local request = buildRequest(method, host, path, headers, body)
        sendAndReceive(conn, request, sockmod, deadline, callback)
    end)
end
