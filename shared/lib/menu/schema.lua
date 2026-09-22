-- The menu protocol: what a definition may contain, what may cross the wire and
-- how an oversized one is chunked. Pure Lua -- no natives, no Platform, no
-- globals beyond the module table -- so the same file loads inside tLib's VM and
-- inside a consumer's (shared/imports/menu/shared.lua), letting a resource validate a
-- definition before it reaches an export boundary.
--
-- The rules are pinned by their own suite. A "tidier" rewrite is how a
-- permission-relevant check goes missing.

MenuSchema = {}
local S = MenuSchema

S.events = {
    request  = 'tlib:menu:request',
    response = 'tlib:menu:response',
    refresh  = 'tlib:menu:refresh',
    options  = 'tlib:menu:options',
    patch    = 'tlib:menu:patch',
    chunk    = 'tlib:menu:snapshotChunk',
}

-- Ordinary manifests go as one direct event; only unusually large ones fall back
-- to chunking. Chunks are sent without yielding so patches and acknowledgements
-- keep their order.
S.snapshotTransport = { chunkBytes = 65536, directBytes = 524288, maxBytes = 16777216 }
local transport = S.snapshotTransport

-- Only the response event carries a request id; refresh and options are pushes.
local function streamable(event)
    return event == S.events.response or event == S.events.refresh or event == S.events.options
end

local function wireBound(value)
    local kind = type(value)
    if kind == 'string' then return #value + 5 end
    if kind ~= 'table' then return 9 end
    local bytes = 5
    for key, child in pairs(value) do bytes = bytes + wireBound(key) + wireBound(child) end
    return bytes
end
transport.encodedBound = wireBound

