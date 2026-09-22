-- The presentation pipeline.
--
-- A snapshot says what a player is allowed to do; it cannot say what they can do
-- right now -- the mod slots of the car they are sitting in, the tints a weapon
-- supports, whether anyone is close enough to target. That is local, changes
-- second to second, and belongs to whichever resource owns the rows.
--
-- So this file is pipeline only. It decides which pages to build, hands them to
-- the registered presenters, gives them the two operations they all need (narrow
-- a list, disable a row with a reason) plus a cache that empties itself when the
-- world moves, and assembles each page's contextKey from what they contribute.
--
-- The narrowed copy must never be fed back into permission or effect
-- reconciliation: those run against the raw snapshot, and a row disabled here
-- because the player got out of the car is not a revoked grant.

if _TLIB_SIDE ~= 'client' then return end

MenuContext = {}
local C = MenuContext
local S = MenuSchema

local presenters = {}

--
-- Presenters ask the game the same questions repeatedly within a pass and again
-- on the next 750ms poll, and the answers hold for as long as the player is in
-- the same body, car and weapon. So the cache is keyed on that identity and
-- thrown away wholesale when it changes -- entry-by-entry invalidation makes a
-- stale answer unlikely, this makes it impossible.
local cache, cacheKey, cacheSize = {}, nil, 0

function C.invalidate()
    cache, cacheKey, cacheSize = {}, nil, 0
    for _, presenter in ipairs(presenters) do
        if presenter.invalidate then pcall(presenter.invalidate) end
    end
end

--- Memoize one question about the current world. The 512 cap is a ceiling, not a
--- policy -- a page asking about a thousand drawables would otherwise grow the
--- table without bound across a session.
function C.cached(key, fn)
    if cache[key] == nil then
        local result = fn() -- an exception never reaches the cache
        if cacheSize >= 512 then cache, cacheSize = {}, 0 end
        cache[key], cacheSize = result, cacheSize + 1
    end
    return cache[key]
end


--- Take a row out of play and say why -- a greyed row with no explanation reads
--- as a bug.
function C.disable(row, reason)
    row.disabled, row.description = true, reason
end

