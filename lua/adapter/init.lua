-- platform detection, must load before other adapter files

Platform = {}

local _isFiveM = (type(Citizen) == 'table' or type(Citizen) == 'userdata')
    and type(AddEventHandler) == 'function'

local _isHelix = not _isFiveM
    and (type(WebUI) == 'function' or type(WebUI) == 'table')
    and type(Input) == 'table'

-- globals might not be set yet if we're loaded early, try weaker checks
if not _isFiveM and not _isHelix then
    if type(WebUI) == 'function' then
        _isHelix = true
    elseif type(AddEventHandler) == 'function' then
        _isFiveM = true
    end
end

_TLIB_IS_FIVEM = _isFiveM
_TLIB_IS_HELIX = _isHelix

if _isFiveM then
    Platform.name = 'fivem'
elseif _isHelix then
    Platform.name = 'helix'
else
    Platform.name = 'unknown'
end

function Platform.getPackageName()
    if _isHelix then
        return _G.__PackageName
    else
        return GetCurrentResourceName()
    end
end

function Platform.getSide()
    if _isHelix then
        return (HPlayer ~= nil) and 'client' or 'server'
    else
        return IsDuplicityVersion() and 'server' or 'client'
    end
end

_TLIB_PACKAGE = Platform.getPackageName()
_TLIB_SIDE    = Platform.getSide()


function Platform.isHelix() return Platform.name == 'helix' end

function Platform.isFiveM() return Platform.name == 'fivem' end

local _cachedContext
function Platform.context()
    if not _cachedContext then
        _cachedContext = {
            package  = Platform.getPackageName(),
            side     = Platform.getSide(),
            platform = Platform.name,
        }
    end
    return _cachedContext
end

function Platform._stub(name)
    return function(...)
        print('WARN: Platform.' .. name
            .. ' called but platform is "' .. Platform.name .. '" — no-op')
    end
end

