-- Run from tLib root: bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/healthcheck-class.lua
--
-- Oracle for tlib.healthcheck's failure classes. "Public check failed (usually hairpin NAT)"
-- was printed for a port nobody listened on AND for a router that cannot loop back, because
-- both reached the consumer as `status 0`. They differ in the one thing the old code did not
-- record: a refusal comes back on its own, a silence only ends when the timer does.
--
-- HYPOTHESIS, not proven here: that FXServer's PerformHttpRequest really does call back fast
-- with status 0 (or the empty-headers 200) on a closed port. The suite proves the module's
-- classification given that; one run on a live VPS and one behind a NAT router proves the premise.

local realPrint = print
local passed = 0
local function test(name, fn)
    local ok, err = pcall(fn)
    if not ok then
        realPrint('FAIL ' .. name .. ': ' .. tostring(err))
        error('suite failed', 0)
    end
    passed = passed + 1
    realPrint('PASS ' .. name)
end

--- A cooperative host: virtual clock, coroutine threads, promises, and a PerformHttpRequest
--- whose answers the test scripts. `script(url)` returns { after = ms, args... } or nil for
--- a request that never calls back.
local function host(script)
    local clock, jobs = 0, {}
    local h = { printed = {}, requests = 0 }

    _ENV.GetGameTimer = function() return clock end
    _ENV.CreateThread = function(fn) jobs[#jobs + 1] = { at = clock, thread = coroutine.create(fn) } end
    _ENV.Wait = function(ms) return coroutine.yield(ms) end
    _ENV.promise = { new = function()
        local p = { done = false }
        function p:resolve(value) self.done, self.value = true, value end
        return p
    end }
    _ENV.Citizen = { Await = function(p)
        while not p.done do coroutine.yield(5) end
        return p.value
    end }
    _ENV.PerformHttpRequest = function(url, cb)
        h.requests = h.requests + 1
        local answer = script(url, h.requests)
        if not answer then return end
        CreateThread(function()
            Wait(answer.after or 0)
            cb(answer.status, answer.body, answer.headers, answer.errorData)
        end)
    end
    _ENV.AddEventHandler = function() end
    print = function(line) h.printed[#h.printed + 1] = tostring(line) end

    function h.runAll()
        while true do
            table.sort(jobs, function(a, b) return a.at < b.at end)
            local job = table.remove(jobs, 1)
            if not job then break end
            clock = math.max(clock, job.at)
            local ok, delay = coroutine.resume(job.thread)
            assert(ok, delay)
            if coroutine.status(job.thread) ~= 'dead' then
                job.at = clock + (delay or 0)
                jobs[#jobs + 1] = job
            end
        end
    end
    return h
end

local healthcheck = assert(loadfile('shared/imports/healthcheck/server.lua'))

--- Run one check against `script`, one attempt, and return the result.
local function check(script, step)
    local h = host(script)
    local result
    healthcheck()({
        url = 'http://198.18.0.9:30120',
        retries = 0,
        timeout = 8000,
        steps = { step or { name = 'reachable', path = '/tRadio/api/health' } },
        callback = function(r) result = r end,
    })
    h.runAll()
    print = realPrint
    assert(result, 'the check never called back')
    return result, h
end

local OK_HEADERS = { Date = 'Fri, 13 Nov 2026 10:00:00 GMT', ['Content-Type'] = 'application/json' }

test('a passing step is class ok, with the time it took', function()
    local r = check(function() return { after = 40, status = 200, body = '{"ok":true}', headers = OK_HEADERS } end)
    assert(r.success and r.failedClass == nil)
    assert(r.steps[1].class == 'ok' and r.steps[1].elapsedMs == 40, tostring(r.steps[1].elapsedMs))
end)

test('status 0 that comes back fast is REFUSED, and carries what the engine said', function()
    local r = check(function()
        return { after = 12, status = 0, body = '', headers = {}, errorData = 'connection refused' }
    end)
    assert(not r.success and r.failedClass == 'refused', tostring(r.failedClass))
    assert(r.steps[1].errorData == 'connection refused')
    assert(r.steps[1].elapsedMs == 12)
end)

test('a request that never calls back is SILENT: the timer ends it, not the network', function()
    local r = check(function() return nil end)
    assert(not r.success and r.failedClass == 'silent', tostring(r.failedClass))
    assert(r.steps[1].elapsedMs >= 8000, 'a silence is as long as the timeout: ' .. tostring(r.steps[1].elapsedMs))
end)

test('the engine\'s refused-connection shape (200, empty body, no headers) is REFUSED, not healthy', function()
    -- Measured on the ingress relay: a dead upstream arrives as status 200 with nothing at all.
    local r = check(function() return { after = 3, status = 200, body = '', headers = {} } end)
    assert(not r.success, 'a dead port passed as a healthy empty page')
    assert(r.failedClass == 'refused' and r.steps[1].status == 0, tostring(r.failedClass))
end)

test('a real empty 204 (it has headers) is not mistaken for a refusal', function()
    local r = check(function() return { after = 3, status = 204, body = '', headers = OK_HEADERS } end,
        { name = 'reachable', path = '/' })
    assert(r.success, 'an empty answer WITH headers is an answer')
end)

test('an answer that is not what the step expected is WRONG-SERVICE', function()
    local r = check(function() return { after = 20, status = 404, body = 'Not found.', headers = OK_HEADERS } end,
        { name = 'identity', path = '/api/health', expect = function(status) return status == 200 end })
    assert(not r.success and r.failedClass == 'wrong-service', tostring(r.failedClass))
    assert(r.steps[1].status == 404)
end)

test('errorMsgs picks the words by class, and falls back to errorMsg', function()
    local steps = function(extra)
        extra.name, extra.path = 'reachable', '/'
        extra.errorMsg = 'generic: port %port%'
        return extra
    end
    local words = { refused = 'nothing accepted port %port%', silent = 'no answer on port %port%' }

    local refused = check(function() return { after = 5, status = 0, body = '', headers = {} } end,
        steps({ errorMsgs = words }))
    assert(refused.message == 'nothing accepted port 30120', refused.message)

    local silent = check(function() return nil end, steps({ errorMsgs = words }))
    assert(silent.message == 'no answer on port 30120', silent.message)

    -- No entry for this class: the single message still applies, so no consumer breaks.
    local wrong = check(function() return { after = 5, status = 500, body = 'x', headers = OK_HEADERS } end,
        steps({ errorMsgs = words, expect = function(s) return s == 200 end }))
    assert(wrong.message == 'generic: port 30120', wrong.message)

    -- And a consumer that never heard of classes behaves exactly as before.
    local plain = check(function() return { after = 5, status = 0, body = '', headers = {} } end,
        steps({}))
    assert(plain.message == 'generic: port 30120', plain.message)
end)

test('the class is the one of the step that failed, after earlier steps passed', function()
    local h = host(function(url)
        if url:find('/one', 1, true) then return { after = 5, status = 200, body = 'ok', headers = OK_HEADERS } end
        return nil
    end)
    local result
    healthcheck()({
        url = 'http://198.18.0.9:30120', retries = 0, timeout = 1000,
        steps = { { name = 'one', path = '/one' }, { name = 'two', path = '/two' } },
        callback = function(res) result = res end,
    })
    h.runAll()
    print = realPrint
    assert(result.failedStep == 'two' and result.failedClass == 'silent', tostring(result.failedClass))
    assert(result.steps[1].class == 'ok' and result.steps[2].class == 'silent')
end)

realPrint(('Passed %d healthcheck-class tests'):format(passed))
