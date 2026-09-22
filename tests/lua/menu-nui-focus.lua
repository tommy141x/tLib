_TLIB_IS_FIVEM = true
local focused, focusCalls = true, 0
local commands = {}
Platform = { createThread = function() end }
IsNuiFocused = function() return focused end
SetNuiFocus = function(active) focusCalls = focusCalls + 1; focused = active end
SetNuiFocusKeepInput = function() end
RegisterCommand = function(name, fn) commands[name] = fn end
RegisterKeyMapping = function() end
dofile('client/lib/menu/input.lua')
MenuInput.setVisible(true)
assert(focusCalls == 0 and focused, 'Opening a menu must not release another UI focus')
assert(MenuInput.text(true) == false, 'Menu search must not steal dialog focus')
MenuInput.setVisible(false)
assert(focusCalls == 0 and focused, 'Closing a menu must not release dialog focus')
focused = false
MenuInput.setVisible(true)
assert(MenuInput.text(true) and focused, 'Search may acquire unclaimed focus')
MenuInput.text(false)
assert(not focused and focusCalls == 2, 'Search releases its own focus')
print('PASS: menu search respects externally owned NUI focus')
