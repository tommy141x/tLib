/**
 * `createRuntimeAssetCache` — and above everything else, the assertion that
 * **after a resource restart tWeb is not consulted**.
 *
 * That is the half of the one-click-install contract that protects the
 * architecture, and it is the half that fails silently: a cache that kept
 * preferring the remote copy would work perfectly in every manual test and
 * would only be discovered the day tWeb went down, by which time every
 * installed item on every server had become a remote dependency.
 *
 * What "after a restart" is, in a test
 *
 * A resource restart does two things and only two: it tears down the NUI
 * document (so every map in the module is gone — the cache is constructed
 * fresh here, which IS that) and it rebuilds the client file manifest (so the
 * newly-installed file is now served locally — the fake file server here
 * answers 200 for it, which IS that).
 *
 * So the measurement is: build a fresh cache, make the local server answer for
 * the asset, drive the SAME install path the pre-restart case uses, and assert
 * that **nothing in the recorded request log points at the marketplace host**.
 * It is the request log that is asserted, not a flag or a return value — a flag
 * is a claim about intent, and the request log is the behaviour the rule is
 * actually about.
 *
 * The negative controls, and what they prove
 *
 * A passing assertion proves nothing on its own. Each local-first check below
 * is paired with a run of the same check against a server that 404s the local
 * path — the pre-restart state. If the assertion still passed there, it would
 * not be observing requests at all. Stated plainly: these controls prove the
 * assertions *fire*; they do not prove the rule set is complete.
 */

import { describe, expect, test } from "bun:test";
// adm-zip, NOT fflate — the module extracts with fflate, so building the
// fixtures with the same library would hide a disagreement about zip layout
// between a writer and a reader. adm-zip is already tLib's test-side zip tool.
import AdmZip from "adm-zip";
import {
  createRuntimeAssetCache,
  type FetchLike,
  type RuntimeAssetCache,
} from "../../shared/ts/runtime-assets.ts";

const MARKETPLACE = "https://timmygstudios.com";
const REMOTE_ZIP = `${MARKETPLACE}/api/v1/items/tradio-fancy/download`;

const LAYOUT_HTML = `<div class="radio">
  <img src="chassis.png">
  <img src="./icons/mic.png">
  <link href="skin.css" rel="stylesheet">
  <img src="https://cdn.example/absolute.png">
  <img src="/rooted.png">
  <img src="../escaped.png">
  <a href="#frag">x</a>
</div>`;

function zipOf(entries: Record<string, Uint8Array | string>): Uint8Array {
  const zip = new AdmZip();
  for (const [name, body] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(typeof body === "string" ? Buffer.from(body) : body));
  }
  return new Uint8Array(zip.toBuffer());
}

/**
 * A zip built byte by byte, because a HOSTILE entry name cannot be produced by
 * a library.
 *
 * adm-zip sanitises on write: `addFile("../../../escape.lua", …)` lands in the
 * archive as `escape.lua`, so a zip-slip fixture built with it tests nothing.
 * The traversal guard is only reachable with a zip no well-behaved writer would
 * make — which is exactly the input it exists for. Stored (method 0) entries,
 * with real CRCs so fflate has nothing to object to beyond the name.
 */
