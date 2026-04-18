import * as fs from "node:fs";
import * as path from "node:path";
import { installRealtime } from "./realtime/index";

declare function GetResourcePath(resourceName: string): string | null;
declare function exports(name: string, fn: (...args: unknown[]) => unknown): void;

// Register realtime exports. The WS server only opens a port once a consumer
// resource actually uses one of the rt* APIs — tLib stays a pure library
// until someone needs the transport.
installRealtime();

// sibling keys so new manifest lines get grouped near related ones
const siblings: string[] = [];

exports("RegisterManifestSibling", (key: string) => {
  if (!siblings.includes(key)) siblings.push(key);
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// List files in a resource subdirectory — FiveM's Lua runtime has no
// directory enumeration API, so consumers that need to discover files by
// pattern (e.g. auto-detected audio tracks) can only probe known names
// without this. Returns a JSON-encoded string[] of filenames (not full
// paths); consumers filter by extension themselves.
//
// Usage from Lua:
//   local names = json.decode(exports.tLib:ListResourceFiles('tAFK', 'audio') or '[]')
//
// `subdir` is relative to the resource root and must not contain `..`;
// returns '[]' on any error (missing dir, traversal attempt, etc.) so callers
// don't have to branch on success.
exports("ListResourceFiles", (resourceName: unknown, subdir: unknown): string => {
  try {
    if (typeof resourceName !== "string" || resourceName.length === 0) return "[]";
    const sub = typeof subdir === "string" ? subdir : "";
    if (sub.includes("..")) return "[]";

    const resPath = GetResourcePath(resourceName);
    if (!resPath) return "[]";

    const target = sub ? path.join(resPath, sub) : resPath;
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return "[]";

    const entries = fs
      .readdirSync(target, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
    return JSON.stringify(entries);
  } catch {
    return "[]";
  }
});

// adds a metadata line to fxmanifest if it's not already there
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

      // Already present — nothing to do
      if (content.includes(line)) return true;

      // Key exists but points to a different file — update in place
      const keyPattern = new RegExp(`^${escapeRegExp(metadataKey)}\\s+['"].+['"]`, "m");
      if (keyPattern.test(content)) {
        content = content.replace(keyPattern, line);
        fs.writeFileSync(manifestPath, content, "utf8");
        return true;
      }

      // Look for a sibling key to append after, so related keys stay grouped
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

      // No sibling found — append at end of file
      fs.appendFileSync(manifestPath, `\n\n${line}\n`, "utf8");
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[tLib] AppendToManifest error for '${resourceName}': ${msg}`);
      return false;
    }
  }
);
