-- shared/imports/screentarget: which vehicle's device screen this client draws.
--
-- The rules are cheap to state and expensive to get wrong, because the thing
-- they arbitrate is a GLOBAL texture replacement: a picker that changes its mind
-- twice a second does not wobble one prop, it strobes every prop of that model
-- in the world, on every client that can see them. There is no way to observe
-- that in a game session without three people and two cars.
--
-- So every native the module would call is an injected provider here and the
-- real client.lua is driven directly. The last block is a MUTATION PROOF: the
-- same input sequence is replayed through an arbiter whose margin and dwell are
-- zeroed, and it is asserted to flap. Without that, a suite that only shows the
-- tuned arbiter holding still would pass just as happily against an arbiter that
-- could never change its mind at all.

-- ── Stub world ──────────────────────────────────────────────────────────────
--
-- Vehicles are plain integers. `world[v]` carries a position and whether it has a
-- prop; absence from the table is "does not exist".

local world = {}
local myPos = { x = 0, y = 0, z = 0 }
local aboardVehicle, aboardNet = nil, nil
local clock = 0

local function put(vehicle, x, hasProp)
    world[vehicle] = { pos = { x = x, y = 0, z = 0 }, prop = hasProp ~= false }
end

local function providers(extra)
    local opts = {
        hasScreen  = function(v) return world[v] ~= nil and world[v].prop == true end,
        vehicles   = function()
            local out = {}
            for v in pairs(world) do out[#out + 1] = v end
            table.sort(out)
            return out
        end,
        exists     = function(v) return world[v] ~= nil end,
        positionOf = function(v) return world[v] and world[v].pos end,
        myPosition = function() return myPos end,
        netIdOf    = function(v) return v * 10 end,
        now        = function() return clock end,
        aboard     = function()
            if aboardVehicle == nil then return nil end
            return aboardVehicle, aboardNet
        end,
    }
    for k, val in pairs(extra or {}) do opts[k] = val end
    return opts
end

local screentarget = dofile('shared/imports/screentarget/client.lua')

local function freshWorld()
    world = {}
    myPos = { x = 0, y = 0, z = 0 }
    aboardVehicle, aboardNet = nil, nil
    clock = 0
end

-- ── The constants are part of the contract ──────────────────────────────────
--
-- Pinned by name and by value: every assertion below is written against these
-- numbers, so a silent retune would turn this suite into a description of
-- whatever the module happens to do.

assert(screentarget.DEFAULT_RANGE_M == 8.0, 'reading range defaults to 8 m')
assert(screentarget.DEFAULT_SWITCH_MARGIN_M == 2.0, 'a challenger must be 2 m closer')
assert(screentarget.DEFAULT_DWELL_MS == 1500, 'and the incumbent holds for 1.5 s first')
assert(screentarget.SOURCE_OWN == 'own' and screentarget.SOURCE_NEAREST == 'nearest')

-- The range must be SHORTER than any plausible audio range: you can hear a radio
-- from across the street and cannot read its display from there. Asserted rather
-- than left as prose, because the two numbers will be tuned by different people.
assert(screentarget.DEFAULT_RANGE_M < 20.0,
    'the reading range is the short one; audio range is a different, longer number')

-- ── hasScreen is mandatory, and says so ─────────────────────────────────────

local ok, err = pcall(function() return screentarget.create({}) end)
assert(not ok and tostring(err):find('hasScreen', 1, true),
    'an arbiter with no candidate test is not a defaulting case, it is a mistake')

-- ── On foot: the nearest screen wins ────────────────────────────────────────

freshWorld()
put(10, 3.0)   -- three metres away
put(20, 6.0)
local arb = screentarget.create(providers())

local v, net, src = arb.update()
assert(v == 10, 'the nearer of two equipped vehicles is the one drawn')
assert(net == 100, 'and its network id comes back with it')
assert(src == screentarget.SOURCE_NEAREST, 'labelled as a proximity pick')

-- A vehicle with no prop is not a candidate however close it is.
put(30, 0.5, false)
assert(arb.update() == 10, 'a vehicle without a prop of this kind is not a candidate')

-- ── Range is a cliff, not a preference ──────────────────────────────────────

freshWorld()
put(10, 8.5)
arb = screentarget.create(providers())
assert(arb.update() == nil, 'a screen past the reading range is not drawn')

put(10, 8.0)
assert(arb.update() == 10, 'and the boundary itself is inside')

-- Overridable, which is the whole reason it is a parameter.
freshWorld()
put(10, 12.0)
local wide = screentarget.create(providers({ range = 20.0 }))
assert(wide.update() == 10, 'a consumer may widen the range from its own config')
assert(wide.settings().range == 20.0, 'and can read back what is actually in force')

-- ── Rule 1: the vehicle you are aboard wins ─────────────────────────────────

freshWorld()
put(10, 4.0)              -- the car we are sitting in; our ped is inside it
put(20, 0.2)              -- a car alongside, fractionally closer to our ped
aboardVehicle, aboardNet = 10, 999
arb = screentarget.create(providers())

v, net, src = arb.update()
assert(v == 10, 'your own vehicle wins over a marginally closer one alongside')
assert(src == screentarget.SOURCE_OWN, 'and is labelled as such, so the consumer '
    .. 'knows its own NUI is looking at the same device')
assert(net == 999, "the occupancy module's own net id is used when it has one")

-- It wins from ANY seat. occupancy.cabin() answers for a rear passenger, which
-- is the point of using it rather than myVehicle(): perceiving the cabin you are
-- sitting in is not operating anything.
assert(arb.update() == 10, 'and keeps winning while you are aboard')

-- Beyond the reading range is irrelevant when you are IN it -- you cannot be too
-- far from a screen you are sitting behind, whatever the entity centre says.
world[10].pos.x = 50.0
assert(arb.update() == 10, 'your own vehicle is never out of range of you')

-- ── Aboard a vehicle with no screen: you can still read the one next door ───

freshWorld()
put(10, 0.0, false)       -- our own car, no prop
put(20, 3.0)              -- the patrol car we have pulled alongside
aboardVehicle, aboardNet = 10, 999
arb = screentarget.create(providers())

v, _, src = arb.update()
assert(v == 20 and src == screentarget.SOURCE_NEAREST,
    'sitting in a car without the device does not blind you to the one beside you')

-- ── Rule 4: no candidate tears down ─────────────────────────────────────────

freshWorld()
put(10, 3.0)
arb = screentarget.create(providers())
local announcements = {}
arb.onChange(function(vehicle, netId, source)
    announcements[#announcements + 1] = { vehicle = vehicle, netId = netId, source = source }
end)

assert(arb.update() == 10)
assert(#announcements == 1 and announcements[1].vehicle == 10, 'adoption is announced')

world[10] = nil                      -- it despawned
assert(arb.update() == nil, 'with nothing in range the answer is nothing')
assert(arb.current() == nil, 'and that is what the cached answer says too')
assert(#announcements == 2 and announcements[2].vehicle == nil,
    'teardown is announced as nil, not merely left stale')

-- Repeated emptiness is not repeated news.
assert(arb.update() == nil)
assert(#announcements == 2, 'and nothing is announced while there is still nothing')

-- ── Losing the incumbent is not a displacement, so nothing delays it ────────
--
-- The dwell is a floor on being DISPLACED by a rival. An incumbent that
-- despawned, lost its prop or drove off has not been displaced, and holding it
-- for the dwell would be a blank or wrong screen for no reason.

freshWorld()
put(10, 1.0)
put(20, 5.0)
arb = screentarget.create(providers())
assert(arb.update() == 10)
clock = clock + 100                  -- nowhere near the dwell
world[10].prop = false               -- its prop was removed
assert(arb.update() == 20, 'an incumbent that stopped being a candidate is dropped at once')

freshWorld()
put(10, 1.0)
put(20, 5.0)
arb = screentarget.create(providers())
assert(arb.update() == 10)
clock = clock + 100
world[10].pos.x = 30.0               -- it drove away
assert(arb.update() == 20, 'and so is one that left range, without waiting out the dwell')

-- ── Rule 3a: the switch margin ──────────────────────────────────────────────

freshWorld()
put(10, 4.0)
put(20, 5.0)
arb = screentarget.create(providers())
assert(arb.update() == 10, 'the nearer one is adopted first')

clock = clock + 5000                 -- well past the dwell, so only the margin is in play
world[20].pos.x = 2.2                -- now 1.8 m nearer than the incumbent's 4.0
assert(arb.update() == 10, 'a challenger 1.8 m nearer is not meaningfully nearer')

world[20].pos.x = 1.9                -- 2.1 m nearer
assert(arb.update() == 20, 'a challenger 2.1 m nearer has earned it')
assert(arb.currentDistance() == 1.9, 'and the distance is reported for diagnostics')

-- ── Rule 3b: the dwell ──────────────────────────────────────────────────────

freshWorld()
put(10, 4.0)
arb = screentarget.create(providers())
assert(arb.update() == 10)

clock = clock + 1499
put(20, 0.1)                         -- a wildly closer challenger, well past the margin
assert(arb.update() == 10, 'inside the dwell even an obvious challenger waits')

clock = clock + 2
assert(arb.update() == 20, 'and takes over the moment the dwell expires')

-- ── Hysteresis prevents the flap at equal distance ──────────────────────────
--
-- The scenario the module exists for: two equipped vehicles side by side, our
-- player between them, the sub-centimetre jitter of two networked entities
-- putting first one and then the other marginally nearer. Without hysteresis the
-- global texture changes owner on every pass.

local FLAP_PASSES = 40

local function runFlapSequence(arbiter)
    local switches = 0
    arbiter.onChange(function() switches = switches + 1 end)
    for pass = 1, FLAP_PASSES do
        -- Alternating, and by a margin that grows a little each pass so that this
        -- is not merely a tie being broken consistently by table order: the
        -- ACTUAL nearest really does change every single pass.
        local wobble = 0.01 * pass
        if pass % 2 == 0 then
            world[10].pos.x = 3.0 - wobble
            world[20].pos.x = 3.0 + wobble
        else
            world[10].pos.x = 3.0 + wobble
            world[20].pos.x = 3.0 - wobble
        end
        clock = clock + 250          -- a realistic poll interval; 40 passes is 10 s
        arbiter.update()
    end
    return switches
end

freshWorld()
put(10, 3.0)
put(20, 3.0)
arb = screentarget.create(providers())
arb.update()                          -- adopt one of them
local tuned = runFlapSequence(arb)
assert(tuned == 0,
    'ten seconds of two cars trading places by centimetres changes the screen '
    .. ('zero times; got %d'):format(tuned))
-- And it held a real target throughout rather than quietly having none: a
-- teardown is announced, so "no switches" could otherwise have meant "there was
-- never anything to switch away from".
assert(arb.current() == 10, 'the incumbent it started with is the one still drawn')

-- ── MUTATION PROOF ──────────────────────────────────────────────────────────
--
-- Remove the hysteresis -- margin 0, dwell 0, which reduces the module to
-- "nearest always wins" -- and replay the identical sequence. It must flap. If
-- this ever stops flapping, the assertion above has stopped proving anything and
-- is passing for some other reason.

freshWorld()
put(10, 3.0)
put(20, 3.0)
local naive = screentarget.create(providers({ switchMargin = 0, dwellMs = 0 }))
naive.update()
local flapped = runFlapSequence(naive)
assert(flapped >= FLAP_PASSES - 1,
    'with the margin and the dwell removed the same input flaps on essentially '
    .. ('every pass; got %d of %d'):format(flapped, FLAP_PASSES))

-- Stated as a ratio too, so the two numbers are compared rather than each being
-- asserted against a constant that could drift apart.
assert(flapped > tuned, 'the hysteresis is what makes the difference, not the input')

-- ── reset ───────────────────────────────────────────────────────────────────

freshWorld()
put(10, 3.0)
arb = screentarget.create(providers())
assert(arb.update() == 10)
arb.reset()
assert(arb.current() == nil, 'reset forgets the incumbent')
assert(arb.update() == 10, 'and the next pass re-adopts from scratch')

-- ── The DEFAULT providers, against a native that answers the way the game does ──
--
-- EVERY test above this line injects `exists`, which is exactly why the suite was
-- green while the feature was dead in game. The default provider was
-- `DoesEntityExist(entity) == true`, and MEASURED in FiveM Enhanced on 2026-09-26
-- every BOOL native reaches Lua as the NUMBER 1 -- checked with `type()` on
-- DoesEntityExist, NetworkDoesNetworkIdExist, IsPedInAnyVehicle, IsEntityAVehicle
-- and HasModelLoaded, all of which answered "number". So the comparison was always
-- false, no vehicle ever qualified, and tRadar, tDetector and tRadio all showed a
-- dead prop: no browser, no backlight, no lamps, and nothing logged, because the
-- arbiter returning nil is a legitimate answer.
--
-- So this block deliberately does NOT inject `exists`. It stubs the native itself,
-- in both shapes a BOOL can arrive in, which is the only way the default gets
-- exercised at all.

freshWorld()
put(10, 3.0)

local realDoesEntityExist = rawget(_G, 'DoesEntityExist')

-- An `exists = nil` entry in the overrides table CANNOT express this: `pairs`
-- skips nil values, so
-- the key is simply absent from the overrides table and the injected provider
-- survives untouched. Caught here by the 0-is-a-denial case still adopting the
-- vehicle -- the other two cases had been passing vacuously against the stub.
local function defaultExistsProviders()
    local opts = providers()
    opts.exists = nil
    return opts
end

-- 1 is YES. This is the shape the game actually returns.
DoesEntityExist = function(entity) return world[entity] ~= nil and 1 or 0 end
local numericArb = screentarget.create(defaultExistsProviders())
assert(numericArb.update() == 10,
    'a BOOL native returning the NUMBER 1 must count as "this entity exists"; '
    .. 'comparing it against `true` is what killed the feature in game')

-- 0 is NO, and it must not be read as yes. `not not v` would fail here, because 0
-- is TRUTHY in Lua -- which is why the fix spells both shapes out rather than
-- coercing.
freshWorld()
put(11, 3.0)
DoesEntityExist = function() return 0 end
local zeroArb = screentarget.create(defaultExistsProviders())
assert(zeroArb.update() == nil,
    'a BOOL native returning the NUMBER 0 is a denial; 0 is truthy in Lua, so a '
    .. 'plain truthiness test would turn every "no" into a "yes"')

-- true/false still work, because a runtime that marshals properly must not break.
freshWorld()
put(12, 3.0)
DoesEntityExist = function(entity) return world[entity] ~= nil end
local boolArb = screentarget.create(defaultExistsProviders())
assert(boolArb.update() == 12, 'a genuine boolean still has to work')

DoesEntityExist = realDoesEntityExist

print('PASS: screentarget picks your own vehicle over a closer neighbour, the '
    .. 'nearest equipped vehicle otherwise, holds it against a flap that the same '
    .. 'input provokes without the margin and the dwell, and answers nothing when '
    .. 'there is nothing')
