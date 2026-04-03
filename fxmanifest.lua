fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'Tommy Johnston'
description 'tLib — shared UI and utility library (FiveM/Helix)'
version '1.0.0'

shared_scripts {
    'lua/adapter/init.lua',
    'lua/utils/logger.lua',
    'lua/adapter/core.lua',
    'lua/coords/shared.lua',
}

client_scripts {
    'lua/adapter/player.lua',
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
    'server.lua',
}

files {
    'imports.lua',
    'imports/**/shared.lua',
    'imports/**/client.lua',
    'ui/build/index.html',
    'ui/build/**/*',
}

ui_page 'ui/build/index.html'
