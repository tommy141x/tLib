-- tlib.healthcheck
-- see tRadio/server/sv_version.lua for usage

local function httpGet(url, timeoutMs)
    local p = promise.new()
    local resolved = false

    PerformHttpRequest(url, function(status, body, headers)
        if not resolved then
            resolved = true
            p:resolve({ status = status or 0, body = body or '' })
        end
    end, 'GET', '', { ['User-Agent'] = 'tLib-HealthCheck' })

    CreateThread(function()
        Wait(timeoutMs or 8000)
        if not resolved then
            resolved = true
            p:resolve({ status = 0, body = '' })
        end
    end)

    return Citizen.Await(p)
end

local function extractPort(url)
    local port = url:match('//[^/]*:(%d+)')
    if port then return tonumber(port) end
    if url:match('^https://') then return 443 end
    if url:match('^http://') then return 80 end
    return nil
end

local function substituteVars(msg, url)
    if not msg then return msg end
    local port = extractPort(url) or '?'
    return msg:gsub('%%port%%', tostring(port))
end

--- The base to hang step paths off, or nil when `url` cannot be dialled.
---
--- A non-empty string is NOT enough, and that is what this exists for.
--- `PerformHttpRequest` resolves a RELATIVE url against `fivem://local/`, a
--- scheme its own http-client then refuses. The engine reports that as
---
---     [http-client] Unsupported scheme for URL: fivem://local/
---     [http-client] Unsupported scheme for URL: fivem://local/api/health
---
--- which names neither the resource that asked nor the value that was wrong, so
--- it reads as an engine fault. It is not: a `url` of "/" strips to an empty
--- base here and every step path goes out on its own. The caller's address
--- simply was not resolved yet.
---
--- Requiring scheme AND host also rejects "http://" and "localhost", which the
--- old `url ~= ''` guard let through to the same place.
local function usableBase(url)
    if type(url) ~= 'string' then return nil end
    -- Every trailing slash, not just one: "//" also strips to "" below.
    local trimmed = url:gsub('/+$', '')
    if not trimmed:match('^https?://[^/]+') then return nil end
    return trimmed
end

--- `base` arrives already validated and trailing-slash-stripped by `usableBase`,
--- so nothing here has to defend against a relative or empty address.
local function runSteps(base, steps, timeout)
    local results = {}
    for i, step in ipairs(steps) do
        local checkUrl = base .. (step.path or '/')
        local resp = httpGet(checkUrl, timeout)

        local passed = false
        local stepError = nil
        if step.expect then
            passed = step.expect(resp.status, resp.body)
        else
            passed = resp.status >= 200 and resp.status < 600
        end

        if not passed then
            if resp.status == 0 then
                stepError = step.errorMsg or ('Connection failed on step: ' .. step.name)
            else
                stepError = step.errorMsg or ('Check failed on step: ' .. step.name)
            end
            stepError = substituteVars(stepError, base)
        end

        results[i] = {
            name   = step.name,
            passed = passed,
            status = resp.status,
            error  = stepError,
        }

        if not passed then
            return results, step.name, stepError
        end
    end
    return results, nil, nil
end

local function check(opts)
    if not opts then return end

    local steps      = opts.steps or {{ name = 'reachable', path = '/' }}
    local retries    = opts.retries or 2
    local retryDelay = opts.retryDelay or 1000
    local timeout    = opts.timeout or 8000
    local callback   = opts.callback

    --- `base` is always an absolute, trailing-slash-stripped URL here; the
    --- result still reports it as `url`, which is what consumers read.
    local function run(base)
        CreateThread(function()
            local stepResults, failedStep, failMsg
            local attempts = 0

            for attempt = 0, retries do
                attempts = attempt + 1
                if attempt > 0 then Wait(retryDelay) end
                stepResults, failedStep, failMsg = runSteps(base, steps, timeout)
                if not failedStep then break end
            end

            local result = {
                success    = failedStep == nil,
                steps      = stepResults,
                attempts   = attempts,
                failedStep = failedStep,
                message    = failedStep and failMsg or 'All checks passed',
                url        = base,
            }

            if callback then callback(result) end
        end)
    end

    --- Refuse an address we cannot dial, and say so ONCE.
    ---
    --- Silence was the old behaviour for an empty string and it is the wrong
    --- half of the lesson: the consumer never hears back, its status sits on
    --- "checking" forever, and nothing in the log connects that to the address.
    --- A line naming the event and the offending value turns it into a
    --- five-second fix in the resource that fired it.
    ---
    --- Deduplicated per value: `waitEvent` can fire on every address
    --- re-resolution, and a warning repeating each time is one an operator
    --- learns to scroll past.
    local warned = {}
    local function accept(url, source)
        local base = usableBase(url)
        if base then return base end
        local shown = type(url) == 'string' and url or type(url)
        local key = source .. '\0' .. tostring(shown)
        if not warned[key] then
            warned[key] = true
            print(('^3[tLib] healthcheck: %s gave %q, which is not an absolute http(s) URL — ' ..
                'skipping the check rather than requesting a relative path, which FiveM ' ..
                'resolves to fivem://local/ and then refuses. Nothing is broken here; the ' ..
                'address was not resolved when the check was asked to run.^0')
                :format(source, tostring(shown)))
        end
        return nil
    end

    if opts.waitEvent then
        AddEventHandler(opts.waitEvent, function(url)
            local base = accept(url, opts.waitEvent)
            if not base then return end
            CreateThread(function()
                Wait(opts.delay or 500)
                run(base)
            end)
        end)
    elseif opts.url then
        local base = accept(opts.url, 'opts.url')
        if base then run(base) end
    end
end

return setmetatable({
    check = check,
}, {
    __call = function(_, opts) return check(opts) end,
})
