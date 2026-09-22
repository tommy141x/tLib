-- Asking the player to type something without handing the browser the keyboard.
-- The menu draws and the game keeps the input; NUI focus for a text field would
-- put a mouse cursor over a controller-navigated menu and swallow movement keys
-- while the field was open. GTA's onscreen keyboard -- what the pause menu uses --
-- avoids both. One prompt for the whole interface, since there is one screen.

if _TLIB_SIDE ~= 'client' then return end

MenuPrompt = {}
local P = MenuPrompt

-- Registered at call time with the caller's title. Arbitrary but global to the
-- game session, hence the prefix.
local TEXT_ENTRY = 'TLIB_MENU_INPUT'

local prompting = false

--- Always safe to call: cancels whatever is open and returns the menu to ordinary
--- navigation. The client engine calls it on close and on shutdown.
function P.release()
    if prompting and type(CancelOnscreenKeyboard) == 'function' then pcall(CancelOnscreenKeyboard) end
    prompting = false
    if MenuInput then MenuInput.setModal(false) end
end

function P.active() return prompting end

--- Ask for a line of text. Blocks the calling thread until the player commits or
--- cancels, so call it from an action handler and never from the presentation path.
---
--- Returns the string on commit and nil on cancel. Everything else -- a second
--- concurrent prompt, an action cancelled underneath it, a timeout -- is raised
--- with error(message, 0), the shape the dispatcher reports to the player rather
--- than logging as a crash.
function P.text(title, initial, maximum, context)
    assert(MenuSchema.text(title, 128), 'Invalid input title')
    assert(type(maximum) == 'number' and maximum % 1 == 0 and maximum >= 1 and maximum <= 128, 'Invalid input length')
    assert(type(initial) == 'string' and #initial <= maximum and not initial:find('%c'), 'Invalid initial input')
    if not _TLIB_IS_FIVEM then error('Text input is unavailable on this platform', 0) end
    if prompting then error('Another input is already active', 0) end
    local function active() return context and context.isActive and context.isActive() end
    if not active() then error('Action cancelled', 0) end
    local ok, result = pcall(function()
        prompting = true
        if MenuInput then MenuInput.text(false); MenuInput.setModal(true) end
        AddTextEntry(TEXT_ENTRY, title)
        DisplayOnscreenKeyboard(1, TEXT_ENTRY, '', initial, '', '', '', maximum)
        -- Two deadlines: the wall clock catches a player who walked away, the
        -- frame count catches a paused or hitching game, where the wall clock
        -- would expire without the keyboard ever being polled.
        local started, frames = Platform.now(), 0
        while prompting and active() do
            local state = UpdateOnscreenKeyboard()
            if state == 1 then
                local value = GetOnscreenKeyboardResult()
                if type(value) ~= 'string' or #value > maximum or value:find('%c') then error('Invalid input text', 0) end
                return value
            end
            if state == 2 or state == 3 then return nil end
            frames = frames + 1
            if Platform.now() - started >= 60000 or frames >= 36000 then error('Text input timed out', 0) end
            Platform.wait(0)
        end
        error('Action cancelled', 0)
    end)
    P.release()
    if not ok then error(result, 0) end
    -- The action may have been cancelled while the player typed; committing into a
    -- dead action is worse than losing the text.
    if not active() then error('Action cancelled', 0) end
    return result
end

return MenuPrompt
