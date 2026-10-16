-- The driven-matrix prop: uniform scale for a prop on a vehicle.
--
-- Drives `shared/imports/drivenprop/shared.lua`.
--
-- Run via `bun run test:lua`.
--
-- Why this suite exists
--
-- Every rule in `shared/imports/drivenprop/client.lua` fails SILENTLY in game,
-- and two of them fail in ways no amount of reading numbers back can catch:
--
--   * THE ROTATION CONVENTION. `localRotation` has to reproduce
--     `AttachEntityToEntity`'s own interpretation of (rx, ry, rz) exactly. Get it
--     wrong and every placement that already exists reorients the moment someone
--     gives it a scale — which presents as "the editor broke my placement", not
--     as a maths bug, because the prop is still the right size in the right
--     place. The nine fixtures below are the oracle for it.
--
--   * HANDEDNESS. A left-handed basis renders the mesh inside-out: right size,
--     right place, right orientation, inverted normals — and on a symmetric prop
-- you may not see it at all. IT CANNOT BE CAUGHT BY READING THE MATRIX
--     BACK, because a sign does not change a length, so every scale assertion
--     passes either way. That is why the module asserts rather than warns, and
--     why this suite asserts that the assert fires.
--
--   * NaN. It is a number to both `type` and `tonumber`, survives `json.encode`
--     as `nan`, and `math.max(lo, math.min(hi, nan))` does NOT clamp it, because
--     every comparison against NaN is false. It reaches SetEntityMatrix as a
--     basis that puts the prop nowhere at no size.
--
-- Where the fixtures came from
--
-- MEASURED, not derived. On a live Enhanced client, 2026-10-07: an object parent
-- was created and `SetEntityRotation(parent, 0, 0, 0)` applied, so the parent's
-- basis is exactly the world axes — right (1,0,0), fwd (0,1,0), up (0,0,1) — and
-- therefore a child's WORLD matrix IS its local rotation matrix. Nine props were
-- attached to it with `AttachEntityToEntity(prop, parent, 0, 0,0,0, rx,ry,rz,
-- ...)`, given a frame to settle, and their `GetEntityMatrix` read back. The
-- numbers below are that read, rounded to five decimals.
--
-- The three single-axis cases are what identify the axes and the signs; the two
-- mixed cases are what identify the ORDER, which no single-axis case can.
--
-- The per-frame cost, for the record
--
-- Measured on the same client. `GetGameTimer()` is the FRAME clock — it does not
-- advance within a frame, so it cannot time intra-frame work directly — but work
-- done before a `Wait(0)` does show up as a longer gap between two reads of it.
-- Averaging that gap over 20-40 frames at 2k/10k/20k iterations of the real
-- per-prop body (parent matrix read, basis build, SetEntityMatrix) against a
-- zero-iteration baseline of 8.875 ms gave 0.55 / 0.75 / 0.83 µs per prop per
-- frame. Thirty scaled props is therefore ~25 µs, about 0.15% of a 16.6 ms
-- frame. It is cheap, and `hasMoved` makes a parked vehicle cheaper still.

local function fail(message) error(message, 2) end

local report = print
local passed = 0

local function test(name, fn)
    local ok, err = pcall(fn)
    if not ok then
        report('FAIL ' .. name .. ': ' .. tostring(err))
        error('suite failed', 0)
    end
    passed = passed + 1
    report('PASS ' .. name)
end

local function near(a, b, tol)
    tol = tol or 1e-4
    if type(a) ~= 'number' then
        fail(('expected a number, got %s (%s)'):format(type(a), tostring(a)))
    end
    if math.abs(a - b) > tol then
        fail(('expected %s, got %s (tolerance %s)'):format(tostring(b), tostring(a), tostring(tol)))
    end
end

local function nearVec(got, want, label, tol)
    near(got.x, want[1], tol)
    near(got.y, want[2], tol)
    near(got.z, want[3], tol)
    return label
end

-- Host stubs
--
-- The module is loaded FOR REAL against these rather than reimplemented here. A
-- suite that reimplements its subject asserts that two copies agree and notices
-- nothing when the shipped one changes.

local world = {}
local nextHandle = 100
local matrixWrites = {}

