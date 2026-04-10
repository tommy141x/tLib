-- server entry point

-- DON'T register Logger exports here — storeCallback must be in the client VM
-- or the callback keys never resolve. see client.lua.
Discovery.registerExports()
Permission.registerExports()
ServerSettings.registerExports()

Platform.onShutdown(function()
end)
