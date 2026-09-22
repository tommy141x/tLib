import * as http from "node:http";
import * as https from "node:https";

export interface DownloadResult {
  buf: Buffer;
  hash: string;
  size: number;
}

/** v1 provides a hash, but size headers are optional on streamed responses. */
export function downloadBundle(
  url: string,
  maxBytes: number,
  timeoutMs = 60_000
): Promise<DownloadResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("unsupported marketplace download URL");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error("invalid download byte limit");
    let settled = false;
    let response: http.IncomingMessage | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response?.destroy();
      req.destroy();
      reject(error);
    };
    const req = (parsed.protocol === "https:" ? https : http).get(
      parsed,
      {
        headers: { Accept: "application/octet-stream,application/zip" },
      },
      (res) => {
        response = res;
        if (settled) {
          res.destroy();
          return;
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          fail(new Error(`download failed: HTTP ${res.statusCode}`));
          return;
        }
        const hashHeader = res.headers["x-marketplace-file-hash"];
        const hash =
          typeof hashHeader === "string" ? hashHeader.toLowerCase().replace(/^sha256:/, "") : "";
        if (!/^[0-9a-f]{64}$/.test(hash)) {
          fail(new Error("missing or invalid marketplace hash"));
          return;
        }
        const sizeHeader = res.headers["x-marketplace-size-bytes"] ?? res.headers["content-length"];
        const size = sizeHeader === undefined ? 0 : Number(sizeHeader);
        if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
          fail(new Error("invalid or oversized marketplace size"));
          return;
        }
        let received = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          received += chunk.byteLength;
          if (received > maxBytes) {
            fail(new Error("download exceeds maximum bundle size"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", fail);
        res.on("aborted", () => fail(new Error("marketplace download aborted")));
        res.on("end", () => {
          if (settled) return;
          if (sizeHeader !== undefined && received !== size) {
            fail(new Error("marketplace size mismatch"));
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve({ buf: Buffer.concat(chunks, received), hash, size });
        });
      }
    );
    req.on("error", fail);
    // Absolute deadline, not an idle timeout that a slow stream can extend forever.
    timer = setTimeout(() => fail(new Error("marketplace download timed out")), timeoutMs);
  });
}
