-- tLib — root server entry point
-- Loads each server-side subsystem and registers their exports.
--
-- Load order (enforced by package.json / fxmanifest.lua):
--   lua/adapter/init.lua     ← Platform detection
--   lua/utils/logger.lua     ← Logger.*
--   lua/adapter/core.lua     ← Platform.* API
--   lua/adapter/helix/http.lua  ← Http.*  (Helix only — package.json, not fxmanifest.lua)
--   lua/adapter/utils.lua    ← Platform.Fetch and other utility exports
--   server.lua               ← this file

-- Logger.registerExports() is intentionally NOT called here.
-- CreateLogger uses Platform.storeCallback to return a closure across the VM
-- boundary. storeCallback writes into the client VM's _tLibSharedCallbacks
-- table, and the RegisterClientEvent('tLib:callback') handler reads from that
-- same table — both must be in the same VM. Registering CreateLogger here in
-- the server VM causes storeCallback to write into the server VM's table
-- instead, which the client-side handler never sees, so every log key misses.
-- Logger exports are registered exclusively from client.lua.

-- Register server-side exports
Discovery.registerExports()
Permission.registerExports()

Platform.onShutdown(function()
end)