local function spawn(basis)
    nextHandle = nextHandle + 1
    world[nextHandle] = {
        attached = false,
        frozen = false,
        collision = true,
        basis = basis,
    }
    return nextHandle
end

local function vec(x, y, z) return { x = x, y = y, z = z } end

--- An axis-aligned parent, so a child's world matrix is its local one.
local function identityBasis(px, py, pz)
    return {
        fwd   = vec(0, 1, 0),
        right = vec(1, 0, 0),
        up    = vec(0, 0, 1),
        pos   = vec(px or 0, py or 0, pz or 0),
    }
end

_ENV.DoesEntityExist = function(h) return world[h] ~= nil and not world[h].deleted end
_ENV.IsEntityAttached = function(h) return world[h] ~= nil and world[h].attached == true end
_ENV.DetachEntity = function(h) if world[h] then world[h].attached = false end end
_ENV.FreezeEntityPosition = function(h, v) if world[h] then world[h].frozen = v end end
_ENV.SetEntityCollision = function(h, v) if world[h] then world[h].collision = v end end
_ENV.GetCurrentResourceName = function() return 'consumer' end

_ENV.GetEntityMatrix = function(h)
    local e = world[h]
    if not e or not e.basis then return vec(0, 1, 0), vec(1, 0, 0), vec(0, 0, 1), vec(0, 0, 0) end
    local b = e.basis
    return b.fwd, b.right, b.up, b.pos
end

_ENV.SetEntityMatrix = function(h, fx, fy, fz, rx, ry, rz, ux, uy, uz, ax, ay, az)
    matrixWrites[#matrixWrites + 1] = {
        prop = h,
        fwd = vec(fx, fy, fz), right = vec(rx, ry, rz), up = vec(ux, uy, uz), at = vec(ax, ay, az),
    }
    if world[h] then
        world[h].basis = { fwd = vec(fx, fy, fz), right = vec(rx, ry, rz), up = vec(ux, uy, uz), pos = vec(ax, ay, az) }
    end
end

