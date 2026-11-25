-- The fault dedupe window, across the game timer wrapping.
-- Run via `bun run test:lua`.

local checks = 0
local function check(value, message)
    checks = checks + 1
    if not value then error('FAIL: ' .. message, 2) end
end

local now = 1000
function GetGameTimer() return now end
function IsDuplicityVersion() return false end
function GetCurrentResourceName() return 'alpha' end

local netHandlers, batches = {}, {}
function RegisterNetEvent(name, fn) netHandlers[name] = fn end
function TriggerServerEvent(_, batch) batches[#batches + 1] = batch end
-- The batch is asserted on as a table, so the encoder hands it through untouched.
json = { encode = function(value) return value end }

local T = dofile('shared/imports/telemetry/shared.lua')
netHandlers[T.CONSENT_EVENT]({ enabled = true })

--- How many events the next flush carries.
local function flushed()
    batches = {}
    T.flush()
    return batches[1] and #batches[1].events or 0
end

T.error('boom', 'site')
check(flushed() == 1, 'the first report of a fault is sent')

now = now + 5000
T.error('boom', 'site')
check(flushed() == 0, 'the same fault inside the window is deduplicated')

-- The 32-bit timer wraps to a value far below the stamp. The difference is then negative,
-- which reads as "inside the window" and as "not yet old enough to forget", so the fault
-- would be dropped for the rest of the session.
now = -2000000000
T.error('boom', 'site')
check(flushed() == 1, 'a fault seen before the timer wrapped is reported again after it')

now = now + 5000
T.error('boom', 'site')
check(flushed() == 0, 'and the window applies again from the new stamp')

print(('PASS telemetry-dedupe-wrap (%d checks)'):format(checks))
