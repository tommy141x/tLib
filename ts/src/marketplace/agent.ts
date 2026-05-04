// Marketplace agent — import this in each consumer resource's server bundle.
// Because it runs inside the consumer's own Node.js VM, all fs operations
// target that resource's own path and are never subject to the cross-resource
// sandbox write restriction.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import AdmZip from "adm-zip";

const g = globalThis as unknown as {
  GetCurrentResourceName: () => string;
  GetResourcePath: (name: string) => string;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
};

export interface AgentConfig {
  /** type → install path relative to this resource's root (e.g. { ui: 'layouts', sound: 'layouts/sounds' }) */
  installTypes: Record<string, string>;
  /** Max uncompressed ZIP bytes before zip-bomb abort. Default 100 MB. */
  maxBundleBytes?: number;
}

interface DoInstallPayload {
  url: string;
  slug: string;
  type: string;
  token: string;
}

interface DoUninstallPayload {
  slug: string;
  type: string;
  token: string;
}

interface AgentResult {
  token: string;
  ok: boolean;
  slug: string;
  error?: string;
  fileCount?: number;
  bytesWritten?: number;
  installedAt?: string;
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function isZipBuffer(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

function guessExt(buf: Buffer): string {
  if (buf.length >= 4 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return ".wav";
  if (buf.length >= 4 && buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return ".ogg";
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return ".mp3";
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return ".mp3";
  return ".wav";
}

function isSafeEntry(name: string): boolean {
  const n = name.replace(/\\/g, "/");
  if (n.startsWith("/") || /^[a-z]:/i.test(n)) return false;
  return !n.split("/").includes("..");
}

function rmSafe(p: string): void {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

interface DownloadResult {
  buf: Buffer;
  hash: string;
  size: number;
}

function download(url: string): Promise<DownloadResult> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https://") ? https : http;
    const req = lib.get(url, { headers: { Accept: "application/octet-stream,application/zip" } }, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        reject(new Error(`download failed: HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const hash = (res.headers["x-marketplace-file-hash"] as string | undefined) ?? "";
        const size =
          parseInt(
            ((res.headers["x-marketplace-size-bytes"] ?? res.headers["content-length"] ?? "0") as string),
            10
          ) || 0;
        resolve({ buf, hash, size });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

function installFromBuffer(
  resourceRoot: string,
  installPath: string,
  slug: string,
  buf: Buffer,
  hash: string,
  size: number,
  maxBundleBytes: number
): Omit<AgentResult, "token" | "slug"> {
  if (size > 0 && buf.byteLength !== size) {
    return { ok: false, error: `size mismatch (got ${buf.byteLength}, expected ${size})` };
  }

  if (hash) {
    const clean = hash.toLowerCase().replace(/^sha256:/, "");
    if (/^[0-9a-f]{64}$/.test(clean) && sha256Hex(buf) !== clean) {
      return { ok: false, error: "hash mismatch — bundle corrupted or tampered" };
    }
  }

  const baseDir = path.resolve(resourceRoot, installPath);
  const finalDir = path.join(baseDir, slug);

  if (path.relative(baseDir, finalDir).startsWith("..") || path.isAbsolute(path.relative(baseDir, finalDir))) {
    return { ok: false, error: "install path escaped resource root" };
  }

  // Raw audio file (not a ZIP)
  if (!isZipBuffer(buf)) {
    const ext = guessExt(buf);
    const dest = path.join(baseDir, slug + ext);
    if (path.relative(baseDir, dest).startsWith("..")) {
      return { ok: false, error: "raw file path escaped install dir" };
    }
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(dest, buf);
    return { ok: true, fileCount: 1, bytesWritten: buf.byteLength, installedAt: dest };
  }

  // ZIP bundle (UI layout or multi-file pack)
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  if (entries.length === 0) return { ok: false, error: "bundle is empty" };

  const stageDir = path.join(baseDir, `.install-${slug}-${Date.now()}`);
  try {
    let totalBytes = 0;
    let fileCount = 0;
    fs.mkdirSync(stageDir, { recursive: true });

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const entryName = entry.entryName.replace(/\\/g, "/");
      if (!isSafeEntry(entryName)) throw new Error(`unsafe zip entry: "${entryName}"`);
      let data = entry.getData();
      totalBytes += data.byteLength;
      if (totalBytes > maxBundleBytes) throw new Error("bundle exceeds max size (zip bomb suspected)");
      const dest = path.join(stageDir, entryName);
      if (path.relative(stageDir, dest).startsWith("..")) throw new Error(`zip entry escaped staging: "${entryName}"`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (entryName === "ui.html") {
        let html = data.toString("utf8");
        html = html.replace(/\n?<!-- studio-design:[A-Za-z0-9+/=\s]*-->/g, "");
        data = Buffer.from(html, "utf8");
      }
      fs.writeFileSync(dest, data);
      fileCount++;
    }

    rmSafe(finalDir);
    fs.mkdirSync(baseDir, { recursive: true });
    fs.renameSync(stageDir, finalDir);
    return { ok: true, fileCount, bytesWritten: totalBytes, installedAt: finalDir };
  } catch (err) {
    rmSafe(stageDir);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function uninstallBySlug(
  resourceRoot: string,
  installPath: string,
  slug: string
): Omit<AgentResult, "token" | "slug"> {
  const baseDir = path.resolve(resourceRoot, installPath);
  const finalDir = path.join(baseDir, slug);

  if (path.relative(baseDir, finalDir).startsWith("..") || path.isAbsolute(path.relative(baseDir, finalDir))) {
    return { ok: false, error: "uninstall path escaped resource root" };
  }

  if (fs.existsSync(finalDir) && fs.statSync(finalDir).isDirectory()) {
    try {
      rmSafe(finalDir);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  for (const ext of [".wav", ".ogg", ".mp3"]) {
    const p = finalDir + ext;
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  return { ok: false, error: `"${slug}" is not installed` };
}

export function createMarketplaceAgent(config: AgentConfig): void {
  const resourceName = g.GetCurrentResourceName();
  const resourceRoot = g.GetResourcePath(resourceName);
  const maxBundleBytes = config.maxBundleBytes ?? 100 * 1024 * 1024;

  const installEvent = `tlib:marketplace:doInstall:${resourceName}`;
  const uninstallEvent = `tlib:marketplace:doUninstall:${resourceName}`;

  g.on(installEvent, (raw: unknown) => {
    const p = raw as DoInstallPayload;
    if (!p?.token || !p?.slug || !p?.type) return;

    const installPath = config.installTypes[p.type];
    if (!installPath) {
      g.emit("tlib:marketplace:agentResult", {
        token: p.token, ok: false, slug: p.slug,
        error: `unknown type "${p.type}"`,
      } satisfies AgentResult);
      return;
    }

    const safeSlug = p.slug.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!safeSlug || safeSlug !== p.slug.toLowerCase()) {
      g.emit("tlib:marketplace:agentResult", {
        token: p.token, ok: false, slug: p.slug,
        error: `invalid slug "${p.slug}"`,
      } satisfies AgentResult);
      return;
    }

    download(p.url)
      .then(({ buf, hash, size }) => {
        const result = installFromBuffer(resourceRoot, installPath, safeSlug, buf, hash, size, maxBundleBytes);
        g.emit("tlib:marketplace:agentResult", { token: p.token, slug: p.slug, ...result } satisfies AgentResult);
      })
      .catch((err: unknown) => {
        g.emit("tlib:marketplace:agentResult", {
          token: p.token, ok: false, slug: p.slug,
          error: err instanceof Error ? err.message : String(err),
        } satisfies AgentResult);
      });
  });

  g.on(uninstallEvent, (raw: unknown) => {
    const p = raw as DoUninstallPayload;
    if (!p?.token || !p?.slug || !p?.type) return;

    const installPath = config.installTypes[p.type];
    if (!installPath) {
      g.emit("tlib:marketplace:agentResult", {
        token: p.token, ok: false, slug: p.slug,
        error: `unknown type "${p.type}"`,
      } satisfies AgentResult);
      return;
    }

    const safeSlug = p.slug.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!safeSlug || safeSlug !== p.slug.toLowerCase()) {
      g.emit("tlib:marketplace:agentResult", {
        token: p.token, ok: false, slug: p.slug,
        error: `invalid slug "${p.slug}"`,
      } satisfies AgentResult);
      return;
    }

    const result = uninstallBySlug(resourceRoot, installPath, safeSlug);
    g.emit("tlib:marketplace:agentResult", { token: p.token, slug: p.slug, ...result } satisfies AgentResult);
  });
}
