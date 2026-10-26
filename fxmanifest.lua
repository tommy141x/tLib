fx_version 'cerulean'
game 'gta5'
lua54 'yes'

-- Set explicitly so StudioBranding.displayName is not reading a fallback.
name 'tLib'
author 'Tommy Johnston'
author 'TIMMYG Studios'
description 'tLib — shared UI and utility library (FiveM)'

-- 0.6 and 1.0 are the only releases, so every consumer pins `tlib_min_version
-- '1.0'`. 0.6.0 and 0.12.0-0.17.0 were never tagged and exist only as values on
-- this line; a consumer installed against the public v0.6 zip therefore fails the
-- gate in imports.lua rather than running degraded.
--
-- `BindMenuKey` and the five `tlib_menu_*` open-key convars were removed WITHIN
-- 1.0 -- the download is republished, not superseded, and no pin moves. Update
-- tMenu in step: it registers its own F1 now and an older tLib also bound one, so
-- both would fire.
--
-- The retired CHANGELOG.md holds the per-module rationale for 0.7-0.17:
-- `git show 858f933:CHANGELOG.md`.
version '1.0.0'

-- A released tLib also carries `tlib_build '<yyyymmdd>-<hash8>'`, written into the
-- staged manifest by `bun run prod` (`stampBuildId`) from a hash of the bytes it is
-- about to zip. Absent here because this tree is a checkout, not a release.
--
-- It exists because the republish above is invisible from `version '1.0.0'`: both
-- 1.0 trees reported `tLib 1.0.0` to `tradio_diag`, and support could not confirm a
-- customer's re-download had landed. A version bump only moves that to the next
-- republish.
--
-- NEVER fold it into `version`: imports.lua gates `tlib_min_version` by pulling
-- digits out of that string, and every consumer pins `'1.0'`.

-- The top-level folder is the VM a file loads into, so the blocks below are the
-- single authority on what runs where. imports.lua stays at the root because
-- consumers name '@tLib/imports.lua' in their own manifests -- that path is a
-- contract.

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
    -- The one definition of the studio API host and of tlib_api_base_url's
    -- normalisation. Shared so cl_marketplace, sv_marketplace and a consumer VM
    -- all get the same answer.
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
    'server/sv_discovery.lua',
    'server/sv_permission.lua',
    -- Server-only: holds the authority state and the action handlers, neither of
    -- which may exist in a VM a consumer can reach. Before sv_menu.lua, which
    -- instantiates it.
    'server/lib/menu/registry.lua',
    -- Before sv_menu.lua, which dispatches `kind = 'feedback'` into it. Server
    -- only: it reaches the menu registry's namespace table to check which
    -- resource a message may be attributed to.
    'server/sv_feedback.lua',
    'server/sv_menu.lua',
    'server/sv_serversettings.lua',
    'server/sv_marketplace.lua',
    'server/sv_community_configs.lua',
    -- The diagnostics door: the net events a consumer's client posts to, and the
    -- consent broadcast. After sv_demo.lua, and before sv_main.lua, which
    -- registers the exports for the boot handshake.
    'server/sv_telemetry.lua',
    'server/sv_main.lua',
}

files {
    'imports.lua',
    -- Read by a consumer's versioncheck module via LoadResourceFile.
    'shared/sh_branding.lua',
    -- Same: a consumer VM loads this to resolve tlib_api_base_url.
    'shared/sh_api.lua',
    'shared/imports/**/*.lua',
    'client/ui/index.html',
    'client/ui/assets/**/*',
}

ui_page 'client/ui/index.html'
