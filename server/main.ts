/**
 * tLib — server-side Node.js bundle
 * Exports that require Node.js filesystem access (unavailable in Lua).
 */

import * as fs from "node:fs";
import * as path from "node:path";

// FiveM server-side globals (Node.js runtime)
declare function GetResourcePath(resourceName: string): string | null;
declare function exports(name: string, fn: (...args: unknown[]) => unknown): void;

// ══════════════════════════════════════════════════════════════════
//  MANIFEST WRITER
// ══════════════════════════════════════════════════════════════════

// sibling keys so new manifest lines get grouped near related ones
const siblings: string[] = [];

exports("RegisterManifestSibling", (key: string) => {
	if (!siblings.includes(key)) siblings.push(key);
});

// adds a metadata line to fxmanifest if it's not already there
exports("AppendToManifest", (resourceName: string, metadataKey: string, filePath: string): boolean => {
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
		const keyPattern = new RegExp(`^${metadataKey}\\s+['"].+['"]`, "m");
		if (keyPattern.test(content)) {
			content = content.replace(keyPattern, line);
			fs.writeFileSync(manifestPath, content, "utf8");
			return true;
		}

		// Look for a sibling key to append after, so related keys stay grouped
		for (const sibling of siblings) {
			if (sibling === metadataKey) continue;
			const sibPattern = new RegExp(`^(${sibling}\\s+['"].+['"].*)$`, "m");
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
});