local threads = {}
_ENV.Citizen = {
    CreateThread = function(fn) threads[#threads + 1] = fn end,
    Wait = function() error('__budget__', 0) end,
}
local handlers = {}
_ENV.AddEventHandler = function(name, fn) handlers[name] = fn end

-- Load the real module

local chunk = assert(loadfile('shared/imports/drivenprop/shared.lua'))
local DP = chunk()
if type(DP) ~= 'table' then fail('drivenprop/client.lua did not return a table') end

--  THE ENGINE FIXTURES — the rotation convention

local FIXTURES = {
    { rot = {   0,   0,   0 }, right = {  1,       0,        0       },
                               fwd   = {  0,       1,        0       },
                               up    = {  0,       0,        1       } },
    { rot = {  90,   0,   0 }, right = {  1,       0,        0       },
                               fwd   = {  0,       0,        1       },
                               up    = {  0,      -1,        0       } },
    { rot = {   0,  90,   0 }, right = {  0,       0,       -1       },
                               fwd   = {  0,       1,        0       },
                               up    = {  1,       0,        0       } },
    { rot = {   0,   0,  90 }, right = {  0,       1,        0       },
                               fwd   = { -1,       0,        0       },
                               up    = {  0,       0,        1       } },
    { rot = {  30,   0,   0 }, right = {  1,       0,        0       },
                               fwd   = {  0,       0.86603,  0.5     },
                               up    = {  0,      -0.5,      0.86603 } },
    { rot = {   0,  30,   0 }, right = {  0.86603, 0,       -0.5     },
                               fwd   = {  0,       1,        0       },
                               up    = {  0.5,     0,        0.86603 } },
    { rot = {   0,   0,  30 }, right = {  0.86603, 0.5,      0       },
                               fwd   = { -0.5,     0.86603,  0       },
                               up    = {  0,       0,        1       } },
    -- The two that pin the ORDER. No single-axis case can: Rz*Ry*Rx and
    -- Rx*Ry*Rz agree on every one of the seven above and disagree here.
    { rot = {  30,  40,  50 }, right = {  0.4924,  0.58682, -0.64279 },
                               fwd   = { -0.45683, 0.80287,  0.38302 },
                               up    = {  0.74084, 0.10504,  0.66341 } },
    { rot = {  17, -41, 123 }, right = { -0.41104, 0.63295,  0.65606 },
                               fwd   = { -0.69756, -0.68171, 0.22066 },
                               up    = {  0.58691, -0.36694, 0.72173 } },
}

test('localRotation reproduces the engine on all nine measured fixtures', function()
    for i, f in ipairs(FIXTURES) do
        local r, fw, u = DP.localRotation(f.rot[1], f.rot[2], f.rot[3])
        local label = ('fixture %d (%g, %g, %g)'):format(i, f.rot[1], f.rot[2], f.rot[3])
        local ok, err = pcall(function()
            nearVec(r, f.right); nearVec(fw, f.fwd); nearVec(u, f.up)
        end)
        if not ok then fail(label .. ': ' .. tostring(err)) end
    end
end)

-- BROKEN-CONTROL DRILL.
--
-- The nine assertions above being green proves the shipped formula matches the
-- engine. It does NOT prove they would have noticed a formula that did not — a
-- fixture set that is too forgiving, or a tolerance that is too loose, is green
-- against anything. So: compose the SAME three rotations in the wrong order and
-- require the fixtures to reject it. If this test fails, the suite above is not
-- evidence of anything.
test('CONTROL: the fixtures reject the opposite composition order (Rx*Ry*Rz)', function()
    local function wrongOrder(rx, ry, rz)
        local ax, ay, az = math.rad(rx), math.rad(ry), math.rad(rz)
        local cx, sx = math.cos(ax), math.sin(ax)
        local cy, sy = math.cos(ay), math.sin(ay)
        local cz, sz = math.cos(az), math.sin(az)
        -- Columns of Rx(ax) * Ry(ay) * Rz(az).
        local right = { x = cy * cz,                    y = cx * sz + sx * sy * cz,   z = sx * sz - cx * sy * cz }
        local fwd   = { x = -cy * sz,                   y = cx * cz - sx * sy * sz,   z = sx * cz + cx * sy * sz }
        local up    = { x = sy,                         y = -sx * cy,                 z = cx * cy }
        return right, fwd, up
    end

    local rejected = 0
    for _, f in ipairs(FIXTURES) do
        local r, fw, u = wrongOrder(f.rot[1], f.rot[2], f.rot[3])
        local ok = pcall(function()
            nearVec(r, f.right); nearVec(fw, f.fwd); nearVec(u, f.up)
        end)
        if not ok then rejected = rejected + 1 end
    end
    -- The seven single-axis-or-zero fixtures legitimately agree under either
    -- order, so only the two mixed ones can reject. Both must.
    if rejected ~= 2 then
        fail(('expected exactly the 2 mixed fixtures to reject the wrong order, got %d')
            :format(rejected))
    end
end)

test('localRotation is orthonormal and right-handed for every fixture', function()
    for _, f in ipairs(FIXTURES) do
        local r, fw, u = DP.localRotation(f.rot[1], f.rot[2], f.rot[3])
        near(DP.dot(r, r), 1.0, 1e-9)
        near(DP.dot(fw, fw), 1.0, 1e-9)
        near(DP.dot(u, u), 1.0, 1e-9)
        near(DP.dot(r, fw), 0.0, 1e-9)
        near(DP.dot(r, u), 0.0, 1e-9)
        near(DP.dot(fw, u), 0.0, 1e-9)
        -- right x forward = up, the invariant the whole module turns on.
        near(DP.handedness(fw, r, u), 1.0, 1e-9)
    end
end)

test('localRotation defaults a nil angle to zero rather than erroring', function()
    local r, fw, u = DP.localRotation(nil, nil, nil)
    nearVec(r, { 1, 0, 0 }); nearVec(fw, { 0, 1, 0 }); nearVec(u, { 0, 0, 1 })
end)

--  SCALE NORMALISATION

test('normaliseScale: an absent scale is normal size, not a rejection', function()
    -- Every record written before records had a scale has no `scale` key. If nil
    -- did anything other than 1.0, every existing placement would change size.
    near(DP.normaliseScale(nil), 1.0)
    near(DP.normaliseScale(false), 1.0)
    near(DP.normaliseScale({}), 1.0)
    near(DP.normaliseScale('not a number'), 1.0)
end)

test('normaliseScale: NaN becomes 1.0', function()
    local nan = 0 / 0
    if nan == nan then fail('this Lua did not produce a NaN; the test below is vacuous') end
    -- The trap: NaN is a number to type() and tonumber(), and a naive
    -- math.max(lo, math.min(hi, nan)) returns NaN because every comparison
    -- against NaN is false.
    near(DP.normaliseScale(nan), 1.0)
end)

test('normaliseScale clamps an in-range-ish value to [SCALE_MIN, SCALE_MAX]', function()
    near(DP.normaliseScale(1000), DP.SCALE_MAX)
    near(DP.normaliseScale(0.001), DP.SCALE_MIN)
    near(DP.normaliseScale(DP.SCALE_MIN), DP.SCALE_MIN)
    near(DP.normaliseScale(DP.SCALE_MAX), DP.SCALE_MAX)
    near(DP.normaliseScale(2.5), 2.5)
    -- Numeric strings out of a JSON file are accepted, as tonumber implies.
    near(DP.normaliseScale('2.5'), 2.5)
end)

test('normaliseScale: zero, negative and infinity are NOT SUPPLIED, not SMALLEST', function()
    -- They resolve to 1.0, not to SCALE_MIN. A corrupt or hostile record must
    -- render as a normal-sized prop, not as one shrunk to a tenth — which is a
    -- worse failure and a far more confusing one to diagnose. This also has to
    -- agree exactly with `clampUniformScale` in internal/shared-ts/gizmo/types.ts, which
    -- is the same rule on the NUI side.
    near(DP.normaliseScale(0), 1.0)
    near(DP.normaliseScale(-0.0001), 1.0)
    near(DP.normaliseScale(-5), 1.0)
    near(DP.normaliseScale(math.huge), 1.0)
    near(DP.normaliseScale(-math.huge), 1.0)
end)

test('normaliseScale never returns zero or a negative', function()
    -- A zero scale is a degenerate matrix: the mesh vanishes, and the next
    -- renormalise divides by zero. A negative one mirrors the mesh, which is the
    -- inside-out failure arrived at from the other direction.
    for _, v in ipairs({ 0, -0.0001, -1, -1e9 }) do
        local s = DP.normaliseScale(v)
        if s <= 0 then fail(('normaliseScale(%s) returned %s'):format(tostring(v), tostring(s))) end
    end
end)

test('isUnitScale is true for absent and 1.0, false for a real scale', function()
    if not DP.isUnitScale(nil) then fail('nil must read as unit scale') end
    if not DP.isUnitScale(1.0) then fail('1.0 must read as unit scale') end
    if not DP.isUnitScale(1.00000001) then fail('within epsilon must read as unit scale') end
    if DP.isUnitScale(1.5) then fail('1.5 must not read as unit scale') end
    if DP.isUnitScale(0.5) then fail('0.5 must not read as unit scale') end
    -- Unusable values normalise to 1.0, so they ARE unit scale — which is the
    -- behaviour that matters: a corrupt record takes the cheap attached path
    -- rather than being driven per frame to render at a nonsense size.
    if not DP.isUnitScale(0) then fail('0 normalises to 1.0, so it is unit scale') end
    if not DP.isUnitScale(0 / 0) then fail('NaN normalises to 1.0, so it is unit scale') end
end)

--  HANDEDNESS

test('handedness is positive for the right-handed basis and negative for the flip', function()
    -- The exact pair from the module header, with f = (0.6, 0.8, 0).
    local f = vec(0.6, 0.8, 0)
    local up = vec(0, 0, 1)
    local rightHanded = vec(f.y, -f.x, 0)   -- the correct one
    local leftHanded  = vec(-f.y, f.x, 0)   -- the one that renders inside-out
    near(DP.handedness(f, rightHanded, up), 1.0, 1e-6)
    near(DP.handedness(f, leftHanded, up), -1.0, 1e-6)
end)

test('assertHandedness raises on a left-handed basis and returns on a right-handed one', function()
    local f, up = vec(0, 1, 0), vec(0, 0, 1)
    local ok = pcall(DP.assertHandedness, f, vec(1, 0, 0), up, 'test')
    if not ok then fail('a right-handed basis must not raise') end

    local bad, err = pcall(DP.assertHandedness, f, vec(-1, 0, 0), up, 'test')
    if bad then fail('a left-handed basis MUST raise — nothing else can catch it') end
    if not tostring(err):find('right%-handed') then
        fail('the message must name the problem; got: ' .. tostring(err))
    end
end)

test('a sign flip does not change any basis LENGTH', function()
    -- The reason the assert exists. This is the whole trap: an inside-out prop
    -- reads back identical scales, so a scale assertion cannot see it.
    local function lengths(a, b, c)
        local function l(v) return math.sqrt(DP.dot(v, v)) end
        return l(a), l(b), l(c)
    end
    local f, up = vec(0, 2, 0), vec(0, 0, 2)
    local g1, g2, g3 = lengths(f, vec(2, 0, 0), up)
    local b1, b2, b3 = lengths(f, vec(-2, 0, 0), up)
    near(g1, b1); near(g2, b2); near(g3, b3)
end)

--  THE TRANSFORM

test('transform carries the scale in the basis-vector LENGTHS', function()
    local basis = identityBasis(10, 20, 30)
    local m = DP.transform(basis, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, scale = 3.0 })
    local function l(x, y, z) return math.sqrt(x * x + y * y + z * z) end
    near(l(m.fx, m.fy, m.fz), 3.0)
    near(l(m.rx, m.ry, m.rz), 3.0)
    near(l(m.ux, m.uy, m.uz), 3.0)
end)

