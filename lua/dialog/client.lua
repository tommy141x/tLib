-- helix needs explicit require, fivem already loaded these via fxmanifest

if _TLIB_IS_HELIX then
    require('lua/dialog/state')
    require('lua/dialog/exports')
end

Dialog = {}

function Dialog.init(ui)
    DialogState.setUI(ui)
    DialogExports.register()
end
