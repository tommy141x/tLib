import { join } from "node:path";
import AdmZip from "adm-zip";
import { runProd } from "../ts/src/build/index.ts";

runProd(
  {
    name: "tLib",
    root: join(import.meta.dir, ".."),
    uiBuilds: [{ source: "ui/src", label: "Building UI and server bundle" }],
    include: [
      "fxmanifest.lua",
      "client.lua",
      "server.lua",
      "imports.lua",
      "tLibShim.lua",
      "README.md",
      "LICENSE",
      "lua",
      "imports",
      "ui/index.html",
      "ui/assets",
      "server/bundle.js",
    ],
  },
  AdmZip
);
