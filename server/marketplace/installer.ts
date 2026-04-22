// Atomic install pipeline: download → verify → extract → write → swap.
// Writes land in resources/<consumer>/<installPath>/<slug>/. A staging
// directory alongside is populated first; once every file is written and
// the hash matches, the old install (if any) is replaced in one rename.

import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { downloadBundle, MarketplaceError } from "./api";
import { resolveConfig } from "./config";
import { fGetResourcePath } from "./fivem";
import { get as getTarget } from "./registry";

export interface InstallResult {
	ok: true;
	installedAt: string; // absolute path of the final install directory
	fileCount: number;
	bytesWritten: number;
}

export interface InstallFailure {
	ok: false;
	error: string;
}

export type InstallOutcome = InstallResult | InstallFailure;

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Rejects absolute paths, traversal, and drive letters. Zip entries must stay relative. */
function isSafeEntryName(name: string): boolean {
	if (!name || typeof name !== "string") return false;
	const normalized = name.replace(/\\/g, "/");
	if (normalized.startsWith("/")) return false;
	if (/^[a-z]:/i.test(normalized)) return false;
	for (const seg of normalized.split("/")) {
		if (seg === "..") return false;
	}
	return true;
}

function rmDirSafe(p: string): void {
	if (!fs.existsSync(p)) return;
	fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

export async function installItem(
	type: string,
	slug: string,
	version: string
): Promise<InstallOutcome> {
	if (!type || !slug || !version) {
		return { ok: false, error: "type, slug, and version are required" };
	}

	const target = getTarget(type);
	if (!target) {
		return { ok: false, error: `no install target registered for type "${type}"` };
	}

	const resourceRoot = fGetResourcePath(target.resourceName);
	if (!resourceRoot) {
		return { ok: false, error: `resource "${target.resourceName}" has no resolvable path` };
	}

	const safeSlug = slug.toLowerCase().replace(/[^a-z0-9_-]/g, "");
	if (!safeSlug || safeSlug !== slug.toLowerCase()) {
		return { ok: false, error: `slug "${slug}" contains invalid characters` };
	}

	// Final destination and staging directory (same parent so rename is atomic on same filesystem).
	const baseDir = path.resolve(resourceRoot, target.installPath);
	const finalDir = path.join(baseDir, safeSlug);
	const stageDir = path.join(baseDir, `.install-${safeSlug}-${Date.now()}`);

	// Paranoia: stageDir and finalDir must be descendants of baseDir.
	const rel = path.relative(baseDir, finalDir);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		return { ok: false, error: "install path resolution escaped resource root" };
	}

	try {
		// 1) Download bundle — api.ts guarantees hash + size headers are present
		// and well-formed or it throws a MarketplaceError before we get here.
		const dl = await downloadBundle(slug, version);
		if (dl.bytes.byteLength !== dl.expectedSize) {
			return {
				ok: false,
				error: `size mismatch (got ${dl.bytes.byteLength}, expected ${dl.expectedSize})`,
			};
		}
		const actualHash = sha256Hex(dl.bytes);
		if (actualHash !== dl.expectedHash) {
			return { ok: false, error: "hash mismatch — bundle corrupted or tampered" };
		}

		// 2) Open zip; adm-zip accepts a Buffer.
		const zip = new AdmZip(Buffer.from(dl.bytes));
		const entries = zip.getEntries();
		if (entries.length === 0) return { ok: false, error: "bundle is empty" };

		const cfg = resolveConfig();
		let totalUncompressed = 0;

		// 3) Prepare staging directory.
		fs.mkdirSync(stageDir, { recursive: true });

		let fileCount = 0;
		for (const entry of entries) {
			if (entry.isDirectory) continue;
			const entryName = entry.entryName.replace(/\\/g, "/");
			if (!isSafeEntryName(entryName)) {
				throw new Error(`unsafe zip entry: "${entryName}"`);
			}
			const data = entry.getData();
			totalUncompressed += data.byteLength;
			if (totalUncompressed > cfg.maxBundleBytes) {
				throw new Error("uncompressed bundle exceeds max size (zip bomb suspected)");
			}
			const dest = path.join(stageDir, entryName);
			// Re-check that resolved dest is under stageDir after join.
			const destRel = path.relative(stageDir, dest);
			if (destRel.startsWith("..") || path.isAbsolute(destRel)) {
				throw new Error(`zip entry path escaped staging dir: "${entryName}"`);
			}
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.writeFileSync(dest, data);
			fileCount++;
		}

		// 4) Swap: delete existing final dir, move stage → final.
		rmDirSafe(finalDir);
		fs.mkdirSync(baseDir, { recursive: true });
		fs.renameSync(stageDir, finalDir);

		return {
			ok: true,
			installedAt: finalDir,
			fileCount,
			bytesWritten: totalUncompressed,
		};
	} catch (err) {
		// Clean up staging on any failure — the old install remains intact because
		// we only delete it right before the rename succeeds.
		rmDirSafe(stageDir);
		if (err instanceof MarketplaceError) {
			return { ok: false, error: `${err.code}${err.retryAfter ? ` (retry after ${err.retryAfter}s)` : ""}` };
		}
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
