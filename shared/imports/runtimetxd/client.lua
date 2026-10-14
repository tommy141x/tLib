--[[
    tLib — RUNTIME TXD LIFETIME: CREATE ONCE, NEVER AGAIN

    Loaded into the CONSUMER's VM like every other module under shared/imports/:
    `tlib.runtimetxd`. Client only — every native it touches is a graphics native.

        local txds = tlib.runtimetxd.create('tdet_scr_txd')
        local txd  = txds.ensure()
        local name = txds.textureName('tdet_screen', serial)

     Why this exists

    CREATE_RUNTIME_TXD is not the cheap "make me a namespace" call it reads as. In
    RuntimeAssetNatives.cpp it resolves the name through FindSlotFromHashKey against
    the `ytd` streaming module, AddRef()s that slot and marks it SetDoNotDefrag — it
    PERMANENTLY CONSUMES one of the game's finite ytd streaming slots and pins it in
    place. And it is never given back: the native registration binds .AddConstructor
    for both RuntimeTxd and RuntimeTex with NO matching .AddDestructor, so there is
    no code path in the engine, and therefore none reachable from Lua, that frees
    either one.

    Calling it twice with the SAME name is worse than wasteful, it is incoherent.
    RuntimeTxd::EnsureTxd only assigns m_txd inside `if (!entry.handle)`, and a slot
    created by a script never acquires a streaming handle. So the second call either
    allocates a fresh empty pgDictionary and SetResource()s it over the first —
    orphaning every texture already registered under that name, which is exactly the
    set AddReplaceTexture is still pointing at — or leaves m_txd null, in which case
    every later CreateRuntimeTexture against it silently returns 0. Neither is
    recoverable, and NEITHER RAISES.

    tRadio got this wrong first; tRadar got it right. tDetector and tRadar then
    carried the same ~70 lines of it each, with the measurement written down twice
    and, in one of the two, a comment that contradicted its own code about whether
    the dictionary name was tokenised. It is one implementation now.

     THE TXD NAME IS TOKENISED PER RESOURCE LOAD

    That is not the obvious call — it costs one pinned `ytd` streaming slot per
    resource load. It is still right. CreateRuntimeTxd is NOT idempotent across
    owners: re-registering an existing name produces a SECOND dictionary, and
    AddReplaceTexture then resolves the name to whichever one does not hold our
    textures, so every replacement silently does nothing. That is the state a plain
    `restart <resource>` leaves a resource in. Measured 2026-09-25 in tRadar: the
    same name handed out handle 20 and handle 6 minutes apart.

    One leaked slot per restart is far cheaper than a screen that dies on every
    restart, and a customer loads a resource once per session anyway.

     AND SO IS EVERY TEXTURE NAME

    Runtime textures are process-global and have no destructor either, so every name
    a resource took before a restart is still taken afterwards for as long as the game
    client runs. Without the tag the first browser of a restarted resource asks for
    `tdet_screen_1` again, CreateRuntimeTextureFromDuiHandle returns null, the caller
    takes its failure branch and destroys the browser — and the screen stays baked for
    the whole session with one line in the client console. A texture whose name is
    otherwise CONSTANT is worse still: it collides on every restart without exception.

    `textureName` is here rather than left to each caller for exactly that reason: the
    rule is "a runtime texture name must carry the per-load tag", and a name built by
    hand is a name that can forget to.

     What is NOT owned here

    Which textures go in the dictionary, what they are bound to, and when the
    replacements are issued or re-issued. Those are the consumer's; this module
    answers "what dictionary, and under what name" and nothing further.
]]

local RuntimeTxd = {}

--- @param prefix string  dictionary name stem, e.g. 'tdet_scr_txd'
--- @return table instance
function RuntimeTxd.create(prefix)
    assert(type(prefix) == 'string' and prefix ~= '',
        'tlib.runtimetxd.create: a non-empty name prefix is required')

    local instance = {}

    -- [name] = handle, plus a count of CREATE_RUNTIME_TXD CALLS.
    --
    -- The call count, not the size of the table, is what `count` answers, and the
    -- difference is the whole hazard: the dangerous case is calling the native twice
    -- with the SAME name, which a table keyed by name cannot see at all. Counting
    -- names reads 1 for a resource that has pinned the slot twenty times.
    local txds = {}
    local txdCalls = 0
    local tagCache = nil
    local nameCache = nil

    --- A token unique to this RESOURCE LOAD, carried by every name below.
    ---
    --- GetGameTimer is milliseconds since the game started and a restart takes very
    --- much longer than a millisecond, so two loads in one process cannot share a
    --- value. Resolved LAZILY rather than when the module loads, because natives are
    --- not reliably callable while a resource's scripts are still being loaded.
    function instance.tag()
        if not tagCache then tagCache = ('%x'):format(GetGameTimer()) end
        return tagCache
    end

    --- The dictionary name for this resource load. Cached, so `ensure` creates
    --- exactly one dictionary per load however often it is called.
    function instance.name()
        if not nameCache then
            nameCache = ('%s_%s'):format(prefix, instance.tag())
        end
        return nameCache
    end

    --- The runtime txd, creating it AT MOST ONCE per resource lifetime.
    ---
    --- The cache is the entire point. `CreateRuntimeTxd` is cheap-looking and
    --- permanently expensive; this is the only place a consumer may reach it.
    function instance.ensure()
        local name = instance.name()
        local txd = txds[name]
        if txd == nil then
            txd = CreateRuntimeTxd(name)
            txdCalls = txdCalls + 1
            txds[name] = txd
        end
        return txd
    end

    --- A runtime TEXTURE name carrying this load's tag.
    ---
    --- `serial` is the caller's: CREATE_RUNTIME_TEXTURE* returns null when the name
    --- already exists in the dictionary, so a texture bound to something that is
    --- genuinely new each time — a DUI handle, say — needs a fresh name per
    --- instance rather than a constant. That accumulates one dead texture entry per
    --- instance, which is unavoidable without a destructor, but a texture entry is a
    --- pointer in a hash map rather than a pinned streaming slot.
    --- @param stem string
    --- @param serial number|nil
    function instance.textureName(stem, serial)
        assert(type(stem) == 'string' and stem ~= '',
            'tlib.runtimetxd.textureName: a non-empty stem is required')
        if serial == nil then return ('%s_%s'):format(stem, instance.tag()) end
        return ('%s_%s_%d'):format(stem, instance.tag(), serial)
    end

    --- How many times this instance has called CREATE_RUNTIME_TXD -- which is how
    --- many `ytd` streaming slots it has pinned.
    ---
    --- Exported for the suites, which assert it stays at one across repeated screen
    --- activations. The leak is invisible in game until the streamer runs out of
    --- slots, so a counter is the only oracle available.
    ---
    --- CALLS, not distinct names. The dangerous case is calling the native twice with
    --- the SAME name, and a count of names reads 1 for a resource that has pinned the
    --- slot twenty times -- a counter that cannot see the defect it exists for.
    function instance.count()
        return txdCalls
    end

    return instance
end

return RuntimeTxd
