import * as fs from "node:fs";
import * as path from "node:path";
import { registerWriteResourceFile } from "../shared/ts/fs/server";
import { setInstallIdResolver } from "../shared/ts/install-id";
import { installCommunityConfigs } from "./lib/community-configs/index";
import { installFeedback } from "./lib/feedback/index";
import { installHttp } from "./lib/http/index";
import { installInference } from "./lib/inference/index";
import { installId } from "./lib/install-id";
import { installMarketplace } from "./lib/marketplace/index";
import { installRealtime } from "./lib/realtime/index";
import { installSpawn } from "./lib/spawn/index";
import { installTelemetry } from "./lib/telemetry/index";

declare function GetResourcePath(resourceName: string): string | null;
declare function exports(name: string, fn: (...args: never[]) => unknown): void;
// Must run before any module that can build a request: the per-install id rides
// every tWeb-bound call, resolved lazily so an install that never talks to tWeb
// mints none. Header builders ask through this seam rather than importing the
// reader, since a static import would have each consumer resolve a different id.
setInstallIdResolver(installId);

// tLib's one external port; every web surface any resource exposes mounts on it.
// Eager, since a consumer's Lua can call RegisterWebApp before tLib's own
// onResourceStart runs — which is also why everything below is eager.
installHttp();

// Mounted on that router at /rt rather than its own socket.
installRealtime();

// Opt-in: only a resource declaring `tlib_module { 'marketplace' }` wakes it.
installMarketplace();

// The `cc*` exports behind sv_community_configs.lua, registered separately from
// the marketplace because only the publish path shares its credential — reads
// stay open.
installCommunityConfigs();

// Tracks which resource already serves which model, so two resources shipping
// local inference load one copy between them.
installInference();

// Gated child-process broker: `add_unsafe_child_process_permission tLib` is the
// only line an operator writes, narrower than the four unrestricted grants it replaced.
installSpawn();

// Opt-in diagnostics, off by default; nothing collected or sent while opted out.
// The install id is not part of that promise — it rides every tWeb-bound request.
installTelemetry();

// The "Send feedback" dialog in every t* menu, deliberately not gated on telemetry consent.
installFeedback();

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
// not contain `..`. Reports failure rather than flattening it: a caller
// reconciling a stored registry against disk needs "empty" (prune everything)
// distinct from "could not be read" (keep what you have), or a scan failure
// reads as a deliberate deletion.
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

// List a resource's files, from Lua:
//
//   local names = json.decode(exports.tLib:ListResourceFiles('tAFK', 'audio') or '[]')
//
// Returns JSON-encoded filenames, or '[]' on any error — callers never branch.
// Prefer ScanResourceFiles where unreadable and empty must not be alike.
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

/** Hard ceiling on a bridged read. A `module.json` is ~1 KB; 256 KB is slack, not a budget. */
const MAX_READ_BYTES = 256 * 1024;

// The read counterpart of the scans above. FiveM's own LoadResourceFile answers
// from the index built at resource start, so a folder copied in afterwards is on
// disk but not in it — this reads straight from disk instead.
//
//   local raw = exports.tLib:ReadResourceFile('tRadio', 'layouts/QRX-720/module.json')
//
// Returns the file as UTF-8, or '' on any failure. Bounded at MAX_READ_BYTES and
// refuses anything that is not a regular file, so a manifest read can't stream an
// arbitrary asset through a Lua string.
exports("ReadResourceFile", (resourceName: unknown, relPath: unknown): string => {
  if (typeof resourceName !== "string" || !resourceName) return "";
  if (typeof relPath !== "string" || !relPath || relPath.includes("..")) return "";
  const resPath = GetResourcePath(resourceName);
  if (!resPath) return "";
  const target = path.resolve(resPath, relPath);
  const root = path.resolve(resPath);
  if (target !== root && !target.startsWith(root + path.sep)) return "";
  try {
    const s = fs.lstatSync(target);
    if (!s.isFile() || s.size > MAX_READ_BYTES) return "";
    return fs.readFileSync(target, "utf8");
  } catch {
    return "";
  }
});

// The write counterpart, registered here for tLib's OWN files only. FiveM's Node
// runtime sandboxes each resource to its own directory, so a write into another
// resource's folder is refused before reaching disk — cross-resource writes work
// only by calling the TARGET resource's own registered copy of this function.
registerWriteResourceFile();

// The directory counterpart. Lua cannot list folders server-side: io.popen is nil
// in the sandbox and io.readdir returns empty for every path, including the
// resource's own root. Same flattened-failure contract as ListResourceFiles.
//
//   local dirs = json.decode(exports.tLib:ListResourceDirs('tLS', 'layouts') or '[]')
//
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
