-- The menu engine's host layer: the one file in the engine that talks to the
-- outside world. It owns the registry instance, the request event, action
-- dispatch, the framework-authority veto and the public exports.
--
-- Everything goes through Platform rather than raw natives. registry.lua is pure
-- so that host differences can only ever appear here.

if _TLIB_SIDE ~= 'server' then return end

local log = Logger.create('tLib/menu')
local S = MenuSchema

MenuEngine = {}
local E = MenuEngine

-- Defaults, not constants: how long an action may take is a property of what it
-- does, which the engine cannot know.
E.config = {
    requestTimeoutMs = 10000,
    -- Sized against what the UI legitimately produces, not against a guess.
    --
    -- A select or slider row with apply = 'change' sends one request per value
    -- step, and stepping is a held arrow key. MEASURED on a live server: a
    -- serialized request round trip is ~26ms, so the real pipeline sustains ~39
    -- requests/second. At the old burst = 6 / refill = 2 that exhausted the whole
    -- budget in 174ms of holding one key, and every further step of an ordinary
    -- colour or ped-model row came back 'Rate limit exceeded'. A limiter a normal
    -- user trips by scrolling a list is not protecting anything; it is just a bug
    -- with a reassuring name.
    --
    -- The ceiling is now above what a held key can produce, because the client
    -- coalesces those steps (client/web/src/menu/Menu.tsx) and so a legitimate
    -- session stays far below this. Flooding still gets cut off, which is the only
    -- thing this was ever for.
    rateLimit = { burst = 30, refillPerSecond = 15 },
    maxAuthorities = 8,
    maxPermissionQuery = 64,
}

local registry = MenuRegistry.new({
    hasPermission = function(source, key) return Platform.hasPermission(source, key) end,
    now = function() return Platform.now() end,
    log = function(message) log(message, 3) end,
    -- Count limits only. `owner` is a name the registry established itself, so
    -- this reads that resource's own manifest rather than a claim it made about
    -- itself -- the same rule the startup banner uses (shared/sh_branding.lua).
    -- A type check rather than an assert: a host that cannot answer should fall
    -- through to "not exempt" rather than hard-error over a courtesy limit.
    trusted = function(owner)
        return type(Platform.isStudioResource) == 'function' and Platform.isStudioResource(owner)
    end,
})
E.registry = registry

local cooldowns = {}


local function sendSnapshot(source, requestId)
    local value = registry:snapshot(source)
    local event = requestId and S.events.response or S.events.refresh
    if requestId then value = { ok = true, snapshot = value } end
    local ok, err = S.snapshotTransport.send(event, source, requestId, value, Platform.TriggerClientEvent)
    if not ok then
        log(err, 4)
        if requestId then
            Platform.TriggerClientEvent(S.events.response, source, requestId, { ok = false, error = err })
        end
    end
end

--- Re-push every connected player's tree.
---
--- A snapshot is permission-filtered at build time, so it is a photograph of the
--- player's ACEs. `add_ace`/`remove_ace` raise no event, so nothing calls this
--- automatically when a grant changes -- which is why the console command below
--- exists. Revocation is the case that matters: the row stays on screen and only
--- the dispatch-time check stops it doing anything.
function E.refresh()
    local count = 0
    for source in registry:eachPlayer() do
        sendSnapshot(source)
        count = count + 1
    end
    return count
end

--
-- A framework bridge registers a check over one or more authority domains and
-- gets a veto, nothing else:
--
--   * The return value is read as a boolean refusal plus an optional reason.
--     There is no way to return a handler, value, patch or redirect.
--   * It runs after every other gate and before the action, so it can only
--     subtract. A buggy or compromised bridge cannot grant anything.
--   * It only ever sees rows their own owner tagged with a domain.
--   * It cannot wedge dispatch: the check runs under pcall, an error is an
--     abstain, and one that blocks past the request timeout is unregistered.
--   * With nothing registered the feature is one `#authorities == 0` test.

local authorities = {}

