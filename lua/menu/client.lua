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
    MenuState.markReady()
end
