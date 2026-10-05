-- The per-player rate limiter, and the disconnect sweep that goes with it.
--
-- The sweep is the whole reason this module exists rather than an eighth copy
-- of the twelve-line function: without it every bucket keeps one timestamp per
-- player who has EVER connected, for the life of the server. That is invisible
-- from the call site, it never raises, and six of the seven copies in the tree
-- happened to remember it. This suite is what makes "cannot be forgotten" true.
--
-- Run via `bun run test:lua`.

local function fail(message) error(message, 2) end

-- ── Host stubs ──────────────────────────────────────────────────────────────

local now = 0
function GetGameTimer() return now end

local dropHandlers = {}
function AddEventHandler(name, fn)
    dropHandlers[name] = dropHandlers[name] or {}
    table.insert(dropHandlers[name], fn)
end

--- Fires `playerDropped` for one player, the way the host does: through the
--- GLOBAL `source`, not an argument.
local function drop(src)
    source = src
    for _, fn in ipairs(dropHandlers.playerDropped or {}) do fn() end
    source = nil
end

local RateLimit = dofile('shared/imports/ratelimit/server.lua')

-- ── A floor on the interval, per player ─────────────────────────────────────

local gate = RateLimit.bucket('requestVehicleProps', 1000)

now = 5000
if gate(1) then fail("a player's first call was refused") end
if not gate(1) then fail('a second call inside the interval was allowed') end

-- Per PLAYER, not per bucket: one client flooding must not lock everyone out.
if gate(2) then fail("one player's flood refused another player's first call") end

now = 5999
if not gate(1) then fail('a call one millisecond inside the interval was allowed') end
now = 6000
if gate(1) then fail('a call exactly at the interval was refused') end

-- A nil src is not a player. Refusing it would be the wrong failure: the
-- caller's own `if not src` guard is what rejects those, and answering `true`
-- here would make an absent source look like a flood.
if gate(nil) then fail('a nil source was reported as rate limited') end

-- ── Two buckets are independent ─────────────────────────────────────────────

local other = RateLimit.bucket('requestOpenSettings', 1000)
now = 6000
if other(1) then
    fail('a call to one bucket counted against another; every event in a resource '
        .. 'would share one limit')
end

-- The same NAME twice is the same bucket, deliberately: two handlers that are
-- two ways of asking for the same thing share one limit.
local again = RateLimit.bucket('requestVehicleProps', 1000)
if not again(1) then fail('re-opening a bucket by name started fresh timestamps') end

-- ── The sweep ───────────────────────────────────────────────────────────────
--
-- Without it the bucket keeps one entry per player who has ever connected.
-- Asserted through the OBSERVABLE consequence rather than by reading the table:
-- after a disconnect the next call from that src must be treated as a first
-- call, which it cannot be if the timestamp survived.

now = 6500
if not gate(1) then fail('precondition broken: player 1 is not inside the interval') end
drop(1)
if gate(1) then
    fail('a disconnected player kept their timestamp; every bucket leaks one entry '
        .. 'per unique player for the life of the server')
end
-- Every bucket, not just the one that was last used.
now = 6500
if other(2) then fail('precondition broken') end
drop(2)
if other(2) then fail('the sweep missed a bucket') end

-- A disconnect with no source is ignored rather than wiping everything.
now = 7000
if gate(3) then fail('precondition broken') end
drop(nil)
if not gate(3) then fail('a sourceless playerDropped forgot every player') end

-- ── The sweep is LIVE over the bucket table, not a snapshot of it ───────────
--
-- This is what a consumer relies on when it DELETES its own hand-written sweep
-- line and keeps the bucket: tRadio's sv_radio.lua and sv_integrations.lua each
-- cleared their timestamps from a consolidated playerDropped handler hundreds of
-- lines from the limit. Removing those lines is only safe if the module's single
-- handler reaches every bucket it owns, including ones opened after it was
-- installed and after a disconnect has already been processed.
--
-- Asserted through the consequence, not by inspecting `buckets`: a bucket opened
-- late must still treat a post-disconnect call as a FIRST call.

local late = RateLimit.bucket('openedAfterADisconnect', 1000)
now = 8000
if late(4) then fail('precondition broken: player 4 has no timestamp in the late bucket') end
drop(4)
if late(4) then
    fail('a bucket opened after the sweep was installed is not swept; a consumer that '
        .. 'deleted its own playerDropped line in favour of this module would leak')
end

-- All of them at once, from ONE disconnect. The hand-written sweeps this module
-- replaced each cleared exactly one named table, so "the module reaches every
-- bucket" is the whole content of the migration.
local many = {}
for i = 1, 5 do many[i] = RateLimit.bucket('sweepAll' .. i, 1000) end
now = 9000
for i = 1, 5 do
    if many[i](7) then fail('precondition broken: bucket ' .. i .. ' already held player 7') end
