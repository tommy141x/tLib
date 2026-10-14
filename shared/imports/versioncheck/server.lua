-- tlib.versioncheck. See tLib/server.lua and tRadio/server/sv_version.lua for use.

-- Eligibility comes from the resource loading this module, never from opts.name
-- or opts.author: branding policy, not an authenticity boundary.
--
-- The rule is loaded as the exact file the menu registry's limit exemption uses,
-- the way shared/imports/menu/shared.lua loads shared/lib/menu/schema.lua. One copy is what
-- stops the banner and the exemption disagreeing about who counts as the studio.
-- LoadResourceFile reads from disk, so tLib need not have started.
if type(StudioBranding) ~= 'table' then
    local path = 'shared/sh_branding.lua'
    local source = assert(LoadResourceFile('tLib', path), 'Missing tLib module: ' .. path)
    assert(load(source, '@@tLib/' .. path))()
end

-- Same mechanism, same reason: the `studios` provider below talks to the same
-- host the marketplace does, so it must honour `tlib_api_base_url` too.
-- Without this the convar was only half a switch -- installs went to a local dev
-- worker while the version check and its changelog still hit production.
if type(StudioApi) ~= 'table' then
    local path = 'shared/sh_api.lua'
    local source = assert(LoadResourceFile('tLib', path), 'Missing tLib module: ' .. path)
    assert(load(source, '@@tLib/' .. path))()
end

local function hasStudioAuthor()
    return StudioBranding.isStudioResource(GetCurrentResourceName())
end

-- Lean figlet font data; row 0 is blank and skipped at render.

