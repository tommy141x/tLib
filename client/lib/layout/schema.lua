-- Shared HUD layout data. No natives or renderer state belong in this module.
HudLayoutSchema = {}
local S = HudLayoutSchema
local anchors = { ['top-left'] = true, ['top-right'] = true, ['bottom-left'] = true,
    ['bottom-right'] = true, center = true }

-- Offsets are a ratio of a 1080px-tall reference screen -- the same unit the
-- widget's own size scales by -- so a corner inset stays visually constant from
-- 16:9 to 32:9. Centre-anchored X stays proportional to width. Mirrored by
-- layout/geometry.ts; the two must agree or the editor and the game disagree.
S.REFERENCE_HEIGHT = 1080
S.MAX_OFFSET = 4
S.MIN_VISIBLE_PIXELS = 96
S.MIN_VISIBLE_FRACTION = 0.4

function S.finite(value, min, max)
    return type(value) == 'number' and value == value and value >= min and value <= max
end
function S.id(value)
    return type(value) == 'string' and #value > 0 and #value <= 80 and value:match('^[%w_-]+$') ~= nil
end
function S.copy(layout)
    return { x = layout.x, y = layout.y, scale = layout.scale, visible = layout.visible, anchor = layout.anchor }
end
function S.layout(value, component)
    if type(value) ~= 'table' or not anchors[value.anchor]
        or not S.finite(value.x, -S.MAX_OFFSET, S.MAX_OFFSET)
        or not S.finite(value.y, -S.MAX_OFFSET, S.MAX_OFFSET)
        or not S.finite(value.scale, component.minScale, component.maxScale)
        or type(value.visible) ~= 'boolean' then return nil end
    if not component.canHide and not value.visible then return nil end
    if not component.canScale and value.scale ~= component.defaults.scale then return nil end
    return S.copy(value)
end
-- Recoverability constraint, shared with layout/geometry.ts. Applies to EVERY
-- component: a widget must always be grabbable again, whatever put it where it
-- is -- a drag, a resolution change, or a record written by an older version.
-- Pixels are CSS pixels at the given viewport; fraction uses the rendered extent.
function S.constrain(layout, component, viewport)
    if type(viewport) ~= 'table' or not S.finite(viewport.width, 1, 16384)
        or not S.finite(viewport.height, 1, 16384) then return nil end
    local px = component.minVisiblePixels or S.MIN_VISIBLE_PIXELS
    local fraction = component.minVisibleFraction or S.MIN_VISIBLE_FRACTION
    local pivotX = layout.anchor == 'center' and 0.5 or (layout.anchor:find('right') and 1 or 0)
    local pivotY = layout.anchor == 'center' and 0.5 or (layout.anchor:find('bottom') and 1 or 0)
    -- One unit of x/y is a reference height, except centre-anchored x (see above).
    local unitX = layout.anchor == 'center' and viewport.width or viewport.height
    local unitY = viewport.height
    local function axis(size, unit, extent, pivot, offset)
        local need = math.min(extent, size, math.max(px, extent * fraction))
        local base = pivot * (size - extent)
        local start = base + offset * unit
        local clamped = math.max(need - extent, math.min(size - need, start))
        -- An already-legal placement is returned verbatim. Round-tripping it
        -- through the pixel conversion would rewrite saved values by a float
        -- epsilon every time a component registered.
        if clamped == start then return offset end
        return math.max(-S.MAX_OFFSET, math.min(S.MAX_OFFSET, (clamped - base) / unit))
    end
    local result = S.copy(layout)
    local scale = layout.scale * viewport.height / S.REFERENCE_HEIGHT
    result.x = axis(viewport.width, unitX, component.width * scale, pivotX, layout.x)
    result.y = axis(viewport.height, unitY, component.height * scale, pivotY, layout.y)
    return result
end
-- v1 stored x as a fraction of viewport WIDTH. Convert assuming the record was
-- saved at 16:9, which is right for effectively every existing save; Reset
-- recovers the rest. Centre-anchored x was already proportional to width.
function S.migrate(layout)
    if type(layout) ~= 'table' or type(layout.anchor) ~= 'string' or layout.anchor == 'center' then return layout end
    if not S.finite(layout.x, -S.MAX_OFFSET, S.MAX_OFFSET) then return layout end
    local result = S.copy(layout)
    result.x = math.max(-S.MAX_OFFSET, math.min(S.MAX_OFFSET, layout.x * (16 / 9)))
    return result
end
function S.component(owner, id, options)
    if not S.id(owner) or not S.id(id) or type(options) ~= 'table' then return nil end
    if type(options.label) ~= 'string' or #options.label == 0 or #options.label > 100
        or options.label:find('%c') or not S.finite(options.width, 8, 4096)
        or not S.finite(options.height, 8, 4096) then return nil end
    if options.persist ~= nil and type(options.persist) ~= 'boolean' then return nil end
    if options.minVisiblePixels ~= nil and not S.finite(options.minVisiblePixels, 0, 4096) then return nil end
    if options.minVisibleFraction ~= nil and not S.finite(options.minVisibleFraction, 0, 1) then return nil end
    local minScale, maxScale = options.minScale or 0.5, options.maxScale or 2
    if not S.finite(minScale, 0.1, 4) or not S.finite(maxScale, minScale, 4) then return nil end
    local component = { key = owner .. ':' .. id, owner = owner, id = id, label = options.label,
        width = options.width, height = options.height, minScale = minScale, maxScale = maxScale,
        canHide = options.canHide ~= false, canScale = options.canScale ~= false,
        persist = options.persist ~= false,
        minVisiblePixels = options.minVisiblePixels, minVisibleFraction = options.minVisibleFraction }
    component.defaults = type(options.defaults) == 'table' and options.defaults or
        { x = 0.02, y = 0.02, scale = 1, visible = true, anchor = 'top-left' }
    component.defaults = S.layout(component.defaults, component)
    if not component.defaults then return nil end
    -- `defaults` is the FACTORY placement -- the thing Reset goes back to -- and
    -- `layout` is where the widget is right now. They are only the same object for
    -- a consumer that has nowhere else to keep its placement. A consumer that owns
    -- its own storage (persist = false) used to have to pass its saved position as
    -- `defaults`, which made Reset restore the broken position it was being asked
    -- to escape from. Passing both separates "where it is" from "where it belongs".
    component.initial = type(options.layout) == 'table' and S.layout(options.layout, component) or nil
    return component
end
return S
