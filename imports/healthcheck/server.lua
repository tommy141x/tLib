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
    local port = url:match(':(%d+)')
    return port and tonumber(port) or nil
end

local function substituteVars(msg, url)
    if not msg then return msg end
    local port = extractPort(url) or '?'
    return msg:gsub('%%port%%', tostring(port))
end

local function runSteps(url, steps, timeout)
    local results = {}
    for i, step in ipairs(steps) do
        local checkUrl = url .. (step.path or '/')
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
            stepError = substituteVars(stepError, url)
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

    local function run(url)
        CreateThread(function()
            local stepResults, failedStep, failMsg
            local attempts = 0

            for attempt = 0, retries do
                attempts = attempt + 1
                if attempt > 0 then Wait(retryDelay) end
                stepResults, failedStep, failMsg = runSteps(url, steps, timeout)
                if not failedStep then break end
            end

            local result = {
                success    = failedStep == nil,
                steps      = stepResults,
                attempts   = attempts,
                failedStep = failedStep,
                message    = failedStep and failMsg or 'All checks passed',
                url        = url,
            }

            if callback then callback(result) end
        end)
    end

    if opts.waitEvent then
        AddEventHandler(opts.waitEvent, function(url)
            if type(url) == 'string' and url ~= '' then
                CreateThread(function()
                    Wait(opts.delay or 500)
                    run(url)
                end)
            end
        end)
    elseif opts.url then
        run(opts.url)
    end
end

return setmetatable({
    check = check,
}, {
    __call = function(_, opts) return check(opts) end,
})
