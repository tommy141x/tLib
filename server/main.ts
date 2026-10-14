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
// FIRST, and before any module that can build a request: the per-install id
// rides every tWeb-bound call, and the header builders ask through this seam
// rather than importing the reader -- a static import would have each consumer
// resolve a DIFFERENT id from its own directory. Nothing is read or written here;
// `installId` resolves lazily, so an install that never talks to tWeb mints none.
setInstallIdResolver(installId);

// tLib's one external port; every web surface any resource exposes is a mount on
// it. Eager, because a consumer's Lua can call RegisterWebApp before tLib's own
// onResourceStart runs -- which is also why everything below is eager.
installHttp();

// Realtime is a mount on that router at /rt rather than its own socket.
installRealtime();

// Opt-in: only a resource declaring `tlib_module { 'marketplace' }` wakes it.
installMarketplace();

// The `cc*` exports behind sv_community_configs.lua. Registered separately from
// the marketplace because only the PUBLISH path shares its credential -- the
// reads are open, and one module that is half authenticated is a module whose
// reader assumes the wrong half.
installCommunityConfigs();

// A table of which resource is already serving which model, so two resources that
// each ship local inference load one copy between them.
installInference();

// The gated child-process broker, so `add_unsafe_child_process_permission tLib`
// is the only line an operator writes -- and what sits behind it is narrower than
// the four unrestricted grants it replaced. See server/lib/spawn/catalog.ts.
installSpawn();

// Opt-in diagnostics. Nothing is collected or sent while opted out and consent
// defaults to OFF, but the install id is NOT part of that promise: it belongs to
// every tWeb-bound request. server/lib/telemetry/consent.ts decides consent.
installTelemetry();

// The "Send feedback" dialog in every t* menu. Deliberately NOT gated on
// telemetry consent -- the reasoning is at the top of server/lib/feedback/index.ts.
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
// not contain `..`. It REPORTS failure rather than flattening it, because the
// difference matters to a caller reconciling a stored registry against disk:
// "the folder is empty" means prune everything, "could not be read" means keep
// what you have. Collapsing the two is what let a scan failure look like a
// deliberate deletion.
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
// Returns JSON-encoded filenames, or '[]' on any error, so callers never branch.
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

// The read counterpart of the scans above, and the other half of what makes a
// drop-in install work: LoadResourceFile answers from the index FiveM builds at
// resource start, so a folder copied in afterwards is on disk but not in it.
//
//   local raw = exports.tLib:ReadResourceFile('tRadio', 'layouts/QRX-720/module.json')
//
// Returns the file as a UTF-8 string, or '' on any failure, so callers never
// branch. Bounded, and refuses anything that is not a regular file -- a manifest
// read must not become a way to stream an arbitrary asset through a Lua string.
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

// The write counterpart. tLib registers this for its OWN files; it is NOT the
// bridge other resources call, and cannot be -- FiveM's Node runtime sandboxes
// each resource to its own directory, so a write tLib issued into another
// resource's folder was refused before reaching the disk. Each consumer registers
// the same shared implementation from its own `server/main.ts`. This registration
// stays because tLib legitimately writes its own files.
registerWriteResourceFile();

// The directory counterpart. Every consumer that ships "packs" needs the folder
// names, and Lua cannot get them: io.popen is nil in the server sandbox and
// io.readdir returns an empty list for every path, including the resource's own
// root. Same flattened-failure contract as ListResourceFiles.
//
//   local dirs = json.decode(exports.tLib:ListResourceDirs('tELS', 'layouts') or '[]')
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
