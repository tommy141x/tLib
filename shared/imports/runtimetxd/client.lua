--[[
    tLib — runtime TXD lifetime: create once, never again.

    Loaded into the consumer's VM like every other module under shared/imports/:
    `tlib.runtimetxd`. Client only — every native it touches is a graphics native.

        local txds = tlib.runtimetxd.create('tdet_scr_txd')
        local txd  = txds.ensure()
        local name = txds.textureName('tdet_screen', serial)

    CREATE_RUNTIME_TXD permanently consumes one of the game's finite `ytd`
    streaming slots (FindSlotFromHashKey + AddRef + SetDoNotDefrag), and
    nothing in the engine ever frees it — RuntimeTxd/RuntimeTex register a
    constructor with no matching destructor. Calling it twice with the same
    name is worse than wasteful: RuntimeTxd::EnsureTxd only assigns m_txd when
    the slot has no handle yet, so a second call either orphans every texture
    already registered under that name (AddReplaceTexture keeps pointing at
    the old dictionary) or leaves m_txd null, silently killing every later
    CreateRuntimeTexture against it. Neither failure raises. Replaces ~70
    lines duplicated across tRadio (which got it wrong first), tDetector and
    tRadar (which got it right).

    The dictionary name is tokenised per resource load, at the cost of one
    pinned `ytd` slot per restart: CreateRuntimeTxd is not idempotent across
    owners, so re-registering an existing name creates a second dictionary and
    AddReplaceTexture may resolve to the wrong one — the state a plain
    `restart <resource>` otherwise leaves a resource in (measured: the same
    name handed out two different handles minutes apart). Runtime texture
    names need the same tag for the same reason, process-global with no
    destructor: a restarted resource's first browser re-requesting a bare name
    gets a null handle from CreateRuntimeTextureFromDuiHandle and the screen
    stays dead for the rest of the session. `textureName` lives here, not at
    each call site, so the tag can't be forgotten.

    Not owned here: which textures go in the dictionary, what they're bound
    to, or when replacements are (re-)issued — that's the consumer's.
]]

local RuntimeTxd = {}

--- @param prefix string  dictionary name stem, e.g. 'tdet_scr_txd'
--- @return table instance
function RuntimeTxd.create(prefix)
    assert(type(prefix) == 'string' and prefix ~= '',
        'tlib.runtimetxd.create: a non-empty name prefix is required')

    local instance = {}

    -- [name] = handle. txdCalls counts native calls, not table size: a table
    -- keyed by name can't see the hazard of calling the native twice with the
    -- same name, since that would just read as 1 for a slot pinned 20 times.
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

    --- How many times this instance has called CREATE_RUNTIME_TXD -- i.e. how
    --- many `ytd` slots it has pinned. Exported for suites asserting it stays
    --- at one across repeated activations; the leak is invisible in game
    --- until the streamer runs out of slots.
    function instance.count()
        return txdCalls
    end

    return instance
end

return RuntimeTxd
