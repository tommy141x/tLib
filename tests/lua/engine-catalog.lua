-- Standalone from resource root:
--   bunx --bun fengari tests/lua/engine-catalog.lua
--
-- Oracle for tLib's catalog and snapshot hydration.
--
-- This is the file the compact wire format rests on. The server sends one bit per
-- row against a signature the client already holds, so everything here is about a
-- single question: can a player end up holding a row the server did not grant them?
-- A bitmap read one character off, a delta applied to a row outside the grant, a
-- descriptor that collides with a catalogued page, a signature that matched when the
-- definitions did not -- each of those turns a permission check into a coincidence.
--
-- So the assertions are exclusive rather than inclusive: pages and rows are pinned
-- by exact count AND ordered id, because an inclusion check cannot see a row that
-- was never supposed to be there, and an extra row is the failure that matters.
--
-- Runs the REAL shared/lib/menu/schema.lua and shared/lib/menu/catalog.lua. Both are pure Lua, so
-- there is no host to stub at all -- which is itself the property being relied on
-- when a consumer builds the same catalog inside its own VM.


assert(loadfile('shared/lib/menu/schema.lua', 't', _G),
    'shared/lib/menu/schema.lua not found -- run this suite from the tLib resource root')()
assert(loadfile('shared/lib/menu/catalog.lua', 't', _G))()

local S, K = MenuSchema, MenuCatalog

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