end
drop(7)
for i = 1, 5 do
    if many[i](7) then
        fail('one disconnect did not reach bucket ' .. i .. ' of 5; a resource with several '
            .. 'request-shaped events would leak from all but one of them')
    end
end

-- ── One handler, not one per bucket ─────────────────────────────────────────
--
-- `playerDropped` is an ordinary event; N handlers would mean N table walks per
-- disconnect for no benefit.
RateLimit.bucket('a', 1000); RateLimit.bucket('b', 1000); RateLimit.bucket('c', 1000)
if #(dropHandlers.playerDropped or {}) ~= 1 then
    fail('the disconnect sweep was registered ' .. #dropHandlers.playerDropped
        .. ' times; it must be installed once')
end

-- ── Bad arguments are a programming error, not a silent no-op ───────────────
--
-- A bucket that quietly did nothing would be a rate limit that is not there,
-- which is exactly the failure this module is supposed to make impossible.
if pcall(RateLimit.bucket, '', 1000) then fail('an empty bucket name was accepted') end
if pcall(RateLimit.bucket, nil, 1000) then fail('a nil bucket name was accepted') end
if pcall(RateLimit.bucket, 'x', nil) then fail('a nil interval was accepted') end
if pcall(RateLimit.bucket, 'x', -1) then fail('a negative interval was accepted') end

-- ── ⚠️ NEGATIVE CONTROLS ────────────────────────────────────────────────────
--
-- Two sweeps that are wrong in ways nothing raises about, asserted to be caught
-- by the scenarios above. Reported BY NAME, never by count: the point of a
-- control is to say which rule is doing the catching, and a total goes stale.

local controls = {}

--- A sweep that captured the bucket list at install time instead of reading it
--- live. This is the shape you get by writing the handler once, next to the
--- first bucket, which is exactly how the hand-written copies were written.
controls['sweep over a snapshot of the bucket list'] = function()
    local buckets = {}
    local installed = false
    local snapshot
    local function open(name)
        local b = buckets[name] or {}
        buckets[name] = b
        if not installed then
            installed = true
            snapshot = {}
            for _, v in pairs(buckets) do snapshot[#snapshot + 1] = v end
        end
        return function(src, t)
            local last = b[src]
            if last and (t - last) < 1000 then return true end
            b[src] = t
            return false
        end
    end
    local function sweep(src)
        for _, b in ipairs(snapshot) do b[src] = nil end
    end

    local first = open('first')
    first(1, 0)
    local late = open('late')
    late(1, 0)
    sweep(1)
    -- Correct behaviour: BOTH buckets forget player 1, so both treat the next
    -- call as a first call.
    return first(1, 100) == false and late(1, 100) == false
end

--- A sweep that only clears the bucket it was registered alongside -- one
--- handler per call site, each naming its own table. Six of the seven copies
--- this module replaced were exactly this.
controls['sweep clears only its own bucket'] = function()
    local a, b = {}, {}
    local function gateOver(t)
        return function(src, now)
            local last = t[src]
            if last and (now - last) < 1000 then return true end
            t[src] = now
            return false
        end
    end
    local ga, gb = gateOver(a), gateOver(b)
    ga(1, 0)
    gb(1, 0)
    a[1] = nil -- only the first site remembered to sweep
    return ga(1, 100) == false and gb(1, 100) == false
end

local EXPECTED_REFUSED = {
    ['sweep over a snapshot of the bucket list'] = true,
    ['sweep clears only its own bucket'] = true,
}

local refused, slipped = {}, {}
for name, fn in pairs(controls) do
    local ok, satisfied = pcall(fn)
    if (not ok) or satisfied ~= true then
        refused[#refused + 1] = name
    else
        slipped[#slipped + 1] = name
    end
end
table.sort(refused)
table.sort(slipped)

for _, name in ipairs(slipped) do
    fail(('⚠️ negative control "%s" PASSED. It re-implements a sweep this module '
        .. 'exists to replace, so the scenario meant to catch it is not '
        .. 'discriminating.'):format(name))
end
local want = {}
for name in pairs(EXPECTED_REFUSED) do want[#want + 1] = name end
table.sort(want)
if table.concat(refused, '|') ~= table.concat(want, '|') then
    fail(('the set of controls refused is [%s]; declared [%s]')
        :format(table.concat(refused, ', '), table.concat(want, ', ')))
end

print('PASS ratelimit (' .. #refused .. ' negative controls, all refused)')