function rawZip(entries: Record<string, string>): Uint8Array {
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (b: Uint8Array): number => {
    let c = 0xffffffff;
    for (const byte of b) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const [name, body] of Object.entries(entries)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(body);
    const crc = crc32(data);

    const lfh = new DataView(new ArrayBuffer(30));
    lfh.setUint32(0, 0x04034b50, true);
    lfh.setUint16(4, 20, true);
    lfh.setUint32(14, crc, true);
    lfh.setUint32(18, data.length, true);
    lfh.setUint32(22, data.length, true);
    lfh.setUint16(26, nameBytes.length, true);
    locals.push(new Uint8Array(lfh.buffer), nameBytes, data);

    const cdh = new DataView(new ArrayBuffer(46));
    cdh.setUint32(0, 0x02014b50, true);
    cdh.setUint16(4, 20, true);
    cdh.setUint16(6, 20, true);
    cdh.setUint32(16, crc, true);
    cdh.setUint32(20, data.length, true);
    cdh.setUint32(24, data.length, true);
    cdh.setUint16(28, nameBytes.length, true);
    cdh.setUint32(42, offset, true);
    central.push(new Uint8Array(cdh.buffer), nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const centralBytes = central.reduce((n, a) => n + a.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, Object.keys(entries).length, true);
  eocd.setUint16(10, Object.keys(entries).length, true);
  eocd.setUint32(12, centralBytes, true);
  eocd.setUint32(16, offset, true);

  const parts = [...locals, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function bundleZip(): Uint8Array {
  return zipOf({
    "ui.html": LAYOUT_HTML,
    "chassis.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    "icons/mic.png": new Uint8Array([1, 2, 3]),
    "skin.css": ".radio{color:red}",
  });
}

interface Harness {
  cache: RuntimeAssetCache;
  /** Every URL requested, in order, with its method. */
  requests: Array<{ url: string; method: string }>;
  /** Only the requests that left for the marketplace host. */
  remote(): string[];
  blobs: Map<string, Blob>;
  revoked: string[];
  warnings: string[];
}

interface HarnessOptions {
  /** Paths the resource's own file server answers. `null` = serve nothing. */
  local?: Record<string, string> | null;
  /** The zip the marketplace answers with, or a status to answer instead. */
  remoteZip?: Uint8Array | number;
  /** Bytes the marketplace answers with for a single-file download. */
  remoteFile?: Uint8Array | number;
  /** Make the local HEAD probe reject rather than answer. */
  probeThrows?: boolean;
}

function harness(opts: HarnessOptions = {}): Harness {
  const requests: Array<{ url: string; method: string }> = [];
  const blobs = new Map<string, Blob>();
  const revoked: string[] = [];
  const warnings: string[] = [];
  const local = opts.local === undefined ? {} : opts.local;
  let blobSeq = 0;

  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ url, method });

    if (url.startsWith(MARKETPLACE)) {
      if (url.endsWith("/download") && url.includes("tradio-fancy")) {
        const z = opts.remoteZip;
        if (typeof z === "number") return new Response(null, { status: z });
        return new Response((z ?? bundleZip()) as unknown as BodyInit, { status: 200 });
      }
      const f = opts.remoteFile;
      if (typeof f === "number") return new Response(null, { status: f });
      return new Response((f ?? new Uint8Array([9, 9, 9])) as unknown as BodyInit, {
        status: 200,
      });
    }

    if (opts.probeThrows) throw new TypeError("Failed to fetch");
    // Strip the cache-busting query the document fetch adds.
    const path = url.split("?")[0] as string;
    const body = local?.[path];
    if (body === undefined) return new Response(null, { status: 404 });
    return new Response(method === "HEAD" ? null : body, { status: 200 });
  };

  const cache = createRuntimeAssetCache({
    tag: "test",
    bundleBase: (key) => `../../layouts/${key}/`,
    filePath: (filename) => `../../layouts/sounds/${filename}`,
    fetchImpl,
    logger: {
      log: () => {},
      warn: (...args: unknown[]) => warnings.push(args.map(String).join(" ")),
    },
    objectUrls: {
      create: (blob) => {
        const u = `blob:test/${++blobSeq}`;
        blobs.set(u, blob);
        return u;
      },
      revoke: (u) => revoked.push(u),
    },
  });

  return {
    cache,
    requests,
    remote: () => requests.filter((r) => r.url.startsWith(MARKETPLACE)).map((r) => r.url),
    blobs,
    revoked,
    warnings,
  };
}

// THE CONTRACT: after a restart, tWeb is not consulted.

describe("after a resource restart, tWeb is not consulted", () => {
  test("a bundle the resource now serves is never downloaded", async () => {
    // A fresh cache IS the torn-down NUI document; a local 200 IS the rebuilt
    // file manifest. Nothing else distinguishes the two sides of a restart.
    const h = harness({
      local: { "../../layouts/tradio-fancy/ui.html": LAYOUT_HTML },
    });

    await h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP);

    expect(h.remote()).toEqual([]);
    // Not cached as a runtime bundle either — so every consumer's
    // `hasBundle()` branch keeps pointing at the local path.
    expect(h.cache.hasBundle("tradio-fancy")).toBe(false);
    expect(h.cache.bundleUrl("tradio-fancy", "chassis.png")).toBeNull();

    // And the document comes off the file server, rewritten against it.
    const doc = await h.cache.bundleDocument("tradio-fancy");
    expect(h.remote()).toEqual([]);
    expect(doc).toContain('src="../../layouts/tradio-fancy/chassis.png"');
  });

  test("NEGATIVE CONTROL: the same check sees the download before a restart", async () => {
    // Identical assertions, local server serving nothing. If the test above
    // passed here too it would not be observing requests at all.
    const h = harness({ local: null });

    await h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP);

    expect(h.remote()).toEqual([REMOTE_ZIP]);
    expect(h.cache.hasBundle("tradio-fancy")).toBe(true);
  });

  test("repeat loads of a locally-served bundle cost no further requests", async () => {
    const h = harness({
      local: { "../../layouts/tradio-fancy/ui.html": LAYOUT_HTML },
    });
    await h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP);
    const afterFirst = h.requests.length;

    // `ensureBundle` runs on every load in the consumers. Without the memo of
    // the local verdict this would be one HEAD per load, forever.
    expect(h.cache.ensureBundle("tradio-fancy")).toBeUndefined();
    await h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP);

    expect(h.requests.length).toBe(afterFirst);
    expect(h.remote()).toEqual([]);
  });

  test("a bundle with no entry document is still recognised by its module.json", async () => {
    // tRadio has a JSON layout shape with no `ui.html` at all. With a single
    // `ui.html` probe this layout would 404 locally on EVERY boot and send the
    // client to tWeb for files sitting on the server's own disk — a permanent
    // remote dependency, which is the one outcome this module exists to prevent.
    const h = harness({
      local: { "../../layouts/tradio-json/module.json": '{"kind":"layout"}' },
    });

    await h.cache.acquireBundle("tradio-json", REMOTE_ZIP);

    expect(h.remote()).toEqual([]);
    expect(h.cache.hasBundle("tradio-json")).toBe(false);
    // Two HEADs, not one: `ui.html` is tried first because it is the document
    // consumers load, and only its absence reaches the second marker.
    expect(h.requests.map((r) => r.url)).toEqual([
      "../../layouts/tradio-json/ui.html",
      "../../layouts/tradio-json/module.json",
    ]);
  });

  test("NEGATIVE CONTROL: a single-probe cache does reach tWeb for that layout", async () => {
    // The same bundle against a cache configured the way this module USED to
    // behave. If this did not download, the test above would be asserting
    // nothing about the probe list.
    const requests: string[] = [];
    const cache = createRuntimeAssetCache({
      tag: "test",
      bundleProbe: "ui.html",
      bundleBase: (k) => `../../layouts/${k}/`,
      filePath: (f) => `../../layouts/sounds/${f}`,
      logger: { log: () => {}, warn: () => {} },
      objectUrls: { create: () => "blob:x", revoke: () => {} },
      fetchImpl: async (input, init) => {
        const url = String(input);
        requests.push(url);
        if (url.startsWith(MARKETPLACE)) {
          return new Response(bundleZip() as unknown as BodyInit, { status: 200 });
        }
        if ((init?.method ?? "GET") === "HEAD" && url.endsWith("module.json")) {
          return new Response(null, { status: 200 });
        }
        return new Response(null, { status: 404 });
      },
    });

    await cache.acquireBundle("tradio-json", REMOTE_ZIP);
    expect(requests.filter((u) => u.startsWith(MARKETPLACE))).toEqual([REMOTE_ZIP]);
  });

  test("a sound the resource now serves is never downloaded", async () => {
    const h = harness({ local: { "../../layouts/sounds/siren.wav": "RIFF" } });

    await h.cache.acquireFile("siren.wav", `${MARKETPLACE}/api/v1/items/x/download`);

    expect(h.remote()).toEqual([]);
    expect(h.cache.fileUrl("siren.wav")).toBeNull();
  });

  test("NEGATIVE CONTROL: the same sound check sees the download before a restart", async () => {
    const h = harness({ local: null });

    await h.cache.acquireFile("siren.wav", `${MARKETPLACE}/api/v1/items/x/download`);

    expect(h.remote()).toEqual([`${MARKETPLACE}/api/v1/items/x/download`]);
    expect(h.cache.fileUrl("siren.wav")).toBe("blob:test/1");
  });

  test("a broken local probe stays local rather than becoming a remote dependency", async () => {
    // The conservative direction: if the probe itself cannot answer, we must
    // not conclude "not served locally" and reach for tWeb on every asset.
    const h = harness({ probeThrows: true });

    await h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP);
    await h.cache.acquireFile("siren.wav", `${MARKETPLACE}/api/v1/items/x/download`);

    expect(h.remote()).toEqual([]);
  });

  test("syncFiles downloads only the entries the resource cannot serve", async () => {
    // The replay path. `installedSounds` carries the shipped tones too, so an
    // unconditional fetch was ~34 marketplace 404s per session.
    const h = harness({
      local: {
        "../../layouts/sounds/shipped.wav": "RIFF",
        "../../layouts/sounds/alsoshipped.wav": "RIFF",
      },
      remoteFile: new Uint8Array([1, 2]),
    });
    const ready: string[] = [];

    h.cache.syncFiles(
      [
        { slug: "a", filename: "shipped.wav" },
        { slug: "b", filename: "alsoshipped.wav" },
        { slug: "c", filename: "bought.wav" },
        { slug: "d", filename: "builtin.wav", localOnly: true },
        { filename: "noslug.wav" },
      ],
      MARKETPLACE,
      (filename) => ready.push(filename)
    );
    await Bun.sleep(5);

    expect(h.remote()).toEqual([`${MARKETPLACE}/api/v1/items/c/download`]);
    expect(ready).toEqual(["bought.wav"]);
    expect(h.cache.fileUrl("bought.wav")).toBe("blob:test/1");
  });

  test("syncFiles with no base URL reaches nothing", async () => {
    // The base arrives from Lua's convar alongside the config payload. A
    // handshake that has not landed must not be papered over with a default.
    const h = harness({ local: null });
    h.cache.syncFiles([{ slug: "c", filename: "bought.wav" }], undefined);
    await Bun.sleep(5);
    expect(h.requests).toEqual([]);
  });
});

