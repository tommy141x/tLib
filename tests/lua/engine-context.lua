-- Standalone from resource root:
--   bunx --bun fengari tests/lua/engine-context.lua
--
-- Oracle for tLib's presentation pipeline.
--
-- Presentation is the one stage that is allowed to take rows AWAY and never allowed
-- to add them back. A snapshot says what the server granted; this pass narrows it to
-- what the world currently permits -- the mods this car has, the tints this weapon
-- supports -- and hands the result to the browser. Three things have to hold for
-- that to be safe rather than merely useful:
--
--   * a presenter that breaks costs its own narrowing and nothing else, because the
--     permission-correct fallback is the rows exactly as the server described them;
--   * the cache is keyed on the world and emptied when the world moves, or a row
--     narrowed for the car the player was in survives into the one they are in now;
--   * the contextKey two different worlds produce is never the same string, because
--     that string is the whole basis for refusing an action aimed at something the
--     player has since walked away from.
--
-- Runs the REAL client/lib/menu/context.lua against a stub host, with presenters standing
-- in for the ones a consuming resource registers.


_TLIB_SIDE = 'client'
local clock = 0
Platform = {
    now = function() return clock end,
    createThread = function(fn) fn() end,
    wait = function() end,
}

assert(loadfile('shared/lib/menu/schema.lua', 't', _G),
    'shared/lib/menu/schema.lua not found -- run this suite from the tLib resource root')()
assert(loadfile('shared/lib/menu/catalog.lua', 't', _G))()
assert(loadfile('client/lib/menu/actions.lua', 't', _G))()
assert(loadfile('client/lib/menu/context.lua', 't', _G))()

local S, C = MenuSchema, MenuContext

