fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'Tommy Johnston'
description 'tLib — shared UI and utility library (FiveM/Helix)'
version '0.4'

shared_scripts {
    'lua/adapter/init.lua',
    'lua/utils/logger.lua',
    'lua/adapter/shim.lua',
    'lua/adapter/core.lua',
    'lua/adapter/events.lua',
    'lua/adapter/ui.lua',
    'lua/adapter/shutdown.lua',
    'lua/utils/shared.lua',
    'lua/coords/shared.lua',
}

client_scripts {
    'lua/adapter/player.lua',
    'lua/adapter/vehicle.lua',
    'lua/adapter/world.lua',
    'lua/permission/client.lua',
    'lua/theme/exports.lua',
    'lua/theme/client.lua',
    'lua/menu/state.lua',
    'lua/menu/actions.lua',
    'lua/menu/navigation.lua',
    'lua/menu/exports.lua',
    'lua/menu/client.lua',
    'lua/toast/exports.lua',
    'lua/toast/client.lua',
    'lua/dialog/state.lua',
    'lua/dialog/exports.lua',
    'lua/dialog/client.lua',
    'client.lua',
}

server_scripts {
    'server/bundle.js',
    'lua/adapter/utils.lua',
    'lua/discovery/server.lua',
    'lua/permission/server.lua',
    'lua/serversettings/server.lua',
    'server.lua',
}

files {
    'imports.lua',
    'imports/**/shared.lua',
    'imports/**/client.lua',
    'imports/**/*.lua',
    'ui/index.html',
    'ui/assets/**/*',
}

ui_page 'ui/index.html'
