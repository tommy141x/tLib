-- helix needs explicit require, fivem already loaded these via fxmanifest

if _TLIB_IS_HELIX then
    require('lua/menu/state')
    require('lua/menu/actions')
    require('lua/menu/navigation')
    require('lua/menu/exports')
end

Menu = {}

function Menu.init(ui)
    MenuState.setUI(ui)
    MenuNavigation.init(ui)
    MenuExports.register()
    -- markReady is intentionally NOT called here. The NUI page may not have
    -- loaded yet; client.lua defers the call until Platform.onNUIReady fires
    -- so that consumer resources cannot open menus before the JS listeners
    -- are active and messages would be silently lost.
end