function E.registerAuthority(owner, spec)
    if not owner then return false, 'Resource invocation required' end
    if type(spec) ~= 'table' or not S.callable(spec.check) then
        return false, 'An authority requires a check function'
    end
    if type(spec.domains) ~= 'table' then return false, 'An authority must name the domains it owns' end
    -- Checked by count as well as by key: '#' on a table with a hole may answer
    -- either side of it, so `{ [2] = 'health' }` can length 2 while ipairs walks
    -- nothing, registering an authority that owns no domain at all.
    local count = 0
    for key in pairs(spec.domains) do
        count = count + 1
        if type(key) ~= 'number' or key % 1 ~= 0 or key < 1 or key > #spec.domains then
            return false, 'Domains must be an array'
        end
    end
    if count ~= #spec.domains then return false, 'Domains must be an array' end
    if #spec.domains == 0 or #spec.domains > 8 then
        return false, 'An authority must name between 1 and 8 domains'
    end
    local domains = {}
    for _, name in ipairs(spec.domains) do
        if not registry:isDomain(name) then return false, 'Unknown authority domain: ' .. tostring(name) end
        domains[name] = true
    end
    -- One per resource, or a bridge re-registering on a config reload stacks
    -- checks and its older closure keeps vetoing.
    for _, existing in ipairs(authorities) do
        if existing.owner == owner then
            return false, 'Authority already registered; the previous one is still active'
        end
    end
    if #authorities >= E.config.maxAuthorities then
        return false, ('Maximum %d authorities'):format(E.config.maxAuthorities)
    end
    authorities[#authorities + 1] = { owner = owner, domains = domains, check = spec.check }
    return true
end

function E.unregisterAuthority(owner)
    if not owner then return false, 'Resource invocation required' end
    for index, existing in ipairs(authorities) do
        if existing.owner == owner then
            table.remove(authorities, index)
            return true
        end
    end
    return false, 'No authority registered for this resource'
end

-- Returns a refusal reason, or nil to allow.
local function refused(source, action, menuId, itemId, value, active)
    local domain = action.domain
    if not domain then return nil end
    local index = 1
    while index <= #authorities do
        local authority = authorities[index]
        local dropped = false
        if authority.domains[domain] then
            local started = Platform.now()
            local ok, allow, reason = pcall(authority.check, source, menuId, itemId, value, domain, { isActive = active })
            local elapsed = Platform.now() - started
            if elapsed >= E.config.requestTimeoutMs then
                table.remove(authorities, index)
                dropped = true
                log(('authority %s took %dms on %s and was unregistered'):format(authority.owner, elapsed, itemId), 4)
            elseif not ok then
                -- Abstain, not deny: failing open is identical to having no
                -- authority, which is the standalone default.
                log(('authority %s errored on %s: %s'):format(authority.owner, itemId, tostring(allow)), 4)
            elseif allow == false then
                return S.text(reason, 256) and reason or 'Not permitted here'
            end
        end
        if not dropped then index = index + 1 end
    end
    return nil
end


Platform.AddNetEventHandler(S.events.request, function(requestId, body)
    local src = source
    if not S.text(requestId, 96) or type(body) ~= 'table' then return end
    local state = registry:playerState(src)
    local function immediate(message)
        Platform.TriggerClientEvent(S.events.response, src, requestId, { ok = false, error = message })
    end
    if not S.consume(state.bucket, Platform.now(), E.config.rateLimit.burst, E.config.rateLimit.refillPerSecond) then
        immediate('Rate limit exceeded'); return
    end
    if state.pending then immediate('An action is already running'); return end

    if body.kind == 'permissions' then
        if type(body.actions) ~= 'table' or #body.actions > E.config.maxPermissionQuery then
            immediate('Invalid permission request'); return
        end
        for index, name in pairs(body.actions) do
            if type(index) ~= 'number' or index % 1 ~= 0 or index < 1 or index > #body.actions or not S.id(name) then
                immediate('Invalid permission request'); return
            end
        end
        Platform.TriggerClientEvent(S.events.response, src, requestId,
            { ok = true, allowed = registry:grantsFor(src, body.actions) })
        return
    end

    -- The shared "Send feedback" dialog, which tLib's own menu injects into
    -- every owner's root page. It is here rather than behind a net event of its
    -- own because this channel already carries the correlation id, the rate
    -- limiter, the timeout and the drop sweep -- and because the dialog is only
    -- reachable from the menu.
    --
    -- NOT an `action`, deliberately: an action is a row a resource registered
    -- with an ACE and a handler, and this row belongs to no resource. Routing it
    -- through `resolveAction` would mean every consumer having to register an
    -- item they did not write, which is exactly the per-resource wiring the
    -- injection exists to avoid.
    --
    -- And NOT permission-gated. Feedback is about the software, not about the
    -- server, so an ACE would let an operator switch off the only channel a
    -- player has for telling US something -- while leaving the impression it
    -- still worked.
    if body.kind == 'feedback' then
        if not MenuFeedback then immediate('Feedback is unavailable'); return end
        MenuFeedback.submit(src, body, function(result)
            Platform.TriggerClientEvent(S.events.response, src, requestId, result)
        end)
        return
    end

    if body.kind == 'snapshot' then
        -- Before the build, so an owner's per-player overrides travel inside the
        -- snapshot rather than arriving as a second event to reconcile.
        registry:runSnapshotHooks(src)
        sendSnapshot(src, requestId); return
    end

    if body.kind ~= 'action' then immediate('Invalid request'); return end

    local entry, item, action = registry:resolveAction(src, body.menuId, body.itemId, body.value)
    if not entry then immediate(item); return end

    -- Ahead of the client-dispatch branch on purpose: vehicle spawns and ped
    -- models dispatch to the client, and those are exactly the rows a garage or a
    -- character store contests.
    if #authorities > 0 then
        local deny = refused(src, action, body.menuId, body.itemId, body.value, function()
            return registry.players[src] == state and registry.entries[body.menuId] == entry
                and registry:allowed(src, entry) and Platform.hasPermission(src, action.ace)
        end)
        if deny then immediate(deny); return end
    end

    -- Also ahead of the client branch: `register` accepts a cooldown on every
    -- action, so honouring it only for server-`run` rows would silently ignore the
    -- field for the rest.
    --
    -- Stamped on ADMISSION rather than on success, because the stamp is also what
    -- stops a second press racing the first while a handler is still in flight.
    --
    -- But an attempt the server itself watched FAIL is refunded (`refundCooldown`
    -- below). Charging a full window for a handler that refused and produced
    -- nothing is what makes an ordinary session feel like a punishment -- the
    -- player waits out the window having received nothing, and cannot tell that
    -- from a success they somehow missed. Rapid retries of a cheaply-failing row
    -- are bounded by the request rate limiter above, which is the guard whose job
    -- that is.
    --
    -- The refund is only ever applied to a server-`run` row. A client-dispatched
    -- action reports its outcome to nobody -- the branch below answers `ok = true`
    -- and hands off -- so the server never learns whether it worked, and a
    -- client-reported failure would be forgeable into an unlimited-spawn bypass.
    -- Those rows keep the admission stamp, and the honest lever for them is the
    -- length of the window itself.
    local refundCooldown
    if action.cooldown then
        local key = action.cooldownKey and (entry.owner .. ':group:' .. action.cooldownKey) or item.id
        local now, previous = Platform.now(), cooldowns[src] and cooldowns[src][key]
        if previous and now >= previous and now - previous < action.cooldown then
            immediate('That action is cooling down'); return
        end
        cooldowns[src] = cooldowns[src] or {}
        cooldowns[src][key] = now
        -- Restores the prior stamp rather than clearing the key: that stamp is
        -- expired by definition (admission proved it) but restoring it keeps this
        -- a true undo rather than a widening.
        refundCooldown = function()
            if cooldowns[src] and cooldowns[src][key] == now then cooldowns[src][key] = previous end
        end
    end

    if action.clientAction then
        -- The handler name is scoped to the owner, so a resource can only name a
        -- handler in its own namespace. That is what makes client dispatch safe
        -- to offer to every resource.
        Platform.TriggerClientEvent(S.events.response, src, requestId, {
            ok = true,
            owner = entry.owner,
            clientAction = action.clientAction,
            value = action.fixedValue or body.value,
            capabilities = registry:capabilities(src),
        })
        return
    end

    local token = {}
    state.pending = token
    local function active()
        return registry.players[src] == state and state.pending == token
            and registry.entries[body.menuId] == entry
            and registry:allowed(src, entry) and Platform.hasPermission(src, action.ace)
    end
    local function finish(result)
        if registry.players[src] ~= state or state.pending ~= token then return end
        state.pending = nil
        Platform.TriggerClientEvent(S.events.response, src, requestId, result)
    end
    Platform.setTimeout(function() finish({ ok = false, error = 'Action timed out' }) end,
        E.config.requestTimeoutMs - 500)
    Platform.createThread(function()
        -- Refunded on the three outcomes the server can be sure cost nothing: the
        -- handler never started, it raised before completing, or it completed and
        -- explicitly refused. Deliberately NOT refunded after a successful run
        -- whose patch was malformed, nor on the `active()` check below, nor on the
        -- timeout above -- in each of those the handler may have already had its
        -- side effect, and giving the window back would be giving away a second
        -- one for work that was really done.
        if not active() then
            if refundCooldown then refundCooldown() end
            finish({ ok = false, error = 'Action no longer available' }); return
        end
        -- Handlers are trusted installed code, but isActive still has to be
        -- re-checked after any yield and before any side effect.
        local ok, success, changes = pcall(action.run, src, body.value, { isActive = active })
        if not active() then finish({ ok = false, error = 'Unavailable or permission revoked' }); return end
        if not ok then
            if refundCooldown then refundCooldown() end
            log(('%s action %s failed: %s'):format(entry.owner, item.id, tostring(success)), 4)
            finish({ ok = false, error = 'Action failed' }); return
        end
        if success ~= true then
            if refundCooldown then refundCooldown() end
            finish({ ok = false, error = S.text(changes, 256) and changes or 'Action rejected' }); return
        end
        local patch
        if changes ~= nil then
            patch = S.patch(changes)
            if not patch or (patch.value ~= nil and not S.value(item, patch.value)) then
                finish({ ok = false, error = 'Handler returned an invalid patch' }); return
            end
            registry:recordOverride(src, body.menuId, entry, item.id, patch)
        end
        finish({ ok = true, patch = patch and { menuId = body.menuId, itemId = body.itemId, changes = patch } or nil })
    end)
end)


Platform.onResourceStop(function(stopped)
    local changed = registry:unregisterOwner(stopped)
    E.unregisterAuthority(stopped)
    if changed then E.refresh() end
end)

Platform.onPlayerDropped(function(src)
    registry:dropPlayer(src)
    cooldowns[src] = nil
end)

-- Console only: these report and re-push whatever the ACEs now say.
Platform.registerCommand('tlib_menu_refresh', function()
    local count = 0
    for _ in registry:eachPlayer() do count = count + 1 end
    E.refresh()
    print(('[tLib] Re-sent permission-filtered menus to %d connected player(s).'):format(count))
end, true)

Platform.registerCommand('tlib_menu_permissions', function(_, args)
    local target = tonumber(args[1])
    if not target or target % 1 ~= 0 or target <= 0 then
        print('[tLib] Usage: tlib_menu_permissions <connected player server ID>')
        return
    end
    local snapshot = registry:snapshot(target)
    print(('[tLib] player=%d grants=%d descriptors=%d'):format(target, #snapshot.grants, #snapshot.menus))
    for owner, ns in pairs(registry.namespaces) do
        print(('[tLib]   namespace %s root=%s allowed=%s'):format(
            owner, ns.ace, tostring(Platform.hasPermission(target, ns.ace))))
    end
end, true)

--
-- `owner` comes from the host when it can identify the caller, and from the
-- caller otherwise. Where both exist they must agree -- a mismatch is refused
-- rather than silently corrected, so no resource can claim another's namespace.
local function ownerOf(declared)
    local invoking = Platform.getInvokingResource()
    if invoking then
        if declared ~= nil and declared ~= invoking then return nil, 'Declared owner does not match the calling resource' end
        return invoking
    end
    if type(declared) == 'string' and declared ~= '' then return declared end
    return nil, 'This platform cannot identify the caller; pass the owning resource name explicitly'
end

local function api(name, fn)
    Platform.export('tLib', name, fn)
end

--- Declare a resource's corner of the menu.
api('DefineMenuNamespace', function(spec, declaredOwner)
    local owner, err = ownerOf(declaredOwner or (type(spec) == 'table' and spec.owner))
    if not owner then return false, err end
    return registry:defineNamespace(owner, spec)
end)

api('RegisterMenuDomains', function(domains, declaredOwner)
    local owner, err = ownerOf(declaredOwner)
    if not owner then return false, err end
    return registry:registerDomains(owner, domains)
end)

api('RegisterMenu', function(menu, definition, declaredOwner)
    local owner, err = ownerOf(declaredOwner)
    if not owner then return false, err end
    local ok, message = registry:register(owner, menu, definition)
    if ok then E.refresh() end
    return ok, message
end)

api('UnregisterMenu', function(menuId, declaredOwner)
    local owner, err = ownerOf(declaredOwner)
    if not owner then return false, err end
    local ok, message = registry:unregister(owner, menuId)
    if ok then E.refresh() end
    return ok, message
end)

--- Re-theme a namespace. nil clears it and its pages fall back to the default.
api('SetMenuNamespaceTheme', function(theme, declaredOwner)
    local owner, err = ownerOf(declaredOwner)
    if not owner then return false, err end
    local ok, message = registry:setNamespaceTheme(owner, theme)
    if ok then E.refresh() end
    return ok, message
end)

--- Re-theme one page over its namespace's theme. nil clears the override, not
--- the namespace theme underneath it.
api('SetMenuTheme', function(menuId, theme, declaredOwner)
    local owner, err = ownerOf(declaredOwner)
    if not owner then return false, err end
    local ok, message = registry:setMenuTheme(owner, menuId, theme)
    if ok then E.refresh() end
    return ok, message
end)

-- Shared by both patch entry points. Going through the export instead would mean
-- tLib calling its own export, which reports no invoking resource.
local function patch(owner, menuId, itemId, changes)
    local ok, message, targets, clean = registry:patchItem(owner, menuId, itemId, changes)
    if not ok then return false, message end
    for _, src in ipairs(targets) do
        Platform.TriggerClientEvent(S.events.patch, src, { menuId = menuId, itemId = itemId, changes = clean })
    end
    return true
end

api('PatchMenuItem', function(menuId, itemId, changes, declaredOwner)
    local owner, err = ownerOf(declaredOwner)
    if not owner then return false, err end
    return patch(owner, menuId, itemId, changes)
end)

--- Patch a row by item ID, without having to know which page it lives on.
api('PatchMenuAction', function(itemId, changes, declaredOwner)
    local owner, err = ownerOf(declaredOwner)
    if not owner then return false, err end
    local menuId = registry:findItem(owner, itemId)
    if not menuId then return false, 'Unknown action' end
    return patch(owner, menuId, itemId, changes)
end)

api('SetMenuLinks', function(menuId, links, declaredOwner)
    local owner, err = ownerOf(declaredOwner)
    if not owner then return false, err end
    local ok, message = registry:setMenuLinks(owner, menuId, links)
    if ok then E.refresh() end
    return ok, message
end)

api('SetMenuItemVisible', function(itemId, visible, declaredOwner)
    local owner, err = ownerOf(declaredOwner)
    if not owner then return false, err end
    local ok, message, changed = registry:setItemVisible(owner, itemId, visible)
    if ok and changed then E.refresh() end
    return ok, message
end)

api('SetPlayerMenuOptions', function(source, itemId, options, declaredOwner)
    local owner, err = ownerOf(declaredOwner)
    if not owner then return false, err end
    source = tonumber(source)
    local ok, message, menuId, changes = registry:setPlayerOptions(owner, source, itemId, options)
    if not ok then return false, message end
    return S.snapshotTransport.send(S.events.options, source, nil,
        { menuId = menuId, itemId = itemId, changes = changes }, Platform.TriggerClientEvent)
end)

api('OnMenuSnapshot', function(hook, declaredOwner)
    local owner, err = ownerOf(declaredOwner)
    if not owner then return false, err end
    return registry:onSnapshot(owner, hook)
end)

api('RefreshMenus', function()
    return true, E.refresh()
end)

--- Which namespaces and pages resolve for one player, and at which layer a denial
--- happens -- so a consumer's self-test can name the missing ACE rather than
--- report "Menu unavailable" as its own bug. Read-only and server-side.
---
--- Not owner-scoped: a diagnostic that could only see its caller's pages could
--- never explain a link into another resource going missing.
api('GetMenuDiagnostics', function(source)
    if type(source) ~= 'number' and type(source) ~= 'string' then
        return nil, 'A player server ID is required'
    end
    return registry:diagnostics(source)
end)

api('RegisterMenuAuthority', function(spec, declaredOwner)
    local owner, err = ownerOf(declaredOwner)
    if not owner then return false, err end
    return E.registerAuthority(owner, spec)
end)

api('UnregisterMenuAuthority', function(declaredOwner)
    local owner, err = ownerOf(declaredOwner)
    if not owner then return false, err end
    return E.unregisterAuthority(owner)
end)

return MenuEngine