test('transform at unit scale is an orthonormal basis', function()
    local basis = identityBasis()
    local m = DP.transform(basis, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0 })
    local function l(x, y, z) return math.sqrt(x * x + y * y + z * z) end
    near(l(m.fx, m.fy, m.fz), 1.0)
    near(l(m.rx, m.ry, m.rz), 1.0)
    near(l(m.ux, m.uy, m.uz), 1.0)
end)

test('transform: SCALE DOES NOT MOVE THE PROP', function()
    -- The position is the attachment point, not a scaled vector: a prop that
    -- grew must grow about where it sits, not slide along the vehicle. Scaling
    -- the offset too is the obvious mistake and it looks like a placement bug.
    local basis = identityBasis(100, 200, 300)
    local placement = { x = 0.35, y = 0.90, z = 0.55, rx = 17, ry = -41, rz = 123 }
    local one = DP.transform(basis, placement)
    placement.scale = 4.0
    local four = DP.transform(basis, placement)
    near(four.ax, one.ax); near(four.ay, one.ay); near(four.az, one.az)
end)

test('transform: the offset is (right, forward, up), as AttachEntityToEntity takes it', function()
    -- Measured in game: a placement of (0.35, 0.90, 0.55) attached to an
    -- axis-aligned parent came back out of the engine at (0.35001, 0.90001,
    -- 0.55000). With an identity basis the mapping is readable directly.
    local basis = identityBasis(0, 0, 0)
    local m = DP.transform(basis, { x = 0.35, y = 0.90, z = 0.55, rx = 0, ry = 0, rz = 0 })
    near(m.ax, 0.35)   -- x is ACROSS the parent (right)
    near(m.ay, 0.90)   -- y is ALONG it (forward)
    near(m.az, 0.55)   -- z is UP
end)

