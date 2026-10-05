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
-- Bound BEFORE any suite can run, because several suites replace the global `print`
-- to read back what the code under test emitted. With a plain `print` on the line
-- below, a suite that fails while its capture is installed resolves the CAPTURED
-- print: the traceback goes into the suite's buffer and the process exits 1 having
-- shown nothing. The right exit code with no way to tell what went wrong.
--
-- MEASURED in tCAD, whose runner has carried this fix for a while: a real failure in
-- its json-adapter suite produced ZERO output. tLib's copy never got it, and
-- tests/lua/diag-command.lua works around it by binding its own realPrint -- a
-- per-suite patch for a runner-level problem, which is why only that one suite was
-- protected. Ported here 2026-10-05 so every suite is.
local realPrint = print

local ok, err = xpcall(function()
    dofile(assert(arg[1], 'Suite path required'))
end, debug.traceback)
if not ok then realPrint(err); os.exit(1) end
