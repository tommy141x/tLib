--[[
    tLib — the driven-matrix prop: uniform scale for an attached prop.

    There is no `SetEntityScale`; scale lives in the basis-vector lengths of
    `SetEntityMatrix`, and it does NOT survive `AttachEntityToEntity`. So a
    scaled prop is detached, frozen, and driven from its parent's matrix.
    Loaded into the CONSUMER's VM. `shared.lua` because `normaliseScale` is
    asked on both sides -- what to draw, and what a save may store.
    Measured facts and the rotation convention: docs/internal/driven-prop-scale.md

]]

local DrivenProp = {}

--  PURE RULES — no natives, no state. tests/lua/drivenprop.lua drives these
--  directly, which is possible only because they take no globals.

--- Uniform scale bounds. One scalar is a product decision, not a limit of the
--- mechanism. The bounds are what the handle can reach: 0 collapses the basis to
--- a degenerate matrix and a negative mirrors the mesh.
DrivenProp.SCALE_MIN = 0.1
DrivenProp.SCALE_MAX = 10.0
DrivenProp.SCALE_DEFAULT = 1.0

--- How close to 1.0 counts as "not scaled". See `isUnitScale`.
DrivenProp.SCALE_EPSILON = 1e-4

--- A usable uniform scale, always. Everything unusable lands on 1.0, NOT on
--- SCALE_MIN: nil, NaN, infinity, zero and a negative all mean "no scale was
--- supplied", not "as small as possible". Mirrors `clampUniformScale` in
--- internal/shared-ts/gizmo/types.ts.
--- @param value any
--- @return number
function DrivenProp.normaliseScale(value)
    local n = tonumber(value)
    -- nil, NaN (n ~= n), ±infinity (not < math.huge) and anything <= 0.
    if n == nil or n ~= n or n <= 0 or not (n < math.huge) then
        return DrivenProp.SCALE_DEFAULT
    end
    if n < DrivenProp.SCALE_MIN then return DrivenProp.SCALE_MIN end
    if n > DrivenProp.SCALE_MAX then return DrivenProp.SCALE_MAX end
    return n
end

--- Is this scale indistinguishable from "normal size"? A unit-scaled prop does
--- not need this module at all -- it can stay attached, which the engine
--- maintains for free. Every pre-existing placement is unit-scaled.
--- @param value any
--- @return boolean
function DrivenProp.isUnitScale(value)
    local n = DrivenProp.normaliseScale(value)
    return math.abs(n - DrivenProp.SCALE_DEFAULT) < DrivenProp.SCALE_EPSILON
end

function DrivenProp.dot(a, b)
    return a.x * b.x + a.y * b.y + a.z * b.z
end

function DrivenProp.cross(a, b)
    return {
        x = a.y * b.z - a.z * b.y,
        y = a.z * b.x - a.x * b.z,
        z = a.x * b.y - a.y * b.x,
    }
end

--- `dot(cross(right, forward), up)`. Positive for a right-handed basis.
--- Scale-invariant in SIGN but not magnitude, so test the sign, never equality
--- with 1.
--- @return number
function DrivenProp.handedness(fwd, right, up)
    return DrivenProp.dot(DrivenProp.cross(right, fwd), up)
end

--- Raises unless (fwd, right, up) is right-handed. An assert, not a log: a
--- left-handed basis renders the mesh inside-out while every number you can read
--- back is identical, so nothing else can catch it.
--- @param where string|nil  included in the message, for the call site
function DrivenProp.assertHandedness(fwd, right, up, where)
    local h = DrivenProp.handedness(fwd, right, up)
    if h > 0 then return h end
    error(('tlib.drivenprop: basis is not right-handed (dot(cross(right, fwd), up) = %s)%s' ..
        ' — the mesh would render inside-out. right x forward must equal up.')
        :format(tostring(h), where and (' at ' .. tostring(where)) or ''), 2)
end

--- The local rotation matrix for a placement's (rx, ry, rz), in degrees, as
--- three columns in the parent's (right, forward, up) axes.
---
--- MEASURED, not assumed: three standard right-handed rotations composing as
--- M = Rz . Ry . Rx, calibrated in game and pinned by tests/lua/drivenprop.lua.
--- The expansion below is that product multiplied out; if you change the form,
--- that suite is what proves the new form is the same rotation.
--- @param rx number degrees about the parent's right axis
--- @param ry number degrees about the parent's forward axis
--- @param rz number degrees about the parent's up axis
--- @return table right, table fwd, table up
function DrivenProp.localRotation(rx, ry, rz)
    local ax = math.rad(rx or 0.0)
    local ay = math.rad(ry or 0.0)
    local az = math.rad(rz or 0.0)

    local cx, sx = math.cos(ax), math.sin(ax)
    local cy, sy = math.cos(ay), math.sin(ay)
    local cz, sz = math.cos(az), math.sin(az)

    -- Columns of Rz(az) * Ry(ay) * Rx(ax).
    local right = { x = cz * cy,                  y = sz * cy,                  z = -sy }
    local fwd   = { x = cz * sy * sx - sz * cx,   y = sz * sy * sx + cz * cx,   z = cy * sx }
    local up    = { x = cz * sy * cx + sz * sx,   y = sz * sy * cx - cz * sx,   z = cy * cx }

    return right, fwd, up
