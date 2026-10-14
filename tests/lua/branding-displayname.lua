-- Oracle for StudioBranding.displayName (shared/sh_branding.lua) and for the
-- one place it is rendered: the startup banner's title line.
--
-- Loads the REAL shared/sh_branding.lua and the REAL versioncheck module, the
-- way tests/lua/versioncheck.lua does, so this suite is an oracle for the shared
-- rule itself rather than for a mocked stand-in. A display name is text and only
-- text, so the assertions here are about what gets PRINTED -- and, just as
-- importantly, about what does not change: the figlet wordmark is still spelled
-- from the technical resource name, never from the title.
local report = print
local passed = 0

local function test(name, fn)
    local ok, err = pcall(fn)
    if not ok then
        report('FAIL ' .. name .. ': ' .. tostring(err))
        os.exit(1)
    end
    passed = passed + 1
    report('PASS ' .. name)
end

-- Minimal host: just enough natives for sh_branding.lua on its own.
local function branding(resource, metaName, authors)
    local meta = { name = metaName, author = authors or {} }
    function GetCurrentResourceName() return resource end
    function GetNumResourceMetadata(_, key)
        if key == 'name' then return meta.name ~= nil and 1 or 0 end
        return #(meta[key] or {})
    end
    function GetResourceMetadata(_, key, index)
        if key == 'name' then return index == 0 and meta.name or nil end
        return (meta[key] or {})[index + 1]
    end
    StudioBranding = nil
    assert(loadfile('shared/sh_branding.lua'))()
    return StudioBranding
end

test('displayName returns the manifest name when the manifest declares one', function()
    local b = branding('tels', "Tommy's ELS")
    assert(b.displayName('tels') == "Tommy's ELS", b.displayName('tels'))
    -- The apostrophe survives the Lua escape in the manifest, which is the one
    -- character in these titles that can silently break a single-quoted string.
    assert(b.displayName('tels'):find("'", 1, true), 'apostrophe lost')
end)

test('displayName falls back to the resource name when absent, empty or blank', function()
    for _, value in ipairs({ 'ABSENT', '', '   ', '\t\n' }) do
        local b = branding('tDetector', value ~= 'ABSENT' and value or nil)
        assert(b.displayName('tDetector') == 'tDetector',
            ('%q yielded %q'):format(value, tostring(b.displayName('tDetector'))))
    end
end)

test('displayName trims surrounding whitespace rather than rendering it', function()
    local b = branding('tUnit', "  Tommy's Unit Numbers  ")
    assert(b.displayName('tUnit') == "Tommy's Unit Numbers", ('%q'):format(b.displayName('tUnit')))
end)

-- A host that cannot answer must land on the resource name, not crash startup --
-- the same contract isStudioResource has, and for the same reason: this runs
-- while the server is booting.
test('displayName does not throw when the metadata natives are missing', function()
    local b = branding('tAFK', 'ignored')
    GetResourceMetadata = nil
    assert(b.displayName('tAFK') == 'tAFK')
    GetResourceMetadata = function() error('native exploded') end
    assert(b.displayName('tAFK') == 'tAFK')
    GetResourceMetadata = function() return {} end
    assert(b.displayName('tAFK') == 'tAFK')
    for _, bad in ipairs({ '', 0, {}, true }) do
        local out = b.displayName(bad ~= '' and bad or '')
        assert(out == '', ('%s yielded %q'):format(tostring(bad), tostring(out)))
    end
    assert(b.displayName(nil) == '')
end)

-- displayName and isStudioResource must stay independent axes: a title cannot
-- buy branding, and branding does not invent a title. Both are in this file so
-- that is cheap to get wrong.
test('a display title grants no branding and branding invents no title', function()
    local b = branding('tMenu', 'TIMMYG Studios', { 'Someone else' })
    assert(b.isStudioResource('tMenu') == false, 'a name claimed the studio')
    local c = branding('tChirp', nil, { 'TIMMYG Studios' })
    assert(c.isStudioResource('tChirp') == true)
    assert(c.displayName('tChirp') == 'tChirp', 'branding invented a title')
end)