// The pre-restart window: the install has to render without a restart.

describe("the pre-restart window", () => {
  async function installed(opts: HarnessOptions = {}): Promise<Harness> {
    const h = harness({ local: null, ...opts });
    await h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP);
    return h;
  }

  test("every zip entry becomes a blob, and text entries decode too", async () => {
    const h = await installed();
    expect(h.cache.hasBundle("tradio-fancy")).toBe(true);
    expect(h.cache.bundleUrl("tradio-fancy", "chassis.png")).not.toBeNull();
    expect(h.cache.bundleUrl("tradio-fancy", "icons/mic.png")).not.toBeNull();
    expect(h.cache.bundleText("tradio-fancy", "skin.css")).toBe(".radio{color:red}");
    // A path's case and separators must not decide whether it is found: the
    // consumers build these from server-supplied names and from zip entries.
    expect(h.cache.bundleUrl("tradio-fancy", "Icons\\Mic.PNG")).toBe(
      h.cache.bundleUrl("tradio-fancy", "icons/mic.png")
    );
  });

  test("the entry document is served from the zip, with its assets pointed at blobs", async () => {
    const h = await installed();
    const before = h.requests.length;
    const doc = await h.cache.bundleDocument("tradio-fancy");

    // No request at all: the text came out of the zip.
    expect(h.requests.length).toBe(before);
    expect(doc).toContain(`src="${h.cache.bundleUrl("tradio-fancy", "chassis.png")}"`);
    expect(doc).toContain(`src="${h.cache.bundleUrl("tradio-fancy", "icons/mic.png")}"`);
    expect(doc).toContain(`href="${h.cache.bundleUrl("tradio-fancy", "skin.css")}"`);
    // Absolute, root-relative, parent-relative and fragment URLs are authored
    // deliberately and must survive untouched.
    expect(doc).toContain('src="https://cdn.example/absolute.png"');
    expect(doc).toContain('src="/rooted.png"');
    expect(doc).toContain('src="../escaped.png"');
    expect(doc).toContain('href="#frag"');
  });

  test("a relative path the zip does not contain falls back to the local base", async () => {
    const h = await installed();
    const doc = h.cache.rewriteDocument("tradio-fancy", '<img src="missing.png">');
    expect(doc).toBe('<img src="../../layouts/tradio-fancy/missing.png">');
  });

  test("a zip whose entries are prefixed with the bundle name is unwrapped", async () => {
    const h = harness({
      local: null,
      remoteZip: zipOf({
        "tradio-fancy/ui.html": LAYOUT_HTML,
        "tradio-fancy/chassis.png": new Uint8Array([1]),
      }),
    });
    await h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP);
    expect(h.cache.bundleUrl("tradio-fancy", "chassis.png")).not.toBeNull();
    expect(h.cache.bundleText("tradio-fancy", "ui.html")).toBe(LAYOUT_HTML);
  });

  test("a zip-slip entry is skipped, not written", async () => {
    const h = harness({
      local: null,
      remoteZip: rawZip({
        "ui.html": "<div></div>",
        "../../../escape.lua": "bad",
      }),
    });
    await h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP);
    expect(h.cache.bundleUrl("tradio-fancy", "../../../escape.lua")).toBeNull();
    expect(h.warnings.some((w) => w.includes("unsafe bundle entry"))).toBe(true);
    // The safe entry still installed — a bad sibling must not void the bundle.
    expect(h.cache.bundleText("tradio-fancy", "ui.html")).toBe("<div></div>");
  });

  test("a response that is not a zip is refused by magic, not by content-type", async () => {
    const h = harness({
      local: null,
      remoteZip: new TextEncoder().encode("<!doctype html><title>404</title>"),
    });
    await h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP);
    expect(h.cache.hasBundle("tradio-fancy")).toBe(false);
    expect(h.warnings.some((w) => w.includes("not a zip bundle"))).toBe(true);
  });

  test("concurrent acquisitions of one bundle make one request", async () => {
    const h = harness({ local: null });
    await Promise.all([
      h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP),
      h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP),
      h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP),
    ]);
    expect(h.remote()).toEqual([REMOTE_ZIP]);
  });

  test("a download that fails is retried once, then gives up without throwing", async () => {
    const h = harness({ local: null, remoteZip: 503 });
    // Must RESOLVE: callers await this to proceed to their local fallback, and
    // an export that throws here would surface later as a JSON parse error.
    await h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP);
    expect(h.remote()).toEqual([REMOTE_ZIP, REMOTE_ZIP]);
    expect(h.cache.hasBundle("tradio-fancy")).toBe(false);
    expect(h.warnings.some((w) => w.includes("permanently failed"))).toBe(true);
  }, 10_000);

  test("ensureBundle retries a failed download using the remembered URL", async () => {
    const h = harness({ local: null, remoteZip: 503 });
    await h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP);
    const pending = h.cache.ensureBundle("tradio-fancy");
    expect(pending).not.toBeUndefined();
    await pending;
    expect(h.remote().length).toBe(4);
  }, 20_000);

  test("a permanently failing sound is not retried on the next config refresh", async () => {
    const h = harness({ local: null, remoteFile: 404 });
    const url = `${MARKETPLACE}/api/v1/items/x/download`;
    await h.cache.acquireFile("gone.wav", url);
    await h.cache.acquireFile("gone.wav", url);
    await h.cache.acquireFile("gone.wav", url);
    // One attempt, not three. `installedSounds` is re-pushed on every config
    // change and a wall of warnings per push is what this suppresses.
    expect(h.remote()).toEqual([url]);
  });

  test("evictFile clears the recorded failure so a reinstall is picked up", async () => {
    const h = harness({ local: null, remoteFile: 404 });
    const url = `${MARKETPLACE}/api/v1/items/x/download`;
    await h.cache.acquireFile("gone.wav", url);
    h.cache.evictFile("gone.wav");
    await h.cache.acquireFile("gone.wav", url);
    expect(h.remote()).toEqual([url, url]);
  });
});

