-- helix needs explicit require, fivem already loaded this via fxmanifest

if _TLIB_IS_HELIX then
    require('lua/toast/exports')
end

Toast = {}

function Toast.init(ui)
    ToastExports.register(ui)
end