test('transform: scale does not change any basis DIRECTION', function()
    local basis = identityBasis(5, 5, 5)
    local placement = { x = 0.1, y = 0.2, z = 0.3, rx = 30, ry = 40, rz = 50 }
    local one = DP.transform(basis, placement)
    placement.scale = 2.5
    local big = DP.transform(basis, placement)
    for _, axis in ipairs({ 'f', 'r', 'u' }) do
        for _, comp in ipairs({ 'x', 'y', 'z' }) do
            local k = axis .. comp
            near(big[k] / 2.5, one[k], 1e-9)
        end
    end
end)

test('transform: an absent scale is identical to scale 1.0', function()
    local basis = identityBasis(1, 2, 3)
    local a = DP.transform(basis, { x = 1, y = 2, z = 3, rx = 10, ry = 20, rz = 30 })
    local b = DP.transform(basis, { x = 1, y = 2, z = 3, rx = 10, ry = 20, rz = 30, scale = 1.0 })
    for k, v in pairs(a) do near(b[k], v, 1e-12) end
end)

test('transform: a NaN scale does not produce a NaN matrix', function()
    local basis = identityBasis()
    local m = DP.transform(basis, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, scale = 0 / 0 })
    for k, v in pairs(m) do
        if v ~= v then fail('component ' .. k .. ' is NaN') end
    end
