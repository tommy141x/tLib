-- The orbit camera's maths, off-game.
--
-- `orbit` is deliberately native-free so this suite can exist: every one of these
-- relations used to be asserted only by looking at the game, where a sign error
-- in camUp reads as "panning feels wrong" rather than as a failure.

local PropEditor = dofile('shared/imports/propeditor/client.lua')
local orbit = PropEditor.orbit

local function near(a, b, eps)
    return math.abs(a - b) <= (eps or 1e-6)
end

-- ── eye / lookFrom are inverses ─────────────────────────────────────────────

local s = orbit.new(10.0, 20.0, 30.0)
s.yaw, s.pitch, s.dist = 37.0, -18.0, 6.5
local ex, ey, ez = orbit.eye(s)

local back = orbit.new(10.0, 20.0, 30.0)
orbit.lookFrom(back, ex, ey, ez, false)
assert(near(back.yaw, 37.0, 1e-4), 'lookFrom recovers the yaw eye() was built from')
assert(near(back.pitch, -18.0, 1e-4), 'lookFrom recovers the pitch')
assert(near(back.dist, 6.5, 1e-4), 'lookFrom recovers the distance')

-- `clampOpen` is the "inherit the gameplay camera" case: a camera inside the car
-- or a hundred metres away must not become the starting orbit distance.
local opened = orbit.new(0.0, 0.0, 0.0)
orbit.lookFrom(opened, 0.0, 100.0, 0.0, true)
assert(near(opened.dist, 15.0), 'a far gameplay camera opens clamped to 15m')
orbit.lookFrom(opened, 0.0, 0.5, 0.0, true)
assert(near(opened.dist, 2.0), 'a camera inside the car opens clamped to 2m')
orbit.lookFrom(opened, 0.0, 0.5, 0.0, false)
assert(near(opened.dist, 0.5), 'without clampOpen the true distance is kept')

-- ── camRight / camUp ────────────────────────────────────────────────────────

local flat = orbit.new()
flat.yaw, flat.pitch = 0.0, 0.0
local rx, ry, rz = orbit.camRight(flat)
-- `eye()` at yaw 0 is focus + (0, dist, 0): the camera stands to the NORTH of the
-- focus and looks along -Y. Standing there, +X is on your LEFT, so the vector this
-- function returns is screen-LEFT despite its name. That is not a bug -- every
-- caller is written against it -- but it is the single easiest thing in this file
-- to get backwards, and getting it backwards is exactly what inverted Shift-pan.
assert(near(rx, 1.0) and near(ry, 0.0) and near(rz, 0.0),
    'at yaw 0, camRight is +X -- which is SCREEN-LEFT, because eye() looks along -Y')
local ux, uy, uz = orbit.camUp(flat)
assert(near(ux, 0.0) and near(uy, 0.0) and near(uz, 1.0),
    'with no pitch, up is world up')

-- right is horizontal at every pitch -- panning left/right must never change Z.
for _, pitch in ipairs({ -80.0, -30.0, 0.0, 45.0, 80.0 }) do
    local t = orbit.new()
    t.yaw, t.pitch = 123.0, pitch
    local _, _, z = orbit.camRight(t)
    assert(near(z, 0.0), 'camRight never has a vertical component')
end

-- right and up stay unit length and perpendicular.
local q = orbit.new()
q.yaw, q.pitch = 71.0, -34.0
local qrx, qry, qrz = orbit.camRight(q)
local qux, quy, quz = orbit.camUp(q)
assert(near(math.sqrt(qrx * qrx + qry * qry + qrz * qrz), 1.0), 'camRight is a unit vector')
assert(near(math.sqrt(qux * qux + quy * quy + quz * quz), 1.0), 'camUp is a unit vector')
assert(near(qrx * qux + qry * quy + qrz * quz, 0.0), 'camRight and camUp are perpendicular')

-- ── applyDrag ───────────────────────────────────────────────────────────────

-- ── The four drag axes, pinned one at a time ────────────────────────────────
--
-- Two controls, two axes each, and ONE convention between all four: **the scene
-- follows the cursor**. Drag right and what you are looking at moves right; drag
-- down and it moves down.
--
-- Two of the four disagreed with that in the shipped editor and were reported
-- from the game -- "shift-drag horizontally is backwards like left = right" and
-- "camera orbit is inverted up or down" -- while the other two were correct. So
-- each axis is asserted SEPARATELY here, in both its numeric sign and the
-- geometric consequence, and each is asserted not to disturb the other axis of
-- its own control. Flipping any one sign in `orbit.applyDrag` must fail exactly
-- one of these blocks and no others.
--
-- The canonical pose throughout: focus at the origin, yaw 0, pitch 0. The camera
-- is then at (0, dist, 0) looking along -Y, so screen-right is -X and screen-up
-- is +Z.

