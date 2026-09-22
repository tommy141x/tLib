-- Runtime adapter boundary. Only FiveM is currently implemented.
-- Reject unsupported hosts before any subsystem can register inert APIs.
local isFiveM = (type(Citizen) == 'table' or type(Citizen) == 'userdata')
    and type(AddEventHandler) == 'function'
    and type(GetCurrentResourceName) == 'function'
    and type(IsDuplicityVersion) == 'function'

if not isFiveM then
    error('[tLib] Unsupported runtime: only the FiveM adapter is available', 0)
end

Platform = { name = 'fivem' }
_TLIB_IS_FIVEM = true

function Platform.getPackageName()
    return GetCurrentResourceName()
end

function Platform.getSide()
    return IsDuplicityVersion() and 'server' or 'client'
end

_TLIB_PACKAGE = Platform.getPackageName()
_TLIB_SIDE = Platform.getSide()

function Platform.isFiveM() return true end

local cachedContext
function Platform.context()
    if not cachedContext then
        cachedContext = {
            package = Platform.getPackageName(),
            side = Platform.getSide(),
            platform = Platform.name,
        }
    end
    return cachedContext
end

-- Unsupported capabilities must fail explicitly, never report no-op success.
function Platform._stub(name)
    return function()
        error(('Platform.%s is unavailable on runtime %q'):format(name, Platform.name), 2)
    end
end
