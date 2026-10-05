fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'Tommy Johnston'
author 'TIMMYG Studios'
description 'tLib — shared UI and utility library (FiveM)'
-- 0.13.0 adds `vehicleprop` (shared/imports/vehicleprop/shared.lua): the whole
-- of the in-vehicle prop -- model registry, placement store, ownership mark and
-- the lifecycle pass -- which tDetector and tRadar each carried as their own
-- 591-line client/cl_props.lua. Normalising only the prefix, the model name and
-- the device noun left 80 differing lines between the two, every one of them
-- comment prose or whitespace. It is `shared.lua` rather than `client.lua`
-- because the registry rules are asked on both sides: the client builds it to
-- decide what to SPAWN, the server to decide what a save may STORE.
-- Additive -- nothing that worked against 0.12.0 behaves differently.
--
-- 0.12.0 adds two things a consumer can need and cannot probe for:
--   * tLib:HasPermissionBatch — resolves many permission keys in ONE export round trip
--     (server/lib/adapter/permission.lua). tRadio was making 40+ consecutive export calls
--     per permission resolution, which a profiler attributed ~5.2 ms to.
--   * the optional `validate` content contract on a marketplace install target
--     (shared/ts/marketplace/installer/core.ts), so a consumer can refuse a bundle that is
--     safe to extract but is not a valid instance of its own item type.
-- Both are additive — nothing that worked against 0.11.0 behaves differently. The bump
-- exists so a consumer can PIN them via tlib_min_version, which is what imports.lua's
-- header calls the real guarantee: a capability probe cannot report its own absence.
version '0.13.0'

-- Layout note: the top-level folder is the VM a file is loaded into, matching
-- every other resource here. Where one module spans VMs -- the platform adapter
-- does -- it keeps its own name under each tree's lib/ rather than being split
-- by prefix, so `adapter` stays findable while the manifest below stays the
-- single authority on what runs where.
--
-- imports.lua stays at the root: consumers name it as '@tLib/imports.lua' in
-- their own manifests, so that path is a contract, not a convention.

shared_scripts {
    'shared/lib/adapter/init.lua',
    'shared/lib/logger.lua',
    'shared/lib/adapter/shim.lua',
    'shared/lib/adapter/core.lua',
    'shared/lib/adapter/events.lua',
    'shared/lib/adapter/ui.lua',
    'shared/lib/adapter/shutdown.lua',
    -- Before lifecycle.lua, which wraps it as Platform.isStudioResource. Shared
    -- because a consumer VM loads this exact file via shared/imports/versioncheck.
    'shared/sh_branding.lua',
    -- The one definition of the studio API host and of tmarketplace_base_url's
    -- normalisation. Shared because client/cl_marketplace.lua, server/
    -- sv_marketplace.lua and a consumer VM (via shared/imports/versioncheck)
    -- all need the same answer.
    'shared/sh_api.lua',
    'shared/lib/adapter/lifecycle.lua',
    'shared/sh_utils.lua',
    'shared/sh_coords.lua',
    -- The menu protocol. Shared so a consumer can validate its own definitions
    -- against this exact file via shared/imports/menu/shared.lua.
    'shared/lib/menu/schema.lua',
    -- The client only accepts a snapshot whose signature it can reproduce byte
    -- for byte, so the consumer's VM has to run this exact file too.
    'shared/lib/menu/catalog.lua',
}

client_scripts {
    'client/lib/adapter/player.lua',
    'client/lib/adapter/vehicle.lua',
    'client/lib/adapter/world.lua',
    'client/cl_permission.lua',
    'client/lib/theme/exports.lua',
    'client/cl_theme.lua',
    -- Client-only: handlers are functions living in the consumer's client VM and
    -- the effect scheduler is a client thread. Before cl_menu.lua, which hands
    -- it the item resolver and the publisher.
    'client/lib/menu/actions.lua',
    -- Built from GTA V control IDs, but always loaded: its entry points are what
    -- the menu client calls, and they degrade to no-ops rather than going missing.
    'client/lib/menu/input.lua',
    -- After actions.lua: context walks every dispatcher on each pass.
    'client/lib/menu/context.lua',
    'client/lib/menu/prompts.lua',
    -- Last of the engine: installs the item resolver into actions, the sender into
    -- input, and the client API. Before cl_main.lua, which hands it the UI handle.
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
    -- After the adapters and Logger (it uses both), and before cl_main so the
    -- ReportKeybind export exists by the time a consumer resource starts binding.
    'client/cl_keybinds.lua',
    'client/cl_main.lua',
}

server_scripts {
    'server/dist/bundle.js',
    'server/lib/adapter/utils.lua',
    'server/lib/adapter/permission.lua',
    -- Before sv_permission.lua and sv_marketplace.lua: both consult `Demo`, and
    -- in demo mode its answer replaces theirs rather than being consulted late.
    'server/sv_demo.lua',
    'server/sv_probe_fsperm.lua',
    'server/sv_discovery.lua',
    'server/sv_permission.lua',
    -- Server-only: holds the authority state and the action handlers, neither of
    -- which may exist in a VM a consumer can reach. Before sv_menu.lua, which
    -- instantiates it.
    'server/lib/menu/registry.lua',
    'server/sv_menu.lua',
    'server/sv_serversettings.lua',
    'server/sv_marketplace.lua',
    'server/sv_community_configs.lua',
    'server/sv_main.lua',
}

files {
    'imports.lua',
    -- Read by a consumer's versioncheck module via LoadResourceFile.
    'shared/sh_branding.lua',
    -- Same: a consumer VM loads this to resolve tmarketplace_base_url.
    'shared/sh_api.lua',
    'shared/imports/**/*.lua',
    'client/ui/index.html',
    'client/ui/assets/**/*',
}

ui_page 'client/ui/index.html'