local DRAG = 50.0
local DIST = 10.0
local PAN = DIST * orbit.PAN_SENS_PX

-- 1. PAN, horizontal. Dragging right slides the focus toward +X, which is
--    SCREEN-LEFT -- so the subject, which does not move, ends up screen-RIGHT of
--    the new focus. The scene followed the cursor.
local panH = orbit.new(0.0, 0.0, 0.0)
panH.yaw, panH.pitch, panH.dist = 0.0, 0.0, DIST
orbit.applyDrag(panH, DRAG, 0.0, 'pan')
assert(near(panH.focus.x, DRAG * PAN),
    'pan: dragging RIGHT moves the focus screen-left, so the subject tracks right')
assert(near(panH.focus.y, 0.0) and near(panH.focus.z, 0.0),
    'pan: a purely horizontal drag touches neither depth nor height')

-- 2. PAN, vertical. Dragging down lifts the focus along camUp, leaving the
--    subject below it -- the scene moved down with the cursor.
local panV = orbit.new(0.0, 0.0, 0.0)
panV.yaw, panV.pitch, panV.dist = 0.0, 0.0, DIST
orbit.applyDrag(panV, 0.0, DRAG, 'pan')
assert(near(panV.focus.z, DRAG * PAN),
    'pan: dragging DOWN raises the focus, so the subject tracks down')
assert(near(panV.focus.x, 0.0) and near(panV.focus.y, 0.0),
    'pan: a purely vertical drag at zero pitch is height only')

-- 3. ORBIT, yaw. Dragging right swings the camera toward +X (screen-left of where
--    it was), which carries the subject across the screen to the right.
local orbY = orbit.new()
orbY.yaw, orbY.pitch, orbY.dist = 0.0, 0.0, DIST
orbit.applyDrag(orbY, DRAG, 0.0, 'orbit')
assert(near(orbY.yaw, DRAG * orbit.ORBIT_SENS_PX),
    'orbit: dragging RIGHT increases yaw -- degrees per PIXEL of drag')
assert(near(orbY.pitch, 0.0), 'orbit: a purely horizontal drag does not pitch')
local yex = select(1, orbit.eye(orbY))
assert(yex > 0.0, 'orbit: a right drag walks the camera round toward +X')

-- 4. ORBIT, pitch. Dragging down RAISES the camera, so it looks down on the
--    subject and the subject slides down the screen after the cursor. This is the
--    one that shipped inverted: it was `pitch - dy`, which dropped the camera and
--    sent the subject up.
local orbP = orbit.new()
orbP.yaw, orbP.pitch, orbP.dist = 0.0, 0.0, DIST
orbit.applyDrag(orbP, 0.0, DRAG, 'orbit')
assert(near(orbP.pitch, DRAG * orbit.ORBIT_SENS_PX),
    'orbit: dragging DOWN increases pitch, so the subject tracks down')
assert(near(orbP.yaw, 0.0), 'orbit: a purely vertical drag does not yaw')
local _, _, pez = orbit.eye(orbP)
assert(pez > 0.0, 'orbit: a down drag lifts the camera above the focus')

-- Pitch is clamped, not wrapped, in BOTH directions: passing +-90 flips the up
-- vector and the camera rolls over.
local clampd = orbit.new()
clampd.pitch = 0.0
orbit.applyDrag(clampd, 0.0, 100000.0, 'orbit')
assert(near(clampd.pitch, orbit.PITCH_LIMIT), 'pitch clamps at the top pole, it does not wrap')
orbit.applyDrag(clampd, 0.0, -100000.0, 'orbit')
assert(near(clampd.pitch, -orbit.PITCH_LIMIT), 'pitch clamps at the bottom pole too')

-- Pan is a fraction of the orbit distance, so it feels the same at every zoom.
local far = orbit.new(0.0, 0.0, 0.0)
far.yaw, far.pitch, far.dist = 0.0, 0.0, DIST * 2.0
orbit.applyDrag(far, DRAG, 0.0, 'pan')
assert(near(far.focus.x, panH.focus.x * 2.0), 'twice as far away pans twice as fast')

