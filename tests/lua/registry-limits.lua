-- Standalone from resource root:
--   bunx --bun fengari tests/lua/registry-limits.lua
--
-- Oracle for the registration count limits and the studio exemption from them.
--
-- Why this suite exists: the limits used to be unowned. Nothing in tLib tested
-- them, and the only thing that ever hit one was tMenu's catalog-capacity suite
-- discovering it had grown past 240 pages -- which read like tMenu's bug and was
-- actually tLib refusing a registration for a reason it could not defend. The
-- numbers are courtesy guardrails against wire cost, not crash boundaries: the
-- real ceiling is shared/lib/menu/schema.lua's snapshotTransport, which chunks at 64 KB
-- and only refuses past 16 MB. So an owner may be exempted from the counts.
--
-- The whole risk in an exemption is scope creep, so the assertions here are
-- exclusive about what `trusted` buys. It buys room and nothing else:
--
--   * schema validation still runs and still refuses malformed menus
--   * duplicate IDs are still refused
--   * cross-owner ID theft is still refused
--   * every ACE decision is byte-for-byte what an untrusted owner would get
--
-- An inclusion-only test ("the trusted owner registered 300 menus") would pass
-- just as happily if `trusted` had accidentally become a permission bypass. Each
-- of those four is therefore asserted against a TRUSTED registry, not merely an
-- untrusted one.


Platform = { now = function() return 0 end }
assert(loadfile('shared/lib/menu/schema.lua', 't', _G),
    'shared/lib/menu/schema.lua not found -- run this suite from the tLib resource root')()
assert(loadfile('server/lib/menu/registry.lua', 't', _G))()

local R = MenuRegistry
local checks = 0
local function fail(message) error('FAIL: ' .. message, 0) end
local function check(condition, message)
    checks = checks + 1
    if not condition then fail(message) end
end
local function equal(actual, expected, message)
    checks = checks + 1
    if actual ~= expected then
        fail(('%s: expected %s, got %s'):format(message, tostring(expected), tostring(actual)))
    end
end

-- Small limits rather than the shipped 32/240/300: the behaviour under test is
-- "the count is enforced, and trusted skips it", which is the same behaviour at
-- any number, and a suite that registered 300 real menus to prove it would be
-- asserting the constant instead of the rule.
local LIMITS = { menusPerOwner = 3, cataloguedMenusPerOwner = 5, totalMenus = 7, maxDomains = 8 }

local granted = {}
local function newRegistry(trusted)
    return R.new({
        hasPermission = function(_, key) return granted[key] == true end,
        now = function() return 0 end,
        limits = LIMITS,
        trusted = trusted,
    })
end

-- Item IDs carry the owner prefix their page does; the schema requires it, and
-- it is what stops one resource from patching another's rows by guessing an id.
local function page(id, title)
    local owner, name = id:match('^(.-):(.*)$')
    return { id = id, title = title or 'Page', items = {
        { id = owner .. ':row_' .. name, label = 'Row', kind = 'action' },
    } }
end
local function definition(ace)
    return { ace = ace, actions = setmetatable({}, { __index = function()
        return { ace = ace, clientAction = 'noop' }
    end }) }
end

-- The default is to enforce
--
-- `trusted` is optional, and an engine that defaulted to exempt would make every
-- consumer trusted the moment someone forgot to pass it.

local plain = newRegistry()
assert(plain:defineNamespace('plain_resource', { ace = 'plain.open' }))
for index = 1, LIMITS.menusPerOwner do
    local registered, why = plain:register('plain_resource',
        page('plain_resource:p' .. index), definition('plain.open'))
    check(registered, ('an untrusted owner registers up to its limit: page %d rejected with %s')
        :format(index, tostring(why)))
end
local ok, reason = plain:register('plain_resource', page('plain_resource:over'), definition('plain.open'))
equal(ok, false, 'the untrusted owner is refused at the limit')
equal(reason, 'Maximum 3 menus per resource',
    'and is told the number it hit, so the refusal is diagnosable from the console alone')

-- Trusted skips the counts

local trustedNames = { studio_resource = true }
local registry = newRegistry(function(owner) return trustedNames[owner] == true end)
assert(registry:defineNamespace('studio_resource', { ace = 'studio.open' }))
assert(registry:defineNamespace('other_resource', { ace = 'other.open' }))