local L = {}
L[33] = {'         ', '    _/   ', '   _/    ', '  _/     ', '         ', '_/       '}
L[35] = {'               ', '     _/  _/    ', '  _/_/_/_/_/   ', '   _/  _/      ', '_/_/_/_/_/     ', ' _/  _/        '}
L[38] = {'              ', '     _/       ', '  _/  _/      ', '   _/_/  _/   ', '_/    _/      ', ' _/_/  _/     '}
L[40] = {'       _/  ', '    _/     ', '   _/      ', '  _/       ', ' _/        ', '_/         '}
L[41] = {'      _/    ', '       _/   ', '      _/    ', '     _/     ', '    _/      ', '   _/       '}
L[43] = {'             ', '      _/     ', '     _/      ', '_/_/_/_/_/   ', '   _/        ', '  _/         '}
L[44] = {'        ', '        ', '        ', '        ', '        ', '   _/   '}
L[45] = {'             ', '             ', '             ', '_/_/_/_/_/   ', '             ', '             '}
L[46] = {'     ', '     ', '     ', '     ', '     ', '_/   '}
L[47] = {'                 ', '            _/   ', '         _/      ', '      _/         ', '   _/            ', '_/               '}
L[48] = {'           ', '     _/    ', '  _/  _/   ', ' _/  _/    ', '_/  _/     ', ' _/        '}
L[49] = {'         ', '    _/   ', ' _/_/    ', '  _/     ', ' _/      ', '_/       '}
L[50] = {'              ', '      _/_/    ', '   _/    _/   ', '      _/      ', '   _/         ', '_/_/_/_/      '}
L[51] = {'              ', '    _/_/_/    ', '         _/   ', '    _/_/      ', '       _/     ', '_/_/_/        '}
L[52] = {'           ', '  _/  _/   ', ' _/  _/    ', '_/_/_/_/   ', '   _/      ', '  _/       '}
L[53] = {'               ', '    _/_/_/_/   ', '   _/          ', '  _/_/_/       ', '       _/      ', '_/_/_/         '}
L[54] = {'              ', '     _/_/_/   ', '  _/          ', ' _/_/_/       ', '_/    _/      ', ' _/_/         '}
L[55] = {'               ', '  _/_/_/_/_/   ', '         _/    ', '      _/       ', '   _/          ', '_/             '}
L[56] = {'             ', '     _/_/    ', '  _/    _/   ', '   _/_/      ', '_/    _/     ', ' _/_/        '}
L[57] = {'              ', '      _/_/    ', '   _/    _/   ', '    _/_/_/    ', '       _/     ', '_/_/_/        '}
L[65] = {'              ', '      _/_/    ', '   _/    _/   ', '  _/_/_/_/    ', ' _/    _/     ', '_/    _/      '}
L[66] = {'              ', '    _/_/_/    ', '   _/    _/   ', '  _/_/_/      ', ' _/    _/     ', '_/_/_/        '}
L[67] = {'              ', '     _/_/_/   ', '  _/          ', ' _/           ', '_/            ', ' _/_/_/       '}
L[68] = {'              ', '    _/_/_/    ', '   _/    _/   ', '  _/    _/    ', ' _/    _/     ', '_/_/_/        '}
L[69] = {'               ', '    _/_/_/_/   ', '   _/          ', '  _/_/_/       ', ' _/            ', '_/_/_/_/       '}
L[70] = {'               ', '    _/_/_/_/   ', '   _/          ', '  _/_/_/       ', ' _/            ', '_/             '}
L[71] = {'              ', '     _/_/_/   ', '  _/          ', ' _/  _/_/     ', '_/    _/      ', ' _/_/_/       '}
L[72] = {'               ', '    _/    _/   ', '   _/    _/    ', '  _/_/_/_/     ', ' _/    _/      ', '_/    _/       '}
L[73] = {'             ', '    _/_/_/   ', '     _/      ', '    _/       ', '   _/        ', '_/_/_/       '}
L[74] = {'              ', '         _/   ', '        _/    ', '       _/     ', '_/    _/      ', ' _/_/         '}
L[75] = {'               ', '    _/    _/   ', '   _/  _/      ', '  _/_/         ', ' _/  _/        ', '_/    _/       '}
L[76] = {'           ', '    _/     ', '   _/      ', '  _/       ', ' _/        ', '_/_/_/_/   '}
L[77] = {'                 ', '    _/      _/   ', '   _/_/  _/_/    ', '  _/  _/  _/     ', ' _/      _/      ', '_/      _/       '}
L[78] = {'                 ', '    _/      _/   ', '   _/_/    _/    ', '  _/  _/  _/     ', ' _/    _/_/      ', '_/      _/       '}
L[79] = {'             ', '     _/_/    ', '  _/    _/   ', ' _/    _/    ', '_/    _/     ', ' _/_/        '}
L[80] = {'              ', '    _/_/_/    ', '   _/    _/   ', '  _/_/_/      ', ' _/           ', '_/            '}
L[81] = {'             ', '     _/_/    ', '  _/    _/   ', ' _/  _/_/    ', '_/    _/     ', ' _/_/  _/    '}
L[82] = {'              ', '    _/_/_/    ', '   _/    _/   ', '  _/_/_/      ', ' _/    _/     ', '_/    _/      '}
L[83] = {'               ', '      _/_/_/   ', '   _/          ', '    _/_/       ', '       _/      ', '_/_/_/         '}
L[84] = {'             ', '_/_/_/_/_/   ', '   _/        ', '  _/         ', ' _/          ', '_/           '}
L[85] = {'              ', '   _/    _/   ', '  _/    _/    ', ' _/    _/     ', '_/    _/      ', ' _/_/         '}
L[86] = {'               ', '  _/      _/   ', ' _/      _/    ', '_/      _/     ', ' _/  _/        ', '  _/           '}
L[87] = {'                   ', '  _/          _/   ', ' _/          _/    ', '_/    _/    _/     ', ' _/  _/  _/        ', '  _/  _/           '}
L[88] = {'                 ', '    _/      _/   ', '     _/  _/      ', '      _/         ', '   _/  _/        ', '_/      _/       '}
L[89] = {'             ', '_/      _/   ', ' _/  _/      ', '  _/         ', ' _/          ', '_/           '}
L[90] = {'                 ', '    _/_/_/_/_/   ', '         _/      ', '      _/         ', '   _/            ', '_/_/_/_/_/       '}
L[97] = {'             ', '             ', '    _/_/_/   ', ' _/    _/    ', '_/    _/     ', ' _/_/_/      '}
L[98] = {'             ', '    _/       ', '   _/_/_/    ', '  _/    _/   ', ' _/    _/    ', '_/_/_/       '}
L[99] = {'             ', '             ', '    _/_/_/   ', ' _/          ', '_/           ', ' _/_/_/      '}
L[100] = {'              ', '         _/   ', '    _/_/_/    ', ' _/    _/     ', '_/    _/      ', ' _/_/_/       '}
L[101] = {'            ', '            ', '    _/_/    ', ' _/_/_/_/   ', '_/          ', ' _/_/_/     '}
L[102] = {'             ', '      _/_/   ', '   _/        ', '_/_/_/_/     ', ' _/          ', '_/           '}
L[103] = {'              ', '              ', '     _/_/_/   ', '  _/    _/    ', ' _/    _/     ', '  _/_/_/      '}
L[104] = {'             ', '    _/       ', '   _/_/_/    ', '  _/    _/   ', ' _/    _/    ', '_/    _/     '}
L[105] = {'         ', '    _/   ', '         ', '  _/     ', ' _/      ', '_/       '}
L[106] = {'             ', '        _/   ', '             ', '      _/     ', '     _/      ', '    _/       '}
L[107] = {'            ', '    _/      ', '   _/  _/   ', '  _/_/      ', ' _/  _/     ', '_/    _/    '}
L[108] = {'         ', '    _/   ', '   _/    ', '  _/     ', ' _/      ', '_/       '}
L[109] = {'                   ', '                   ', '   _/_/_/  _/_/    ', '  _/    _/    _/   ', ' _/    _/    _/    ', '_/    _/    _/     '}
L[110] = {'             ', '             ', '   _/_/_/    ', '  _/    _/   ', ' _/    _/    ', '_/    _/     '}
L[111] = {'            ', '            ', '    _/_/    ', ' _/    _/   ', '_/    _/    ', ' _/_/       '}
L[112] = {'               ', '               ', '     _/_/_/    ', '    _/    _/   ', '   _/    _/    ', '  _/_/_/       '}
L[113] = {'             ', '             ', '    _/_/_/   ', ' _/    _/    ', '_/    _/     ', ' _/_/_/      '}
L[114] = {'              ', '              ', '   _/  _/_/   ', '  _/_/        ', ' _/           ', '_/            '}
L[115] = {'              ', '              ', '     _/_/_/   ', '  _/_/        ', '     _/_/     ', '_/_/_/        '}
L[116] = {'           ', '   _/      ', '_/_/_/_/   ', ' _/        ', '_/         ', ' _/_/      '}
L[117] = {'             ', '             ', '  _/    _/   ', ' _/    _/    ', '_/    _/     ', ' _/_/_/      '}
L[118] = {'              ', '              ', ' _/      _/   ', '_/      _/    ', ' _/  _/       ', '  _/          '}
L[119] = {'                      ', '                      ', ' _/      _/      _/   ', '_/      _/      _/    ', ' _/  _/  _/  _/       ', '  _/      _/          '}
L[120] = {'              ', '              ', '   _/    _/   ', '    _/_/      ', ' _/    _/     ', '_/    _/      '}
L[121] = {'              ', '              ', '   _/    _/   ', '  _/    _/    ', ' _/    _/     ', '  _/_/_/      '}
L[122] = {'              ', '              ', '   _/_/_/_/   ', '      _/      ', '   _/         ', '_/_/_/_/      '}

