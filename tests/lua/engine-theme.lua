-- Standalone from resource root:
--   bunx --bun fengari tests/lua/engine-theme.lua
--
-- Oracle for per-namespace menu theming.
--
-- The feature: a resource that creates menus can make them look like its own, and
-- tLib supplies the default for anything that does not. There are three layers --
-- interface default, namespace theme, per-page override -- and the two that live
-- on the server are what this suite covers.
--
-- Two things are being held down here. The first is the validator, which is an
-- allowlist mirroring tLib/client/web/src/menu/branding.ts: the accent is written into a CSS custom
-- property and the banner into an <img src>, so the rejections matter more than the
-- acceptances and are enumerated one by one. The second is that a theme is scoped
-- like everything else in this engine -- a resource themes its own namespace, not
-- someone else's, and a theme for a page the player cannot see never travels.


Platform = { now = function() return 0 end }
assert(loadfile('shared/lib/menu/schema.lua', 't', _G),
    'shared/lib/menu/schema.lua not found -- run this suite from the tLib resource root')()
assert(loadfile('server/lib/menu/registry.lua', 't', _G))()

local S = MenuSchema
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

-- ── The validator ───────────────────────────────────────────────────────────

local accepted = {
    { name = 'a six-digit accent', theme = { accent = '#2865aa' } },
    { name = 'uppercase hex', theme = { accent = '#2865AA' } },
    { name = 'a game texture banner', theme = { banner = { dictionary = 'shopui_title_supermod', texture = 'shopui_title_supermod' } } },
    { name = 'an https banner url', theme = { banner = { url = 'https://example.com/logo.png' } } },
    { name = 'a registered theme id', theme = { theme = 'midnight' } },
    -- A skin alone is a complete theme: switching the menu to the legacy vMenu
    -- presentation is not a colour choice and must not require one.
    { name = 'the default skin', theme = { skin = 'default' } },
    { name = 'the vmenu test skin', theme = { skin = 'vmenu' } },
    { name = 'a skin beside colours', theme = { accent = '#123456', skin = 'vmenu' } },
    { name = 'all four together', theme = { accent = '#123456', theme = 'midnight', skin = 'default',
        banner = { url = 'https://cdn.example.com/a/b.png?v=2' } } },
}
for _, case in ipairs(accepted) do
    local clean, reason = S.theme(case.theme)
    check(clean ~= nil, 'accepts ' .. case.name .. ': ' .. tostring(reason))
end

-- The returned theme is a copy: a caller that keeps its table and mutates it later
-- must not be able to reach inside the registry through it.
local source = { banner = { dictionary = 'abc', texture = 'def' } }
local copied = S.theme(source)
source.banner.texture = 'mutated'
equal(copied.banner.texture, 'def', 'the validated theme is a copy, not the caller\'s table')

