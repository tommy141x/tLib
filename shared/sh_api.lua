-- Where the TIMMYG Studios API lives, defined once for every Lua VM.
--
-- `tmarketplace_base_url` is a SINGLE switch: point it at a local dev worker and
-- every call this codebase makes to the studio -- marketplace browse, preview,
-- install downloads, community configs, AND the product version check and its
-- changelog -- follows it. It got that name from the marketplace API.md contract
-- and is read outside this repo, so the name stays even though its reach is now
-- the whole `timmygstudios.com` API surface (`/api/v1`, `/api/v2`, `/api/products`).
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

--- The convar that redirects every studio API call. Named for the marketplace
--- API contract; do not rename (docs/content/convars.mdx, "Naming").
StudioApi.CONVAR = 'tmarketplace_base_url'

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

return StudioApi
