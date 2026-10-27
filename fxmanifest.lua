fx_version 'cerulean'
game 'gta5'
lua54 'yes'

name 'tLib'
author 'Tommy Johnston'
author 'TIMMYG Studios'
description 'tLib — shared UI and utility library (FiveM)'

version '1.0.0'

-- Don't move imports.lua: consumers name '@tLib/imports.lua' in their own
-- manifests, so the path is a contract.

shared_scripts {
    'shared/lib/adapter/init.lua',
    'shared/lib/logger.lua',
    'shared/lib/adapter/shim.lua',
    'shared/lib/adapter/core.lua',
    'shared/lib/adapter/events.lua',
    'shared/lib/adapter/ui.lua',
    'shared/lib/adapter/shutdown.lua',
    -- Before lifecycle.lua. Consumers load this exact file too.
    'shared/sh_branding.lua',
    -- The only definition of the studio API host. Consumers load it too.
    'shared/sh_api.lua',
    'shared/lib/adapter/lifecycle.lua',
    'shared/sh_utils.lua',
    'shared/sh_coords.lua',
    -- The menu protocol. Consumers validate against this exact file.
    'shared/lib/menu/schema.lua',
    -- Signatures must match byte for byte, so consumers run this file too.
    'shared/lib/menu/catalog.lua',
}

client_scripts {
    'client/lib/adapter/player.lua',
    'client/lib/adapter/vehicle.lua',
    'client/lib/adapter/world.lua',
    'client/cl_permission.lua',
    'client/lib/theme/exports.lua',
    'client/cl_theme.lua',
    -- Before cl_menu.lua, which hands it the resolver and publisher.
    'client/lib/menu/actions.lua',
    -- Always loaded: the menu client calls these, and they no-op if unused.
    'client/lib/menu/input.lua',
    -- After actions.lua: context walks every dispatcher on each pass.
    'client/lib/menu/context.lua',
    'client/lib/menu/prompts.lua',
    -- Last of the menu engine. Before cl_main.lua, which gives it the UI handle.
    'client/cl_menu.lua',
    'client/lib/toast/exports.lua',
    'client/cl_toast.lua',
    'client/cl_ui_effects.lua',
    'client/lib/dialog/state.lua',
    'client/lib/dialog/exports.lua',
    'client/cl_dialog.lua',
    'client/lib/layout/schema.lua',
    'client/cl_layout.lua',
    'client/cl_marketplace.lua',
    -- Before cl_main.lua, so ReportKeybind exists before consumers bind keys.
    'client/cl_keybinds.lua',
    'client/cl_main.lua',
}

server_scripts {
    'server/dist/bundle.js',
    'server/lib/adapter/utils.lua',
    'server/lib/adapter/permission.lua',
    -- Before sv_permission and sv_marketplace: in demo mode it overrides both.
    'server/sv_demo.lua',
    'server/sv_discovery.lua',
    -- The hub on the FiveM server port. After bundle.js, whose bridge exports the
    -- routing decision it asks for; a request before that is answered 503.
    'server/sv_http_ingress.lua',
    'server/sv_permission.lua',
    -- Server-only authority state. Before sv_menu.lua, which instantiates it.
    'server/lib/menu/registry.lua',
    -- Before sv_menu.lua, which dispatches `kind = 'feedback'` into it.
    'server/sv_feedback.lua',
    'server/sv_menu.lua',
    'server/sv_serversettings.lua',
    'server/sv_marketplace.lua',
    'server/sv_community_configs.lua',
    -- After sv_demo.lua, before sv_main.lua's boot handshake.
    'server/sv_telemetry.lua',
    'server/sv_main.lua',
}

files {
    'imports.lua',
    -- These two are read by consumers via LoadResourceFile.
    'shared/sh_branding.lua',
    'shared/sh_api.lua',
    'shared/imports/**/*.lua',
    'client/ui/index.html',
    'client/ui/assets/**/*',
}

ui_page 'client/ui/index.html'
