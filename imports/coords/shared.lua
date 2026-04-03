-- tLib — Coords module
-- Pure-math coordinate conversion utilities.
-- No platform calls — works on both FiveM and Helix, client and server.
--
-- All functions take pre-extracted matrix vectors (not entity handles) so they
-- stay platform-agnostic. Consumers call GetEntityMatrix(vehicle) or equivalent
-- themselves and pass the vectors in.
--
-- Loaded into consumer VM via imports.lua.
-- Available as both tlib.coords.* and the Coords.* global.

Coords = {}

--- Convert vehicle-local coordinates to FiveM world space.
--- @param right table  Vehicle right axis {x,y,z}
--- @param fwd   table  Vehicle forward axis {x,y,z}
--- @param up    table  Vehicle up axis {x,y,z}
--- @param pos   table  Vehicle world position {x,y,z}
--- @param lx    number Local X offset
--- @param ly    number Local Y offset
--- @param lz    number Local Z offset
--- @return number, number, number  World X, Y, Z
function Coords.localToWorld(right, fwd, up, pos, lx, ly, lz)
    return
        pos.x + right.x * lx + fwd.x * ly + up.x * lz,
        pos.y + right.y * lx + fwd.y * ly + up.y * lz,
        pos.z + right.z * lx + fwd.z * ly + up.z * lz
end

--- Convert FiveM world coordinates to vehicle-local space.
--- @param right table  Vehicle right axis {x,y,z}
--- @param fwd   table  Vehicle forward axis {x,y,z}
--- @param up    table  Vehicle up axis {x,y,z}
--- @param pos   table  Vehicle world position {x,y,z}
--- @param wx    number World X
--- @param wy    number World Y
--- @param wz    number World Z
--- @return number, number, number  Local X, Y, Z
function Coords.worldToLocal(right, fwd, up, pos, wx, wy, wz)
    local dx, dy, dz = wx - pos.x, wy - pos.y, wz - pos.z
    return
        dx * right.x + dy * right.y + dz * right.z,
        dx * fwd.x   + dy * fwd.y   + dz * fwd.z,
        dx * up.x    + dy * up.y    + dz * up.z
end

--- Build a world-space rotation matrix from bone euler angles (ZXY order).
--- rx = pitch (deg), ry = roll (deg), rz = yaw (deg)
--- Returns boneRight, boneFwd, boneUp as {x,y,z} tables.
function Coords.buildBoneRotMatrix(rx, ry, rz)
    local px, py, pz = math.rad(rx), math.rad(ry), math.rad(rz)
    local cx, sx = math.cos(px), math.sin(px)
    local cy, sy = math.cos(py), math.sin(py)
    local cz, sz = math.cos(pz), math.sin(pz)
    -- R = Rz(yaw) * Rx(pitch) * Ry(roll) — columns = world right / fwd / up
    return
        { x = cz*cy - sz*sx*sy, y = sz*cy + cz*sx*sy, z = -cx*sy },   -- right
        { x = -sz*cx,           y = cz*cx,             z = sx },        -- fwd
        { x = cz*sy + sz*sx*cy, y = sz*sy - cz*sx*cy,  z = cx*cy }     -- up
end

--- Convert a world-space point into bone-local coordinates.
--- bRight/bFwd/bUp = bone's world-space axes (from buildBoneRotMatrix).
--- bPx/bPy/bPz = bone world position.
function Coords.worldToBoneLocal(bRight, bFwd, bUp, bPx, bPy, bPz, wx, wy, wz)
    local dx, dy, dz = wx - bPx, wy - bPy, wz - bPz
    return
        dx*bRight.x + dy*bRight.y + dz*bRight.z,
        dx*bFwd.x   + dy*bFwd.y   + dz*bFwd.z,
        dx*bUp.x    + dy*bUp.y    + dz*bUp.z
end

--- Convert bone-local coordinates to world-space.
function Coords.boneLocalToWorld(bRight, bFwd, bUp, bPx, bPy, bPz, lx, ly, lz)
    return
        bPx + bRight.x*lx + bFwd.x*ly + bUp.x*lz,
        bPy + bRight.y*lx + bFwd.y*ly + bUp.y*lz,
        bPz + bRight.z*lx + bFwd.z*ly + bUp.z*lz
end

return Coords
