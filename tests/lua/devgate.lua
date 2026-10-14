-- shared/imports/devgate: the internal-feature gate.
--
-- The module is four lines of logic, so what is worth asserting is not the
-- arithmetic but the two properties consumers depend on and cannot see:
--
--   * the convar is read on every call, so a mid-session flip takes effect;
--   * an absent or misspelled convar reads as OFF, because the gate hides
--     features and failing open would ship them.

local convars = {}
GetConvar = function(name, default)
    local v = convars[name]
    if v == nil then return default end
    return v
end

local devgate = dofile('shared/imports/devgate/shared.lua')

-- Each resource names its own convar, and two gates in one VM stay independent.
local els = devgate('tels_internal_name')
local radio = devgate('tradio_internal_name')

assert(els() == false, 'an unset convar is off')
assert(radio() == false, 'an unset convar is off')

convars['tels_internal_name'] = '1'
assert(els() == true, 'the convar is re-read, not captured at gate creation')
assert(radio() == false, 'one resource turning its gate on does not turn another on')

-- Mid-session: the convar is replicated, so this is a real sequence and not a
-- contrived one. Reading once at load would have pinned the `false` above.
convars['tels_internal_name'] = '0'
assert(els() == false, 'turning it back off takes effect at the next call')

for _, spelling in ipairs({ '1', 'true', 'TRUE', 'yes', 'On' }) do
    convars['tels_internal_name'] = spelling
    assert(els() == true, ('"%s" is truthy'):format(spelling))
end

for _, spelling in ipairs({ '0', 'false', 'no', 'off', '', '2', 'enabled' }) do
    convars['tels_internal_name'] = spelling
    assert(els() == false, ('"%s" is not truthy'):format(spelling))
end

-- A name that cannot work must raise where it is written. Returning a
-- permanently-false predicate would read exactly like the feature being off.
for _, bad in ipairs({ '', 42, true }) do
    assert(not pcall(devgate, bad), ('%s is rejected as a convar name'):format(tostring(bad)))
end
assert(not pcall(devgate), 'no name at all is rejected')

-- Loaded into a runtime with no natives -- the other Lua suites, and any static
-- check -- the gate is off rather than an error at the call site.
local realGetConvar = GetConvar
GetConvar = nil
local bare = devgate('tels_internal_name')
assert(bare() == false, 'no GetConvar native means off, not a crash')
GetConvar = realGetConvar

-- A native that raises (an engine that has the symbol but refuses the call) is
-- the same answer: off.
GetConvar = function() error('native unavailable') end
assert(devgate('tels_internal_name')() == false, 'a raising native means off')
GetConvar = realGetConvar

print('PASS: devgate')