local function glyphRight(glyph, r)
    local row = glyph[r]
    local trimmed = row:gsub('%s+$', '')
    return #trimmed
end

local function glyphLeft(glyph, r)
    local row = glyph[r]
    local _, pos = row:find('%S')
    return pos or (#row + 1)
end

-- Italic-aware kerning: the tightest diagonal gap between each pair.
local function renderLean(text, c1, c2, split)
    if not hasStudioAuthor() then return { tostring(text) } end
    c1 = c1 or '^9'
    c2 = c2 or '^7'
    split = split or 1

    local glyphs = {}
    for i = 1, #text do
        local code = string.byte(text, i)
        local glyph = L[code]
        if glyph then
            glyphs[#glyphs + 1] = glyph
        end
    end

    local kerns = {}
    for i = 1, #glyphs - 1 do
        local prev = glyphs[i]
        local next = glyphs[i + 1]
        local prevW = #prev[1]
        local nextW = #next[1]
        local minGap = 999
        for r = 1, 6 do
            local rEdge = glyphRight(prev, r)
            local lEdge = glyphLeft(next, r)
            if rEdge > 0 and lEdge <= nextW then
                local gap = (prevW - rEdge) + (lEdge - 1)
                if gap < minGap then minGap = gap end
            end
        end
        kerns[i] = (minGap > 1 and minGap < 999) and (minGap - 1) or 0
    end

    local rendered = {}
    for gi = 1, #glyphs do
        rendered[gi] = {}
        local glyph = glyphs[gi]
        local w = #glyph[1]
        for r = 1, 6 do
            local row = glyph[r]
            if #row < w then row = row .. string.rep(' ', w - #row) end
            rendered[gi][r] = row
        end
    end

    for i = 1, #glyphs - 1 do
        local kern = kerns[i]
        if kern > 0 then
            for r = 1, 6 do
                local leftRow = rendered[i][r]
                local leftContent = #leftRow:gsub('%s+$', '')
                local leftTrail = #leftRow - leftContent
                local fromLeft = math.min(kern, leftTrail)
                if fromLeft > 0 then
                    rendered[i][r] = leftRow:sub(1, #leftRow - fromLeft)
                end
                local fromRight = kern - fromLeft
                if fromRight > 0 then
                    rendered[i + 1][r] = rendered[i + 1][r]:sub(fromRight + 1)
                end
            end
        end
    end

    local rows = {}
    for r = 1, 6 do rows[r] = '' end

    local charIdx = 0
    for i = 1, #text do
        local code = string.byte(text, i)
        if L[code] then
            charIdx = charIdx + 1
            local color = (i <= split) and c1 or c2
            for r = 1, 6 do
                rows[r] = rows[r] .. color .. rendered[charIdx][r]
            end
        end
    end

    local out = {}
    for r = 2, 6 do
        out[#out + 1] = rows[r]:gsub('%s+$', '') .. '^7'
    end
    return out
end

local BOX_TL = '\xe2\x95\xad'
local BOX_TR = '\xe2\x95\xae'
local BOX_BL = '\xe2\x95\xb0'
local BOX_BR = '\xe2\x95\xaf'
local BOX_H  = '\xe2\x94\x80'
local BOX_V  = '\xe2\x94\x82'

local GREY = '\x1b[37m'
local TEAL = '\x1b[38;2;0;180;210m'
local RESET = '\x1b[0m'

-- Width of a banner line, with colour codes removed.
--
-- COUNTS CODEPOINTS, NOT COLUMNS. This looks like a bug and is not: a terminal
-- draws columns, and the Unicode width tables call U+2705 two of them.
-- The console these banners are actually read in renders that glyph in ONE
-- cell, so column counting puts every line carrying one a place out. Changing
-- this to measure columns makes the box worse, and a test built from the width
-- tables will agree with the tables rather than with the console.
--
-- So: do not 'fix' this again from first principles. If a banner ever does look
-- crooked, screenshot the console first -- the terminal is the oracle here, not
-- the standard.
local function visLen(s)
    local stripped = s:gsub('%^%d', ''):gsub('%[[%d;]*m', '')
    local count = 0
    local i = 1
    local len = #stripped
    while i <= len do
        local b = stripped:byte(i)
        if b < 0x80 then i = i + 1
        elseif b < 0xE0 then i = i + 2
        elseif b < 0xF0 then i = i + 3
        else i = i + 4 end
        count = count + 1
    end
    return count
end

local function drawBox(lines, accent)
    accent = accent or '^7'
    local maxW = 0
    for _, line in ipairs(lines) do
        local w = visLen(line)
        if w > maxW then maxW = w end
    end

    local pad = maxW + 2
    print(accent .. BOX_TL .. string.rep(BOX_H, pad) .. BOX_TR)
    for _, line in ipairs(lines) do
        local deficit = maxW - visLen(line)
        print(accent .. BOX_V .. ' ' .. line .. string.rep(' ', deficit) .. ' ' .. accent .. BOX_V)
    end
    print(accent .. BOX_BL .. string.rep(BOX_H, pad) .. BOX_BR)
end

-- Accept the site's abbreviated tags (v6.3) as well as SemVer. Never
-- extract digits from arbitrary labels or let prerelease digits become a patch.
local function parseVer(s)
    if type(s) ~= 'string' then return nil end
    s = s:match('^%s*(.-)%s*$'):gsub('^[vV]', '')
    local base, build = s:match('^(.-)%+(.+)$')
    if base then
        if not build:match('^[%w.-]+$') or build:find('..', 1, true)
            or build:match('^%.') or build:match('%.$') then return nil end
        s = base
    end
    local core, pre = s:match('^(.-)%-(.+)$')
    core = core or s
    if not core:match('^%d+%.?%d*%.?%d*$') or core:match('%.$')
        or core:find('..', 1, true) then return nil end
    local parts = {}
    for n in core:gmatch('%d+') do
        if #n > 1 and n:sub(1, 1) == '0' then return nil end
        parts[#parts + 1] = n
    end
    if #parts > 3 then return nil end
    while #parts < 3 do parts[#parts + 1] = '0' end
    if pre then
        if not pre:match('^[%w.-]+$') or pre:find('..', 1, true)
            or pre:match('^%.') or pre:match('%.$') then return nil end
        parts.pre = {}
        for id in pre:gmatch('[^.]+') do
            if id:match('^%d+$') and #id > 1 and id:sub(1, 1) == '0' then return nil end
            parts.pre[#parts.pre + 1] = id
        end
    end
    return parts
end

local function numericCompare(a, b)
    if #a ~= #b then return #a < #b and -1 or 1 end
    if a == b then return 0 end
    return a < b and -1 or 1
end

local function isOutdated(current, latest)
    local cur, new = parseVer(current), parseVer(latest)
    if not cur or not new then return false end
    for i = 1, 3 do
        local cmp = numericCompare(cur[i], new[i])
        if cmp ~= 0 then return cmp < 0 end
    end
    if not cur.pre then return false end
    if not new.pre then return true end
    for i = 1, math.max(#cur.pre, #new.pre) do
        local a, b = cur.pre[i], new.pre[i]
        if not a then return true end
        if not b then return false end
        if a ~= b then
            local an, bn = a:match('^%d+$'), b:match('^%d+$')
            if an and bn then return numericCompare(a, b) < 0 end
            if an or bn then return an ~= nil end
            return a < b
        end
    end
    return false
end

local function stripV(s)
    if type(s) ~= 'string' then return tostring(s or '?') end
    return s:gsub('^[vV]', '')
end

-- Flatten changelog markdown so it reads inside the console box: `**text**`
-- loses its markers, and a link becomes its text plus a note, with the URL
-- collected to print below the box and deduplicated against `urlSet`.
local function stripChangelogMarkdown(line, collectedUrls, urlSet)
    -- Links first, so brackets inside link text do not confuse the bold pass.
    -- An unpaired leading `**` is stripped too; authors forget the closer.
    line = line:gsub('%[(.-)%]%((.-)%)', function(text, url)
        if url and url ~= '' and not urlSet[url] then
            urlSet[url] = true
            collectedUrls[#collectedUrls + 1] = url
        end
        return text .. ' (see link below)'
    end)
    line = line:gsub('%*%*', '')
    return line
end

-- Let startup noise settle before printing boxes.
local SETTLE_MS  = 1000
local _settled   = false
local _deadline  = 0
local _pending   = {}
local _isTlib    = GetCurrentResourceName() == 'tLib'
local _tlibDone  = _isTlib -- tLib doesn't wait for itself

AddEventHandler('onResourceStart', function(res)
    if _settled then return end
    if res == GetCurrentResourceName() then return end
    _deadline = GetGameTimer() + SETTLE_MS
end)

if not _isTlib then
    -- Already printed, which happens on a restart after boot.
    if GetResourceState('tLib') == 'started' then
        _tlibDone = true
    end
    AddEventHandler('tlib:versioncheckDone', function()
        _tlibDone = true
        if _settled and _pending then
            for _, fn in ipairs(_pending) do fn() end
            _pending = nil
        end
    end)
end

CreateThread(function()
    local maxDeadline = GetGameTimer() + 35000
    _deadline = GetGameTimer() + SETTLE_MS
    while not _settled or not _tlibDone do
        Wait(200)
        local now = GetGameTimer()
        if now >= maxDeadline then _tlibDone = true end
        if now >= _deadline or now >= maxDeadline then _settled = true end
        if _settled and _tlibDone and _pending then
            local pending = _pending
            _pending = nil
            for _, fn in ipairs(pending) do fn() end
        end
    end
end)

local function afterStartup(fn)
    if _settled and _tlibDone then fn()
    else
        if _pending then _pending[#_pending + 1] = fn end
    end
end

local function buildOutput(opts, release, infoValues)
    local resource = GetCurrentResourceName()
    -- `name` is the WORDMARK -- what the figlet spells, a short identifier-shaped
    -- token. `title` is the human-visible product title from the manifest's
    -- `name` directive. They are deliberately separate; see titleLine below.
    local name    = opts.name or resource
    -- displayName falls back to the resource name, so a title EQUAL to it means
    -- the manifest declared nothing worth showing. Treated as absent here rather
    -- than printed: without this, `opts.name` stops reaching the banner on the
    -- unbranded path, which tests/lua/versioncheck.lua guards.
    local title   = StudioBranding.displayName(resource)
    if title == '' or title == resource then title = nil end
    local current = opts.current or '?'
    local author  = opts.author
    local color   = opts.color or TEAL

    -- The display title is NOT put through the figlet. That font has glyphs for
    -- letters and digits only -- no space, no apostrophe -- so art silently
    -- renders "Tommy's Radar Detector" as TommysRadarDetector, and MEASURED it
    -- is 173 columns wide against tDetector's 74, which wraps and destroys the
    -- box on any normal console. So the wordmark stays short and the title is a
    -- text line under it. Omitted when it would just repeat the wordmark.
    local titleLine = nil

    local bannerLines = {}
    if not hasStudioAuthor() then
        -- Already plain text here, so there is no width or glyph cost.
        bannerLines[1] = color .. (title or name) .. '^7'
    elseif opts.banner then
        for row in opts.banner:gmatch('[^\r\n]+') do
            bannerLines[#bannerLines + 1] = row
        end
        if title and title ~= name then titleLine = color .. title .. '^7' end
    else
        local split = 1
        local _, upper = name:find('^%l+')
        if upper then split = upper end
        local rows = renderLean(name, color, '^7', split)
        for _, row in ipairs(rows) do bannerLines[#bannerLines + 1] = row end
        if title and title ~= name then titleLine = color .. title .. '^7' end
    end

    local authorLine = nil
    if author then
        authorLine = color .. 'By ' .. '^7' .. author
    end

    local contentLines = {}
    local lines = contentLines
    local urls = {}
    local urlSet = {}
    if not release or not release.version then
        lines[#lines + 1] = color .. '  Version:  ' .. GREY .. 'v' .. stripV(current)
        if release and release.status then
            lines[#lines + 1] = GREY .. '  Updates:  ' .. release.status
        else
            lines[#lines + 1] = '^1  Updates:  Could not check for updates'
        end
    elseif not parseVer(current) or not parseVer(release.version) then
        lines[#lines + 1] = color .. '  Version:  ' .. GREY .. 'v' .. stripV(current)
        lines[#lines + 1] = '^3  Updates:  Could not compare versions'
    elseif isOutdated(current, release.version) then
        local versionLine = color .. '  Version:  ' .. GREY .. 'v' .. stripV(current) .. ' ' .. color .. '→ ' .. color .. 'v' .. stripV(release.version)
        if release.url and release.url ~= '' then
            versionLine = versionLine .. ' ' .. GREY .. '(see link below)'
            if not urlSet[release.url] then
                urlSet[release.url] = true
                urls[#urls + 1] = release.url
            end
        end
        lines[#lines + 1] = versionLine
    else
        lines[#lines + 1] = color .. '  Version:  ' .. color .. 'v' .. stripV(current) .. ' ' .. GREY .. '— up to date'
    end

    local maxLineW = 45
    if infoValues then
        for _, entry in ipairs(infoValues) do
            if entry.value and entry.value ~= '' then
                local key = entry.key or '?'
                local valColor = entry.color or GREY
                local padded = key .. ':' .. string.rep(' ', math.max(1, 10 - #key - 1))
                local val = tostring(entry.value)
                local first = true
                for vline in val:gmatch('[^\r\n]+') do
                    local words = {}
                    for w in vline:gmatch('%S+') do words[#words + 1] = w end
                    local cur = ''
                    for _, w in ipairs(words) do
                        if cur ~= '' and #cur + 1 + #w > maxLineW then
                            if first then
                                lines[#lines + 1] = color .. '  ' .. padded .. valColor .. cur
                                first = false
                            else
                                lines[#lines + 1] = '  ' .. string.rep(' ', 10) .. valColor .. cur
                            end
                            cur = w
                        else
                            cur = cur ~= '' and (cur .. ' ' .. w) or w
                        end
                    end
                    if cur ~= '' then
                        if first then
                            lines[#lines + 1] = color .. '  ' .. padded .. valColor .. cur
                            first = false
                        else
                            lines[#lines + 1] = '  ' .. string.rep(' ', 10) .. valColor .. cur
                        end
                    end
                end
            end
        end
    end

    if release and release.changelog and release.changelog ~= '' and isOutdated(current, release.version) then
        lines[#lines + 1] = ''
        for line in release.changelog:gmatch('[^\r\n]+') do
            local clean = stripChangelogMarkdown(line, urls, urlSet)
            if clean:match('^%s*%d+/%d+/%d+') or clean:match('^%s*v%d') then
                lines[#lines + 1] = color .. '  ' .. clean
            else
                lines[#lines + 1] = GREY .. '  ' .. clean
            end
        end
    end

    lines[#lines + 1] = ''

    local maxW = 0
    for _, line in ipairs(bannerLines) do
        local w = visLen(line)
        if w > maxW then maxW = w end
    end
    if titleLine then
        local w = visLen(titleLine)
        if w > maxW then maxW = w end
    end
    if authorLine then
        local w = visLen(authorLine)
        if w > maxW then maxW = w end
    end
    for _, line in ipairs(contentLines) do
        local w = visLen(line)
        if w > maxW then maxW = w end
    end

    local allLines = {}
    local bannerMaxW = 0
    for _, line in ipairs(bannerLines) do
        local w = visLen(line)
        if w > bannerMaxW then bannerMaxW = w end
    end
    local bannerPad = math.floor((maxW - bannerMaxW) / 2)
    if bannerPad < 0 then bannerPad = 0 end
    for _, line in ipairs(bannerLines) do
        if bannerPad > 0 then
            allLines[#allLines + 1] = string.rep(' ', bannerPad) .. line
        else
            allLines[#allLines + 1] = line
        end
    end

    allLines[#allLines + 1] = ''

    if titleLine then
        local w = visLen(titleLine)
        local pad = math.floor((maxW - w) / 2)
        allLines[#allLines + 1] = string.rep(' ', pad) .. titleLine
    end

    if authorLine then
        local w = visLen(authorLine)
        local pad = math.floor((maxW - w) / 2)
        allLines[#allLines + 1] = string.rep(' ', pad) .. authorLine
    end

    allLines[#allLines + 1] = ''

    for _, line in ipairs(contentLines) do
        allLines[#allLines + 1] = line
    end

    return allLines, urls
end

local function check(opts)
    if not opts or not opts.fetch then return end

    local infoEntries = opts.info or {}
    local infoValues = {}
    local requiredPending = 0
    local fetchDone = false
    local fetchRelease = nil
    local printed = false
    local infoHandlers = {}

    local function tryPrint()
        if printed then return end
        if not fetchDone then return end
        if requiredPending > 0 then return end
        printed = true

        afterStartup(function()
            for _, handler in ipairs(infoHandlers) do RemoveEventHandler(handler) end
            infoHandlers = {}
            if opts.beforePrint then
                local ok, err = pcall(opts.beforePrint, infoValues)
                if not ok then print('^1[versioncheck] beforePrint failed: ' .. tostring(err) .. '^7') end
            end
            local lines, urls = buildOutput(opts, fetchRelease, #infoValues > 0 and infoValues or nil)
            drawBox(lines, opts.color or TEAL)
            if urls then
                for _, url in ipairs(urls) do
                    print('^5' .. url .. '^7')
                end
            end
            if opts.extraUrls then
                for _, url in ipairs(opts.extraUrls) do
                    print('^5' .. url .. '^7')
                end
            end
            if _isTlib then
                TriggerEvent('tlib:versioncheckDone')
            end
        end)
    end

    for i, entry in ipairs(infoEntries) do
        infoValues[i] = { key = entry.key, value = entry.value, color = entry.color }
        if entry.event then
            local received = false
            if entry.required then requiredPending = requiredPending + 1 end
            infoHandlers[#infoHandlers + 1] = AddEventHandler(entry.event, function(val)
                if type(val) == 'table' then
                    infoValues[i].value = tostring(val.value or '')
                    if val.color then infoValues[i].color = val.color end
                else
                    infoValues[i].value = tostring(val)
                end
                if entry.required and not received then
                    received = true
                    requiredPending = requiredPending - 1
                    tryPrint()
                end
            end)
        end
    end

    local function finish(release)
        if fetchDone then return end
        fetchDone = true
        -- A provider may fail or hand back a decoded JSON scalar. An optional
        -- field must not make rendering throw and swallow the completion event.
        if type(release) == 'table' then
            fetchRelease = {}
            for _, key in ipairs({ 'version', 'changelog', 'url', 'status' }) do
                if type(release[key]) == 'string' then fetchRelease[key] = release[key] end
            end
        end
        tryPrint()
    end

    -- Arm the deadline before calling user code, including a throwing provider.
    CreateThread(function()
        Wait(opts.infoTimeout or 30000)
        if not printed then
            requiredPending = 0
            if not fetchDone then finish(nil) else tryPrint() end
        end
    end)
    local ok = pcall(opts.fetch, finish)
    if not ok then finish({ status = 'Update provider failed' }) end
end

local function github(repo)
    return function(cb)
        if not repo or repo == '' then
            return cb({ status = 'GitHub repository not configured' })
        end
        PerformHttpRequest('https://api.github.com/repos/' .. repo .. '/releases/latest', function(status, body)
            if status ~= 200 or not body then return cb(nil) end

            local ok, data = pcall(json.decode, body)
            if not ok or type(data) ~= 'table' or type(data.tag_name) ~= 'string' then return cb(nil) end

            cb({
                version   = data.tag_name,
                changelog = data.body,
                url       = data.html_url,
            })
        end, 'GET', '', {
            ['User-Agent'] = (repo:match('[^/]+$') or 'tLib') .. '-VersionCheck',
            ['Accept'] = 'application/vnd.github.v3+json',
        })
    end
end

-- Shared provider for products published through TIMMYG Studios. tRadio keeps
-- its cached JS provider because the same result also feeds its panel API.
local function studios(product, current)
    return function(cb)
        local encoded = tostring(current or 'unknown'):gsub('[^%w%-._~]', function(c)
            return ('%%%02X'):format(c:byte())
        end)
        -- Same host, same API surface as the marketplace, so the same convar
        -- points it at a dev worker. The `github` provider above deliberately
        -- does NOT follow it -- that one really is GitHub.
        local url = ('%s/api/products/%s/changelog?since=%s&limit=10')
            :format(StudioApi.baseUrl(), product, encoded)
        local resolved = false
        local function finish(release)
            if resolved then return end
            resolved = true
            cb(release)
        end
        PerformHttpRequest(url, function(status, body)
            if status ~= 200 or not body then return finish(nil) end
            local ok, data = pcall(json.decode, body)
            if not ok or type(data) ~= 'table' or type(data.product) ~= 'table'
                or type(data.product.currentVersion) ~= 'string' then
                return finish(nil)
            end
            if data.product.currentVersion == '' then
                return finish({ status = 'No published version available' })
            end
            local parts = {}
            if isOutdated(current, data.product.currentVersion) and type(data.updates) == 'table' then
                for _, update in ipairs(data.updates) do
                    if type(update) == 'table' then
                        parts[#parts + 1] = ('%s - %s'):format(tostring(update.publishedAt or ''):sub(1, 10), tostring(update.version or '?'))
                        local title = type(update.title) == 'string' and update.title or ''
                        local bodyText = type(update.body) == 'string' and update.body or ''
                        local text = title .. (title ~= '' and bodyText ~= '' and '\n' or '') .. bodyText
                        for line in text:gmatch('[^\r\n]+') do
                            local trimmed = line:match('^%s*(.-)%s*$')
                            if trimmed ~= '' then parts[#parts + 1] = '  ' .. trimmed end
                        end
                    end
                end
            end
            finish({ version = data.product.currentVersion, changelog = table.concat(parts, '\n'), url = '' })
        -- Through `StudioApi.headers` and never as a literal table, because
        -- the per-install id has to be on this request as it is on every other
        -- studio call. IT RUNS REGARDLESS OF `tlib_telemetry` — the update
        -- check is not diagnostics and is not gated on consent — which is
        -- exactly why docs/content/convars.mdx has to say out loud that the id
        -- is sent whether or not diagnostics are on. (It said so on the hub's
        -- diagnostics panel too; that panel is gone, the docs section is not.)
        end, 'GET', '', StudioApi.headers({ ['Accept'] = 'application/json' }))
        CreateThread(function()
            Wait(8000)
            finish(nil)
        end)
    end
end

return setmetatable({
    check  = check,
    github = github,
    studios = studios,
    lean   = renderLean,
}, {
    __call = function(_, opts) return check(opts) end,
})
