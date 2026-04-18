-- tlib.versioncheck
-- see tLib/server.lua, tRadio/server/sv_version.lua, tELS/server/sv_version.lua for usage

-- Lean figlet font data (row 0 blank, skipped at render)

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

-- italic-aware kerning: finds tightest diagonal gap between each pair
local function renderLean(text, c1, c2, split)
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

local function visLen(s)
    local stripped = s:gsub('%^%d', ''):gsub('\x1b%[[%d;]*m', '')
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

local function parseVer(s)
    if type(s) ~= 'string' then return { 0, 0, 0 } end
    s = s:gsub('^v', '')
    local parts = {}
    for n in s:gmatch('%d+') do parts[#parts + 1] = tonumber(n) end
    while #parts < 3 do parts[#parts + 1] = 0 end
    return parts
end

local function isOutdated(current, latest)
    local cur = parseVer(current)
    local new = parseVer(latest)
    for i = 1, 3 do
        if cur[i] < new[i] then return true end
        if cur[i] > new[i] then return false end
    end
    return false
end

local function stripV(s)
    if type(s) ~= 'string' then return tostring(s or '?') end
    return s:gsub('^v', '')
end

-- Strip the markdown that commonly appears in changelog bodies so it reads
-- cleanly inside the console box:
--   **text**       → text                      (bold markers, paired or unpaired)
--   [text](url)    → text (see link below)     (url collected for printing outside the box)
-- Seen URLs are deduplicated against `urlSet` so repeated links don't print twice.
local function stripChangelogMarkdown(line, collectedUrls, urlSet)
    -- Convert links first so brackets inside link text don't confuse the bold
    -- pass. Unpaired `**` at the start of a line (common when authors forget
    -- the closing marker) is also stripped.
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

-- wait for startup noise to settle before printing boxes
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
    -- check if tLib already printed (covers resource restart after boot)
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
    _deadline = GetGameTimer() + SETTLE_MS
    while not _settled do
        Wait(200)
        if GetGameTimer() >= _deadline then
            _settled = true
            if _tlibDone and _pending then
                for _, fn in ipairs(_pending) do fn() end
                _pending = nil
            end
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
    local name    = opts.name or GetCurrentResourceName()
    local current = opts.current or '?'
    local author  = opts.author
    local color   = opts.color or TEAL

    local bannerLines = {}
    if opts.banner then
        for row in opts.banner:gmatch('[^\r\n]+') do
            bannerLines[#bannerLines + 1] = row
        end
    else
        local split = 1
        local _, upper = name:find('^%l+')
        if upper then split = upper end
        local rows = renderLean(name, color, '^7', split)
        for _, row in ipairs(rows) do bannerLines[#bannerLines + 1] = row end
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
        lines[#lines + 1] = '^1  Status:   Could not check for updates'
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

    local function tryPrint()
        if printed then return end
        if not fetchDone then return end
        if requiredPending > 0 then return end
        printed = true

        afterStartup(function()
            if opts.beforePrint then opts.beforePrint(infoValues) end
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
            if entry.required then requiredPending = requiredPending + 1 end
            AddEventHandler(entry.event, function(val)
                if type(val) == 'table' then
                    infoValues[i].value = tostring(val.value or '')
                    if val.color then infoValues[i].color = val.color end
                else
                    infoValues[i].value = tostring(val)
                end
                if entry.required then
                    requiredPending = requiredPending - 1
                    tryPrint()
                end
            end)
        end
    end

    opts.fetch(function(release)
        fetchDone = true
        fetchRelease = release
        tryPrint()
    end)

    CreateThread(function()
        Wait(opts.infoTimeout or 30000)
        if not printed then
            fetchDone = true
            requiredPending = 0
            tryPrint()
        end
    end)
end

local function github(repo)
    return function(cb)
        PerformHttpRequest('https://api.github.com/repos/' .. repo .. '/releases/latest', function(status, body)
            if status ~= 200 or not body then return cb(nil) end

            local ok, data = pcall(json.decode, body)
            if not ok or not data then return cb(nil) end

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

return setmetatable({
    check  = check,
    github = github,
    lean   = renderLean,
}, {
    __call = function(_, opts) return check(opts) end,
})
