import * as fs from "node:fs";
import * as path from "node:path";
import { registerWriteResourceFile } from "../shared/ts/fs/server";
import { installCommunityConfigs } from "./lib/community-configs/index";
import { installHttp } from "./lib/http/index";
import { installInference } from "./lib/inference/index";
import { installMarketplace } from "./lib/marketplace/index";
import { installRealtime } from "./lib/realtime/index";
import { installSpawn } from "./lib/spawn/index";

declare function GetResourcePath(resourceName: string): string | null;
declare function exports(name: string, fn: (...args: unknown[]) => unknown): void;

// tLib's one external port; every web surface any resource exposes is a mount on
// it. Binds eagerly because a consumer's Lua can call RegisterWebApp before
// tLib's own onResourceStart handler runs.
installHttp();

// Realtime is a mount on the router at /rt rather than its own socket. Only the
// exports go up here; sessions and rooms are built on the first connection.
installRealtime();

// Opt-in: only a resource declaring `tlib_module { 'marketplace' }` wakes it.
installMarketplace();

// The `cc*` exports behind server/sv_community_configs.lua. Eager for the same
// reason as the marketplace: a consumer's Lua may call them immediately. It is
// registered separately from the marketplace because only the PUBLISH path
// shares its credential — the reads are open, and one module that is half
// authenticated is a module whose reader assumes the wrong half.
installCommunityConfigs();

// A table of which resource is already serving which model, so two resources
// that each ship local inference load one copy between them.
installInference();

// The gated child-process broker. tDB, tAI and tRadio start their engines
// through this, so `add_unsafe_child_process_permission tLib` is the only line
// an operator has to write — and what sits behind that one line is narrower
// than the four unrestricted grants it replaced. See server/lib/spawn/catalog.ts.
installSpawn();

const siblings: string[] = [];