function transport.send(event, target, requestId, value, emit)
    if wireBound(value) <= transport.directBytes then
        if event == S.events.response then emit(event, target, requestId, value)
        else emit(event, target, value) end
        return true
    end
    local payload = msgpack.pack(value)
    if #payload > transport.maxBytes then return false, 'Snapshot exceeds transport capacity' end
    transport.serial = (transport.serial or 0) + 1
    local count = math.ceil(#payload / transport.chunkBytes)
    for index = 1, count do
        emit(S.events.chunk, target, transport.serial, event, requestId,
            index, count, #payload, payload:sub((index - 1) * transport.chunkBytes + 1, index * transport.chunkBytes))
    end
    return true
end

-- One transfer at a time: the sender never interleaves chunk sequences. Strict
-- contiguous receipt also rejects duplicate and replayed completed transfers.
function transport.receiver(deliver, schedule, accept)
    local current, last = nil, 0
    local function reset() current = nil end
    local function integer(value, maximum)
        return type(value) == 'number' and value == value and value % 1 == 0 and value >= 1 and value <= maximum
    end
    local function receive(id, event, requestId, index, count, bytes, chunk)
        if not integer(id, 9007199254740991) or id < last
            or not streamable(event)
            or (event == S.events.response and not S.text(requestId, 96))
            or (event ~= S.events.response and requestId ~= nil)
            or not integer(bytes, transport.maxBytes)
            or not integer(count, math.ceil(transport.maxBytes / transport.chunkBytes))
            or count ~= math.ceil(bytes / transport.chunkBytes)
            or not integer(index, count) or type(chunk) ~= 'string'
            or #chunk ~= math.min(transport.chunkBytes, bytes - (index - 1) * transport.chunkBytes) then return end
        if accept and not accept(event, requestId) then return end
        if index == 1 then
            if id <= last then return end
            last = id
            current = { id = id, event = event, requestId = requestId, count = count, bytes = bytes, chunks = {} }
            local token = current
            schedule(function() if current == token then reset() end end)
        end
        local state = current
        if not state or state.id ~= id or state.event ~= event or state.requestId ~= requestId
            or state.count ~= count or state.bytes ~= bytes or index ~= #state.chunks + 1 then return end
        state.chunks[index] = chunk
        if index ~= count then return end
        local payload = table.concat(state.chunks)
        reset()
        local ok, value = pcall(msgpack.unpack, payload)
        if ok and type(value) == 'table' then deliver(event, requestId, value) end
    end
    return receive, reset
end

function S.text(v, max)
    return type(v) == 'string' and #v > 0 and #v <= (max or 128) and not v:find('%c')
end

function S.id(v)
    return S.text(v, 128) and v:match('^[%w_:%-%.]+$') ~= nil
end

-- Several game BOOL natives return 0/1, and 0 is truthy in Lua. Toggle values and
-- saved flags must be real booleans or the protocol rejects the whole page.
function S.bool(v)
    return v == true or v == 1
end

function S.scalar(v)
    return type(v) == 'boolean' or (type(v) == 'string' and #v <= 256)
        or (type(v) == 'number' and v == v and math.abs(v) <= 1e12)
end

-- True for a plain function and for a funcref. A function crossing a FiveM export
-- or event boundary does not arrive as a function: the scheduler packs it as
-- msgpack ext 10 and unpacks it as a table holding `__cfx_functionReference` whose
-- metatable does the round trip, so `type()` answers 'table'. A plain
-- `type(x) == 'function'` gate therefore passes in-process and fails in the
-- running game, which is why no suite could see it.
--
-- getmetatable rather than indexing: `funcref_mt.__index` raises 'Cannot index a
-- funcref', so reading `value.__call` would throw instead of answering. The
-- metatable is type-checked because a `__metatable` field can make getmetatable
-- return something else.
--
-- Never S.copy one: the copy is a plain table with the reference id and no
-- metatable, which is a silently dead handler.
function S.callable(v)
    if type(v) == 'function' then return true end
    if type(v) ~= 'table' and type(v) ~= 'userdata' then return false end
    local mt = getmetatable(v)
    return type(mt) == 'table' and mt.__call ~= nil
end

function S.copy(v)
    if type(v) ~= 'table' then return v end
    local out = {}
    for k, value in pairs(v) do out[k] = S.copy(value) end
    return out
end

function S.value(item, value, presented)
    if item.kind == 'action' then return value == nil end
    if item.kind == 'toggle' then return type(value) == 'boolean' end
    if item.kind == 'slider' then
        return type(value) == 'number' and S.scalar(value) and value % 1 == 0
            and value >= item.min and value <= item.max and (value - item.min) % item.step == 0
    end
    if item.kind == 'select' then
        for _, option in ipairs(item.options or {}) do
            if option.value == value then return option.disabled ~= true end
        end
        if item.range and not presented then
            local range = item.range
            return type(value) == 'number' and S.scalar(value) and value % 1 == 0
                and value >= range.min and value <= range.max and (value - range.min) % range.step == 0
        end
    end
    return false
end

function S.patch(changes)
    if type(changes) ~= 'table' then return nil, 'Invalid patch' end
    local out = {}
    for k, v in pairs(changes) do
        if k == 'value' and S.scalar(v) then out[k] = v
        elseif (k == 'rightLabel' or k == 'icon' or k == 'rightIcon') and type(v) == 'string' and #v <= (k == 'rightLabel' and 128 or 64) and not v:find('%c') then out[k] = v
        elseif k == 'danger' and type(v) == 'boolean' then out[k] = v
        elseif k == 'disabled' and type(v) == 'boolean' then out[k] = v
        elseif k == 'label' and S.text(v, 128) then out[k] = v
        elseif k == 'description' and S.text(v, 512) then out[k] = v
        else return nil, 'Invalid patch field' end
    end
    return out
end

--
-- A namespace may declare a theme, a page may override it, and the interface
-- supplies the default for anything declaring neither.
--
-- The accent is written into a CSS custom property and the banner into an
-- <img src>, so both are allowlists of the exact shapes they may take rather than
-- sanitizers, mirroring branding.ts (isAccent / isBannerSource). The browser
-- re-checks everything and remains the real boundary; validating here is so a
-- resource that writes `accent = 'red'` finds out at registration instead of
-- shipping a silently un-themed menu.

local BANNER_URL_MAX = 512
-- RFC 3986's set. No space, quote, angle bracket or backslash, so the URL cannot
-- terminate the attribute it is rendered into.
local URL_CHARS = "^[%w%._~:/%?#%[%]@!%$&'%(%)%*%+,;=%%%-]+$"

local function validBanner(banner)
    if type(banner) ~= 'table' then return false end
    local keys = 0
    for _ in pairs(banner) do keys = keys + 1 end
    if banner.url ~= nil then
        if keys ~= 1 or type(banner.url) ~= 'string' then return false end
        local url = banner.url
        if #url > BANNER_URL_MAX or not url:match(URL_CHARS) then return false end
        -- https only: http is a mixed-content block inside CEF anyway, and
        -- data:/blob:/javascript: put author-controlled bytes behind an origin
        -- check that never runs.
        local authority = url:match('^https://([^/%?#]+)$') or url:match('^https://([^/%?#]*)[/%?#]')
        if not authority then return false end
        -- An '@' in the authority is userinfo, never legitimate here.
        return not authority:find('@', 1, true) and #authority > 0
    end
    -- A game texture, resolved as https://nui-img/{dictionary}/{texture}. Limited
    -- to the game's own asset character set so neither segment can introduce a
    -- '/', a '..', a query string or a quote into that path.
    if keys ~= 2 then return false end
    for _, part in ipairs({ banner.dictionary, banner.texture }) do
        if type(part) ~= 'string' or #part < 1 or #part > 64 or not part:match('^[%w_]+$') then return false end
    end
    return true
end

--- Validate a theme declaration. Returns a clean copy, or nil plus a reason.
--- `theme` names one registered through AddTheme, where full CSS-variable control
--- already lives, so there is one theme registry rather than two.
function S.theme(theme)
    if theme == nil then return nil, 'Missing theme' end
    if type(theme) ~= 'table' then return nil, 'A theme must be a table' end
    local out = {}
    for key, value in pairs(theme) do
        if key == 'accent' then
            if type(value) ~= 'string' or not value:match('^#%x%x%x%x%x%x$') then
                return nil, 'theme.accent must be a #rrggbb colour'
            end
            out.accent = value
        elseif key == 'banner' then
            if not validBanner(value) then
                return nil, 'theme.banner must be { dictionary, texture } or { url } on https'
            end
            out.banner = S.copy(value)
        elseif key == 'theme' then
            if not S.id(value) or #value > 64 then
                return nil, 'theme.theme must be the id of a theme registered with AddTheme'
            end
            out.theme = value
        elseif key == 'skin' then
            -- Presentation, not colour: 'default' is the shared look tLib's
            -- dialogs and toasts use, 'vmenu' the legacy vMenu one. A closed set,
            -- because it selects a stylesheet rather than supplying a value to one.
            if value ~= 'default' and value ~= 'vmenu' then
                return nil, "theme.skin must be 'default' or 'vmenu'"
            end
            out.skin = value
        else
            -- Rejecting the whole declaration matches the browser, which drops a
            -- branding push entire: a half-applied theme is a look nobody chose.
            return nil, 'Unknown theme field: ' .. tostring(key)
        end
    end
    if next(out) == nil then return nil, 'A theme must set at least one of accent, banner, theme or skin' end
    return out
end

local function validVehicleStats(stats)
    if stats == nil then return true end
    if type(stats) ~= 'table' then return false end
    for key in pairs(stats) do
        if key ~= 'speed' and key ~= 'acceleration' and key ~= 'braking' and key ~= 'traction' then return false end
    end
    for _, key in ipairs({ 'speed', 'acceleration', 'braking', 'traction' }) do
        local value = stats[key]
        if type(value) ~= 'number' or not S.scalar(value) or value < 0 or value > 1 then return false end
    end
    return true
end

local function validWeaponStats(stats)
    if stats == nil then return true end
    if type(stats) ~= 'table' then return false end
    for key in pairs(stats) do if key ~= 'damage' and key ~= 'speed' and key ~= 'accuracy' and key ~= 'range' then return false end end
    for _, key in ipairs({ 'damage', 'speed', 'accuracy', 'range' }) do
        local value = stats[key]
        if type(value) ~= 'number' or not S.scalar(value) or value < 0 or value > 1 then return false end
    end
    return true
end

-- `catalogued` is a cost rule, not a privilege: a catalogued menu is validated
-- once at boot and then travels as a permission bitmap, so 256 rows cost the wire
-- almost nothing, while an ad-hoc menu ships a full descriptor every time and is
-- capped lower. Nothing here asks which resource is registering.
function S.menu(menu, owner, catalogued)
    if type(menu) ~= 'table' or not S.id(menu.id) or menu.id:sub(1, #owner + 1) ~= owner .. ':' then
        return nil, 'Menu ID must be resource-namespaced'
    end
    if not validWeaponStats(menu.weaponStats) or not S.text(menu.title) or (menu.subtitle ~= nil and not S.text(menu.subtitle, 256)) or (menu.description ~= nil and not S.text(menu.description, 512))
        -- What the page is called from a list of pages when that differs from its
        -- own header: "Vehicle Options" on the root, "Vehicle" once you are on it.
        or (menu.rootLabel ~= nil and not S.text(menu.rootLabel, 128))
        or (menu.parent ~= nil and not S.id(menu.parent)) or type(menu.items) ~= 'table' then
        return nil, 'Invalid menu metadata'
    end
    local itemLimit = catalogued == true and 256 or 100
    if #menu.items > itemLimit then return nil, ('Maximum %d items per menu'):format(itemLimit) end
    local out = { id = menu.id, weaponStats = S.copy(menu.weaponStats), title = menu.title, rootLabel = menu.rootLabel, subtitle = menu.subtitle, description = menu.description, parent = menu.parent, items = {} }
    local seen = {}
    for key in pairs(menu.items) do
        if type(key) ~= 'number' or key % 1 ~= 0 or key < 1 or key > #menu.items then return nil, 'Items must be an array' end
    end
    for _, item in ipairs(menu.items) do
        if type(item) ~= 'table' or not S.id(item.id) or seen[item.id]
            or item.id:sub(1, #owner + 1) ~= owner .. ':' or not S.text(item.label)
            or (item.description ~= nil and not S.text(item.description, 512))
            or (item.confirm ~= nil and not S.text(item.confirm, 512))
            or (item.disabled ~= nil and type(item.disabled) ~= 'boolean') then return nil, 'Invalid item' end
        for _, field in ipairs({ 'rightLabel', 'icon', 'rightIcon', 'groupLabel' }) do
            if item[field] ~= nil and not S.text(item[field], (field == 'icon' or field == 'rightIcon') and 64 or 128) then return nil, 'Invalid presentation text' end
        end
        if item.hidden ~= nil and type(item.hidden) ~= 'boolean' then return nil, 'Invalid hidden flag' end
        if item.danger ~= nil and type(item.danger) ~= 'boolean' then return nil, 'Invalid danger style' end
        if item.groupLabel ~= nil and (item.kind ~= 'select' or item.display ~= 'list') then return nil, 'Invalid group label' end
        if not validWeaponStats(item.weaponStats) or not validVehicleStats(item.vehicleStats) then return nil, 'Invalid vehicle stats' end
        seen[item.id] = true
        local clean = { id = item.id, label = item.label, description = item.description,
            kind = item.kind, weaponStats = S.copy(item.weaponStats), vehicleStats = S.copy(item.vehicleStats), hidden = item.hidden, disabled = item.disabled, confirm = item.confirm, rightLabel = item.rightLabel,
            icon = item.icon, rightIcon = item.rightIcon, danger = item.danger, groupLabel = item.groupLabel }
        if item.display ~= nil and (item.kind ~= 'select' or item.display ~= 'list') then return nil, 'Invalid select display' end
        if item.nextMenu ~= nil and (item.kind ~= 'select' or not S.id(item.nextMenu)
            or item.nextMenu:sub(1, #owner + 1) ~= owner .. ':') then return nil, 'Invalid next menu' end
        if item.apply ~= nil and ((item.kind ~= 'select' and item.kind ~= 'slider')
            or (item.apply ~= 'change' and item.apply ~= 'activate' and item.apply ~= 'both')
            or (item.display == 'list' and item.apply ~= 'activate')) then return nil, 'Invalid select apply' end
        if item.barColor ~= nil then
            if item.kind ~= 'slider' or type(item.barColor) ~= 'table' then return nil, 'Invalid slider color' end
            clean.barColor = {}
            for _, channel in ipairs({ 'r', 'g', 'b' }) do
                local v = item.barColor[channel]
                if type(v) ~= 'number' or v % 1 ~= 0 or v < 0 or v > 255 then return nil, 'Invalid slider color' end
                clean.barColor[channel] = v
            end
        end
        -- MenuAPI's ShowColorPanel/ShowOpacityPanel: a 64-swatch grid from the
        -- hair or makeup palette, or a bar reading the row's own percentage. List
        -- rows only, as upstream.
        if item.panel ~= nil then
            if item.kind ~= 'select' or (item.panel ~= 'hair' and item.panel ~= 'makeup' and item.panel ~= 'opacity') then
                return nil, 'Invalid panel'
            end
            clean.panel = item.panel
        end
        if item.range ~= nil then
            local range = item.range
            if item.kind ~= 'select' or type(range) ~= 'table' then return nil, 'Invalid select range' end
            for _, field in ipairs({ 'min', 'max', 'step' }) do
                if type(range[field]) ~= 'number' or not S.scalar(range[field]) or range[field] % 1 ~= 0 then return nil, 'Invalid select range' end
            end
            if range.min < -1 or range.max > 9999 or range.min >= range.max or range.step <= 0
                or (range.max - range.min) % range.step ~= 0 then return nil, 'Invalid select range' end
            clean.range = { min = range.min, max = range.max, step = range.step }
        end
        if item.kind == 'select' then
            clean.display, clean.nextMenu, clean.apply = item.display, item.nextMenu, item.apply
            local optionLimit = clean.range and ((clean.range.max - clean.range.min) / clean.range.step + 1) or 256
            if type(item.options) ~= 'table' or #item.options < 1 or #item.options > optionLimit then return nil, 'Invalid options' end
            clean.options = {}
            local values = {}
            for _, option in ipairs(item.options) do
                if type(option) ~= 'table' or not S.text(option.label) or not S.scalar(option.value)
                    or type(option.value) == 'boolean' or values[option.value]
                    or (option.disabled ~= nil and type(option.disabled) ~= 'boolean') then return nil, 'Invalid option' end
                if clean.range and (type(option.value) ~= 'number' or option.value % 1 ~= 0
                    or option.value < clean.range.min or option.value > clean.range.max
                    or (option.value - clean.range.min) % clean.range.step ~= 0) then return nil, 'Option outside registered range' end
                for _, field in ipairs({ 'rightLabel', 'icon', 'rightIcon' }) do
                    if option[field] ~= nil and not S.text(option[field], field == 'rightLabel' and 128 or 64) then return nil, 'Invalid option presentation' end
                end
                if option.danger ~= nil and type(option.danger) ~= 'boolean' then return nil, 'Invalid option style' end
                if not validWeaponStats(option.weaponStats) or not validVehicleStats(option.vehicleStats) then return nil, 'Invalid option vehicle stats' end
                values[option.value] = true
                clean.options[#clean.options + 1] = { label = option.label, value = option.value, weaponStats = S.copy(option.weaponStats), vehicleStats = S.copy(option.vehicleStats), disabled = option.disabled, rightLabel = option.rightLabel, icon = option.icon, rightIcon = option.rightIcon, danger = option.danger }
            end
        elseif item.kind == 'slider' then
            for _, field in ipairs({ 'min', 'max', 'step' }) do
                if type(item[field]) ~= 'number' or not S.scalar(item[field]) or item[field] % 1 ~= 0 then return nil, 'Invalid slider bounds' end
            end
            if item.min >= item.max or item.step <= 0 or (item.max - item.min) % item.step ~= 0 then return nil, 'Invalid slider range' end
            clean.min, clean.max, clean.step, clean.apply = item.min, item.max, item.step, item.apply
            if item.value == nil then return nil, 'Slider requires an initial value' end
        elseif item.kind == 'submenu' then
            if not S.id(item.menu) then return nil, 'Invalid submenu' end
            clean.menu = item.menu
        elseif item.kind ~= 'action' and item.kind ~= 'toggle' and item.kind ~= 'status' then return nil, 'Invalid kind' end
        if item.kind == 'toggle' and type(item.value) ~= 'boolean' then return nil, 'Toggle requires an initial boolean value' end
        if item.value ~= nil then
            local valid = S.value(clean, item.value)
            if clean.kind == 'select' then
                for _, option in ipairs(clean.options) do if option.value == item.value then valid = true end end
            end
            if not valid then return nil, 'Invalid initial value' end
            clean.value = item.value
        end
        out.items[#out.items + 1] = clean
    end
    if menu.instructions ~= nil then
        if type(menu.instructions) ~= 'table' or #menu.instructions > 2 then return nil, 'Invalid instructions' end
        out.instructions = {}
        local controls = {}
        for _, instruction in ipairs(menu.instructions) do
            if type(instruction) ~= 'table' or (instruction.control ~= 'jump' and instruction.control ~= 'delete')
                or controls[instruction.control] or not S.text(instruction.label, 128) then return nil, 'Invalid instruction' end
            local target
            for _, item in ipairs(out.items) do if item.id == instruction.itemId then target = item end end
            if not target or not target.hidden or not ((instruction.valueFrom == nil and target.kind == 'action') or (instruction.valueFrom == 'selection' and target.kind == 'select')) then return nil, 'Instruction requires fixed hidden action' end
            controls[instruction.control] = true
            out.instructions[#out.instructions + 1] = { control = instruction.control, label = instruction.label, itemId = target.id, valueFrom = instruction.valueFrom }
        end
    end
    return out
end

-- Presentation only, and only after authoritative permission filtering: a locally
-- unavailable action is not an ACE revocation.
function S.pruneMenus(menus)
    local parents, keep, queue = {}, {}, {}
    for _, menu in ipairs(menus) do
        for _, item in ipairs(menu.items) do
            if item.kind == 'submenu' then
                parents[item.menu] = parents[item.menu] or {}
                parents[item.menu][#parents[item.menu] + 1] = menu.id
            elseif item.kind ~= 'status' and not keep[menu.id] then
                keep[menu.id] = true
                queue[#queue + 1] = menu.id
            end
        end
    end
    -- Reverse reachability, so a productive link cycle survives while an empty one
    -- has no seed and disappears.
    local index = 1
    while index <= #queue do
        for _, parent in ipairs(parents[queue[index]] or {}) do
            if not keep[parent] then keep[parent] = true; queue[#queue + 1] = parent end
        end
        index = index + 1
    end
    local result = {}
    for _, menu in ipairs(menus) do
        if menu.id == 'main' or keep[menu.id] then
            local items = {}
            for _, item in ipairs(menu.items) do
                if item.kind ~= 'submenu' or keep[item.menu] then
                    if item.nextMenu and not keep[item.nextMenu] then item.nextMenu = nil end
                    items[#items + 1] = item
                end
            end
            menu.items = items
            result[#result + 1] = menu
        end
    end
    return result
end

-- Independent of the wall clock; a negative delta resets safely after timer wrap.
function S.consume(bucket, now, burst, refill)
    if not bucket.at then bucket.at, bucket.tokens = now, burst end
    bucket.tokens = math.min(burst, bucket.tokens + math.max(0, now - bucket.at) * refill / 1000)
    bucket.at = now
    if bucket.tokens < 1 then return false end
    bucket.tokens = bucket.tokens - 1
    return true
end

return MenuSchema