end)

test('transform: the result is right-handed for a non-trivial rotation', function()
    local basis = identityBasis(7, 8, 9)
    local m = DP.transform(basis, { x = 1, y = 1, z = 1, rx = 17, ry = -41, rz = 123, scale = 2.0 })
    local h = DP.handedness(vec(m.fx, m.fy, m.fz), vec(m.rx, m.ry, m.rz), vec(m.ux, m.uy, m.uz))
    if h <= 0 then fail('the written basis is left-handed; the mesh would be inside-out') end
    -- ±s^3 for a basis scaled by s, which is why assertHandedness tests the SIGN
    -- and not equality with 1.
    near(h, 8.0, 1e-6)
end)

--  hasMoved — the "a parked car is free" rule

test('hasMoved is true when nothing has been written yet', function()
    if not DP.hasMoved(nil, identityBasis()) then
        fail('a prop that has never been written must be written')
    end
end)

test('hasMoved is false for a stationary parent', function()
    local basis = identityBasis(10, 20, 30)
    local last = { fx = 0, fy = 1, fz = 0, px = 10, py = 20, pz = 30 }
    if DP.hasMoved(last, basis) then fail('a parked vehicle must cost nothing') end
end)

test('hasMoved catches translation', function()
    local last = { fx = 0, fy = 1, fz = 0, px = 10, py = 20, pz = 30 }
    if not DP.hasMoved(last, identityBasis(10.01, 20, 30)) then fail('missed a translation') end
    if not DP.hasMoved(last, identityBasis(10, 20, 30.01)) then fail('missed a vertical move') end
end)

test('hasMoved catches ROTATION ON THE SPOT', function()
    -- The case a position-only check misses: a vehicle that yaws without
    -- translating moves its props without moving its origin, and the prop would
    -- be left pointing the old way.
    local last = { fx = 0, fy = 1, fz = 0, px = 0, py = 0, pz = 0 }
    local turned = identityBasis(0, 0, 0)
    turned.fwd = vec(0.1, 0.995, 0)
    if not DP.hasMoved(last, turned) then fail('missed a rotation on the spot') end
end)

--  THE INSTANCE

local function freshDriver()
    matrixWrites = {}
    return DP.create()
end

test('add detaches, freezes and disables collision', function()
    local driver = freshDriver()
    local parent = spawn(identityBasis(0, 0, 0))
    local prop = spawn(nil)
    world[prop].attached = true

    if not driver.add(prop, parent, { x = 0, y = 1, z = 0, rx = 0, ry = 0, rz = 0, scale = 2 }) then
        fail('add refused a valid prop')
    end
    -- All three matter. An attached prop has its basis rewritten every frame by
    -- the attach recomputation, which discards the scale; an unfrozen unattached
    -- prop falls to the ground; and a prop with collision no longer inherits its
    -- parent's exemption, so a scaled-up one would push the car it sits on.
    if world[prop].attached then fail('prop is still attached') end
    if not world[prop].frozen then fail('prop is not frozen') end
    if world[prop].collision ~= false then fail('prop collision is still on') end
end)

test('add writes the matrix immediately', function()
    local driver = freshDriver()
    local parent = spawn(identityBasis(0, 0, 0))
    local prop = spawn(nil)
    driver.add(prop, parent, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, scale = 3 })
    -- Otherwise the prop is visible for a frame at the wrong size.
    if #matrixWrites ~= 1 then fail('expected exactly one write, got ' .. #matrixWrites) end
    local w = matrixWrites[1]
    near(math.sqrt(DP.dot(w.fwd, w.fwd)), 3.0)
end)

test('add refuses a missing prop, parent or placement', function()
    local driver = freshDriver()
    local parent = spawn(identityBasis())
    local prop = spawn(nil)
    if driver.add(0, parent, {}) then fail('accepted prop handle 0') end
    if driver.add(prop, 0, {}) then fail('accepted parent handle 0') end
    if driver.add(prop, parent, nil) then fail('accepted a nil placement') end
    if driver.add(99999, parent, {}) then fail('accepted a nonexistent prop') end
    if driver.count() ~= 0 then fail('a refused add must not register') end
end)