end

--- A vector in parent-local components, rotated into world space.
---
--- `L` is `{ x = along right, y = along forward, z = along up }`; `basis` is the
--- parent's own `{ fwd, right, up }` as `GetEntityMatrix` returns them.
--- @param basis table { fwd = {x,y,z}, right = {x,y,z}, up = {x,y,z} }
--- @param L table {x,y,z}
--- @return number, number, number
function DrivenProp.toWorld(basis, L)
    local f, r, u = basis.fwd, basis.right, basis.up
    return
        r.x * L.x + f.x * L.y + u.x * L.z,
        r.y * L.x + f.y * L.y + u.y * L.z,
        r.z * L.x + f.z * L.y + u.z * L.z
end

--- Everything `SetEntityMatrix` needs for one scaled prop on one parent, in the
--- native's own argument order (forward, right, up, at) -- which is NOT the
--- (right, forward, up) ordering the rest of this file speaks in. The handedness
--- assert fires here because this is the one place a basis is constructed.
--- @param basis table    the parent's matrix: { fwd, right, up, pos }
--- @param placement table { x, y, z, rx, ry, rz, scale }
--- @return table twelve numbers, keyed fx..az
function DrivenProp.transform(basis, placement)
    local scale = DrivenProp.normaliseScale(placement.scale)

    local lr, lf, lu = DrivenProp.localRotation(placement.rx, placement.ry, placement.rz)

    DrivenProp.assertHandedness(lf, lr, lu, 'localRotation')

    local fx, fy, fz = DrivenProp.toWorld(basis, lf)
    local rx, ry, rz = DrivenProp.toWorld(basis, lr)
    local ux, uy, uz = DrivenProp.toWorld(basis, lu)

    local ox, oy, oz = DrivenProp.toWorld(basis, {
        x = placement.x or 0.0,
        y = placement.y or 0.0,
        z = placement.z or 0.0,
    })

    local p = basis.pos
    return {
        fx = fx * scale, fy = fy * scale, fz = fz * scale,
        rx = rx * scale, ry = ry * scale, rz = rz * scale,
        ux = ux * scale, uy = uy * scale, uz = uz * scale,
        ax = p.x + ox,   ay = p.y + oy,   az = p.z + oz,
    }
end

--- Has the parent moved enough to be worth rewriting a prop's matrix? The whole
--- of the "a parked car is free" optimisation. The forward vector as well as the
--- position, because a vehicle rotating on the spot moves its props without
--- moving its origin. Thresholds are a "has anything happened" test, not a
--- visual tolerance.
--- @param last table|nil  { fx, fy, fz, px, py, pz }, or nil for "never written"
--- @param basis table      the parent's matrix now
--- @return boolean
function DrivenProp.hasMoved(last, basis)
    if last == nil then return true end
    local f, p = basis.fwd, basis.pos
    return math.abs(f.x - last.fx) > 1e-4
        or math.abs(f.y - last.fy) > 1e-4
        or math.abs(f.z - last.fz) > 1e-4
        or math.abs(p.x - last.px) > 1e-3
        or math.abs(p.y - last.py) > 1e-3
        or math.abs(p.z - last.pz) > 1e-3
end

--  THE INSTANCE

--- Reads a parent's matrix into the plain-table shape the pure rules take. Local
--- to the instance because it is the only thing here that touches a native, and
--- the pure half above must stay drivable without one.
local function readBasis(entity)
    local fwd, right, up, pos = GetEntityMatrix(entity)
    return {
        fwd   = { x = fwd.x,   y = fwd.y,   z = fwd.z   },
        right = { x = right.x, y = right.y, z = right.z },
        up    = { x = up.x,    y = up.y,    z = up.z    },
        pos   = { x = pos.x,   y = pos.y,   z = pos.z   },
    }
end

