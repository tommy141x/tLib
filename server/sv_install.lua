-- What this copy of tLib is, and whether all of it arrived.
--
--   * the install check, at boot, for a copy whose files are missing or cut short;
--   * `tlib_version`, one paste-able answer to "which tLib, which door, who needs what".
--
-- Lua, and its own file, because it must run when server/dist/bundle.js did not: a missing
-- or truncated bundle is exactly the install it has to describe, and tRadio could only
-- describe it for tRadio's own users.

local RESOURCE = GetCurrentResourceName()

-- Same page imports.lua names. The page, not the zip: it is where "Source code" and
-- tLib.zip sit side by side, and picking the wrong one is how most of these start.
local RELEASES_URL = 'https://github.com/tommy141x/tLib/releases/latest'

-- Floors, not sizes. Each is far under what the release ships (bundle 353 KB, page script
-- 574 KB, stylesheet 64 KB, HUD helper 6 KB) so a smaller rebuild never trips one, and far
-- over what a transfer that stops at the first 0x1A byte leaves behind.
local BUNDLE = { path = 'server/dist/bundle.js', floor = 100000 }
local UI_FLOORS = { js = 100000, css = 10000, hud = 1000 }

local function fileProblem(path, floor)
    local content = LoadResourceFile(RESOURCE, path)
    if content == nil then return 'missing' end
    if content == '' then return 'empty' end
    if #content < floor then
        return ('cut short: %d bytes, the release has more than %d'):format(#content, floor)
    end
end

--- Every problem with this copy's built files, as `{ path, problem }` pairs.
local function installProblems()
    local found = {}
    local function check(path, floor)
        local problem = fileProblem(path, floor)
        if problem then found[#found + 1] = { path = path, problem = problem } end
    end

    check(BUNDLE.path, BUNDLE.floor)
    check('client/ui/assets/hud-layout.js', UI_FLOORS.hud)

    -- index.html is committed, so it is present in a source download too. What it names is
    -- the gitignored, content-hashed part.
    local page = LoadResourceFile(RESOURCE, 'client/ui/index.html')
    if page == nil or page == '' then
        found[#found + 1] = { path = 'client/ui/index.html', problem = page == nil and 'missing' or 'empty' }
        return found
    end
    for asset in page:gmatch('src="%.?/?(assets/[^"]+%.js)"') do check('client/ui/' .. asset, UI_FLOORS.js) end
    for asset in page:gmatch('href="%.?/?(assets/[^"]+%.css)"') do check('client/ui/' .. asset, UI_FLOORS.css) end
    return found
end

local function warnIfIncomplete()
    -- imports.lua is in every copy, source or release. If even that cannot be read,
    -- LoadResourceFile cannot see into this resource here and every probe would call a
    -- healthy install broken. Silence is the only safe answer.
    local canary = LoadResourceFile(RESOURCE, 'fxmanifest.lua')
    if canary == nil or canary == '' then return end

    local problems = installProblems()
    if #problems == 0 then return end

    local missing = false
    for _, p in ipairs(problems) do if p.problem == 'missing' then missing = true end end

    local rule = ('^1[tLib] %s^0'):format(('-'):rep(60))
    print(rule)
    print('^1[tLib] This copy of tLib is incomplete or damaged:^0')
    for _, p in ipairs(problems) do
        print(('^1[tLib]   %s/%s: %s^0'):format(RESOURCE, p.path, p.problem))
    end
    if missing then
        print('^1[tLib] Missing built files is what the green "Code" button downloads: the source,^0')
        print('^1[tLib] without the build. Download tLib.zip (not "Source code") instead:^0')
    else
        print('^1[tLib] A file that arrived cut short was damaged in transfer. Panel upload tools often^0')
        print('^1[tLib] do this to binary files. Download tLib.zip again and extract it on the server,^0')
        print('^1[tLib] or upload it by SFTP:^0')
    end
    print(('^1[tLib]   %s^0'):format(RELEASES_URL))
    print('^1[tLib] Replace the whole tLib folder, then restart the server.^0')
    print(rule)
end

warnIfIncomplete()

-- tlib_version

--- The comparison imports.lua refuses with, copied rather than shared: that file runs in a
--- consumer's VM against whatever tLib is installed, so it cannot depend on a file this
--- release adds. tests/lua/tlib-version.lua feeds both the same pairs.
local function parseVer(s)
    s = tostring(s or ''):gsub('^v', '')
    local parts = {}
    for n in s:gmatch('%d+') do parts[#parts + 1] = tonumber(n) end
    while #parts < 3 do parts[#parts + 1] = 0 end
    return parts
end

local function olderThan(installed, required)
    local cur, req = parseVer(installed), parseVer(required)
    for i = 1, 3 do
        if cur[i] ~= req[i] then return cur[i] < req[i] end
    end
    return false
end

local function meta(resource, key, index)
    local ok, value = pcall(GetResourceMetadata, resource, key, index or 0)
    if ok and type(value) == 'string' and value ~= '' then return value end
end

local function identity(resource)
    local text = meta(resource, 'version') or '?'
    local build = meta(resource, 'tlib_build')
    return build and ('%s build %s'):format(text, build) or text
end

--- Resources that name tLib as a dependency or pin a version of it. Stopped ones are
--- listed: a consumer that refused to start because tLib is too old is one of them.
local function consumers()
    local found = {}
    for index = 0, GetNumResources() - 1 do
        local name = GetResourceByFindIndex(index)
        if name and name ~= RESOURCE then
            local depends = false
            local ok, count = pcall(GetNumResourceMetadata, name, 'dependency')
            for d = 0, (ok and count or 0) - 1 do
                if meta(name, 'dependency', d) == RESOURCE then depends = true end
            end
            local pin = meta(name, 'tlib_min_version')
            if depends or pin then found[#found + 1] = { name = name, pin = pin } end
        end
    end
    table.sort(found, function(a, b) return a.name:lower() < b.name:lower() end)
    return found
end

--- No address anywhere in it: the whole point is that it can be pasted into a ticket.
local function doorLine()
    local ok, status = pcall(function() return exports[RESOURCE]:GetHttpStatus() end)
    local netPort = GetConvar('netPort', '?')
    if not ok or type(status) ~= 'table' then
        return ('door=unknown (the HTTP bridge is not up) netPort=%s'):format(netPort)
    end
    local source = status.publicUrlOverride == 'rejected' and 'detected (tlib_http_public_url was rejected)'
        or status.publicUrlOverride == 'used' and 'override'
        or status.publicUrlState == 'ready' and 'detected'
        or tostring(status.publicUrlState)
    return ('door=%s listener=%s netPort=%s publicUrl=%s reachedFromOutside=%s'):format(
        tostring(status.door or 'none'), tostring(status.listenerState), netPort, source,
        status.reachedFromOutside and 'yes' or 'no')
end

local function report()
    local commit = meta(RESOURCE, 'tlib_commit')
    print(('[tLib] tLib %s%s @ %s | %s'):format(
        identity(RESOURCE),
        commit and (' commit ' .. commit) or '',
        tostring(GetResourcePath(RESOURCE)),
        doorLine()))

    local installed = meta(RESOURCE, 'version') or '0'
    for _, consumer in ipairs(consumers()) do
        local verdict = 'no tlib_min_version'
        if consumer.pin then
            verdict = ('needs tLib >= %s: %s'):format(
                consumer.pin, olderThan(installed, consumer.pin) and 'TOO OLD' or 'ok')
        end
        local state = GetResourceState(consumer.name)
        print(('[tLib]   %s %s | %s%s'):format(
            consumer.name, identity(consumer.name), verdict,
            state == 'started' and '' or (' | ' .. tostring(state))))
    end
end

-- Console only. `restricted` lets a player with the ACE run it, and the answer holds a
-- filesystem path, so the source is checked as well.
RegisterCommand('tlib_version', function(source)
    if (tonumber(source) or 0) ~= 0 then return end
    local ok, err = pcall(report)
    if not ok then print(('^1[tLib] tlib_version failed partway through: %s^0'):format(tostring(err))) end
end, true)
