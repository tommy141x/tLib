-- server entry point

-- DON'T register Logger exports here — storeCallback must be in the client VM
-- or the callback keys never resolve. see client.lua.
Discovery.registerExports()
Permission.registerExports()
ServerSettings.registerExports()

Platform.onShutdown(function()
end)

-- update check against github releases
Citizen.CreateThread(function()
    Citizen.Wait(5000)

    local currentVersion = GetResourceMetadata(GetCurrentResourceName(), 'version', 0) or '0.0.0'

    PerformHttpRequest('https://api.github.com/repos/tommy141x/tLib/releases/latest', function(status, body)
        if status ~= 200 or not body then return end

        local ok, data = pcall(json.decode, body)
        if not ok or not data then return end

        local latest = data.tag_name
        if not latest then return end

        local function parseVer(s)
            s = (s or ''):gsub('^v', '')
            local parts = {}
            for n in s:gmatch('%d+') do parts[#parts + 1] = tonumber(n) end
            while #parts < 3 do parts[#parts + 1] = 0 end
            return parts
        end

        local cur = parseVer(currentVersion)
        local new = parseVer(latest)

        local outdated = false
        for i = 1, 3 do
            if cur[i] < new[i] then outdated = true; break
            elseif cur[i] > new[i] then break end
        end

        if outdated then
            print('^0--------------------------------------------------------------------')
            print('^3tLib ^1update available^0: v' .. currentVersion .. ' -> ^2' .. latest)
            if data.html_url then
                print('^0Download: ^5' .. data.html_url)
            end
            -- show release notes if they exist
            if data.body and data.body ~= '' then
                print('')
                for line in data.body:gmatch('[^\n]+') do
                    print('^0  ' .. line)
                end
            end
            print('^0--------------------------------------------------------------------')
        else
            print('^2[tLib] ^0v' .. currentVersion .. ' - up to date')
        end
    end, 'GET', '', {
        ['User-Agent'] = 'tLib-UpdateChecker',
        ['Accept'] = 'application/vnd.github.v3+json',
    })
end)
