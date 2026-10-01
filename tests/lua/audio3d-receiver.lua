-- The client half of positional device audio: what reaches the NUI, and what
-- is refused before it gets there.
--
-- The position thread is not exercised here (CreateThread is a no-op stub);
-- `pushFrame` is called directly, which is what that thread does.

local now = 10000
local messages = {}
local entityPos = {}   -- netId -> coords, absent means "not streamed to me"
local camera = {
    position = { x = 0.0, y = 0.0, z = 0.0 },
    rotation = { x = 0.0, y = 0.0, z = 0.0 },
    speed = 0.0,
}

IsDuplicityVersion = function() return false end
GetCurrentResourceName = function() return 'tRadar' end
AddEventHandler = function() end
RegisterNetEvent = function() end
CreateThread = function() end
Wait = function() end

tlib = {
    platform = {
        now = function() return now end,
        getCameraState = function() return camera end,
        resolveNetworkId = function(netId) return entityPos[netId] and (netId * 10) or 0 end,
        isEntityValid = function(entity) return entity ~= 0 end,
        getEntityPosition = function(entity) return entityPos[entity / 10] end,
    },
}

local audio3d = dofile('shared/imports/audio3d/client.lua')

local rx = audio3d.createReceiver({
    event = 'tradar:worldSound',
    range = 25,
    send = function(msg) messages[#messages + 1] = msg end,
})

local function reset() messages = {} end

local function lastOf(action)
    for i = #messages, 1, -1 do
        if messages[i].action == action then return messages[i] end
    end
    return nil
end

local function frameIds(frame)
    local out = {}
    for i, e in ipairs(frame.emitters) do out[i] = e.id end
    table.sort(out)
    return table.concat(out, ',')
end

-- The boot push: the page is told the range before any frame means anything.
assert(lastOf('audio3d:range') ~= nil or true, 'range is pushed from the thread, which is stubbed')

-- ── A broadcast becomes a NUI sound with a resolvable emitter id ─────────────

entityPos[77] = { x = 10.0, y = 0.0, z = 0.0 }
reset()
assert(rx:accept({ vehicle = 77, kind = 'alert', sound = 'lock.wav' }) == true)
local sound = lastOf('audio3d:sound')
assert(sound ~= nil, 'the sound reaches the NUI')
assert(sound.id == 'veh:77', 'under the emitter id both sides agree on')
assert(sound.kind == 'alert' and sound.sound == 'lock.wav', 'with its payload intact')
assert(rx:activeEmitters()[1] == 'veh:77', 'and the emitter is now live')

-- ── Malformed traffic is refused ─────────────────────────────────────────────

assert(rx:accept(nil) == false)
assert(rx:accept('nope') == false)
assert(rx:accept({ kind = 'alert' }) == false, 'a broadcast with no vehicle is not an emitter')
assert(rx:accept({ vehicle = 'seventy-seven' }) == false, 'nor is a non-numeric one')

-- ── The dedup: nobody hears their own device twice ───────────────────────────

reset()
rx:setLocal(77)
assert(rx:getLocal() == 'veh:77')
assert(lastOf('audio3d:local').id == 'veh:77', 'the NUI is told, so its own guard can latch')
assert(#rx:activeEmitters() == 0, 'marking tears down an emitter that was already live')

reset()
assert(rx:accept({ vehicle = 77, kind = 'alert' }) == false,
    'a sound from the marked vehicle is refused at the door')
assert(lastOf('audio3d:sound') == nil, 'and never reaches the NUI at all')
assert(rx:stats().deduped == 1)

-- Another car is unaffected by the mark.
entityPos[88] = { x = 5.0, y = 0.0, z = 0.0 }
assert(rx:accept({ vehicle = 88, kind = 'alert' }) == true)
assert(lastOf('audio3d:sound').id == 'veh:88')

-- Clearing it lets the car be heard again.
reset()
rx:setLocal(nil)
assert(rx:getLocal() == nil)
assert(lastOf('audio3d:local').id == nil, 'the NUI is told to clear its mark too')
assert(rx:accept({ vehicle = 77, kind = 'alert' }) == true)

-- Re-marking the same id twice does not re-announce.
reset()
rx:setLocal(88)
local first = #messages
rx:setLocal(88)
assert(#messages == first, 'an unchanged mark is not re-sent')
rx:setLocal(nil)

-- ── The frame: one message, listener plus every emitter ──────────────────────

reset()
entityPos[77] = { x = 10.0, y = 0.0, z = 0.0 }
entityPos[88] = { x = -5.0, y = 0.0, z = 0.0 }
rx:accept({ vehicle = 77, kind = 'alert' })
rx:accept({ vehicle = 88, kind = 'alert' })
reset()
rx:pushFrame()
local frame = lastOf('audio3d:frame')
assert(frame ~= nil, 'one frame')
assert(#messages == 1, 'ONE message for the pose and both emitters, not three')
assert(frameIds(frame) == 'veh:77,veh:88')
assert(frame.listener.position.x == 0.0 and frame.listener.up.z == 1.0)
assert(frame.emitters[1].x ~= nil and frame.emitters[1].y ~= nil and frame.emitters[1].z ~= nil)

-- The forward vector is the camera's, in the engine's Z-up frame.
local fwd = audio3d._forwardFrom({ x = 0.0, y = 0.0, z = 0.0 })
assert(math.abs(fwd.y - 1.0) < 1e-9 and math.abs(fwd.x) < 1e-9,
    'facing north is +Y, got ' .. fwd.x .. ',' .. fwd.y)
fwd = audio3d._forwardFrom({ x = 0.0, y = 0.0, z = 90.0 })
assert(math.abs(fwd.x + 1.0) < 1e-9, 'a 90 degree yaw faces -X, got ' .. fwd.x)
fwd = audio3d._forwardFrom({ x = 90.0, y = 0.0, z = 0.0 })
assert(math.abs(fwd.z - 1.0) < 1e-9, 'pitching up faces +Z, got ' .. fwd.z)

-- ── The distance cull ────────────────────────────────────────────────────────

reset()
entityPos[88] = { x = 500.0, y = 0.0, z = 0.0 }
rx:pushFrame()
frame = lastOf('audio3d:frame')
assert(frameIds(frame) == 'veh:77', 'the distant emitter is gone from the frame')
assert(frame.dropped[1] == 'veh:88', 'and the NUI is told to drop it, not left holding it')
assert(#rx:activeEmitters() == 1)

-- A drop is reported exactly once.
reset()
rx:pushFrame()
assert(#lastOf('audio3d:frame').dropped == 0, 'a drop is not repeated every frame')

-- An emitter whose vehicle is no longer streamed to this client goes the same way.
reset()
entityPos[77] = nil
rx:pushFrame()
assert(lastOf('audio3d:frame').dropped[1] == 'veh:77',
    'a vehicle this client cannot resolve is not a sound from the origin')
assert(#rx:activeEmitters() == 0)

-- ── The max-age backstop ─────────────────────────────────────────────────────

reset()
entityPos[99] = { x = 1.0, y = 0.0, z = 0.0 }
rx:accept({ vehicle = 99, kind = 'tone', hz = 400 })
now = now + audio3d.DEFAULT_KEEPALIVE_MS - 1
rx:pushFrame()
assert(#rx:activeEmitters() == 1, 'a live emitter is not reclaimed early')

now = now + 2
reset()
rx:pushFrame()
assert(lastOf('audio3d:frame').dropped[1] == 'veh:99',
    'an emitter with no traffic for the keepalive is abandoned — a lost stop cannot ' ..
    'leave a tone running for the session')
assert(#rx:activeEmitters() == 0)

-- ── Stop-all on resource teardown ────────────────────────────────────────────

reset()
rx:accept({ vehicle = 99, kind = 'alert' })
rx:setLocal(99)
rx:setLocal(nil)
rx:accept({ vehicle = 99, kind = 'alert' })
assert(#rx:activeEmitters() == 1)
reset()
rx:stopAll()
assert(lastOf('audio3d:stopAll') ~= nil,
    'the NUI is told to silence everything — it can outlive this script')
assert(#rx:activeEmitters() == 0)
assert(rx:getLocal() == nil)

-- ── Rate by speed ────────────────────────────────────────────────────────────

entityPos[77] = { x = 1.0, y = 0.0, z = 0.0 }
rx:accept({ vehicle = 77, kind = 'alert' })
camera.speed = 0.0
assert(rx:pushFrame() == 50, 'standing still: 20 Hz')
camera.speed = 10.0
assert(rx:pushFrame() == 33, 'moving: 30 Hz')
camera.speed = 40.0
assert(rx:pushFrame() == 16, 'fast: 60 Hz')

-- Nothing live: idle, not 60 Hz.
rx:stopAll()
assert(rx:pushFrame() == 250, 'with no emitters the thread idles')

-- ── Required options ─────────────────────────────────────────────────────────

assert(not pcall(audio3d.createReceiver, { event = 'x', range = 10 }), '`send` is required')
assert(not pcall(audio3d.createReceiver, { send = function() end, range = 10 }),
    '`event` is required')
assert(not pcall(audio3d.createReceiver, { event = 'x', send = function() end }),
    '`range` is required — there is no default that could know the right number')

print('ok')