// Eviction and the generation fence.

describe("eviction", () => {
  test("evictBundle revokes every blob and forgets the bundle", async () => {
    const h = harness({ local: null });
    await h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP);
    const urls = ["ui.html", "chassis.png", "icons/mic.png", "skin.css"].map((p) =>
      h.cache.bundleUrl("tradio-fancy", p)
    );
    h.cache.evictBundle("tradio-fancy");

    expect(h.cache.hasBundle("tradio-fancy")).toBe(false);
    expect(h.cache.bundleText("tradio-fancy", "ui.html")).toBeNull();
    for (const u of urls) expect(h.revoked).toContain(u as string);
    // The download URL goes too: an uninstalled item must not be silently
    // re-fetched by the next ensureBundle.
    expect(h.cache.ensureBundle("tradio-fancy")).toBeUndefined();
  });

  test("a download that lands after its bundle was evicted is discarded", async () => {
    // Uninstall racing a slow download. Without the generation fence the
    // in-flight result reinstates an item the operator just deleted.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const requests: string[] = [];
    const revoked: string[] = [];
    let seq = 0;
    const cache = createRuntimeAssetCache({
      tag: "test",
      bundleBase: (k) => `../../layouts/${k}/`,
      filePath: (f) => `../../layouts/sounds/${f}`,
      logger: { log: () => {}, warn: () => {} },
      objectUrls: { create: () => `blob:test/${++seq}`, revoke: (u) => revoked.push(u) },
      fetchImpl: async (input, init) => {
        requests.push(String(input));
        if ((init?.method ?? "GET") === "HEAD") return new Response(null, { status: 404 });
        await gate;
        return new Response(bundleZip() as unknown as BodyInit, { status: 200 });
      },
    });

    const p = cache.acquireBundle("tradio-fancy", REMOTE_ZIP);
    await Bun.sleep(5);
    cache.evictBundle("tradio-fancy");
    release();
    await p;

    expect(cache.hasBundle("tradio-fancy")).toBe(false);
    // The blobs it had already created are revoked rather than leaked.
    expect(revoked.length).toBeGreaterThan(0);
  });

  test("a reinstall within one session replaces the blobs rather than leaking them", async () => {
    const h = harness({ local: null });
    await h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP);
    const first = h.cache.bundleUrl("tradio-fancy", "chassis.png");

    h.cache.evictBundle("tradio-fancy");
    await h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP);
    const second = h.cache.bundleUrl("tradio-fancy", "chassis.png");

    expect(second).not.toBe(first);
    expect(h.revoked).toContain(first as string);
    expect(h.cache.hasBundle("tradio-fancy")).toBe(true);
  });

  test("evicting then re-acquiring re-probes locally", async () => {
    // An uninstall followed by a reinstall must not inherit the old verdict in
    // either direction.
    const h = harness({ local: { "../../layouts/tradio-fancy/ui.html": LAYOUT_HTML } });
    await h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP);
    const probes = h.requests.length;
    h.cache.evictBundle("tradio-fancy");
    await h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP);
    expect(h.requests.length).toBe(probes + 1);
    expect(h.remote()).toEqual([]);
  });
});

