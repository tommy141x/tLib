import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAssets } from "../../shared/ts/assets";
import { AssetFetchError, fetchAsset } from "../../shared/ts/assets/fetch";
import type { PinnedAsset } from "../../shared/ts/assets/pinned";

const BODY = Buffer.from("x".repeat(4096));
const DIGEST = createHash("sha256").update(BODY).digest("hex");

let server: Server;
let base: string;
let root: string;
/** Ranges the server was asked for, so resume can be asserted rather than assumed. */
let rangeLog: (string | undefined)[] = [];
let hits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    rangeLog.push(req.headers.range);
    const url = req.url ?? "";

    if (url.startsWith("/redirect/")) {
      // Mirrors HuggingFace: /resolve/main/... answers 302 to a different host.
      const hops = Number(url.slice("/redirect/".length)) || 1;
      res.writeHead(302, { Location: hops > 1 ? `/redirect/${hops - 1}` : "/ok" });
      res.end();
      return;
    }
    if (url === "/loop") {
      res.writeHead(302, { Location: "/loop" });
      res.end();
      return;
    }
    if (url === "/404") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (url === "/corrupt") {
      res.writeHead(200, { "Content-Length": String(BODY.length) });
      res.end(Buffer.alloc(BODY.length, 0x79));
      return;
    }
    if (url === "/oversized") {
      res.writeHead(200);
      res.end(Buffer.alloc(BODY.length * 4, 0x78));
      return;
    }
    if (url === "/truncated") {
      // A genuinely dropped connection: promise the full length, deliver half,
      // then kill the socket. Calling res.end() short instead leaves the server
      // waiting on an unfulfilled Content-Length and the client hanging.
      res.writeHead(200, { "Content-Length": String(BODY.length) });
      res.write(BODY.subarray(0, BODY.length / 2), () => res.socket?.destroy());
      return;
    }
    if (url === "/ignores-range") {
      // Answers 200 with the whole body even when Range was sent.
      res.writeHead(200);
      res.end(BODY);
      return;
    }

    const range = req.headers.range;
    if (range) {
      const from = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
      const slice = BODY.subarray(from);
      res.writeHead(206, {
        "Content-Range": `bytes ${from}-${BODY.length - 1}/${BODY.length}`,
        "Content-Length": String(slice.length),
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, { "Content-Length": String(BODY.length) });
    res.end(BODY);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tlib-assets-"));
  rangeLog = [];
  hits = 0;
});

const pin = (over: Partial<PinnedAsset> = {}): PinnedAsset => ({
  id: "weights",
  dest: "server/models/m.bin",
  url: `${base}/ok`,
  sha256: DIGEST,
  bytes: BODY.length,
  ...over,
});

/** The loopback test server is not github.com; every test must allow its origin. */
const allow = () => [new URL(base).origin];

describe("origin allowlist", () => {
  test("refuses a url whose starting origin is not allowed", async () => {
    await expect(
      fetchAsset(pin({ url: "https://example.invalid/m.bin" }), join(root, "m.bin"))
    ).rejects.toThrow("origin is not allowed");
  });

  test("refuses a url carrying credentials", async () => {
    await expect(
      fetchAsset(pin({ url: "https://u:p@huggingface.co/m.bin" }), join(root, "m.bin"))
    ).rejects.toThrow("credentials");
  });

  test("the default allowlist is the two origins the lockfiles actually use", async () => {
    const { DEFAULT_ORIGINS } = await import("../../shared/ts/assets/fetch");
    expect(DEFAULT_ORIGINS).toEqual(["https://github.com", "https://huggingface.co"]);
  });
});

describe("redirects", () => {
  test("follows a redirect chain to a different path", async () => {
    // Every pinned weight is a huggingface.co/.../resolve/main/ URL, which 302s
    // to a CDN. A fetcher that treated 3xx as failure would fetch nothing at all.
    const dest = join(root, "m.bin");
    await fetchAsset(pin({ url: `${base}/redirect/3` }), dest, { allowOrigins: allow() });
    expect(readFileSync(dest)).toEqual(BODY);
  });

  test("a redirect loop terminates instead of hanging", async () => {
    await expect(
      fetchAsset(pin({ url: `${base}/loop` }), join(root, "m.bin"), { allowOrigins: allow() })
    ).rejects.toThrow("too many redirects");
  });

  test("the redirect target is NOT re-checked against the allowlist", async () => {
    // Deliberate, and the reason it is asserted: HuggingFace redirects to
    // cdn-lfs.hf.co, so re-checking each hop would reject every real download.
    // The sha256 pin is the integrity guarantee, not the origin list.
    const dest = join(root, "m.bin");
    await fetchAsset(pin({ url: `${base}/redirect/1` }), dest, {
      allowOrigins: [new URL(base).origin],
    });
    expect(existsSync(dest)).toBe(true);
  });
});

