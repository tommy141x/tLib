-- helix needs explicit require, fivem already loaded this via fxmanifest

if _TLIB_IS_HELIX then
    require('lua/theme/exports')
end

Theme = {}

function Theme.init(ui)
    ThemeExports.register(ui)
end