local rejected = {
    { name = 'nil', theme = nil },
    { name = 'a non-table', theme = '#2865aa' },
    { name = 'an empty table', theme = {} },
    { name = 'an unknown field', theme = { accent = '#2865aa', colour = 'blue' } },
    -- Accents. Anything but #rrggbb could carry a second declaration, a url() or
    -- an image-set() into the panel's own style attribute.
    { name = 'a named colour', theme = { accent = 'red' } },
    { name = 'three-digit hex', theme = { accent = '#abc' } },
    { name = 'eight-digit hex', theme = { accent = '#2865aaff' } },
    { name = 'a missing hash', theme = { accent = '2865aa' } },
    { name = 'rgb()', theme = { accent = 'rgb(1,2,3)' } },
    { name = 'a var()', theme = { accent = 'var(--x)' } },
    { name = 'an accent with a trailing declaration', theme = { accent = '#2865aa; background:url(x)' } },
    { name = 'a non-hex digit', theme = { accent = '#2865ag' } },
    -- Banners.
    { name = 'a banner that is not a table', theme = { banner = 'logo.png' } },
    { name = 'an empty banner', theme = { banner = {} } },
    { name = 'a banner with a stray third key', theme = { banner = { dictionary = 'a', texture = 'b', scale = 2 } } },
    { name = 'a url beside a dictionary', theme = { banner = { url = 'https://a.example/b', dictionary = 'a' } } },
    { name = 'http', theme = { banner = { url = 'http://example.com/logo.png' } } },
    { name = 'a data url', theme = { banner = { url = 'data:image/png;base64,AAAA' } } },
    { name = 'a javascript url', theme = { banner = { url = 'javascript:alert(1)' } } },
    { name = 'a protocol-relative url', theme = { banner = { url = '//example.com/logo.png' } } },
    { name = 'credentials in the url', theme = { banner = { url = 'https://user:pass@example.com/logo.png' } } },
    { name = 'a bare userinfo url', theme = { banner = { url = 'https://evil@example.com/logo.png' } } },
    { name = 'a url with no host', theme = { banner = { url = 'https:///logo.png' } } },
    { name = 'a space in the url', theme = { banner = { url = 'https://example.com/a b.png' } } },
    { name = 'a quote in the url', theme = { banner = { url = 'https://example.com/a".png' } } },
    { name = 'an over-long url', theme = { banner = { url = 'https://example.com/' .. string.rep('a', 513) } } },
    { name = 'a slash in the dictionary', theme = { banner = { dictionary = 'a/b', texture = 'c' } } },
    { name = 'a traversal in the texture', theme = { banner = { dictionary = 'a', texture = '..' } } },
    { name = 'an empty dictionary', theme = { banner = { dictionary = '', texture = 'c' } } },
    { name = 'an over-long dictionary', theme = { banner = { dictionary = string.rep('a', 65), texture = 'c' } } },
    { name = 'a non-string texture', theme = { banner = { dictionary = 'a', texture = 7 } } },
    -- Theme ids.
    { name = 'an empty theme id', theme = { theme = '' } },
    { name = 'a theme id with a space', theme = { theme = 'my theme' } },
    { name = 'an over-long theme id', theme = { theme = string.rep('a', 65) } },
    -- Skins. A closed set, because the value selects a stylesheet rather than
    -- supplying one a value: an unknown skin has no rules to match and would leave
    -- the panel unstyled, so it is refused at the boundary instead.
    { name = 'an unknown skin', theme = { skin = 'vmenu2' } },
    { name = 'a skin in the wrong case', theme = { skin = 'vMenu' } },
    { name = 'an empty skin', theme = { skin = '' } },
    { name = 'a non-string skin', theme = { skin = true } },
    { name = 'a skin that is a table', theme = { skin = { 'vmenu' } } },
}
for _, case in ipairs(rejected) do
    local clean, reason = S.theme(case.theme)
    check(clean == nil, 'rejects ' .. case.name)
    check(type(reason) == 'string' and #reason > 0, 'and says why for ' .. case.name)
end

-- ── Themes in the snapshot ──────────────────────────────────────────────────

local granted = {}
local function newRegistry()
    return MenuRegistry.new({
        hasPermission = function(_, key) return granted[key] == true end,
        now = function() return 0 end,
        log = function() end,
    })
end

local function page(id, title)
    return { id = id, title = title or 'Page', items = {
        { id = id:gsub(':.*', '') .. ':row_' .. id:gsub('.*:', ''), label = 'Row', kind = 'action' },
    } }
end
-- Every row gets the same permission as its page; this suite is about themes, and
-- per-row permission filtering is registry-authority.lua's subject.
local function definition(ace, theme)
    return { ace = ace, theme = theme, actions = setmetatable({}, { __index = function()
        return { ace = ace, clientAction = 'noop' }
    end }) }
end

local registry = newRegistry()
check(registry:defineNamespace('blue_resource', { ace = 'blue.open', theme = { accent = '#2865aa' } }),
    'a namespace declares a theme at definition time')
check(registry:defineNamespace('plain_resource', { ace = 'plain.open' }),
    'and another declares none at all')

local badTheme, badReason = registry:defineNamespace('bad_resource', { ace = 'bad.open', theme = { accent = 'red' } })
equal(badTheme, false, 'a namespace with an invalid theme is refused')
equal(badReason, 'theme.accent must be a #rrggbb colour',
    'at registration, with the field named, rather than silently at runtime in a browser console')

assert(registry:register('blue_resource', page('blue_resource:home'), definition('blue.home')))
assert(registry:register('blue_resource', page('blue_resource:admin'),
    definition('blue.admin', { accent = '#aa2828' })))
assert(registry:register('plain_resource', page('plain_resource:home'), definition('plain.home')))

granted = { ['blue.open'] = true, ['blue.home'] = true, ['blue.admin'] = true,
    ['plain.open'] = true, ['plain.home'] = true }
local snapshot = registry:snapshot(1)
check(snapshot.themes ~= nil, 'the snapshot carries themes')
equal(snapshot.themes.owners.blue_resource.accent, '#2865aa', 'the namespace theme travels under its owner')
equal(snapshot.themes.owners.plain_resource, nil, 'a namespace that declared none contributes nothing')
equal(snapshot.themes.menus['blue_resource:admin'].accent, '#aa2828', 'a page override travels under the page id')
equal(snapshot.themes.menus['blue_resource:home'], nil, 'a page without an override contributes nothing')

-- A theme is not a way to learn a page exists. Revoking the page revokes its theme.
granted['blue.admin'] = nil
local narrowed = registry:snapshot(1)
equal(narrowed.themes.menus['blue_resource:admin'], nil, 'the theme of a page the player cannot see does not travel')
equal(narrowed.themes.owners.blue_resource.accent, '#2865aa', 'while the namespace theme still does')

-- Losing the namespace entirely takes its theme with it.
granted['blue.open'], granted['blue.home'] = nil, nil
local plainOnly = registry:snapshot(1)
equal(plainOnly.themes, nil, 'with nothing themed left visible, themes is absent rather than empty')
check(#plainOnly.grants + #plainOnly.menus > 0, 'even though the player can still see other menus')

-- ── Re-theming, and who may do it ───────────────────────────────────────────

granted = { ['blue.open'] = true, ['blue.home'] = true, ['blue.admin'] = true,
    ['plain.open'] = true, ['plain.home'] = true }

check(registry:setNamespaceTheme('blue_resource', { accent = '#00ff00' }), 'a namespace can be re-themed')
equal(registry:snapshot(1).themes.owners.blue_resource.accent, '#00ff00', 'and the new theme travels')

local invalid, invalidReason = registry:setNamespaceTheme('blue_resource', { accent = 'nope' })
equal(invalid, false, 'an invalid re-theme is refused')
check(invalidReason ~= nil, 'with a reason')
equal(registry:snapshot(1).themes.owners.blue_resource.accent, '#00ff00',
    'and leaves the previous theme in place rather than clearing it')

check(registry:setNamespaceTheme('blue_resource', nil), 'a namespace theme can be cleared')
equal(registry:snapshot(1).themes.owners.blue_resource, nil, 'after which its pages fall back to the default')

-- Scoping. A resource may theme what it owns and nothing else.
local foreign, foreignReason = registry:setMenuTheme('plain_resource', 'blue_resource:home', { accent = '#000000' })
equal(foreign, false, 'a resource cannot theme another resource\'s page')
equal(foreignReason, 'Unknown menu', 'and is told nothing about whether that page exists')
local missing = registry:setMenuTheme('blue_resource', 'blue_resource:nosuchpage', { accent = '#000000' })
equal(missing, false, 'a page that does not exist is refused the same way')

check(registry:setMenuTheme('blue_resource', 'blue_resource:home', { banner = { url = 'https://example.com/a.png' } }),
    'a page the resource owns can be themed')
equal(registry:snapshot(1).themes.menus['blue_resource:home'].banner.url, 'https://example.com/a.png',
    'and the override travels')
check(registry:setMenuTheme('blue_resource', 'blue_resource:home', nil), 'a page override can be cleared')
equal(registry:snapshot(1).themes.menus['blue_resource:home'], nil, 'after which the page follows its namespace again')

-- Skins travel the same three layers as colours do, and are the one field a
-- resource is expected to set on its own without setting any colour at all: a
-- server switching to the legacy vMenu presentation for a comparison has not
-- chosen an accent, and must not be made to.
check(registry:setNamespaceTheme('blue_resource', { skin = 'vmenu' }), 'a namespace can declare a skin alone')
equal(registry:snapshot(1).themes.owners.blue_resource.skin, 'vmenu', 'and the skin travels under its owner')
equal(registry:snapshot(1).themes.owners.blue_resource.accent, nil,
    'without inventing a colour the resource never asked for')
check(registry:setMenuTheme('blue_resource', 'blue_resource:admin', { skin = 'default', accent = '#aa2828' }),
    'a page can override the skin its namespace chose')
equal(registry:snapshot(1).themes.menus['blue_resource:admin'].skin, 'default',
    'and the page override travels under the page id')

local badSkin, badSkinReason = registry:setNamespaceTheme('blue_resource', { skin = 'vmenu2' })
equal(badSkin, false, 'an unknown skin is refused')
equal(badSkinReason, "theme.skin must be 'default' or 'vmenu'", 'naming the field and listing what is allowed')
equal(registry:snapshot(1).themes.owners.blue_resource.skin, 'vmenu',
    'and leaves the previous skin in place rather than clearing it')

-- A skin is presentation, not authority: it must be subject to the same
-- permission filtering every other theme field is.
granted['blue.admin'] = nil
equal(registry:snapshot(1).themes.menus['blue_resource:admin'], nil,
    'the skin of a page the player cannot see does not travel either')
granted['blue.admin'] = true
check(registry:setNamespaceTheme('blue_resource', nil), 'and a skinned namespace theme still clears')

-- An unthemed engine is the same engine. Nothing above may have made themes
-- mandatory for a resource that never asked for them.
local bare = newRegistry()
assert(bare:defineNamespace('plain_resource', { ace = 'plain.open' }))
assert(bare:register('plain_resource', page('plain_resource:home'), definition('plain.home')))
local bareSnapshot = bare:snapshot(1)
equal(bareSnapshot.themes, nil, 'a registry where nobody themed anything sends no themes at all')
equal(#bareSnapshot.menus, 1, 'and is otherwise unchanged')

print(('PASS engine theme: %d checks, %d accepted shapes / %d rejected, three layers, scoped per owner')
    :format(checks, #accepted, #rejected))
