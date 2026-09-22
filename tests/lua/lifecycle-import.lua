local threads, subscriptions, state, logs = {}, {}, 'started', {}
function GetCurrentResourceName() return 'consumer' end
function IsDuplicityVersion() return true end
function GetResourceState() return state end
function CreateThread(fn) threads[#threads+1] = coroutine.create(fn) end
function Wait(ms) coroutine.yield(ms) end
function AddEventHandler(name, fn) subscriptions[#subscriptions+1]={name=name,fn=fn}; return #subscriptions end
function RemoveEventHandler(id) subscriptions[id].fn=false end
local originalPrint=print
function print(message) logs[#logs+1]=message end
local function emit(name, resource)
    for _, sub in ipairs(subscriptions) do if sub.name==name and sub.fn then sub.fn(resource) end end
end
local function step()
    for _, co in ipairs(threads) do
        if coroutine.status(co)~='dead' then local ok,err=coroutine.resume(co); assert(ok,err) end
    end
end
local function drain() for _=1,305 do step() end end
local L=dofile('shared/imports/lifecycle/shared.lua')
local first, second, cleanups, fail = 0,0,0,true
local watch=L.watch({resource='engine',readyEvent='ready', install=function(ctx)
    ctx.once('namespace',function() first=first+1; return true end)
    ctx.once('page',function() second=second+1; if fail then return false,'actual registration error' end; return true end)
end,cleanup=function() cleanups=cleanups+1 end})
assert(not watch.ready())
step(); step()
assert(first==1 and second==1, 'First attempt starts after a scheduler tick')
fail=false; step()
assert(watch.ready() and first==1 and second==2, 'Successful steps are not duplicated on retry')
emit('ready','engine'); emit('onResourceStart','engine'); drain()
assert(first==1 and second==2, 'Duplicate ready/start events do not re-register')
state='stopped'; emit('onResourceStop','engine')
assert(not watch.ready() and cleanups==1)
state='started'; emit('onResourceStart','engine'); drain()
assert(watch.ready() and first==2 and second==3, 'Dependency restart recreates each step once')
watch.invalidate(); assert(cleanups==2 and not watch.ready())
fail=true; watch.retry(); drain()
assert(first==3 and second==303 and #logs==1 and logs[1]:match('actual registration error'), 'Failure bounded with actual error')
fail=false; emit('ready','unrelated'); drain(); assert(second==303)
emit('ready','engine'); drain()
assert(first==3 and second==304 and watch.ready(), 'Readiness can retry after exhaustion without duplicating completed steps')
watch.invalidate(); watch.retry(); step()
emit('onResourceStop','consumer'); drain()
assert(not watch.ready() and first==3, 'Owner stop cancels pending registration before mutation')
local count=cleanups
watch.dispose(); watch.retry(); drain()
assert(cleanups==count, 'Dispose is idempotent')
for _,sub in ipairs(subscriptions) do assert(sub.fn==false, 'Subscriptions released') end
print=originalPrint
print('PASS lifecycle import: partial registration, bounded retries, actual errors, restart, cancellation and cleanup')