--- Builds a driver. One per consumer resource is plenty — the thread is a single
--- `Wait(0)` loop over however many props are registered.
---
--- @param opts table|nil
---   interval number?  frames between passes. 0 (every frame) is the default and
---                     the only value that looks right on a moving vehicle.
---   onError function? (message) -> (), for a handedness assert in the thread.
function DrivenProp.create(opts)
    opts = opts or {}
    local instance = {}

    local driven = {}
    local count = 0
    local stopped = false
    local onError = opts.onError

    --- Registers a prop to be driven, and takes it off its attachment.
    ---
    --- DETACHES, FREEZES and disables collision, none of them incidental: an
    --- attached prop loses the scale to the attach recomputation, an unfrozen
    --- unattached one falls to the ground, and a prop with no parent no longer
    --- inherits the vehicle's collision exemption. Writes the matrix immediately
    --- so the prop is never visible at the wrong size for a frame.
    --- @param prop number
    --- @param parent number
    --- @param placement table { x, y, z, rx, ry, rz, scale }
    --- @return boolean registered
    function instance.add(prop, parent, placement)
        if not prop or prop == 0 or not DoesEntityExist(prop) then return false end
        if not parent or parent == 0 or not DoesEntityExist(parent) then return false end
        if type(placement) ~= 'table' then return false end

        if IsEntityAttached(prop) then DetachEntity(prop, false, false) end
        FreezeEntityPosition(prop, true)
        SetEntityCollision(prop, false, false)

        if driven[prop] == nil then count = count + 1 end
        driven[prop] = { parent = parent, placement = placement, last = nil }

        instance.write(prop)
        return true
    end

    --- Writes one prop's matrix now, whether or not its parent has moved.
    --- Separate from `tick` for the editor: during an edit the vehicle is frozen,
    --- so `hasMoved` is correctly false while the PLACEMENT is what changed.
    --- @param prop number
    --- @return boolean written
    function instance.write(prop)
        local entry = driven[prop]
        if entry == nil then return false end
        if not DoesEntityExist(prop) or not DoesEntityExist(entry.parent) then
            return false
        end

        local basis = readBasis(entry.parent)
        local m = DrivenProp.transform(basis, entry.placement)

        SetEntityMatrix(prop,
            m.fx, m.fy, m.fz,
            m.rx, m.ry, m.rz,
            m.ux, m.uy, m.uz,
            m.ax, m.ay, m.az)

        entry.last = {
            fx = basis.fwd.x, fy = basis.fwd.y, fz = basis.fwd.z,
            px = basis.pos.x, py = basis.pos.y, pz = basis.pos.z,
        }
        return true
    end

    --- Replaces a prop's placement and rewrites its matrix. The editor's hot
    --- path: one call per drag frame, no attach/detach churn.
    --- @param prop number
    --- @param placement table
    function instance.update(prop, placement)
        local entry = driven[prop]
        if entry == nil or type(placement) ~= 'table' then return false end
        entry.placement = placement
        return instance.write(prop)
    end

    --- Stops driving a prop. Does NOT delete it and does NOT re-attach it — the
    --- caller owns the object and knows what it wants to do with it next, and a
    --- module that re-attached here would silently undo a scale.
    --- @param prop number
    function instance.remove(prop)
        if driven[prop] == nil then return false end
        driven[prop] = nil
        count = count - 1
        return true
    end

    function instance.isDriven(prop) return driven[prop] ~= nil end
    function instance.count() return count end

    --- Forgets every prop. Does not delete them; see `remove`.
    function instance.clear()
        for prop in pairs(driven) do driven[prop] = nil end
        count = 0
    end

    --- One pass. Exposed so a suite can drive it without a thread. Drops entries
    --- whose prop or parent has gone: handles are reused, so a stale entry is a
    --- claim on a handle that may later name something else.
    --- @return number written, number skipped
    function instance.tick()
        local written, skipped = 0, 0
        for prop, entry in pairs(driven) do
            if not DoesEntityExist(prop) or not DoesEntityExist(entry.parent) then
                driven[prop] = nil
                count = count - 1
            else
                local basis = readBasis(entry.parent)
                if DrivenProp.hasMoved(entry.last, basis) then
                    local m = DrivenProp.transform(basis, entry.placement)
                    SetEntityMatrix(prop,
                        m.fx, m.fy, m.fz,
                        m.rx, m.ry, m.rz,
                        m.ux, m.uy, m.uz,
                        m.ax, m.ay, m.az)
                    entry.last = {
                        fx = basis.fwd.x, fy = basis.fwd.y, fz = basis.fwd.z,
                        px = basis.pos.x, py = basis.pos.y, pz = basis.pos.z,
                    }
                    written = written + 1
                else
                    skipped = skipped + 1
                end
            end
        end
        return written, skipped
    end

    Citizen.CreateThread(function()
        while not stopped do
            Citizen.Wait(0)
            if next(driven) ~= nil then
                local ok, err = pcall(instance.tick)
                if not ok then
                    if onError then
                        onError(tostring(err))
                    else
                        print('[tlib.drivenprop] ' .. tostring(err))
                    end
                    for prop in pairs(driven) do
                        local good = pcall(instance.write, prop)
                        if not good then instance.remove(prop) end
                    end
                end
            end
        end
    end)

    AddEventHandler('onResourceStop', function(resourceName)
        if resourceName ~= GetCurrentResourceName() then return end
        stopped = true
        instance.clear()
    end)

    return instance
end

return DrivenProp
