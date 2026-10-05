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

print('PASS ratelimit')