exports("RegisterManifestSibling", (key: string) => {
  if (!siblings.includes(key)) siblings.push(key);
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type ScanFailure =
  | "bad-resource"
  | "bad-subdir"
  | "no-resource-path"
  | "missing"
  | "not-a-directory"
  | "read-failed";

type ScanResult = { ok: true; entries: string[] } | { ok: false; reason: ScanFailure };

// The one enumeration path. `subdir` is relative to the resource root and must
// not contain `..`.
//
// This reports failure rather than flattening it, because the difference
// matters to a caller reconciling a stored registry against disk: "the folder
// is empty" means prune everything, "the folder could not be read" means keep
// what you have. Collapsing the two into an empty list is what let a scan
// failure look like a deliberate deletion.
function scanResource(resourceName: unknown, subdir: unknown, want: "file" | "dir"): ScanResult {
  if (typeof resourceName !== "string" || resourceName.length === 0)
    return { ok: false, reason: "bad-resource" };
  const sub = typeof subdir === "string" ? subdir : "";
  if (sub.includes("..")) return { ok: false, reason: "bad-subdir" };

  const resPath = GetResourcePath(resourceName);
  if (!resPath) return { ok: false, reason: "no-resource-path" };

  const target = sub ? path.join(resPath, sub) : resPath;
  try {
    if (!fs.existsSync(target)) return { ok: false, reason: "missing" };
    if (!fs.statSync(target).isDirectory()) return { ok: false, reason: "not-a-directory" };
    const entries = fs
      .readdirSync(target, { withFileTypes: true })
      .filter((e) => (want === "file" ? e.isFile() : e.isDirectory()))
      .map((e) => e.name);
    return { ok: true, entries };
  } catch {
    return { ok: false, reason: "read-failed" };
  }
}

// FiveM's Lua runtime has no directory enumeration, so without this a consumer
// discovering files by pattern can only probe known names:
//
//   local names = json.decode(exports.tLib:ListResourceFiles('tAFK', 'audio') or '[]')
//
// Returns JSON-encoded filenames, or '[]' on any error, so callers never
// branch. Prefer ScanResourceFiles where an unreadable folder and an empty one
// must not be treated alike; this stays for callers that genuinely do not care
// and for consumers already written against it.
exports("ListResourceFiles", (resourceName: unknown, subdir: unknown): string => {
  const result = scanResource(resourceName, subdir, "file");
  return JSON.stringify(result.ok ? result.entries : []);
});

// The honest counterparts:
//
//   local scan = json.decode(exports.tLib:ScanResourceFiles('tAFK', 'audio') or '{}')
//   if scan and scan.ok then ... end
//
// `{ ok = true, entries = { ... } }` or `{ ok = false, reason = '<code>' }`.
exports("ScanResourceFiles", (resourceName: unknown, subdir: unknown): string =>
  JSON.stringify(scanResource(resourceName, subdir, "file"))
);

exports("ScanResourceDirs", (resourceName: unknown, subdir: unknown): string =>
  JSON.stringify(scanResource(resourceName, subdir, "dir"))
);

// ─── The write counterpart of the scans above ────────────────────────────────
//
// tLib registers its own `WriteResourceFile` export for its OWN files, from the
// implementation every consumer now shares (shared/ts/fs/server.ts).
//
// It is NOT the bridge other resources call any more, and cannot be: FiveM's
// Node runtime sandboxes each resource to its own directory, so a write tLib
// issued into tDetector's folder was refused before it reached the disk, with a
// message pointing at `--allow-fs-write` — a server startup argument no shipped
// product may require of a customer. tDetector and tRadar each register the same
// export from their own `server/main.ts`, and
// `shared/imports/fs/server.lua` calls the LOCAL resource's export. The one
// implementation is still shared; only the registration moved.
//
// This registration stays because tLib legitimately writes its own files, and
// because `tlib.fs.writeResourceFile` running inside tLib's VM resolves to
// exactly this export — dropping it would make tLib the one resource that
// cannot use its own module.
registerWriteResourceFile();

// The directory counterpart. Every consumer that ships "packs" — HUD layouts,
// skins, sound sets — needs the folder names, and there is no way to get them
// from inside Lua: io.popen is nil in the server sandbox and io.readdir returns
// an empty list for every path, including the resource's own root. Measured on
// a Windows FiveM server, so a scan built on either one silently finds nothing
// and the consumer falls back to a hardcoded list.
//
//   local dirs = json.decode(exports.tLib:ListResourceDirs('tELS', 'layouts') or '[]')
//
// Same contract as ListResourceFiles, including the flattened failure; see
// ScanResourceDirs for the form that distinguishes empty from unreadable.
exports("ListResourceDirs", (resourceName: unknown, subdir: unknown): string => {
  const result = scanResource(resourceName, subdir, "dir");
  return JSON.stringify(result.ok ? result.entries : []);
});

exports(
  "AppendToManifest",
  (resourceName: string, metadataKey: string, filePath: string): boolean => {
    try {
      const resPath = GetResourcePath(resourceName);
      if (!resPath) return false;

      let manifestPath = path.join(resPath, "fxmanifest.lua");
      if (!fs.existsSync(manifestPath)) {
        manifestPath = path.join(resPath, "__resource.lua");
        if (!fs.existsSync(manifestPath)) return false;
      }

      const line = `${metadataKey} '${filePath}'`;
      let content = fs.readFileSync(manifestPath, "utf8");

      if (content.includes(line)) return true;

      // Key exists but points elsewhere: rewrite it in place.
      const keyPattern = new RegExp(`^${escapeRegExp(metadataKey)}\\s+['"].+['"]`, "m");
      if (keyPattern.test(content)) {
        content = content.replace(keyPattern, line);
        fs.writeFileSync(manifestPath, content, "utf8");
        return true;
      }

      // Append after a sibling key so related lines stay grouped.
      for (const sibling of siblings) {
        if (sibling === metadataKey) continue;
        const sibPattern = new RegExp(`^(${escapeRegExp(sibling)}\\s+['"].+['"].*)$`, "m");
        const match = content.match(sibPattern);
        if (match) {
          content = content.replace(sibPattern, `$1\n${line}`);
          fs.writeFileSync(manifestPath, content, "utf8");
          return true;
        }
      }

      fs.appendFileSync(manifestPath, `\n\n${line}\n`, "utf8");
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[tLib] AppendToManifest error for '${resourceName}': ${msg}`);
      return false;
    }
  }
);