-- Past menusPerOwner (3) and past totalMenus (7) in one owner, which is the pair
-- of checks the exemption wraps.
local BEYOND = 12
for index = 1, BEYOND do
    local registered, why = registry:register('studio_resource',
        page('studio_resource:p' .. index), definition('studio.open'))
    check(registered, ('a trusted owner passes the limit: page %d rejected with %s')
        :format(index, tostring(why)))
end

-- The exemption is per owner. An untrusted resource sharing the registry is still
-- held to its own count -- and is NOT pushed over the total by the trusted
-- owner's menus either, because for it the total check is live and already
-- exceeded. Both refusals are the point: exempting one owner must not silently
-- exempt or silently starve another.
local firstOther, firstWhy = registry:register('other_resource',
    page('other_resource:p1'), definition('other.open'))
equal(firstOther, false, 'an untrusted owner in the same registry is still counted')
equal(firstWhy, 'Maximum 7 registered menus',
    'against the global total, which the trusted owner has already passed')

-- Revoking trust takes effect on the next registration rather than at next boot:
-- the result is not cached anywhere.
trustedNames.studio_resource = nil
local afterRevoke, revokeWhy = registry:register('studio_resource',
    page('studio_resource:after'), definition('studio.open'))
equal(afterRevoke, false, 'an owner that stops being trusted stops being exempt immediately')
equal(revokeWhy, 'Maximum 3 menus per resource', 'and lands on the ordinary per-owner limit')
trustedNames.studio_resource = true

-- What trust does NOT buy
--
-- Everything below runs against the TRUSTED owner. These are the assertions that
-- would catch `trusted` growing from "skip two counts" into a bypass.

local malformed, malformedWhy = registry:register('studio_resource',
    { id = 'studio_resource:bad', title = 'Page', items = 'not a list' }, definition('studio.open'))
equal(malformed, false, 'schema validation still refuses a malformed menu from a trusted owner')
check(type(malformedWhy) == 'string' and malformedWhy ~= '',
    'with a reason, not a bare false')

local duplicate, duplicateWhy = registry:register('studio_resource',
    page('studio_resource:p1'), definition('studio.open'))
equal(duplicate, false, 'a duplicate id is still refused for a trusted owner')
equal(duplicateWhy, 'Menu already registered; unregister before replacing',
    'rather than being silently replaced, which would swap a page under a live player')

local stolen = registry:register('studio_resource', page('other_resource:stolen'), definition('studio.open'))
equal(stolen, false, 'a trusted owner still cannot register a menu id inside another owner namespace')

local noNamespace = registry:register('undeclared_resource',
    page('undeclared_resource:p1'), definition('undeclared.open'))
equal(noNamespace, false, 'trust does not substitute for declaring a namespace first')

-- Permission. The trusted owner's pages are subject to exactly the ACE checks an
-- untrusted owner's are: denied means absent from the snapshot, not greyed out.
granted = {}
local denied = registry:snapshot(1)
equal(#denied.menus, 0, 'a player with no ACE receives none of the trusted owner pages')

granted = { ['studio.open'] = true }
local allowedSnapshot = registry:snapshot(1)
equal(#allowedSnapshot.menus, BEYOND,
    'and with the ACE receives exactly the pages that were registered -- no more')
for _, menu in ipairs(allowedSnapshot.menus) do
    check(menu.id:match('^studio_resource:'),
        'every page in the snapshot belongs to the owner that registered it: ' .. tostring(menu.id))
end

-- The root namespace ACE is still a gate ABOVE the per-page ACE, for trusted
-- owners too. This needs a page whose own ACE differs from the namespace's,
-- otherwise granting the page implicitly grants the namespace and the test
-- proves nothing: here the player holds the page permission and not the
-- namespace one, and must still receive nothing.
assert(registry:register('studio_resource', page('studio_resource:gated'), definition('studio.page')))
granted = { ['studio.page'] = true }
equal(#registry:snapshot(2).menus, 0,
    'holding a page ACE without the namespace ACE yields no menus, trusted owner or not')
granted = { ['studio.open'] = true, ['studio.page'] = true }
equal(#registry:snapshot(2).menus, BEYOND + 1,
    'and holding both yields every page, so the gate above was the only thing withholding them')

print(('Passed %d registry limit checks'):format(checks))
