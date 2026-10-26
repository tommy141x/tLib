-- Entry point for every Lua suite under tests/lua, run from the tLib resource root:
--   bunx --bun fengari scripts/run-lua-suite.lua tests/lua/<suite>.lua
--
-- fengari's CLI can print an unhandled Lua error and still exit zero, so a suite
-- that threw on its first line would be reported as a pass. Every suite exception
-- becomes a non-zero exit here instead.
--
-- Deliberately thin: each suite loads its own engine files, host stubs and globals
-- (like _TLIB_SIDE or Platform), because that choice is part of what it is asserting.
--
-- realPrint is captured before any suite runs because several suites replace the
-- global print to read back what the code under test emitted. A suite that fails
-- while its capture is installed would otherwise swallow its own traceback and
-- exit 1 with nothing to diagnose it with.
local realPrint = print

local ok, err = xpcall(function()
    dofile(assert(arg[1], 'Suite path required'))
end, debug.traceback)
if not ok then realPrint(err); os.exit(1) end