describe("the expanded-size ceiling", () => {
  test("a bundle over the total ceiling is truncated, not refused", async () => {
    const requests: string[] = [];
    let seq = 0;
    const cache = createRuntimeAssetCache({
      tag: "test",
      bundleBase: (k) => `../../layouts/${k}/`,
      filePath: (f) => `../../layouts/sounds/${f}`,
      maxTotalBytes: 32,
      maxEntryBytes: 16,
      logger: { log: () => {}, warn: () => {} },
      objectUrls: { create: () => `blob:test/${++seq}`, revoke: () => {} },
      fetchImpl: async (input, init) => {
        requests.push(String(input));
        if ((init?.method ?? "GET") === "HEAD") return new Response(null, { status: 404 });
        return new Response(
          zipOf({
            "ui.html": "<div></div>",
            "huge.png": new Uint8Array(64),
            "ok.png": new Uint8Array(4),
          }) as unknown as BodyInit,
          { status: 200 }
        );
      },
    });

    await cache.acquireBundle("tradio-fancy", REMOTE_ZIP);
    // The oversized entry is dropped by the per-entry ceiling; the document
    // and the small asset still install.
    expect(cache.bundleText("tradio-fancy", "ui.html")).toBe("<div></div>");
    expect(cache.bundleUrl("tradio-fancy", "huge.png")).toBeNull();
    expect(cache.bundleUrl("tradio-fancy", "ok.png")).not.toBeNull();
  });
});