describe("verification", () => {
  test("a body that does not match the pin is rejected and discarded", async () => {
    const dest = join(root, "m.bin");
    await expect(
      fetchAsset(pin({ url: `${base}/corrupt` }), dest, { allowOrigins: allow() })
    ).rejects.toThrow("sha256 mismatch");
    expect(existsSync(dest)).toBe(false);
    // The .part is deleted too: those bytes are wrong, not merely incomplete,
    // and resuming from them would fail forever.
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  test("a body larger than the pin is cut off mid-stream", async () => {
    await expect(
      fetchAsset(pin({ url: `${base}/oversized` }), join(root, "m.bin"), { allowOrigins: allow() })
    ).rejects.toThrow("exceeds pinned size");
  });

  test("an HTTP error names the asset", async () => {
    const error = await fetchAsset(pin({ url: `${base}/404` }), join(root, "m.bin"), {
      allowOrigins: allow(),
    }).catch((e) => e);
    expect(error).toBeInstanceOf(AssetFetchError);
    expect(error.assetId).toBe("weights");
    expect(error.message).toContain("HTTP 404");
  });

  test("the destination appears only once it is verified", async () => {
    // Nothing may observe a truncated file where a complete one is expected --
    // that failure surfaces later as an unreadable model with no trail back here.
    const dest = join(root, "m.bin");
    await expect(
      fetchAsset(pin({ url: `${base}/truncated` }), dest, { allowOrigins: allow() })
    ).rejects.toThrow(/aborted|incomplete/);
    expect(existsSync(dest)).toBe(false);
  });
});

describe("resume", () => {
  test("a surviving partial file is resumed, not re-downloaded", async () => {
    const dest = join(root, "m.bin");
    // A dropped connection leaves a valid prefix behind.
    await expect(
      fetchAsset(pin({ url: `${base}/truncated` }), dest, { allowOrigins: allow() })
    ).rejects.toThrow(/aborted|incomplete/);
    expect(existsSync(`${dest}.part`)).toBe(true);

    rangeLog = [];
    await fetchAsset(pin(), dest, { allowOrigins: allow() });

    expect(rangeLog).toEqual([`bytes=${BODY.length / 2}-`]);
    expect(readFileSync(dest)).toEqual(BODY);
  });

  test("a truncated attempt keeps its .part so the next run can continue", async () => {
    // Deleting it here is what turns a flaky connection into a download that
    // can never complete.
    const dest = join(root, "m.bin");
    await fetchAsset(pin({ url: `${base}/truncated` }), dest, { allowOrigins: allow() }).catch(
      () => {}
    );
    expect(readFileSync(`${dest}.part`).length).toBe(BODY.length / 2);
  });

  test("a server that ignores Range restarts cleanly instead of appending", async () => {
    // Appending a full body onto a partial one yields a file of plausible size
    // and wrong contents -- which the hash would catch, but only after the
    // whole transfer. Restarting is both correct and cheaper.
    const dest = join(root, "m.bin");
    writeFileSync(`${dest}.part`, BODY.subarray(0, 1000));
    await fetchAsset(pin({ url: `${base}/ignores-range` }), dest, { allowOrigins: allow() });
    expect(readFileSync(dest)).toEqual(BODY);
  });

  test("a .part longer than the pin is discarded rather than reconciled", async () => {
    const dest = join(root, "m.bin");
    writeFileSync(`${dest}.part`, Buffer.alloc(BODY.length * 2, 0x7a));
    await fetchAsset(pin(), dest, { allowOrigins: allow() });
    expect(readFileSync(dest)).toEqual(BODY);
    expect(rangeLog).toEqual([undefined]);
  });
});

describe("ensureAssets", () => {
  test("fetches what is missing and reports it", async () => {
    const report = await ensureAssets(root, [pin()], { allowOrigins: allow() });
    expect(report.ok).toBe(true);
    expect(report.outcomes[0].status).toBe("fetched");
    expect(report.bytesFetched).toBe(BODY.length);
  });

  test("a warm restart transfers nothing and re-hashes nothing", async () => {
    await ensureAssets(root, [pin()], { allowOrigins: allow() });
    hits = 0;
    const report = await ensureAssets(root, [pin()], { allowOrigins: allow() });
    expect(report.outcomes[0].status).toBe("present");
    expect(report.bytesFetched).toBe(0);
    expect(hits).toBe(0);
  });

  test("a file present without a marker is hashed, not re-downloaded", async () => {
    // The case a shipped release or a copied install produces. Re-fetching
    // gigabytes to learn what one local read can tell us is the wrong trade.
    const dest = join(root, "server", "models");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "m.bin"), BODY);
    const report = await ensureAssets(root, [pin()], { allowOrigins: allow() });
    expect(report.outcomes[0].status).toBe("verified");
    expect(hits).toBe(0);
  });

  test("a wrong file on disk is replaced", async () => {
    const dir = join(root, "server", "models");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "m.bin"), Buffer.alloc(BODY.length, 0x79));
    const report = await ensureAssets(root, [pin()], { allowOrigins: allow() });
    expect(report.outcomes[0].status).toBe("fetched");
    expect(readFileSync(join(dir, "m.bin"))).toEqual(BODY);
  });

  test("a failure is reported, not thrown, and does not stop the rest", async () => {
    // tLib must not decide what a missing model means. One product treats it as
    // a feature being unavailable; another as not being ready at all.
    const report = await ensureAssets(
      root,
      [pin({ id: "bad", dest: "a.bin", url: `${base}/404` }), pin({ id: "good", dest: "b.bin" })],
      { allowOrigins: allow() }
    );
    expect(report.ok).toBe(false);
    expect(report.outcomes.map((o) => o.status)).toEqual(["failed", "fetched"]);
    expect(report.outcomes[0].error?.message).toContain("HTTP 404");
    expect(existsSync(join(root, "b.bin"))).toBe(true);
  });

  test("progress is reported against a real denominator", async () => {
    const seen: number[] = [];
    let total = 0;
    await ensureAssets(root, [pin()], {
      allowOrigins: allow(),
      onProgress: (p) => {
        if (p.phase === "downloading") seen.push(p.received);
        total = p.size;
      },
    });
    expect(total).toBe(BODY.length);
    expect(seen.at(-1)).toBe(BODY.length);
    // Monotonic: an operator watching this must never see it go backwards.
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  test("refuses a relative resource root", async () => {
    await expect(ensureAssets("server/models", [pin()])).rejects.toThrow("absolute");
  });

  test("refuses to write outside the resource root", async () => {
    await expect(ensureAssets(root, [pin({ dest: "../escape.bin" })])).rejects.toThrow("'..'");
  });
});