test('tick skips a stationary parent and writes a moved one', function()
    local driver = freshDriver()
    local parent = spawn(identityBasis(0, 0, 0))
    local prop = spawn(nil)
    driver.add(prop, parent, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, scale = 2 })

    local written, skipped = driver.tick()
    if written ~= 0 or skipped ~= 1 then
        fail(('a parked parent must be skipped; got written=%d skipped=%d'):format(written, skipped))
    end

    world[parent].basis = identityBasis(0, 5, 0)
    written, skipped = driver.tick()
    if written ~= 1 or skipped ~= 0 then
        fail(('a moved parent must be written; got written=%d skipped=%d'):format(written, skipped))
    end
end)

test('write ignores hasMoved, because the PLACEMENT can change while the parent is still', function()
    -- The editor's case exactly: during an edit the vehicle is frozen, so
    -- hasMoved is false by construction and a tick would correctly decide there
    -- was nothing to do — while the thing that changed was the placement.
    local driver = freshDriver()
    local parent = spawn(identityBasis(0, 0, 0))
    local prop = spawn(nil)
    driver.add(prop, parent, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, scale = 1 })
    matrixWrites = {}

    if not driver.update(prop, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, scale = 5 }) then
        fail('update refused')
    end
    if #matrixWrites ~= 1 then fail('update must write; got ' .. #matrixWrites .. ' writes') end
    near(math.sqrt(DP.dot(matrixWrites[1].fwd, matrixWrites[1].fwd)), 5.0)
end)

test('tick drops an entry whose prop or parent has gone', function()
    -- Not merely a leak: this table is indexed by entity handle, handles are
    -- reused, and a stale entry is a claim on a handle that may later name
    -- something else entirely.
    local driver = freshDriver()
    local parent = spawn(identityBasis())
    local a = spawn(nil)
    local b = spawn(nil)
    driver.add(a, parent, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, scale = 2 })
    driver.add(b, parent, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, scale = 2 })
    if driver.count() ~= 2 then fail('expected 2 driven props') end

    world[a].deleted = true
    driver.tick()
    if driver.count() ~= 1 then fail('a deleted prop must be dropped, got ' .. driver.count()) end
    if driver.isDriven(a) then fail('the deleted prop is still driven') end

    world[parent].deleted = true
    driver.tick()
    if driver.count() ~= 0 then fail('a deleted parent must drop its props') end
end)

test('remove stops driving without deleting or re-attaching', function()
    local driver = freshDriver()
    local parent = spawn(identityBasis())
    local prop = spawn(nil)
    driver.add(prop, parent, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, scale = 2 })
    if not driver.remove(prop) then fail('remove refused a driven prop') end
    if driver.isDriven(prop) then fail('prop is still driven') end
    if driver.count() ~= 0 then fail('count not decremented') end
    -- The caller owns the object. A module that re-attached here would silently
    -- undo the scale it was asked to apply.
    if world[prop].attached then fail('remove must not re-attach') end
    if world[prop].deleted then fail('remove must not delete') end
    if driver.remove(prop) then fail('removing twice must report false') end
end)

test('clear forgets every prop without deleting any', function()
    local driver = freshDriver()
    local parent = spawn(identityBasis())
    local a, b = spawn(nil), spawn(nil)
    driver.add(a, parent, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, scale = 2 })
    driver.add(b, parent, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, scale = 2 })
    driver.clear()
    if driver.count() ~= 0 then fail('count should be 0') end
    if world[a].deleted or world[b].deleted then fail('clear must not delete') end
end)

test('a second add for the same prop replaces rather than double-counts', function()
    local driver = freshDriver()
    local parent = spawn(identityBasis())
    local prop = spawn(nil)
    driver.add(prop, parent, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, scale = 2 })
    driver.add(prop, parent, { x = 1, y = 0, z = 0, rx = 0, ry = 0, rz = 0, scale = 3 })
    if driver.count() ~= 1 then fail('expected 1 driven prop, got ' .. driver.count()) end
end)

report(('PASS: %d drivenprop assertions'):format(passed))
