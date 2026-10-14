-- Where the TIMMYG Studios API lives, defined once for every Lua VM.
--
-- `tlib_api_base_url` is a SINGLE switch: point it at a local dev worker and
-- every call this codebase makes to the studio -- marketplace browse, preview,
-- install downloads, community configs, AND the product version check and its
-- changelog -- follows it. Its reach is the whole `timmygstudios.com` API
-- surface (`/api/v1`, `/api/v2`, `/api/products`).
--
-- Before this file the default host was written out separately in
-- client/cl_marketplace.lua, server/sv_marketplace.lua and
-- shared/imports/versioncheck/server.lua (which did not read the convar at all).
-- Four copies of a value that must agree is a drift bug waiting to happen; the
-- TypeScript side has the same single definition in
-- shared/ts/marketplace/catalogue.ts, and tests/unit/marketplace-base-url.test.ts
-- asserts the two literals are equal because no single source can span both.
--
-- Free of every tLib global -- no Platform, no Logger, no Config -- so it can be
-- loaded standalone into a CONSUMER resource's Lua VM through LoadResourceFile,
-- exactly the way shared/imports/versioncheck/server.lua loads
-- shared/sh_branding.lua. Keep it dependency-free, and keep it listed in BOTH
-- `shared_scripts` and `files` in fxmanifest.lua, or one side silently ends up
-- with no rule at all.
--
-- Not a security boundary: the base URL is operator-controlled by design.

StudioApi = StudioApi or {}

--- The convar that redirects every studio API call.
StudioApi.CONVAR = 'tlib_api_base_url'

--- Production. Must stay byte-identical to `MARKETPLACE_DEFAULT_BASE_URL` in
--- shared/ts/marketplace/catalogue.ts.
StudioApi.DEFAULT_BASE_URL = 'https://timmygstudios.com'

-- Suffixes callers append themselves. Someone pointing the convar at
-- `http://localhost:8787/api/v1` is describing the same host as
-- `http://localhost:8787`, and taking them literally would build
-- `.../api/v1/api/v1/items` -- a 404 that looks like the dev server is broken.
-- Longest first: a plain sub() test is not anchored ordering.
local APPENDED = { '/api/v2/marketplace', '/api/v2', '/api/v1', '/api' }

local warned = false

--- Normalise a raw convar value into a base URL with no trailing slash and no
--- API path. Pure: takes the raw string, never reads a convar. Mirrored exactly
--- by `normalizeStudioBaseUrl` in shared/ts/marketplace/catalogue.ts.
---@param raw string|nil
---@return string
function StudioApi.normalize(raw)
    local url = type(raw) == 'string' and raw:match('^%s*(.-)%s*$') or ''
    if url == '' then return StudioApi.DEFAULT_BASE_URL end
    url = url:gsub('/+$', '')
    for _, suffix in ipairs(APPENDED) do
        if #url > #suffix and url:sub(-#suffix) == suffix then
            url = url:sub(1, -#suffix - 1)
            if not warned then
                warned = true
                print(('^3[tLib] %s ends in "%s"; callers append that themselves, so it was trimmed to "%s".^0')
                    :format(StudioApi.CONVAR, suffix, url))
            end
            break
        end
    end
    url = url:gsub('/+$', '')
    if url == '' then return StudioApi.DEFAULT_BASE_URL end
    return url
end

--- The resolved base URL, read from the convar on EVERY call.
---
--- Deliberately not memoised. The whole point of the convar is iterating against
--- a local dev server, and a cached value means a mid-session change silently
--- does nothing until the resource restarts. tRadio's client bridge already
--- re-read per call; tLib's `resolveConfig()` used to cache and no longer does,
--- so both sides now agree.
---@return string
function StudioApi.baseUrl()
    if type(GetConvar) ~= 'function' then return StudioApi.DEFAULT_BASE_URL end
    local ok, raw = pcall(GetConvar, StudioApi.CONVAR, StudioApi.DEFAULT_BASE_URL)
    return StudioApi.normalize(ok and raw or nil)
end

-- The per-install id
--
-- THE LUA HALF OF `x-install-id`, AND THE ONLY ONE. Every studio call built
-- in Lua -- which today is the product version check in
-- shared/imports/versioncheck/server.lua -- goes through `StudioApi.headers()`
-- so a second caller cannot assemble its own header set and forget the id. The
-- TypeScript half is `studioHeaders()` in shared/ts/marketplace/catalogue.ts;
-- the two are separate because no single source can span both languages, which
-- is the same reason this file's base URL is asserted byte-equal to the TS copy
-- by tests/unit/marketplace-base-url.test.ts.
--
-- READ-ONLY, AND IT DOES NOT MINT. The id is minted by whichever request
-- needs it first, in tLib's Node bundle (server/lib/install-id.ts), which is
-- the one writer of tLib's data.json. A Lua minter would be a second writer of
-- the same document and could race the first into two different ids. The cost
-- is that on a brand-new install the FIRST version check may carry no id; the
-- next one does. An absent header is a state tWeb handles, two ids for one
-- install is not.
--
-- `LoadResourceFile` rather than an export on tLib, deliberately: it is a plain
-- cross-resource READ that needs nothing started, and it keeps the id off a
-- FiveM export where every third-party script on the operator's server could
-- ask for it.

--- Lower-case; matched case-insensitively at tWeb. Must equal
--- `INSTALL_ID_HEADER` in shared/ts/install-id.ts.
StudioApi.INSTALL_ID_HEADER = 'x-install-id'

--- Where tLib keeps it. Must equal `INSTALL_ID_DATA_FILE` / `INSTALL_ID_KEY`.
StudioApi.INSTALL_ID_RESOURCE = 'tLib'
StudioApi.INSTALL_ID_FILE = 'data.json'
StudioApi.INSTALL_ID_KEY = 'installId'

local cachedInstallId = nil

--- The id, or '' when there is not one yet or this VM cannot read it.
---
--- Memoised only on success: a '' answer is re-asked, because the usual reason
--- for one is that nothing has minted the id YET rather than that there will
--- never be one.
---@return string
function StudioApi.installId()
    if cachedInstallId then return cachedInstallId end
    if type(LoadResourceFile) ~= 'function' or type(json) ~= 'table' then return '' end

    local ok, raw = pcall(LoadResourceFile, StudioApi.INSTALL_ID_RESOURCE, StudioApi.INSTALL_ID_FILE)
    if not ok or type(raw) ~= 'string' or raw == '' then return '' end

    local decoded, doc = pcall(json.decode, raw)
    if not decoded or type(doc) ~= 'table' then return '' end

    local value = doc[StudioApi.INSTALL_ID_KEY]
    -- The same strictness as `isInstallId` on the TypeScript side: a truncated
    -- or hand-edited value would fail tWeb's /^[0-9a-z]{25}$/ and turn an
    -- ordinary request into a 400.
    if type(value) ~= 'string' or #value ~= 25 or value:find('[^0-9a-z]') then return '' end

    cachedInstallId = value
    return value
end

--- Headers for a studio API call, with `extra` merged over them.
---
--- The id is OMITTED rather than sent empty. An empty value fails tWeb's
--- pattern, and a 400 on an update check reads as "the studio is down".
---@param extra table|nil
---@return table
function StudioApi.headers(extra)
    local headers = {}
    local id = StudioApi.installId()
    if id ~= '' then headers[StudioApi.INSTALL_ID_HEADER] = id end
    for k, v in pairs(extra or {}) do headers[k] = v end
    return headers
end

return StudioApi
