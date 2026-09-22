-- Entry point for every Lua suite under tests/lua, run from the tLib resource root:
--   bunx --bun fengari scripts/run-lua-suite.lua tests/lua/<suite>.lua
--
-- It exists for one reason: fengari's CLI can print an unhandled Lua error while
-- still exiting zero, so a suite that blew up on its first line would be reported
-- as a pass. Every suite exception becomes a non-zero exit here instead.
--
-- Deliberately thin. A suite loads the engine files it is an oracle for itself,
-- with its own host stubs, because which files a suite needs -- and what has to be
-- defined before they load, like _TLIB_SIDE or Platform -- is part of what the
-- suite is asserting. A runner that pre-loaded them would be deciding that for it.
local ok, err = xpcall(function()
    dofile(assert(arg[1], 'Suite path required'))
end, debug.traceback)
if not ok then print(err); os.exit(1) end