--- Keep only the options a predicate accepts.
function C.narrow(row, predicate, reason)
    local options = setmetatable({}, { __jsontype = 'array' })
    local selected = false
    for _, option in ipairs(row.options or {}) do
        if predicate(option.value) then
            options[#options + 1] = option
            if option.value == row.value then selected = true end
        end
    end
    row.options = options
    -- With no supported committed value the UI must ask for a choice rather than
    -- imply that a presentation fallback changed action-owned editor state.
    if not selected then row.value = nil end
    if #options == 0 then C.disable(row, reason) end
end

local function equal(a, b)
    if type(a) ~= type(b) then return false end
    if type(a) ~= 'table' then return a == b end
    for k, v in pairs(a) do if not equal(v, b[k]) then return false end end
    for k in pairs(b) do if a[k] == nil then return false end end
    return true
end
C.equal = equal


--- Register one resource's presentation logic. Every field is optional -- a
--- resource that only wants its own stored state on its rows registers nothing,
--- because MenuActions already does that.
---
---   expand(id, want)   page `id` was asked for; call want(other) for any page
---                      whose content moves when this one is built.
---   identity()         a string naming the part of the world this presenter's
---                      answers depend on. Concatenated with the others to key the
---                      shared cache, so a constant never causes a wipe and the
---                      current vehicle causes exactly the wipes it should.
---   present(value, authority)
---                      narrow, disable and relabel, then RETURN `value`. A
---                      presenter in another resource is called across an export
---                      boundary where arguments are copied, so mutating in place
---                      narrows a table nobody keeps. `authority` is scoped to
---                      this pass -- see C.present -- so reach for its `page(id)`
---                      rather than assuming an unasked-for page is in its menus.
---   contextKey(menu)   a string or nil. The browser echoes it back with every
---                      action, which is what lets the client refuse one aimed at
---                      a car the player has since climbed out of.
---   invalidate()       drop this presenter's own caches.
function C.register(owner, presenter)
    if type(owner) ~= 'string' or owner == '' then return false, 'A presenter needs an owner' end
    if type(presenter) ~= 'table' then return false, 'A presenter must be a table' end
    for _, field in ipairs({ 'expand', 'identity', 'present', 'contextKey', 'invalidate' }) do
        if presenter[field] ~= nil and not S.callable(presenter[field]) then
            return false, 'presenter.' .. field .. ' must be a function'
        end
    end
    for index, existing in ipairs(presenters) do
        if existing.owner == owner then
            presenters[index] = { owner = owner, expand = presenter.expand, identity = presenter.identity,
                present = presenter.present, contextKey = presenter.contextKey, invalidate = presenter.invalidate }
            C.invalidate()
            return true
        end
    end
    presenters[#presenters + 1] = { owner = owner, expand = presenter.expand, identity = presenter.identity,
        present = presenter.present, contextKey = presenter.contextKey, invalidate = presenter.invalidate }
    C.invalidate()
    return true
end

function C.unregister(owner)
    for index, existing in ipairs(presenters) do
        if existing.owner == owner then
            table.remove(presenters, index)
            C.invalidate()
            return true
        end
    end
    return false
end

function C.count() return #presenters end

-- A presenter that throws costs its own narrowing for the pass and nothing else:
-- the rows arrive as the server described them, which is permission-correct.
-- Reported once per pass rather than once per row.
local function guard(stage, owner, fn, ...)
    local ok, result = pcall(fn, ...)
    if ok then return result end
    print(('[tLib/menu] %s presenter %s failed: %s'):format(owner, stage, tostring(result)))
    return nil
end

--- Build the presentable form of `requested`, or of every page when it is nil.
--- `raw` is the hydrated, permission-filtered snapshot.
function C.present(raw, requested)
    local wanted
    if requested then
        wanted = {}
        local function want(id) if type(id) == 'string' then wanted[id] = true end end
        for _, id in ipairs(requested) do want(id) end
        -- Over a copy of the keys, not `wanted` itself -- adding to a table while
        -- walking it is undefined, and adding pages is what expansion does.
        local queue = {}
        for id in pairs(wanted) do queue[#queue + 1] = id end
        for _, id in ipairs(queue) do
            for _, presenter in ipairs(presenters) do
                if presenter.expand then guard('expand', presenter.owner, presenter.expand, id, want) end
            end
        end
    end

    local value = { version = raw.version, visible = raw.visible, capabilities = raw.capabilities, menus = {} }
    for _, menu in ipairs(raw.menus) do
        if not wanted or wanted[menu.id] then value.menus[#value.menus + 1] = S.copy(menu) end
    end

    -- `authority`, the second argument to present(), is scoped to this pass on
    -- purpose, and it is the most expensive decision in the menu. A cross-resource
    -- presenter is called over an export boundary that serializes every argument,
    -- so passing the whole hydrated snapshot msgpacked the entire catalog once per
    -- presenter per pass -- twice per navigation and again every 750ms refresh.
    --
    -- Measured against tMenu's catalog (215 pages, ~51,000 option labels, 3.4 MB
    -- encoded), timed with GetNetworkTimeAccurate because GetGameTimer does not
    -- advance within a frame and reports 0ms for all of it:
    --   present() with the whole snapshot as `raw`   43-99ms
    --   the same call with `raw` emptied              0-1ms
    -- Every other stage of a pass measured 0-1ms. The payload was the whole cost.
    --
    -- A presenter therefore gets the pages this pass is building, plus `ids` (every
    -- authorized page id, for "does this page exist for this player") and
    -- `page(id)` (one authorized page on demand, for a page that summarises
    -- another). Both are read-only; `expand` is still how to rebuild a page.
    --
    -- When the caller asked for everything, `menus` is the whole tree -- there is
    -- nothing to scope.
    local authority = { version = raw.version, visible = raw.visible, capabilities = raw.capabilities,
        menus = {}, ids = setmetatable({}, { __jsontype = 'array' }) }
    local rawById = {}
    for _, menu in ipairs(raw.menus) do
        rawById[menu.id] = menu
        authority.ids[#authority.ids + 1] = menu.id
        if not wanted or wanted[menu.id] then authority.menus[#authority.menus + 1] = menu end
    end
    setmetatable(authority.menus, { __jsontype = 'array' })
    function authority.page(id) return rawById[id] end

    -- Settled before any presenter runs, so the first question of a pass is
    -- already asked against the current world.
    local parts = {}
    for _, presenter in ipairs(presenters) do
        if presenter.identity then
            parts[#parts + 1] = presenter.owner .. '=' .. tostring(guard('identity', presenter.owner, presenter.identity))
        end
    end
    local key = table.concat(parts, '|')
    if key ~= cacheKey then
        cache, cacheKey, cacheSize = {}, key, 0
        -- A presenter in another VM cannot see this wipe, so it has to be told.
        for _, presenter in ipairs(presenters) do
            if presenter.invalidate then guard('invalidate', presenter.owner, presenter.invalidate) end
        end
    end

    -- Locally held state first -- an effect the player turned on has to be on the
    -- row before anybody narrows around it.
    for _, dispatcher in pairs(MenuActions.dispatchers()) do dispatcher:decorate(value) end
    for _, presenter in ipairs(presenters) do
        if presenter.present then
            local result = guard('present', presenter.owner, presenter.present, value, authority)
            -- Only a well-formed answer replaces the projection, so a presenter
            -- that returns nothing leaves the next one a whole snapshot.
            if type(result) == 'table' and type(result.menus) == 'table' then value = result end
        end
    end

    -- CitizenFX's encoder honours __jsontype, and an emptied option list has to
    -- reach the browser as [] rather than {}.
    for _, menu in ipairs(value.menus) do
        setmetatable(menu.items, { __jsontype = 'array' })
        for _, row in ipairs(menu.items) do
            if row.options then setmetatable(row.options, { __jsontype = 'array' }) end
        end
    end
    setmetatable(value.menus, { __jsontype = 'array' })

    for _, menu in ipairs(value.menus) do
        local identities = {}
        for _, presenter in ipairs(presenters) do
            if presenter.contextKey then
                local part = guard('contextKey', presenter.owner, presenter.contextKey, menu)
                if type(part) == 'string' and part ~= '' then identities[#identities + 1] = part end
            end
        end
        if #identities > 0 then
            -- Whatever present() wrote leads, so a page keyed on its own editor
            -- state keeps that and gains the world's on top.
            if menu.contextKey then table.insert(identities, 1, menu.contextKey) end
            local assembled = table.concat(identities, '|')
            -- The client validates the echoed key at 256 characters, so several
            -- presenters' contributions have to be bounded here. Digested rather
            -- than truncated: two different worlds sharing a prefix would compare
            -- equal, which is the one thing a context key must never do.
            menu.contextKey = #assembled <= 192 and assembled or MenuCatalog.fingerprint(identities)
        end
    end
    return value
end

return MenuContext