describe("the data-URL mode, for a sandboxed iframe", () => {
  /**
   * tELS hosts a layout pack in a `sandbox`ed iframe with no
   * `allow-same-origin`, so the frame's origin is OPAQUE. The blob URL store is
   * keyed by origin, so a blob: URL minted by the parent cannot be loaded in
   * there at all — it is not a permissions warning, the fetch simply fails. A
   * data: URL carries its bytes and has no origin to check.
   *
   * This is reasoned from the HTML/File-API specs and Chromium's enforcement
   * of them, NOT measured in CEF: there is no way to drive FiveM's browser from
   * a suite. What IS measured here is that the mode produces loadable data:
   * URLs, revokes nothing, and leaves everything else about the cache identical.
   */
  function dataHarness(): { cache: RuntimeAssetCache; revoked: string[] } {
    const revoked: string[] = [];
    const cache = createRuntimeAssetCache({
      tag: "test",
      urlMode: "data",
      bundleBase: (k) => `../../layouts/${k}/`,
      filePath: (f) => `../../layouts/sounds/${f}`,
      logger: { log: () => {}, warn: () => {} },
      objectUrls: {
        create: () => {
          throw new Error("createObjectURL must not be reached in data mode");
        },
        revoke: (u) => revoked.push(u),
      },
      fetchImpl: async (input, init) => {
        if ((init?.method ?? "GET") === "HEAD") return new Response(null, { status: 404 });
        if (String(input).endsWith("/download")) {
          return new Response(bundleZip() as unknown as BodyInit, { status: 200 });
        }
        return new Response(null, { status: 404 });
      },
    });
    return { cache, revoked };
  }

  test("every entry becomes a self-contained data: URL and nothing is revoked", async () => {
    const h = dataHarness();
    await h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP);

    const css = h.cache.bundleUrl("tradio-fancy", "skin.css");
    expect(css).toStartWith("data:text/css;base64,");
    expect(atob((css as string).split(",")[1] as string)).toBe(".radio{color:red}");
    expect(h.cache.bundleUrl("tradio-fancy", "chassis.png")).toStartWith("data:image/png;base64,");

    // Eviction must not try to revoke a data: URL — there is no registry entry
    // for one, and a "leak" here is garbage collection's problem, not ours.
    h.cache.evictBundle("tradio-fancy");
    expect(h.revoked).toEqual([]);
    expect(h.cache.hasBundle("tradio-fancy")).toBe(false);
  });

  test("the rewritten document carries the bytes, so no origin is consulted", async () => {
    const h = dataHarness();
    await h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP);
    const doc = await h.cache.bundleDocument("tradio-fancy");
    expect(doc).toContain('src="data:image/png;base64,');
    expect(doc).toContain('href="data:text/css;base64,');
    // Still only the relative ones.
    expect(doc).toContain('src="https://cdn.example/absolute.png"');
    expect(doc).toContain('src="/rooted.png"');
  });

  test("NEGATIVE CONTROL: blob mode would have failed both assertions", async () => {
    // Proves the two checks above are reading the URL scheme, not just "a
    // non-empty string".
    const h = harness({ local: null });
    await h.cache.acquireBundle("tradio-fancy", REMOTE_ZIP);
    expect(h.cache.bundleUrl("tradio-fancy", "skin.css")).not.toStartWith("data:");
    const doc = await h.cache.bundleDocument("tradio-fancy");
    expect(doc).not.toContain('src="data:image/png');
  });
});
