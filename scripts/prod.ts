import { join } from "node:path";
import AdmZip from "adm-zip";
import { runProd } from "../shared/ts/build/index.ts";

// The release allowlist is written out file by file rather than as whole trees.
// client/ and server/ both mix what runs on a server with what only builds it --
// client/web is the Vite source for client/ui, server/lib/{http,realtime,
// marketplace,inference,community-configs} are the TypeScript that becomes
// server/dist/bundle.js -- so copying either directory whole would ship the
// sources and their node_modules. A missing entry here is a hard error, not a
// warning: see stageFiles in ../shared/ts/build/core.ts.
runProd(
  {
    name: "tLib",
    // tLib is the library, not a configurable resource: it ships no config.lua and
    // has no credentials of its own. Declared so `createZip`'s credential sanitizer
    // treats "no config file staged" as expected here and as a refusal everywhere else.
    expectConfig: false,
    root: join(import.meta.dir, ".."),
    uiBuilds: [
      {
        source: "client/web",
        label: "Building UI, HUD helper and server bundle",
        command: ["bun", "run", "build"],
      },
    ],
    requiredFiles: [
      "client/ui/index.html",
      "client/ui/assets/hud-layout.js",
      "server/dist/bundle.js",
      // Not in the bundle on purpose -- it is 300KB and a server that never
      // renders the hub should not carry it -- so it has to ship as a FILE.
      // It did not, until 2026-10-15: every customer release had a hub with
      // no icons, because the source tree is the runtime on a dev box and
      // nothing here noticed the difference.
      "server/lib/http/icons.json",
    ],
    include: [
      "fxmanifest.lua",
      // Named as '@tLib/imports.lua' by every consumer's manifest.
      "imports.lua",
      "README.md",
      "LICENSE",

      "shared/sh_api.lua",
      "shared/sh_branding.lua",
      "shared/sh_coords.lua",
      "shared/sh_utils.lua",
      "shared/lib",
      // Loaded into a consumer's VM, so it ships even though tLib never runs it.
      "shared/imports",

      "client/cl_dialog.lua",
      "client/cl_keybinds.lua",
      "client/cl_layout.lua",
      "client/cl_main.lua",
      "client/cl_marketplace.lua",
      "client/cl_menu.lua",
      "client/cl_permission.lua",
      "client/cl_theme.lua",
      "client/cl_toast.lua",
      "client/cl_ui_effects.lua",
      "client/lib",
      "client/ui",

      "server/sv_community_configs.lua",
      "server/sv_demo.lua",
      "server/sv_discovery.lua",
      "server/sv_feedback.lua",
      "server/sv_main.lua",
      "server/sv_marketplace.lua",
      "server/sv_menu.lua",
      "server/sv_permission.lua",
      "server/sv_serversettings.lua",
      "server/sv_telemetry.lua",
      "server/lib/adapter",
      "server/lib/menu",
      // The hub's icon set. server/lib/http is otherwise Vite SOURCE that
      // compiles into server/dist/bundle.js, which is why this directory is
      // not shipped whole and this one data file has to be named.
      "server/lib/http/icons.json",
      "server/dist/bundle.js",
    ],
  },
  AdmZip
);