-- The pipeline reports a broken presenter with print. Captured rather than
-- silenced, because "was it reported?" is half of what makes a guard a guard.
local printed = {}
local realPrint = print
print = function(...)
    local parts = {}
    for index = 1, select('#', ...) do parts[index] = tostring((select(index, ...))) end
    printed[#printed + 1] = table.concat(parts, ' ')
end

local checks = 0
local function fail(message) print = realPrint; error('FAIL: ' .. message, 0) end
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
local function ordered(list, field, expected, message)
    equal(#list, #expected, message .. ': count')
    for index, want in ipairs(expected) do
        equal(list[index] and list[index][field], want, ('%s: [%d]'):format(message, index))
    end
end

local function pageOf(value, id)
    for _, menu in ipairs(value.menus) do if menu.id == id then return menu end end
end

-- The fixture

local function raw()
    return {
        version = 1, visible = true, capabilities = {},
        menus = {
            { id = 'main', title = 'Main', items = {
                { id = 'alpha:open', label = 'Alpha', kind = 'submenu', menu = 'alpha:one' },
            } },
            { id = 'alpha:one', title = 'One', items = {
                { id = 'alpha:a', label = 'A', kind = 'action' },
                { id = 'alpha:tint', label = 'Tint', kind = 'select', value = 2, options = {
                    { label = 'Zero', value = 0 }, { label = 'One', value = 1 }, { label = 'Two', value = 2 },
                } },
            } },
            { id = 'alpha:two', title = 'Two', parent = 'alpha:one', items = {
                { id = 'alpha:b', label = 'B', kind = 'action' },
            } },
            { id = 'bravo:one', title = 'B One', items = {
                { id = 'bravo:a', label = 'A', kind = 'toggle', value = false },
            } },
        },
    }
end

local function reset()
    C.unregister('alpha')
    C.unregister('bravo')
    C.invalidate()
    printed = {}
end

-- Registration

equal(C.count(), 0, 'the engine starts with no presenters, because it has no content of its own')
equal((C.register('', {})), false, 'a presenter needs an owner')
equal((C.register('alpha', 'nope')), false, 'and must be a table')
equal((C.register('alpha', { present = 'nope' })), false, 'and every field it does declare must be a function')
equal(C.count(), 0, 'none of which registered anything')

check(C.register('alpha', {}), 'a presenter that declares nothing at all is valid')
equal(C.count(), 1, 'and is registered')
check(C.register('alpha', { present = function() end }), 'registering the same owner again is allowed')
equal(C.count(), 1, 'and REPLACES rather than stacking, so a reloaded resource narrows once')
check(C.unregister('alpha'), 'unregistering reports that it existed')
equal(C.count(), 0, 'and it is gone')
equal(C.unregister('alpha'), false, 'unregistering it twice is a no-op')

-- Requesting pages

reset()
local all = C.present(raw())
ordered(all.menus, 'id', { 'main', 'alpha:one', 'alpha:two', 'bravo:one' },
    'presenting with no request builds every page')

local one = C.present(raw(), { 'alpha:one' })
ordered(one.menus, 'id', { 'alpha:one' }, 'a request builds exactly the pages asked for')

local missing = C.present(raw(), { 'alpha:nowhere' })
ordered(missing.menus, 'id', {}, 'and a page that does not exist builds nothing rather than failing')

-- Expansion is how a presenter says "you cannot build that page without also
-- rebuilding this one" -- a page whose rows are computed from another page's
-- editor state. The engine asks every presenter, including about pages the
-- expansion itself added.
reset()
local expandedFor = {}
C.register('alpha', { expand = function(id, want)
    expandedFor[#expandedFor + 1] = id
    if id == 'alpha:one' then want('alpha:two') end
    if id == 'alpha:two' then want('bravo:one') end
end })
local expanded = C.present(raw(), { 'alpha:one' })
ordered(expanded.menus, 'id', { 'alpha:one', 'alpha:two' },
    'expansion pulls in the page a presenter asked for')
-- Deliberately NOT transitive: the expansion loop walks a snapshot of the requested
-- set taken before it starts, because adding keys to a table while `pairs` walks it
-- is undefined in Lua. One level is the contract; the alternative is a loop that
-- works until the day it silently does not.
equal(#expandedFor, 1, 'and asks about each originally requested page exactly once')
check(pageOf(expanded, 'bravo:one') == nil, 'expansion is one level deep, by design, not by accident')

-- The authority view
--
-- The second argument every presenter is handed. It is SCOPED TO THE PASS, and that
-- scoping is a performance decision with a correctness contract attached: a
-- presenter that lives in another resource is called across an export boundary,
-- where the host serializes every argument, so handing over the whole tree meant
-- msgpacking the entire catalog once per presenter per pass. Measured against a
-- 215-page consumer catalog: 43-99ms with the whole tree, 0-1ms without it.
--
-- What replaced it has to be pinned exclusively, because the failure mode of
-- getting it wrong is a presenter quietly seeing FEWER pages than it asked about
-- and disabling rows it should not have. So: exactly the pass's pages in `menus`,
-- every authorized id in `ids`, and one raw page at a time from `page`.

reset()
local saw
C.register('alpha', { present = function(value, authority) saw = authority; return value end })

C.present(raw(), { 'alpha:one' })
ordered(saw.menus, 'id', { 'alpha:one' },
    'a presenter is handed exactly the pages this pass is building, and no others')
ordered(saw.ids and (function()
    local list = {}
    for index, id in ipairs(saw.ids) do list[index] = { id = id } end
    return list
end)() or {}, 'id', { 'main', 'alpha:one', 'alpha:two', 'bravo:one' },
    'while `ids` is every authorized page, in snapshot order, for the "does this page exist at all" question')
equal(getmetatable(saw.ids).__jsontype, 'array', 'and is an array, because it is a list')
equal(saw.version, 1, 'the view carries the snapshot version')
equal(saw.visible, true, 'and whether the menu is open')
check(saw.capabilities ~= nil, 'and the capability set')

local fetched = saw.page('alpha:two')
check(fetched ~= nil, 'page() answers for a page this pass did NOT build')
ordered(fetched.items, 'id', { 'alpha:b' }, 'with its rows, which is the whole point of asking')
equal(saw.page('alpha:nowhere'), nil, 'and answers nil for a page nobody granted')
equal(saw.page(nil), nil, 'or for no page at all')

-- Raw, not projected: a presenter counting what is available on another page must
-- count what the server granted, not what some earlier presenter narrowed.
reset()
local rawPage, projected
C.register('alpha', { present = function(value, authority)
    pageOf(value, 'alpha:one').items[1].label = 'narrowed'
    rawPage = authority.page('alpha:one')
    projected = pageOf(value, 'alpha:one')
    return value
end })
C.present(raw(), { 'alpha:one' })
equal(rawPage.items[1].label, 'A', 'page() is the authority form of the page, untouched by this pass')
check(rawPage ~= projected, 'and is never the projection the pass is building')

reset()
C.register('alpha', { present = function(value, authority) saw = authority; return value end })
C.present(raw())
ordered(saw.menus, 'id', { 'main', 'alpha:one', 'alpha:two', 'bravo:one' },
    'a pass with no request IS the whole tree, so `menus` is the whole tree')

-- Expansion decides the pass, so it decides the view too.
reset()
C.register('alpha', {
    expand = function(id, want) if id == 'alpha:one' then want('alpha:two') end end,
    present = function(value, authority) saw = authority; return value end,
})
C.present(raw(), { 'alpha:one' })
ordered(saw.menus, 'id', { 'alpha:one', 'alpha:two' },
    'a page pulled in by expansion is part of the pass, and so is in the view')

-- A broken presenter

reset()
local bravoRan = false
C.register('alpha', {
    expand = function() error('expand exploded', 0) end,
    identity = function() error('identity exploded', 0) end,
    present = function() error('present exploded', 0) end,
    contextKey = function() error('key exploded', 0) end,
})
C.register('bravo', { present = function(value)
    bravoRan = true
    pageOf(value, 'alpha:one').items[1].label = 'Bravo was here'
    return value
end })
local survived = C.present(raw(), { 'alpha:one' })
check(bravoRan, 'a presenter that throws at every stage does not stop the next presenter')
equal(pageOf(survived, 'alpha:one').items[1].label, 'Bravo was here', 'which still narrows')
ordered(pageOf(survived, 'alpha:one').items, 'id', { 'alpha:a', 'alpha:tint' },
    'and the broken presenter costs only its own narrowing: the rows arrive as the server described them')
equal(#printed, 4, 'each failed stage is reported once')
for _, stage in ipairs({ 'expand', 'identity', 'present', 'contextKey' }) do
    local found = false
    for _, line in ipairs(printed) do
        if line:find(stage, 1, true) and line:find('alpha', 1, true) then found = true end
    end
    check(found, 'the report names the stage and the owner: ' .. stage)
end

-- Mutate and return
--
-- A presenter in another resource is called across an export boundary, and on FiveM
-- that boundary COPIES its arguments. A presenter that only mutated in place would
-- narrow a table nobody keeps -- and would do it silently, which is the worst
-- possible way for a permission-shaped feature to fail.

reset()
C.register('alpha', { present = function(value)
    local copy = S.copy(value)
    table.remove(pageOf(copy, 'alpha:one').items, 1)
    return copy
end })
local returned = C.present(raw(), { 'alpha:one' })
ordered(pageOf(returned, 'alpha:one').items, 'id', { 'alpha:tint' },
    'a presenter that works on a copy and returns it has its work carried back')
check(getmetatable(pageOf(returned, 'alpha:one').items) ~= nil,
    'and the array marking is re-applied afterwards, so a copied list still encodes as []')

reset()
C.register('alpha', { present = function() return 'not a snapshot' end })
local rejected = C.present(raw(), { 'alpha:one' })
ordered(pageOf(rejected, 'alpha:one').items, 'id', { 'alpha:a', 'alpha:tint' },
    'a presenter that returns something that is not a snapshot leaves the projection standing')

-- Narrowing rows

reset()
local row = { kind = 'select', value = 2, options = {
    { label = 'Zero', value = 0 }, { label = 'One', value = 1 }, { label = 'Two', value = 2 },
} }
C.narrow(row, function(value) return value ~= 1 end, 'Nothing fits')
ordered(row.options, 'value', { 0, 2 }, 'narrowing keeps exactly the options the predicate accepts')
equal(row.value, 2, 'and a committed value that survived stays committed')
check(not row.disabled, 'and the row is still usable')

C.narrow(row, function(value) return value == 0 end, 'Nothing fits')
equal(row.value, nil, 'a committed value that did not survive is cleared rather than silently moved')
check(not row.disabled, 'but one surviving option is still a usable row')

C.narrow(row, function() return false end, 'Nothing fits')
equal(#row.options, 0, 'narrowing to nothing empties the list')
equal(row.disabled, true, 'and disables the row')
equal(row.description, 'Nothing fits', 'with the reason where the player will read it')

local plain = {}
C.disable(plain, 'Not while driving')
equal(plain.disabled, true, 'disabling sets the flag')
equal(plain.description, 'Not while driving', 'and says why, because a greyed row with no reason reads as a bug')

-- The cache

reset()
local world, asked, invalidated = 'car:1', 0, 0
C.register('alpha', {
    identity = function() return world end,
    invalidate = function() invalidated = invalidated + 1 end,
    present = function(value)
        C.cached('mods', function() asked = asked + 1; return world end)
        return value
    end,
})

C.present(raw(), { 'alpha:one' })
equal(asked, 1, 'the first pass asks the world')
C.present(raw(), { 'alpha:one' })
equal(asked, 1, 'the second pass in the same world does not ask again')

-- Zeroed here, not at registration: registering a presenter invalidates as well, so
-- counting from zero at the top would make the assertion below pass without the
-- world ever having changed. Verified by mutation -- with the counter left alone,
-- deleting the whole notify-on-key-change block still passes.
invalidated = 0
world = 'car:2'
C.present(raw(), { 'alpha:one' })
equal(asked, 2, 'a changed identity empties the cache, so the answer is re-asked')
equal(invalidated, 1, 'and the presenter is told exactly once, because its own cache lives in its own VM and cannot see this')

-- The wipe has to happen BEFORE any presenter runs. The pre-split engine settled the
-- key after the consumer's features had already run, which was harmless only because
-- none of them used the cache -- exactly the kind of latent order dependency a port
-- should not inherit.
local seen = {}
reset()
world = 'car:3'
C.register('alpha', {
    identity = function() return world end,
    present = function(value)
        seen[#seen + 1] = C.cached('world', function() return world end)
        return value
    end,
})
C.present(raw(), { 'alpha:one' })
world = 'car:4'
C.present(raw(), { 'alpha:one' })
equal(seen[1], 'car:3', 'the first pass caches the world it ran in')
equal(seen[2], 'car:4', 'and the second sees the new one on its very first question')

-- An exception never enters the cache: a failed lookup that cached itself would
-- keep failing for as long as the player stayed in the same car.
reset()
local tries = 0
local ok = pcall(C.cached, 'flaky', function() tries = tries + 1; error('no ped', 0) end)
equal(ok, false, 'a cached lookup that throws propagates')
pcall(C.cached, 'flaky', function() tries = tries + 1; return 1 end)
equal(tries, 2, 'and is asked again next time rather than being remembered as broken')

-- Locally held state
--
-- An effect the player turned on is theirs, and has to be on the row BEFORE anyone
-- narrows around it -- a presenter that disables "Infinite Ammo" while it is
-- running needs to see that it is running.

reset()
MenuActions.forOwner('bravo'):publish('a', { value = true })
local order = {}
C.register('alpha', { present = function(value)
    order[#order + 1] = pageOf(value, 'bravo:one').items[1].value
    return value
end })
local decorated = C.present(raw(), { 'bravo:one', 'alpha:one' })
equal(order[1], true, 'stored state is replayed onto the row before presenters run')
equal(pageOf(decorated, 'bravo:one').items[1].value, true, 'and survives the pass')
MenuActions.cleanupAll()

-- Context keys

reset()
C.register('alpha', { contextKey = function(menu) return menu.id == 'alpha:one' and 'car=1' or nil end })
C.register('bravo', { contextKey = function(menu) return menu.id == 'alpha:one' and 'ped=7' or nil end })
local keyed = C.present(raw(), { 'alpha:one', 'alpha:two' })
equal(pageOf(keyed, 'alpha:one').contextKey, 'car=1|ped=7',
    'every presenter\'s identity part joins the page key, in registration order')
equal(pageOf(keyed, 'alpha:two').contextKey, nil,
    'and a page nobody keyed has no key, so navigating to it is not gated on one')

-- A page that keys itself on its own editor state keeps that distinction and gains
-- the world's on top of it, rather than having it replaced.
reset()
C.register('alpha', {
    present = function(value) pageOf(value, 'alpha:one').contextKey = 'slot=3'; return value end,
    contextKey = function() return 'car=1' end,
})
local layered = C.present(raw(), { 'alpha:one' })
equal(pageOf(layered, 'alpha:one').contextKey, 'slot=3|car=1', 'the page\'s own key leads')

-- The browser echoes this back and the client validates it as text of at most 256
-- characters, so with several presenters contributing it has to be bounded here.
-- Digested, never truncated: two different worlds sharing a long prefix would
-- compare equal, and comparing equal is the one thing a context key must never do
-- by accident.
reset()
local long = string.rep('x', 200)
local tail = 'a'
C.register('alpha', { contextKey = function() return long .. tail end })
local digested = C.present(raw(), { 'alpha:one' })
local first = pageOf(digested, 'alpha:one').contextKey
check(#first <= 256, 'an oversized key is bounded')
check(first ~= long .. tail, 'by being digested rather than passed through')
tail = 'b'
local second = pageOf(C.present(raw(), { 'alpha:one' }), 'alpha:one').contextKey
check(first ~= second, 'and two worlds differing only past the truncation point still differ')

reset()
C.register('alpha', { contextKey = function() return '' end })
equal(pageOf(C.present(raw(), { 'alpha:one' }), 'alpha:one').contextKey, nil,
    'an empty identity part contributes nothing at all')

-- Comparison
--
-- C.equal is what decides whether a re-presented page is worth sending to the
-- browser. A version that missed a difference would leave the screen showing a row
-- the game no longer offers.

check(C.equal({ a = 1 }, { a = 1 }), 'equal tables compare equal')
check(not C.equal({ a = 1 }, { a = 2 }), 'a changed value does not')
check(not C.equal({ a = 1 }, { a = 1, b = 2 }), 'nor does an added key')
check(not C.equal({ a = 1, b = 2 }, { a = 1 }), 'nor a removed one')
check(C.equal({ a = { b = { c = 3 } } }, { a = { b = { c = 3 } } }), 'nesting is compared all the way down')
check(not C.equal({ a = { b = { c = 3 } } }, { a = { b = { c = 4 } } }), 'including the deepest value')
check(not C.equal(1, '1'), 'and a number is not its string')

-- Array encoding
--
-- CitizenFX honours __jsontype. A list narrowed to nothing has to reach the browser
-- as [] rather than {}, or the page renders a selector with no list at all.

reset()
C.register('alpha', { present = function(value)
    C.narrow(pageOf(value, 'alpha:one').items[2], function() return false end, 'None')
    return value
end })
local stamped = C.present(raw(), { 'alpha:one' })
local meta = getmetatable(pageOf(stamped, 'alpha:one').items[2].options)
equal(meta and meta.__jsontype, 'array', 'an emptied option list is still an array')
equal(getmetatable(stamped.menus).__jsontype, 'array', 'as is the page list')
equal(getmetatable(pageOf(stamped, 'alpha:one').items).__jsontype, 'array', 'and every page\'s row list')

-- Presentation is not permission
--
-- The narrowed copy must never be fed back into permission or effect
-- reconciliation: a row disabled because the player got out of the car is not a
-- revoked grant, and treating it as one would stop their effects every time they
-- stepped outside.

reset()
local source = raw()
C.register('alpha', { present = function(value)
    pageOf(value, 'alpha:one').items[1].disabled = true
    table.remove(pageOf(value, 'alpha:one').items, 2)
    return value
end })
C.present(source, { 'alpha:one' })
ordered(pageOf(source, 'alpha:one').items, 'id', { 'alpha:a', 'alpha:tint' },
    'the raw snapshot is untouched by a pass that disabled and removed rows')
equal(pageOf(source, 'alpha:one').items[1].disabled, nil, 'right down to the flag')

print = realPrint
print(('PASS engine context: %d checks, registration / expansion / guarded presenters / cache keying / narrowing / context keys')
    :format(checks))