--- Exclusive by construction: the count is asserted first, so a page that gained a
--- row cannot slip past by having every expected row still present.
local function ordered(list, field, expected, message)
    equal(#list, #expected, message .. ': count')
    for index, want in ipairs(expected) do
        equal(list[index] and list[index][field], want, ('%s: [%d]'):format(message, index))
    end
end

local function menu(owner, spec)
    local clean, err = S.menu(spec, owner, true)
    if not clean then fail(('fixture %s is not a valid menu: %s'):format(tostring(spec.id), tostring(err))) end
    return clean
end

-- Fingerprints
--
-- The signature is the entire basis for not sending the catalog. If two different
-- trees can produce the same one, a client hydrates somebody else's rows against
-- this player's grant bitmap.

local function tree(label)
    return { { id = 'alpha:one', title = 'One', items = { { id = 'alpha:a', label = label, kind = 'action' } } } }
end

equal(K.fingerprint(tree('Go')), K.fingerprint(tree('Go')), 'the same tree fingerprints the same twice')
check(K.fingerprint(tree('Go')) ~= K.fingerprint(tree('Stop')), 'changing one label changes the signature')
check(K.fingerprint(tree('Go')) ~= K.fingerprint({}), 'and an empty tree is not the same as a populated one')

-- Table key order is not part of the content. If it were, the server and the client
-- could build identical definitions and disagree about them, which would present as
-- an intermittent "catalog mismatch" nobody could reproduce.
local forwards = { id = 'alpha:one', title = 'One', items = {} }
local backwards = { items = {}, title = 'One', id = 'alpha:one' }
equal(K.fingerprint({ forwards }), K.fingerprint({ backwards }), 'key insertion order does not change the signature')

-- 1 and 1.0 are the same Lua value, and the digest says so explicitly rather than
-- by luck: a version that formatted numbers as text would be at the mercy of the
-- host's locale, and a European decimal comma would split every server in half.
equal(K.fingerprint({ 1 }), K.fingerprint({ 1.0 }), 'an integer and its float are one value')
check(K.fingerprint({ 1 }) ~= K.fingerprint({ '1' }), 'but a number is not its string')
check(K.fingerprint({ true }) ~= K.fingerprint({ 'true' }), 'and a boolean is not its name')

-- The checkpoint fires every 256 nodes, so proving it fires at all needs a tree
-- large enough to have 256 nodes -- which is the case it exists for.
local wide = {}
for index = 1, 300 do wide[index] = 'row' .. index end
local sliced = 0
K.fingerprint(wide, function() sliced = sliced + 1 end)
check(sliced > 0, 'the checkpoint is called, so a caller on a game thread can yield')
equal(K.fingerprint(wide, function() end), K.fingerprint(wide),
    'and yielding partway through does not change the answer')

-- Building a catalog

local alphaMenus = {
    menu('alpha', { id = 'alpha:one', title = 'One', rootLabel = 'One Page', items = {
        { id = 'alpha:a', label = 'A', kind = 'action' },
        { id = 'alpha:b', label = 'B', kind = 'action' },
        { id = 'alpha:c', label = 'C', kind = 'select', options = {
            { label = 'Low', value = 1 }, { label = 'High', value = 2 },
        } },
    } }),
    menu('alpha', { id = 'alpha:two', title = 'Two', parent = 'alpha:one', items = {
        { id = 'alpha:d', label = 'D', kind = 'toggle', value = false },
    } }),
}
local bravoMenus = {
    menu('bravo', { id = 'bravo:one', title = 'B One', items = {
        { id = 'bravo:a', label = 'A', kind = 'action' },
    } }),
}

local alpha = assert(K.build(alphaMenus))
local bravo = assert(K.build(bravoMenus))

equal(alpha.byId['alpha:one'], 1, 'a catalog indexes its menus by id')
equal(alpha.byId['alpha:two'], 2, 'in the order they were given')
check(type(alpha.signature) == 'string' and alpha.signature:sub(1, 3) == 'c2:', 'and carries a versioned signature')
check(alpha.signature ~= bravo.signature, 'two resources publish two different signatures')

local dupe, dupeErr = K.build({ alphaMenus[1], alphaMenus[1] })
equal(dupe, nil, 'a catalog refuses two menus with the same id')
check(dupeErr:find('alpha:one', 1, true) ~= nil, 'and names the one it refused')

-- The index IS the protocol: a grant says "menu 2 of alpha's catalog". Reordering
-- the definitions must therefore change the signature, or a server and client that
-- disagree about the order would silently hand out the wrong page's rows.
local swapped = assert(K.build({ alphaMenus[2], alphaMenus[1] }))
check(swapped.signature ~= alpha.signature, 'reordering the definitions changes the signature')

-- Hydration

local catalogs = { alpha = alpha, bravo = bravo }
local function provide(owner) return catalogs[owner] end

-- `pairs` cannot carry a nil, and half of what is worth testing here is a field
-- that is ABSENT rather than wrong. NONE is how an override says so.
local NONE = setmetatable({}, { __tostring = function() return 'NONE' end })

local function compact(overrides)
    local value = {
        version = 1, compact = 1,
        catalogs = { alpha = alpha.signature, bravo = bravo.signature },
        order = { 'bravo:one', 'alpha:one' },
        capabilities = {},
        grants = {
            { owner = 'alpha', menu = 1, items = '101' },
            { owner = 'bravo', menu = 1, items = '1' },
        },
        menus = {},
    }
    for key, override in pairs(overrides or {}) do value[key] = override ~= NONE and override or nil end
    return value
end

local root = { id = 'main', title = 'Main Menu', description = 'Everything' }

local hydrated, err = K.hydrate(compact(), provide, { root = root })
check(hydrated ~= nil, 'a well-formed snapshot hydrates: ' .. tostring(err))
ordered(hydrated.menus, 'id', { 'main', 'bravo:one', 'alpha:one' },
    'the ranked id list orders pages across owners, root first')
equal(hydrated.menus[1].title, 'Main Menu', 'the root page is named by the interface, not by the engine')
equal(hydrated.menus[1].description, 'Everything', 'and described by it')

-- The grant bitmap, character by character. '101' is the whole point of the compact
-- format, and reading it one position off is the failure this pins.
ordered(hydrated.menus[3].items, 'id', { 'alpha:a', 'alpha:c' }, 'the bitmap grants exactly rows 1 and 3')
ordered(hydrated.menus[2].items, 'id', { 'bravo:a' }, 'and the other owner gets its own row')

-- Root rows: a page says what it is called in a list of everything with rootLabel,
-- and falls back to its own title when it has nothing else to say.
ordered(hydrated.menus[1].items, 'label', { 'B One', 'One Page' }, 'root rows use rootLabel where there is one')
ordered(hydrated.menus[1].items, 'menu', { 'bravo:one', 'alpha:one' }, 'and point at their pages')

-- Ordering with no ranking at all is byte order, not table order and not locale
-- order -- the client must reproduce it identically on every machine.
local unranked = assert(K.hydrate(compact({ order = NONE }), provide, { root = root }))
ordered(unranked.menus, 'id', { 'main', 'alpha:one', 'bravo:one' },
    'without a ranked list, pages fall back to raw byte order')

-- Hydration refuses
--
-- Every one of these must produce nil and a message. Hydration is all-or-nothing on
-- purpose: a partially applied snapshot is a player holding rows from a tree the
-- client could not otherwise agree with.

local function refuses(overrides, message, expectation)
    local value, why = K.hydrate(compact(overrides), provide, { root = root })
    equal(value, nil, message)
    checks = checks + 1
    if expectation and not tostring(why):find(expectation, 1, true) then
        fail(('%s: expected a message containing %q, got %q'):format(message, expectation, tostring(why)))
    end
end

refuses({ version = 2 }, 'a snapshot from another protocol version is refused')
refuses({ compact = NONE }, 'a snapshot that is not compact is refused by this path')
refuses({ catalogs = { alpha = 'c2:deadbeef:deadbeef', bravo = bravo.signature } },
    'a signature mismatch is refused', 'alpha')
refuses({ catalogs = { alpha = alpha.signature, bravo = bravo.signature, charlie = 'c2:1:2' } },
    'a catalog nobody published locally is refused', 'charlie')
refuses({ grants = { { owner = 'alpha', menu = 99, items = '1' } } }, 'a grant naming a menu outside the catalog')
refuses({ grants = { { owner = 'alpha', menu = 1, items = '10' } } }, 'a bitmap shorter than the page')
refuses({ grants = { { owner = 'alpha', menu = 1, items = '1011' } } }, 'a bitmap longer than the page')
refuses({ grants = { { owner = 'alpha', menu = 1, items = '1x1' } } }, 'a bitmap that is not bits')
refuses({ grants = { { owner = 'charlie', menu = 1, items = '1' } } }, 'a grant from an owner with no catalog')
refuses({ grants = {
    { owner = 'alpha', menu = 1, items = '101' },
    { owner = 'alpha', menu = 1, items = '111' },
} }, 'the same page granted twice, which is how a wider bitmap would sneak in')
refuses({ capabilities = { thing = 1 } }, 'a capability that is not a boolean')
refuses({ capabilities = { [1] = true } }, 'a capability that is not named')
refuses({ order = { 'alpha:one', 'alpha:one' } }, 'a ranked list that ranks a page twice')
refuses({ order = { 42 } }, 'a ranked list that is not made of ids')

-- A delta is the server changing one granted row. Pointing it at a row the bitmap
-- did not grant would be a grant by another name.
refuses({ grants = { { owner = 'alpha', menu = 1, items = '101', changes = { [2] = { label = 'Sneak' } } } } },
    'a delta aimed at a row outside the grant', 'Delta outside granted items')

-- Same id from two directions. A descriptor is a page nobody catalogued, so it
-- travels in full; letting one shadow a catalogued page would let a resource
-- redefine a page the client already agreed on.
refuses({ menus = { { id = 'alpha:one', title = 'Impostor', items = {} } } },
    'a descriptor colliding with a catalogued page')
refuses({ menus = { { id = 'main', title = 'Impostor', items = {} } } },
    'a descriptor claiming the root page')
refuses({ menus = { { id = 'nocolon', title = 'Impostor', items = {} } } },
    'a descriptor with no namespace at all')

-- Descriptors that are allowed
--
-- The pre-split engine refused every descriptor inside its own namespace, which
-- only worked because it had one consumer. A resource must be able to register a page
-- dynamically; what it must not do is claim an id somebody already holds.

local dynamic = assert(K.hydrate(compact({
    order = { 'bravo:one', 'alpha:one', 'charlie:live' },
    menus = { { id = 'charlie:live', title = 'Live', items = {
        { id = 'charlie:go', label = 'Go', kind = 'action' },
    } } },
}), provide, { root = root }))
ordered(dynamic.menus, 'id', { 'main', 'bravo:one', 'alpha:one', 'charlie:live' },
    'a descriptor from a resource with no catalog at all is hydrated and ranked')
ordered(dynamic.menus[4].items, 'id', { 'charlie:go' }, 'with its rows')
ordered(dynamic.menus[1].items, 'menu', { 'bravo:one', 'alpha:one', 'charlie:live' },
    'and it gets a root row like any other page')

-- Deltas

local delta = assert(K.hydrate(compact({
    grants = {
        { owner = 'alpha', menu = 1, items = '111', changes = { [3] = { rightLabel = 'Now' } } },
        { owner = 'bravo', menu = 1, items = '1' },
    },
}), provide, { root = root }))
equal(delta.menus[3].items[3].rightLabel, 'Now', 'a delta reaches the row it names')
equal(delta.menus[3].items[1].rightLabel, nil, 'and no other row')
equal(alpha.menus[1].items[3].rightLabel, nil, 'and never mutates the catalog it came from')

local swap, swapErr = K.applyDelta(alpha.menus[1].items[3], { options = {
    { label = 'Only', value = 5 },
} }, 'alpha')
check(swap ~= nil, 'a selector\'s options may be replaced wholesale: ' .. tostring(swapErr))
ordered(swap.options, 'value', { 5 }, 'and the replacement is what is left')

local wrongKind = K.applyDelta(alpha.menus[1].items[1], { options = { { label = 'X', value = 1 } } }, 'alpha')
equal(wrongKind, nil, 'options on a row that is not a selector are refused')
local badPatch = K.applyDelta(alpha.menus[1].items[1], { label = 42 }, 'alpha')
equal(badPatch, nil, 'and a delta the schema would have refused at registration is refused here too')

-- Themes
--
-- Themes are permission-filtered with the snapshot, so they have to survive
-- hydration rather than being pushed separately -- a page the player cannot see
-- must not contribute one.

local themed = assert(K.hydrate(compact({
    themes = { owners = { alpha = { accent = '#ff0000' } }, menus = { ['bravo:one'] = { accent = '#00ff00' } } },
}), provide, { root = root }))
equal(themed.themes.owners.alpha.accent, '#ff0000', 'a namespace theme survives hydration')
equal(themed.themes.menus['bravo:one'].accent, '#00ff00', 'as does a per-page one')
equal(hydrated.themes, nil, 'and a snapshot with no themes carries none')

-- Instructions
--
-- A control hint points at a row. If the bitmap dropped that row, the hint is a
-- lie, and a lie about a control is worse than a missing hint.

local hinted = assert(K.build({ menu('alpha', { id = 'alpha:hint', title = 'Hint',
    items = {
        { id = 'alpha:visible', label = 'Visible', kind = 'action' },
        { id = 'alpha:jump', label = 'Jump', kind = 'action', hidden = true },
    },
    instructions = { { control = 'jump', label = 'Jump to it', itemId = 'alpha:jump' } },
}) }))
local hintCatalogs = { alpha = hinted }
local function hintProvide(owner) return hintCatalogs[owner] end
local kept = assert(K.hydrate({ version = 1, compact = 1, catalogs = { alpha = hinted.signature },
    order = { 'alpha:hint' }, capabilities = {}, menus = {},
    grants = { { owner = 'alpha', menu = 1, items = '11' } } }, hintProvide, { root = root }))
equal(#kept.menus[2].instructions, 1, 'an instruction whose row survived is kept')
local dropped = assert(K.hydrate({ version = 1, compact = 1, catalogs = { alpha = hinted.signature },
    order = { 'alpha:hint' }, capabilities = {}, menus = {},
    grants = { { owner = 'alpha', menu = 1, items = '10' } } }, hintProvide, { root = root }))
equal(#dropped.menus[2].instructions, 0, 'an instruction whose row was not granted is dropped with it')

print(('PASS engine catalog: %d checks, signatures / catalog indexing / cross-owner ordering / %d hydration refusals')
    :format(checks, 20))
