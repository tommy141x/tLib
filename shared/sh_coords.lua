-- Coordinate math over raw matrix vectors: no entity handles, no platform calls.
-- `right`, `fwd` and `up` are the axes of the space being converted into or out
-- of, and `pos` is its world origin.

Coords = {}

function Coords.localToWorld(right, fwd, up, pos, lx, ly, lz)
    return
        pos.x + right.x * lx + fwd.x * ly + up.x * lz,
        pos.y + right.y * lx + fwd.y * ly + up.y * lz,
        pos.z + right.z * lx + fwd.z * ly + up.z * lz
end

function Coords.worldToLocal(right, fwd, up, pos, wx, wy, wz)
    local dx, dy, dz = wx - pos.x, wy - pos.y, wz - pos.z
    return
        dx * right.x + dy * right.y + dz * right.z,
        dx * fwd.x   + dy * fwd.y   + dz * fwd.z,
        dx * up.x    + dy * up.y    + dz * up.z
end

--- Bone euler angles in degrees -- pitch, roll, yaw, applied in ZXY order -- to
--- the bone's world right, forward and up axes.
function Coords.buildBoneRotMatrix(rx, ry, rz)
    local px, py, pz = math.rad(rx), math.rad(ry), math.rad(rz)
    local cx, sx = math.cos(px), math.sin(px)
    local cy, sy = math.cos(py), math.sin(py)
    local cz, sz = math.cos(pz), math.sin(pz)
    -- R = Rz(yaw) * Rx(pitch) * Ry(roll); its columns are the axes.
    return
        { x = cz*cy - sz*sx*sy, y = sz*cy + cz*sx*sy, z = -cx*sy },   -- right
        { x = -sz*cx,           y = cz*cx,             z = sx },        -- fwd
        { x = cz*sy + sz*sx*cy, y = sz*sy - cz*sx*cy,  z = cx*cy }     -- up
end

--- Axes come from buildBoneRotMatrix; bPx/bPy/bPz is the bone's world position.
function Coords.worldToBoneLocal(bRight, bFwd, bUp, bPx, bPy, bPz, wx, wy, wz)
    local dx, dy, dz = wx - bPx, wy - bPy, wz - bPz
    return
        dx*bRight.x + dy*bRight.y + dz*bRight.z,
        dx*bFwd.x   + dy*bFwd.y   + dz*bFwd.z,
        dx*bUp.x    + dy*bUp.y    + dz*bUp.z
end

function Coords.boneLocalToWorld(bRight, bFwd, bUp, bPx, bPy, bPz, lx, ly, lz)
    return
        bPx + bRight.x*lx + bFwd.x*ly + bUp.x*lz,
        bPy + bRight.y*lx + bFwd.y*ly + bUp.y*lz,
        bPz + bRight.z*lx + bFwd.z*ly + bUp.z*lz
end
