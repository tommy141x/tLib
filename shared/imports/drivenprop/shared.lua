--[[
    tLib — the driven-matrix prop: uniform scale for an attached prop

    Loaded into the CONSUMER's VM, like every other module under
    shared/imports/: `tlib.drivenprop`. It runs there rather than in tLib's own
    VM because it writes the matrices of objects the consumer created and owns.

        local driver = tlib.drivenprop.create()
        driver.add(prop, vehicle, { x=, y=, z=, rx=, ry=, rz=, scale= })

    `shared.lua` rather than `client.lua`, for the same reason
    `tlib.vehicleprop` is: ONE of the pure rules below is asked on both sides.
    The client asks `normaliseScale` to decide what to DRAW; each consumer's
    `server/sv_props.lua` asks the same function to decide what a save is
    allowed to STORE. Those are two different questions over one rule, and the
    alternative is a second clamp on the server that drifts from this one — which
    is exactly how `normaliseModelName` came to be shared, after a server-side
    copy forgot to trim and quietly stored a name no client could resolve.

    `create` and everything under it is client-only in practice; defining it on
    the server costs nothing, because every native it touches is reached at call
    time rather than at load time.

    ── Why this exists: THERE IS NO `SetEntityScale` ───────────────────────────

    Measured on a live Enhanced client, 2026-10-07: `SetEntityScale` is `nil`.
    It is not a native that is awkward, or deprecated, or server-only — it does
    not exist. Scale is carried in the BASIS-VECTOR LENGTHS of `SetEntityMatrix`
    (hash 0xFB0639B, client-side):

        SetEntityMatrix(entity, fwdX,Y,Z, rightX,Y,Z, upX,Y,Z, atX,Y,Z)

    Argument order is forward, right, up, at — the same order `GetEntityMatrix`
    returns them in. The engine does NOT renormalise what you write, which is
    the whole of why a length can carry a scale.

    ── ⚠️ SCALE DOES NOT SURVIVE `AttachEntityToEntity` ────────────────────────

    This is the measured fact the whole design is built around. Three cones on a
    parent at requested scale 3.0:

                                      | same tick | next frame | +1.7s
      attached, then scaled           |   3.000   |   1.000    | 1.000
      attached, matrix driven EVERY frame |  3.000 |   3.000    | 1.000
      NOT attached, matrix driven     |     —     |   3.000    | 3.000

    The entity stays `IsEntityAttached() == true` throughout — it does not
    detach. The attach recomputation simply rewrites the basis from the parent's
    matrix and the stored offset, and that recomputation has no notion of scale.

    ⚠️ A SAME-TICK READ RETURNS 3.0 AND THE NEXT FRAME RETURNS 1.0. Any check
    that reads the scale back once, in the tick that wrote it, reports success
    falsely. Every assertion about scale has to span at least one frame. The
    middle row is the one that cost the most to find: driving the matrix every
    frame WHILE ATTACHED looks like it works — it survived a frame and 300ms of
    sampling — and then loses the scale anyway, because it is a race with the
    attach recomputation rather than a fix for it. Attachment is unusable for a
    scaled prop, with or without a driver.

    So a scaled prop is NOT attached. It is frozen, and its matrix is written
    from the parent's matrix each frame. That is what this module does.

    ── A one-shot write HOLDS, so a stationary parent costs nothing ────────────

    Measured: an unattached, frozen object given a scaled matrix once still read
    exactly 3.000 a full second later, and 200ms after the driving thread had
    stopped. Nothing recomputes the matrix of an unattached frozen object, so the
    per-frame write is only there to make the prop FOLLOW a parent that moves —
    not to maintain the scale against anything.

    `tick` therefore skips any prop whose parent has not moved since the last
    write. A car parked at the kerb costs one matrix read and a float compare.

    ── The rotation convention is MEASURED, not assumed ───────────────────────

    `localRotation` below reproduces `AttachEntityToEntity`'s own interpretation
    of (rx, ry, rz). It has to be exact: get it wrong and every placement that
    already exists silently reorients the moment someone gives it a scale, which
    reads as "the editor broke my placement" rather than as a maths bug.

    It was not guessed. It was calibrated in game against an axis-aligned parent
    (so the child's world matrix IS the local rotation matrix) across nine
    rotation triples, and the fixtures from that run are the oracle in
    `tests/lua/drivenprop.lua`. The answer:

      * rx, ry and rz are each a STANDARD RIGHT-HANDED rotation about the
        parent's X (right), Y (forward) and Z (up) axis respectively. No negated
        angle, no swapped axis.
      * they compose as **M = Rz · Ry · Rx** — pitch first, then roll, then yaw.

    Verified to five decimals on all nine components of the (30, 40, 50) case.

    ── ⚠️ BUILD THE BASIS RIGHT-HANDED OR THE MESH RENDERS INSIDE-OUT ─────────

    GTA's basis is right-handed: `right × forward = up`. Hand-rolling `right`
    from a forward vector is where this goes wrong, and the two candidates differ
    by one sign:

        local rx, ry = -fv.y,  fv.x   -- ⛔ r × f = -up. Left-handed.
        local rx, ry =  fv.y, -fv.x   -- ✅ right-handed

    With f = (0.6, 0.8, 0) the first gives r × f = (0,0,−1) and the second
    (0,0,+1). This module never hand-rolls a basis — it takes the parent's own,
    which the engine already supplies orthonormal and right-handed — but it still
    ASSERTS the invariant, because:

    ⚠️ THE FAILURE LOOKS LIKE A MODEL PROBLEM, NOT A MATRIX PROBLEM. Right size,
    right place, right orientation, just inside-out; and on a symmetric prop you
    may not see it at all. It was originally caught by eye, and it cannot be
    caught by reading the numbers back, because A SIGN DOES NOT CHANGE A LENGTH —
    every scale assertion passes either way.

    `assertHandedness` is an assert rather than a comment for exactly that
    reason: this is the invariant a later refactor inverts silently.

    ── Not owned here ──────────────────────────────────────────────────────────

    Which vehicles wear a prop, what model it is, and who owns it are
    `tlib.vehicleprop`'s. This module is handed a prop, a parent and a placement,
    and keeps the one matrix correct.
]]

local DrivenProp = {}

-- ══════════════════════════════════════════════════════════════════════════
--  PURE RULES — no natives, no state. tests/lua/drivenprop.lua drives these
--  directly, which is possible only because they take no globals.
-- ══════════════════════════════════════════════════════════════════════════

--- Uniform scale bounds.
---
--- UNIFORM — ONE SCALAR — is a product decision, not a limitation of the
--- mechanism. `SetEntityMatrix` can carry a different length on each axis
--- perfectly well, and an earlier sketch exposed three. The owner chose one:
--- "1. Uniform scale". Three axes on a device that is meant to look like a
--- real object mostly produces squashed ones.
---
--- The bounds are what the handle can reach, and they are deliberately narrow.
--- A scale of 0 collapses the basis to a degenerate matrix — the mesh vanishes
--- and the next `GetEntityMatrix`-based renormalise divides by zero — and a
--- negative scale mirrors the mesh, which is the inside-out failure above
--- arrived at from the other direction.
DrivenProp.SCALE_MIN = 0.1
DrivenProp.SCALE_MAX = 10.0
DrivenProp.SCALE_DEFAULT = 1.0

--- How close to 1.0 counts as "not scaled". See `isUnitScale`.
DrivenProp.SCALE_EPSILON = 1e-4

--- A usable uniform scale, always.
---
--- Everything unusable lands on 1.0 rather than being rejected, because every
--- way of getting here is ordinary rather than exceptional: a record written
--- before records had a scale has no `scale` key at all, and `nil` must mean
--- "normal size". Refusing the record instead would make the prop disappear.
---
--- ⚠️ UNUSABLE RESOLVES TO 1.0, NOT TO SCALE_MIN, AND THAT DISTINCTION IS THE
--- POINT. `nil`, NaN, infinity, zero and a negative all mean "no scale was
--- supplied" — they do not mean "as small as possible". An earlier draft clamped
--- a negative to SCALE_MIN, which would render a corrupt or hostile record as a
--- prop shrunk to a tenth rather than as a normal one: a worse failure, and a
--- more confusing one to diagnose. It also disagreed with `clampUniformScale` in
--- `shared/ts/gizmo/types.ts`, which is the same rule on the NUI side — and two
--- clamps that disagree about the edges is exactly the drift this module is
--- `shared.lua` to avoid.
---
--- Zero is ruled out because it collapses the basis to a degenerate matrix: the
--- mesh vanishes and any later renormalise divides by zero. A negative mirrors
--- the mesh, which is the inside-out failure the handedness assert exists for,
--- arrived at from the other direction.
---
--- NaN is tested explicitly, before the range comparisons. It is a number to
--- both `type` and `tonumber`, it survives `json.encode` as `nan`, and
--- `math.max(SCALE_MIN, math.min(SCALE_MAX, nan))` does NOT clamp it — every
--- comparison against NaN is false, so it falls straight through to the caller
--- and reaches `SetEntityMatrix` as a basis that puts the prop nowhere at no
--- size. `n ~= n` is the only test for it in Lua.
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

--- Is this scale indistinguishable from "normal size"?
---
--- The whole point of asking: a prop at unit scale does NOT need this module.
--- It can stay attached with `AttachEntityToEntity`, which the engine maintains
--- for free, and pays no per-frame cost at all. Every existing placement is
--- unit-scaled — none of them has a `scale` key — so this is the test that keeps
--- the cost of this feature proportional to its use.
--- @param value any
--- @return boolean
function DrivenProp.isUnitScale(value)
    local n = DrivenProp.normaliseScale(value)
    return math.abs(n - DrivenProp.SCALE_DEFAULT) < DrivenProp.SCALE_EPSILON
end

--- @param a table {x,y,z}
--- @param b table {x,y,z}
--- @return number
function DrivenProp.dot(a, b)
    return a.x * b.x + a.y * b.y + a.z * b.z
end

--- @param a table {x,y,z}
--- @param b table {x,y,z}
--- @return table {x,y,z}
function DrivenProp.cross(a, b)
    return {
        x = a.y * b.z - a.z * b.y,
        y = a.z * b.x - a.x * b.z,
        z = a.x * b.y - a.y * b.x,
    }
end

--- `dot(cross(right, forward), up)`. Positive for a right-handed basis.
---
--- Scale-invariant in SIGN but not in magnitude: for an orthonormal basis it is
--- ±1, and for a basis scaled by s it is ±s³. So test the SIGN, never equality
--- with 1 — which is why `assertHandedness` compares against 0.
--- @return number
function DrivenProp.handedness(fwd, right, up)
    return DrivenProp.dot(DrivenProp.cross(right, fwd), up)
end

--- Raises unless (fwd, right, up) is right-handed.
---
--- An assert, deliberately, and not a `log` — see the header. A left-handed
--- basis renders the mesh inside-out while every number you can read back is
--- identical, so the only thing that can catch it is a check that refuses to
--- continue. A warning in a console nobody has open is not that.
--- @param where string|nil  included in the message, for the call site
function DrivenProp.assertHandedness(fwd, right, up, where)
    local h = DrivenProp.handedness(fwd, right, up)
    if h > 0 then return h end
    error(('tlib.drivenprop: basis is not right-handed (dot(cross(right, fwd), up) = %s)%s' ..
        ' — the mesh would render inside-out. right x forward must equal up.')
        :format(tostring(h), where and (' at ' .. tostring(where)) or ''), 2)
end

--- The local rotation matrix for a placement's (rx, ry, rz), in degrees.
---
--- Returns the three COLUMNS, each expressed in the parent's own axes as
--- `{ x = along parent right, y = along parent forward, z = along parent up }` —
--- the same (right, forward, up) ordering `AttachEntityToEntity` takes its
--- offset in, and the same one `tlib.propeditor.localToWorld` already uses.
---
--- ⚠️ THIS IS THE MEASURED CONVENTION. See the header: M = Rz · Ry · Rx with
--- three standard right-handed rotations. The expansion below is that product
--- multiplied out, so that a frame costs six trig calls rather than two 3x3
--- matrix multiplies. `tests/lua/drivenprop.lua` pins it against engine
--- fixtures; if you change the form, that suite is the thing that proves the
--- new form is the same rotation.
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

--- Everything `SetEntityMatrix` needs for one scaled prop on one parent.
---
--- Returns the twelve numbers in the native's own argument order — forward,
--- right, up, at — so the call site cannot reorder them by accident. That
--- ordering is NOT the order this file otherwise speaks in (right, forward, up,
--- which is the offset ordering), and mixing the two is the obvious mistake.
---
--- The handedness assert fires here rather than at the call site because this is
--- the one place a basis is constructed.
--- @param basis table    the parent's matrix: { fwd, right, up, pos }
--- @param placement table { x, y, z, rx, ry, rz, scale }
--- @return table twelve numbers, keyed fx..az
function DrivenProp.transform(basis, placement)
    local scale = DrivenProp.normaliseScale(placement.scale)

    local lr, lf, lu = DrivenProp.localRotation(placement.rx, placement.ry, placement.rz)

    -- Asserted on the LOCAL rotation, before it is taken to world space and
    -- before the scale is applied. Both of those are handedness-preserving — a
    -- right-handed parent basis cannot turn a right-handed local rotation into a
    -- left-handed world one, and a positive uniform scale cannot either — so
    -- this is the one place the sign can actually be wrong, and it is the
    -- cheapest place to test it (unit vectors, so the answer is exactly ±1).
    DrivenProp.assertHandedness(lf, lr, lu, 'localRotation')

    local fx, fy, fz = DrivenProp.toWorld(basis, lf)
    local rx, ry, rz = DrivenProp.toWorld(basis, lr)
    local ux, uy, uz = DrivenProp.toWorld(basis, lu)

    -- The offset is in the parent's axes, in the SAME (right, forward, up)
    -- ordering AttachEntityToEntity takes it — x across, y along, z up. Verified
    -- in game: a placement of (0.35, 0.90, 0.55) attached to an axis-aligned
    -- parent came back out of the engine as (0.35001, 0.90001, 0.55000).
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

--- Has the parent moved enough to be worth rewriting a prop's matrix?
---
--- The whole of the "a parked car is free" optimisation. Compares a parent's
--- forward vector and position against the last ones written for a prop.
---
--- The forward vector as well as the position, because a vehicle rotating on the
--- spot — a car on a turntable, a boat swinging on its mooring, a vehicle being
--- rotated by another script — moves its props without moving its origin, and a
--- position-only check would leave them pointing the old way. Checking `fwd`
--- alone would miss a pure roll, but `fwd` plus `pos` catches every case that
--- has come up; a parent that rolls without translating or yawing would need
--- `up` too, and if that ever matters this is where it goes.
---
--- Thresholds are deliberately tight — a millimetre and about a twentieth of a
--- degree. This is not a visual tolerance, it is a "has anything happened at
--- all" test, and a loose one would show up as a prop lagging its vehicle.
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

-- ══════════════════════════════════════════════════════════════════════════
--  THE INSTANCE
-- ══════════════════════════════════════════════════════════════════════════

--- Reads a parent's matrix into the plain-table shape the pure rules take.
--- Local to the instance because it is the only thing in this file that touches
--- a native, and the pure half above must stay drivable without one.
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

    -- [prop] = { parent = handle, placement = table, last = {fx..pz} }
    --
    -- Keyed by the PROP handle, not the parent, because the prop is what this
    -- module is responsible for and a parent could in principle wear two.
    local driven = {}
    local count = 0
    local stopped = false
    local onError = opts.onError

    --- Registers a prop to be driven, and takes it off its attachment.
    ---
    --- ⚠️ DETACHES AND FREEZES. Those are not incidental: an attached prop has
    --- its basis rewritten every frame by the attach recomputation, which
    --- discards the scale (see the header), and an unfrozen unattached prop
    --- falls to the ground. A prop handed to this function is this module's to
    --- position until `remove` hands it back.
    ---
    --- Collision is turned off with it. The prop no longer has a parent to
    --- inherit the vehicle's collision exemption from, so a 3x detector box
    --- bolted to a windshield would otherwise push the car it is sitting on.
    ---
    --- Writes the matrix IMMEDIATELY as well as registering, so a prop is never
    --- visible for a frame at the wrong size or in the wrong place.
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
    ---
    --- Separate from `tick` because the editor needs it: during an edit the
    --- vehicle is frozen, so `hasMoved` is false by construction and a tick
    --- would correctly decide there was nothing to do — while the thing that
    --- actually changed was the PLACEMENT, not the parent.
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

    --- One pass. Exposed so a suite can drive it without a thread.
    ---
    --- Drops entries whose prop or parent has gone rather than leaving them to
    --- accumulate: this table is indexed by entity handle, and handles are
    --- reused, so a stale entry is not merely a leak — it is a claim on a handle
    --- that may later name something else entirely.
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

    -- ── The thread ───────────────────────────────────────────────────────
    --
    -- Started unconditionally but costs nothing while `driven` is empty, which
    -- is every server that has not scaled a prop: `next(driven) == nil` is one
    -- table probe per frame. Measured cost of a prop that IS driven is ~0.8 µs
    -- per frame (see tests/lua/drivenprop.lua's header for the method), so
    -- thirty scaled props across the whole streaming radius is ~25 µs — about
    -- 0.15% of a 16.6ms frame.
    --
    -- A handedness assert inside this thread would otherwise kill the thread
    -- silently and every scaled prop would freeze at its last good matrix with
    -- nothing logged. `pcall` so the assert is REPORTED, and the offending prop
    -- dropped rather than the loop.
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
                    -- One bad placement must not take the rest with it. Find it
                    -- and drop it, by writing each prop on its own.
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
