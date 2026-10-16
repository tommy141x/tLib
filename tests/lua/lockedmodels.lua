-- shared/imports/lockedmodels: the read-only vehicle set.
--
-- The security property under test is that the set comes from the convar and
-- from nowhere else. There is no "unlock" entry point to exercise, and that
-- absence is the design -- so what these assert is the matching behaviour and
-- the fact that an unset convar locks nothing, which is the state every
-- customer runs in.

-- Stub host

local convars = {}
GetConvar = function(name, default)
    local value = convars[name]
    if value == nil or value == '' then return default end
    return value
end

-- A deterministic stub, NOT real joaat. The module does not care what the hash
-- is, only that it uses whatever this native returns -- so reimplementing joaat
-- here would test the stub, and getting it subtly wrong would make the test
-- agree with itself. The one property that matters is covered: this returns a
-- NEGATIVE value for the first name, which is what exercises the unsigned
-- mirror the module stores alongside the signed form.
local HASHES = { ['18charger21tr'] = -1437226751, ['fpiu21tr'] = 884213001, ['police3'] = 42 }
GetHashKey = function(str)
    return HASHES[str] or 7
end

local function load_module()
    package.loaded['lockedmodels'] = nil
    local chunk = assert(loadfile('shared/imports/lockedmodels/server.lua'))
    return chunk()
end

local failures = 0
local function check(name, cond)
    if cond then
        print('  ok   ' .. name)
    else
        failures = failures + 1
        print('  FAIL ' .. name)
    end
end

-- Unset: the customer case

convars = {}
local m = load_module()
check('unset convar locks nothing', m.isLocked('18charger21tr') == false)
check('unset convar reports none configured', m.any() == false)
check('nil model is not locked', m.isLocked(nil) == false)

-- Configured

convars = { tlib_locked_models = '18charger21tr,fpiu21tr' }
m = load_module()
check('locks a configured name', m.isLocked('18charger21tr') == true)
check('locks the second name', m.isLocked('fpiu21tr') == true)
check('leaves every other vehicle alone', m.isLocked('police3') == false)
check('any() is true when configured', m.any() == true)
check('list() returns both', #m.list() == 2)

-- A caller mutating list() must not unlock anything.
local copy = m.list()
copy[1] = 'mutated'
check('list() is a copy', m.isLocked('18charger21tr') == true)

-- Case and whitespace: a server.cfg value is typed by a human

convars = { tlib_locked_models = ' 18Charger21TR , FPIU21tr ' }
m = load_module()
check('matching is case-insensitive', m.isLocked('18charger21tr') == true)
check('whitespace around entries is ignored', m.isLocked('fpiu21tr') == true)
check('a mixed-case query matches too', m.isLocked('FPIU21TR') == true)

-- Hash forms: tUnit keys by hash-as-string, tELS by name

convars = { tlib_locked_models = '18charger21tr' }
m = load_module()
local signed = GetHashKey('18charger21tr')
local unsigned = signed < 0 and signed + 0x100000000 or signed
check('locks the signed hash as a string', m.isLocked(tostring(signed)) == true)
check('locks the unsigned hash as a string', m.isLocked(tostring(unsigned)) == true)
check('locks the hash passed as a number', m.isLocked(signed) == true)
check('an unrelated hash is not locked', m.isLocked(tostring(GetHashKey('police3'))) == false)

-- Negative control: with the gate's own source of truth emptied, every
-- assertion above that depends on it must flip. A set that matched everything,
-- or nothing, would otherwise pass half of this file by accident.

convars = { tlib_locked_models = '' }
m = load_module()
check('control: an empty value locks nothing', m.isLocked('18charger21tr') == false)
check('control: and reports nothing configured', m.any() == false)

if failures > 0 then
    error(('lockedmodels: %d check(s) failed'):format(failures))
end
print('lockedmodels: all checks passed')