-- The banner
--
-- Full versioncheck host, trimmed from tests/lua/versioncheck.lua's fixture.
local function fixture(resource, metaName, authors)
    local clock, jobs, output, handlers = 0, {}, {}, {}
    local meta = { name = metaName, author = authors or { 'TIMMYG Studios' } }
    function GetCurrentResourceName() return resource end
    function GetNumResourceMetadata(_, key)
        if key == 'name' then return meta.name ~= nil and 1 or 0 end
        return #(meta[key] or {})
    end
    function GetResourceMetadata(_, key, index)
        if key == 'version' then return '1.0.0' end
        if key == 'name' then return index == 0 and meta.name or nil end
        return (meta[key] or {})[index + 1]
    end
    function GetResourceState() return 'started' end
    function GetGameTimer() return clock end
    function AddEventHandler(event, fn)
        handlers[event] = handlers[event] or {}
        local handle = { fn = fn }
        table.insert(handlers[event], handle)
        return handle
    end
    function RemoveEventHandler(handle) handle.fn = nil end
    function TriggerEvent(event, ...)
        for _, handle in ipairs(handlers[event] or {}) do
            if handle.fn then handle.fn(...) end
        end
    end
    function CreateThread(fn) jobs[#jobs + 1] = { at = clock, thread = coroutine.create(fn) } end
    function Wait(ms) return coroutine.yield(ms) end
    function PerformHttpRequest() end
    StudioBranding = nil
    assert(loadfile('shared/sh_branding.lua'))()
    StudioApi = nil
    GetConvar = nil
    assert(loadfile('shared/sh_api.lua'))()
    local realPrint = print
    print = function(line) output[#output + 1] = line end
    json = { decode = function(body) return body end }
    local vc = assert(loadfile('shared/imports/versioncheck/server.lua'))()
    local function run(untilTime)
        while true do
            table.sort(jobs, function(a, b) return a.at < b.at end)
            if not jobs[1] or jobs[1].at > untilTime then break end
            local job = table.remove(jobs, 1)
            clock = job.at
            local ok, delay = coroutine.resume(job.thread)
            assert(ok, delay)
            if coroutine.status(job.thread) ~= 'dead' then
                job.at = clock + delay
                jobs[#jobs + 1] = job
            end
        end
        clock = untilTime
        print = realPrint
    end
    return { vc = vc, run = run, text = function() return table.concat(output, '\n') end }
end

local function contains(text, part) assert(text:find(part, 1, true), 'Missing: ' .. part) end
local function excludes(text, part) assert(not text:find(part, 1, true), 'Unexpected: ' .. part) end
local function current(cb) cb({ version = '1.0.0' }) end

test('the banner prints the manifest title and still spells the wordmark', function()
    local f = fixture('tDetector', "Tommy's Radar Detector")
    f.vc({ name = 'tDetector', current = '1.0.0', fetch = current })
    f.run(1100)
    contains(f.text(), "Tommy's Radar Detector")
    -- The figlet has no space or apostrophe glyph and a title rendered as art
    -- measures 173 columns, so the art is still 'tDetector'. `_/_/_/_/` is the
    -- crossbar row of its leading lowercase t.
    contains(f.text(), '_/_/_/_/')
end)

test('an unbranded resource gets the title as plain text, with no art', function()
    local f = fixture('tELS', "Tommy's ELS", { 'Someone else' })
    f.vc({ name = 'tELS', current = '1.0.0', fetch = current })
    f.run(1100)
    contains(f.text(), "Tommy's ELS")
    excludes(f.text(), '_/_/')
end)

test('a title equal to the resource name is not printed twice', function()
    local f = fixture('tLib', 'tLib')
    f.vc({ name = 'tLib', current = '1.0.0', fetch = current })
    f.run(1100)
    local text = f.text()
    local count = 0
    for line in text:gmatch('[^\r\n]+') do
        -- The plain word on a line of its own, i.e. the title line. The figlet
        -- rows spell it in `_/`, so they cannot match.
        if line:gsub('%^%d', ''):gsub('\27%[[%d;]*m', ''):match('^%s*tLib%s*') then
            count = count + 1
        end
    end
    assert(count == 0, 'tLib printed a redundant title line ' .. count .. ' time(s)')
end)

-- The regression this guards: migrating a stored or wire value to the title.
-- The version check's request URL is keyed on the PRODUCT SLUG, and the slug is
-- the technical name. A title that reached it would 404 every update check.
test('the display title never reaches the studios request URL', function()
    local f = fixture('tELS', "Tommy's ELS")
    local seen
    PerformHttpRequest = function(url) seen = url end
    f.vc({ name = 'tELS', current = '1.0.0', fetch = f.vc.studios('tELS', '1.0.0') })
    assert(seen == 'https://timmygstudios.com/api/products/tELS/changelog?since=1.0.0&limit=10',
        'slug drifted to a display name: ' .. tostring(seen))
end)

report(('Passed %d branding display-name tests'):format(passed))