local dolly = orbit.new()
dolly.dist = 10.0
orbit.applyDrag(dolly, 0.0, 100.0, 'dolly')
assert(near(dolly.dist, 10.0 * (1.0 + 100.0 * 0.004)), 'dolly is multiplicative')
orbit.applyDrag(dolly, 0.0, 1e9, 'dolly')
assert(near(dolly.dist, orbit.DIST_MAX), 'dolly clamps at the far limit')
orbit.applyDrag(dolly, 0.0, -1e9, 'dolly')
assert(near(dolly.dist, orbit.DIST_MIN), 'dolly clamps at the near limit')

-- ── The command switch ──────────────────────────────────────────────────────

-- Every command the TSX half can send that does not need an entity handle. If
-- one of these stops being handled here it has to be handled in the Editor
-- instead, or the key silently does nothing.
local PURE = {
    'orbitLeft', 'orbitRight', 'orbitUp', 'orbitDown',
    'panLeft', 'panRight', 'panUp', 'panDown',
    'zoomIn', 'zoomOut',
    'viewFront', 'viewBack', 'viewLeft', 'viewRight',
    'viewTop', 'viewBottom', 'viewFlip',
}
for _, cmd in ipairs(PURE) do
    assert(orbit.command(orbit.new(), cmd) == true, cmd .. ' is handled by the pure switch')
end

-- These four need the vehicle, the ped or the cam handle, so the Editor keeps
-- them. `orbit.command` must report them UNHANDLED rather than swallow them.
for _, cmd in ipairs({ 'focusSelected', 'focusAll', 'togglePersp', 'viewDriverPov' }) do
    assert(orbit.command(orbit.new(), cmd) == false,
        cmd .. ' needs game state and must fall through to the Editor')
end
assert(orbit.command(orbit.new(), 'nonsense') == false, 'an unknown command is not handled')

local v = orbit.new()
orbit.command(v, 'viewFront')
assert(near(v.yaw, 180.0) and near(v.pitch, 0.0), 'viewFront looks at the front of the car')
orbit.command(v, 'viewFlip')
assert(near(v.yaw, 360.0) and near(v.pitch, 0.0), 'viewFlip turns 180 degrees')
orbit.command(v, 'viewTop')
assert(near(v.pitch, orbit.PITCH_LIMIT), 'viewTop goes to the pitch limit, not to 90')

-- Vertical pan moves the focus along camUp; at zero pitch that is pure Z.
local vp = orbit.new(0.0, 0.0, 0.0)
vp.yaw, vp.pitch = 0.0, 0.0
orbit.command(vp, 'panUp')
assert(near(vp.focus.x, 0.0) and near(vp.focus.y, 0.0), 'panUp at zero pitch is vertical only')
assert(near(vp.focus.z, -orbit.PAN_STEP), 'panUp moves the focus down, so the subject rises')

-- ── localToWorld ────────────────────────────────────────────────────────────

-- Identity matrix: right=+X, fwd=+Y, up=+Z. The offset is (right, fwd, up), i.e.
-- GTA's vehicle-local ordering, not (x, y, z) of the matrix.
local ident = {
    right = { x = 1, y = 0, z = 0 },
    fwd   = { x = 0, y = 1, z = 0 },
    up    = { x = 0, y = 0, z = 1 },
    pos   = { x = 100, y = 200, z = 300 },
}
local wx, wy, wz = PropEditor.localToWorld(ident, { x = 1, y = 2, z = 3 })
assert(near(wx, 101) and near(wy, 202) and near(wz, 303), 'identity matrix is a translation')

-- Car turned 90 degrees left: fwd is -X, right is +Y.
local turned = {
    right = { x = 0, y = 1, z = 0 },
    fwd   = { x = -1, y = 0, z = 0 },
    up    = { x = 0, y = 0, z = 1 },
    pos   = { x = 0, y = 0, z = 0 },
}
local tx, ty, tz = PropEditor.localToWorld(turned, { x = 0, y = 2, z = 0 })
assert(near(tx, -2) and near(ty, 0) and near(tz, 0),
    'a prop 2m forward on a car facing -X is 2m along -X')

print('PASS: prop editor orbit camera maths, command switch and local-to-world transform')
