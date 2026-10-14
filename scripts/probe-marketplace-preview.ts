/**
 * How long does opening a marketplace preview actually cost, and where?
 *
 *   bun run probe:preview            measure
 *   bun run probe:preview --json     machine-readable
 *
 * The owner reports the in-game marketplace preview as "slow to load and laggy,
 * especially on low-end machines". This is the instrument that says WHERE the
 * time goes, because every candidate explanation for that sentence is cheap to
 * believe and none of them were measured.
 *
 * What is measured, and in what
 *
 * Stage A runs in bun: the exact string pipeline `PreviewOverlay.tsx`'s
 * `UiPreviewFrame` applies to a fetched document — the `src|href` rewrite, the
 * centering-CSS splice, the binder splice, and `parsePreviewCanvasSize`.
 *
 * Stage B runs in the PINNED CHROMIUM 103 that CEF is (`shared/ts/build/
 * nui-chromium.ts`), because the thing under suspicion is `srcdoc` parse and
 * image decode and neither of those happens in bun. Every number in stage B is
 * taken in-page with `performance.now()` around a real `load` event, so the CDP
 * round trip is outside the measured window. Every frame REPORTS ITSELF back by
 * postMessage — image count, decoded count, whether the injected script ran, body
 * width — because a sandboxed opaque-origin frame cannot be read from outside and
 * a mode that rendered nothing would otherwise time as fast.
 *
 * Stage C times the JSON encode and parse the document pays crossing into the NUI
 * as a message field.
 *
 * The corpus is the REAL one: `backups/marketplace-import/manifest.json`, the
 * 18 UI heads that were actually imported into the marketplace, plus
 * `manifest-held.json`'s 3 large ones. Not synthetic documents — the whole
 * finding here is about their size distribution, which no synthetic fixture
 * would have reproduced.
 *
 * The control
 *
 * `--control` strips every ASSET REFERENCE out of each document and re-measures.
 * It is not an optimisation proposal — it is the thing that makes the verdict
 * attributable: if the stripped document loads in the same time as the real one,
 * then the assets are NOT the cost and every conclusion drawn from their size is
 * wrong. It is reported beside the real number rather than instead of it.
 *
 * "Asset reference" means BOTH forms, because a document can carry either:
 *
 *   - an inline `data:[type];base64,…` payload, replaced by a 1x1 GIF;
 *   - a REMOTE reference whose target contains `/api/storage/` — a `src=`/`href=`
 *     attribute or a CSS `url()` — likewise replaced by the 1x1 GIF.
 *
 * The second form is not an extension, it is a repair. The rehost lifted every
 * inlined image onto R2 and rewrote the document to reference it by https URL, so
 * a `data:`-only stripper stopped removing anything: MEASURED on the 21 published
 * documents, the control went from 138ms (against 4,020ms real) to 189ms — it
 * went UP, because the "control" document still fetched every image. A control
 * that cannot fail is worse than no control, so the control now also refuses to
 * run: if the control document comes out byte-identical to the real one for any
 * item, the probe exits non-zero instead of printing a number (see `INERT`
 * below), and the `stripped` column reports per item how many references went.
 *
 * `@font-face` is the one case where the 1x1 GIF is the WRONG substitution — a
 * GIF is not a font, so the browser would still pay a fetch-free but real
 * font-parse failure and the measurement would be of that failure rather than of
 * nothing. The whole `@font-face` block is deleted instead: the family then does
 * not resolve, text falls to the next stack entry, and no font asset is loaded at
 * all, which is exactly the "same layout, zero asset loads" document wanted.
 *
 * NOT in `verify` or `check:regression`: `nui-chromium.ts` is Windows-only (a
 * `Win_x64` snapshot, `chrome-win/chrome.exe`, `powershell Expand-Archive`) and
 * `verify` must run on Linux. Same exemption, for the same reason, as
 * `probe:focus`. It also reads a corpus that lives outside this resource, so a
 * fresh clone has nothing to measure — it exits 2 (cannot run), never 0.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
// The SHIPPED function, not a re-typed copy: a probe measuring its own copy
// cannot report on the one that runs in game.
import { parsePreviewCanvasSize } from "../shared/ts/marketplace/ui/preview-canvas";

const TSCRIPTS = resolve(import.meta.dir, "../..");
const CORPUS_DIR = resolve(TSCRIPTS, "../../../backups/marketplace-import");

const JSON_OUT = process.argv.includes("--json");
const WITH_CONTROL = process.argv.includes("--control");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
/**
 * `--from=<dir>` measures `<dir>/*.html` INSTEAD of the import manifests, and
 * it exists because the manifests are the PRE-publish payloads — they are what
 * was handed to the catalogue, not what the catalogue now serves.
 *
 * Those two diverged the moment anything rehosted. `rehostEmbeddedImages` lifts
 * every `data:` image onto R2 and rewrites the document to reference it by URL,
 * so a published item's document is a fraction of the manifest entry it came
 * from — measured on the three that went in through a rehosting path: 12.9 MB →
 * 27 KB, 8.6 MB → 21 KB, 2.8 MB → 84 KB. A probe pinned to the manifests can
 * therefore only ever report the unrehosted cost, which is exactly the number
 * the rehost is supposed to change.
 *
 * So the before/after of a backfill is `--from=<dir of documents fetched from
 * /api/marketplace/items/:slug/ui-html>`, run twice against the same live route.
 * The slug is the filename stem, which is how the fetch loop writes them.
 *
 * It also makes the remote-image question measurable, which is the part that
 * cannot be reasoned about. A rehosted document's images are `https:` URLs on
 * another origin, and the frame is `sandbox="allow-scripts"` with no
 * `allow-same-origin` — an opaque origin. Whether an `<img>` resolves from there
 * is a browser behaviour, not a documented one, and the Control table below
 * already reports `imgs/decoded` as counted by the frame itself. Pointing this
 * at rehosted documents turns "will remote images load" into a number.
 */
const FROM_DIR = process.argv.find((a) => a.startsWith("--from="))?.slice(7);

interface CorpusItem {
  slug: string;
  html: string;
}

function loadCorpus(): CorpusItem[] {
  const out: CorpusItem[] = [];
  if (FROM_DIR) {
    const dir = resolve(FROM_DIR);
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith(".html")) continue;
      const html = readFileSync(resolve(dir, f), "utf8");
      if (html) out.push({ slug: f.slice(0, -5), html });
    }
  } else {
    for (const f of ["manifest.json", "manifest-held.json"]) {
      const p = resolve(CORPUS_DIR, f);
      if (!existsSync(p)) continue;
      for (const it of JSON.parse(readFileSync(p, "utf8")) as Array<Record<string, unknown>>) {
        const html = String(it.ui_html_content ?? "");
        if (html) out.push({ slug: String(it.slug), html });
      }
    }
  }
  return ONLY ? out.filter((i) => i.slug.includes(ONLY)) : out;
}

// Stage A: the string pipeline, verbatim from `UiPreviewFrame`

const CENTER_CSS =
  "<style>html,body{margin:0;padding:0;background:transparent;display:flex;align-items:center;justify-content:center;min-height:100vh;}</style>";

/**
 * Stand-in for `buildHudPreviewScript`, sized from the real one (~2.3 KB) and
 * carrying the one flag the in-frame reporter reads — so "did injected script
 * execute in this mode" is answered by script that really ran, not inferred.
 */
const BINDER = `<script>window.__binderRan=true;/*${"0".repeat(2300)}*/</script>`;

function rewrite(text: string, id: string): string {
  const base = `https://marketplace.invalid/api/v1/preview/${encodeURIComponent(id)}/`;
  let r = text.replace(
    /(src|href)=(['"])(?!https?:|\/\/|data:|#|\/)([^'"]+)\2/gi,
    (_m: string, attr: string, q: string, p: string) => `${attr}=${q}${base}${p}${q}`
  );
  r = r.replace(/(<head[^>]*>)/i, `$1${CENTER_CSS}`);
  if (!/(<head)/i.test(r)) r = CENTER_CSS + r;
  r = r.replace(/<\/body>/i, `${BINDER}</body>`);
  if (!/<\/body>/i.test(r)) r += BINDER;
  return r;
}

const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** `/api/storage/` is the rehost target — see the header. Matched by substring, so
 *  it catches both the absolute `https://next.timmygstudios.com/api/storage/…`
 *  the rehost writes and a same-origin `/api/storage/…`. */
const REMOTE_ASSET = /\/api\/storage\//i;

/**
 * The control document: same markup, every asset reference neutralised — inline
 * `data:` payloads AND remote `/api/storage/` references alike. Returns the
 * number of references removed so a 0 is visible rather than silent.
 */
function stripAssetRefs(html: string): { html: string; removed: number } {
  let removed = 0;

  // FIRST, and as a whole-block delete rather than a substitution: a 1x1 GIF is
  // not a font. Pointing an `@font-face` `src` at one keeps a real cost in the
  // control (the browser still parses the bytes and still fails) and measures
  // that failure instead of measuring nothing. Deleting the block leaves the
  // family unresolved, so text takes the next entry in the stack and NO font
  // asset is loaded — the honest "no asset loads" document.
  let out = html.replace(/@font-face\s*\{[^}]*\}/gi, (block) => {
    if (!/data:/i.test(block) && !REMOTE_ASSET.test(block)) return block;
    removed++;
    return "";
  });

  out = out.replace(/data:[a-z0-9/+.-]+;base64,[A-Za-z0-9+/=]+/gi, () => {
    removed++;
    return PIXEL;
  });

  out = out.replace(
    /(src|href)=(['"])([^'"]*\/api\/storage\/[^'"]*)\2/gi,
    (_m: string, attr: string, q: string) => {
      removed++;
      return `${attr}=${q}${PIXEL}${q}`;
    }
  );

  // Whatever is left in CSS — `background-image`, a mask, a cursor.
  out = out.replace(/url\(\s*(['"]?)([^)'"]*\/api\/storage\/[^)'"]*)\1\s*\)/gi, () => {
    removed++;
    return `url("${PIXEL}")`;
  });

  return { html: out, removed };
}

interface StageA {
  slug: string;
  bytes: number;
  b64Bytes: number;
  rewriteMs: number;
  canvasMs: number;
  tier: 1 | 2 | 3;
}

function measureStageA(items: CorpusItem[]): StageA[] {
  const N = 5;
  return items.map((it) => {
    const b64 = [...it.html.matchAll(/data:[a-z0-9/+.-]+;base64,([A-Za-z0-9+/=]+)/gi)].reduce(
      (a, m) => a + (m[1]?.length ?? 0),
      0
    );
    rewrite(it.html, "warm");
    parsePreviewCanvasSize(it.html);
    let r = 0;
    let c = 0;
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      const doc = rewrite(it.html, "id");
      const t1 = performance.now();
      parsePreviewCanvasSize(doc);
      const t2 = performance.now();
      r += t1 - t0;
      c += t2 - t1;
    }
    const tier: 1 | 2 | 3 = /<!--\s*studio-design:/.test(it.html)
      ? 1
      : /data-rad(?:io|ar)-width="[\d.]+"/.test(it.html)
        ? 2
        : 3;
    return {
      slug: it.slug,
      bytes: it.html.length,
      b64Bytes: b64,
      rewriteMs: r / N,
      canvasMs: c / N,
      tier,
    };
  });
}

// Stage B: srcdoc parse + decode, in Chromium 103

const HARNESS = `<!doctype html><meta charset="utf-8"><title>preview probe</title>
<style>html,body{margin:0}#box{width:700px;height:400px;overflow:hidden;display:flex;align-items:center;justify-content:center}</style>
<div id="box"></div>
<script>
window.__docs = {};
window.__canvas = {};
// What the frame reports back about ITSELF. A sandboxed frame with no
// allow-same-origin cannot be read from here, so the only honest check that a
// mode actually rendered is one the frame posts out. Keyed by mode so a blob
// run cannot be credited with a srcdoc run's report.
window.__reports = {};
addEventListener('message', (e) => {
  if (e.data && e.data.__previewProbe) window.__reports[e.data.mode] = e.data;
});
window.probe = {
  async load(slug, canvasW, canvasH){
    const r = await fetch('/doc/' + encodeURIComponent(slug));
    window.__docs[slug] = await r.text();
    // The shipped wrapper is EXACTLY the canvas, then transformed — see
    // previewBoxStyle. Reproduced here because the frame's viewport size is
    // an input to layout, and a 700x400 stand-in measures a different document
    // from the one that ships.
    window.__canvas[slug] = { w: canvasW, h: canvasH };
    return window.__docs[slug].length;
  },
  /** One open: build the frame, set srcdoc, wait for load. Returns ms. */
  open(slug, mode){
    delete window.__reports[mode];
    // ⚠️ APPENDED, not spliced before </body>. MEASURED: not one of the 21 real
    // marketplace documents contains a <body> tag at all — they are bare
    // fragments — so a splice-before-</body> injected nothing and every mode
    // read "no report", which looks exactly like a mode that rendered nothing.
    const reporter =
      '<' + 'script>setTimeout(function(){var i=document.images,ok=0;' +
      'for(var k=0;k<i.length;k++)if(i[k].naturalWidth>0)ok++;' +
      'parent.postMessage({__previewProbe:1,mode:' + JSON.stringify(mode) +
      ',imgs:i.length,decoded:ok,bound:!!window.__binderRan,' +
      'bodyW:document.body?document.body.scrollWidth:0},"*");},400);<' + '/script>';
    const html = window.__docs[slug] + reporter;
    const box = document.getElementById('box');
    box.innerHTML = '';
    const c = window.__canvas[slug];
    const wrap = document.createElement('div');
    const fit = Math.min(1, Math.min(700 / c.w, 400 / c.h));
    wrap.style.cssText = 'width:' + c.w + 'px;height:' + c.h + 'px;overflow:hidden;' +
      'flex-shrink:0;transform-origin:center center;transform:scale(' + fit + ')';
    box.appendChild(wrap);
    return new Promise((res) => {
      const t0 = performance.now();
      const f = document.createElement('iframe');
      f.setAttribute('sandbox','allow-scripts');
      f.setAttribute('scrolling','no');
      f.style.cssText = 'width:100%;height:100%;border:none;display:block;overflow:hidden';
      let url = null;
      f.onload = () => {
        const t = performance.now() - t0;
        if (url) URL.revokeObjectURL(url);
        res({ ms: t, ok: true });
      };
      f.onerror = () => res({ ms: performance.now() - t0, ok: false });
      if (mode === 'blob') {
        url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        f.src = url;
      } else {
        f.srcdoc = html;
      }
      wrap.appendChild(f);
      setTimeout(() => res({ ms: performance.now() - t0, ok: false, timeout: true }), 20000);
    });
  },
  /** Just the attribute write, with no load wait — isolates serialisation. */
  setOnly(slug){
    const html = window.__docs[slug];
    const f = document.createElement('iframe');
    f.setAttribute('sandbox','allow-scripts');
    const t0 = performance.now();
    f.srcdoc = html;
    return performance.now() - t0;
  },
  clear(){ document.getElementById('box').innerHTML = ''; },
  report(mode){ return window.__reports[mode] || null; },
  /**
   * The NUI MESSAGE cost: a preview document crosses into the renderer as a
   * field of a JSON message, so the frame pays an encode/decode of the whole
   * thing before any of the pipeline above runs. Measured here because it is
   * the one part of the transport that happens in the browser.
   */
  json(slug){
    const html = window.__docs[slug];
    const t0 = performance.now();
    const s = JSON.stringify({ requestId:'x', ok:true, html: html });
    const t1 = performance.now();
    const o = JSON.parse(s);
    const t2 = performance.now();
    return { encodeMs: t1 - t0, decodeMs: t2 - t1, wireBytes: s.length, ok: o.html.length === html.length };
  }
};
</script>`;

interface StageB {
  slug: string;
  bytes: number;
  srcdocMs: number;
  reopenMs: number;
  setOnlyMs: number;
  blobMs: number | null;
  blobOk: boolean;
  controlMs: number | null;
  /** How many asset references the control removed. 0 would be an inert control
   *  — which `main` refuses to reach, but it is reported so the number is seen. */
  controlRemoved: number | null;
  jsonMs: number;
  wireBytes: number;
  /** `imgs/decoded/bound`, per mode — the correctness control on the blob swap. */
  srcdocReport: FrameReport | null;
  blobReport: FrameReport | null;
}

interface FrameReport {
  imgs: number;
  decoded: number;
  bound: boolean;
  bodyW: number;
}

async function main(): Promise<number> {
  const source = FROM_DIR ? resolve(FROM_DIR) : CORPUS_DIR;
  const corpus = loadCorpus();
  if (corpus.length === 0) {
    console.error(`[probe] no corpus at ${source} — nothing to measure.`);
    console.error(
      FROM_DIR
        ? "[probe] --from expects a directory of <slug>.html documents. Exit 2."
        : "[probe] this needs backups/marketplace-import/manifest.json. Exit 2."
    );
    return 2;
  }
  console.error(`[probe] corpus: ${corpus.length} documents from ${source}`);

  const a = measureStageA(corpus);

  // Documents are served rather than injected: a 13 MB `Runtime.evaluate`
  // expression is its own measurement, and not the one wanted here.
  const docs = new Map<string, string>();
  for (const it of corpus) docs.set(it.slug, rewrite(it.html, "id"));
  const controls = new Map<string, string>();
  const removedCounts = new Map<string, number>();
  if (WITH_CONTROL) {
    // The INERTNESS GUARD. A control document identical to the real one is not a
    // weak control, it is a second measurement of the same document — it reports
    // a plausible number that no change to the corpus can ever falsify. That is
    // precisely how the `data:`-only stripper survived the rehost. So this fails
    // the whole run rather than printing the number.
    const inert: string[] = [];
    for (const it of corpus) {
      const stripped = stripAssetRefs(it.html);
      const doc = rewrite(stripped.html, "id");
      controls.set(it.slug, doc);
      removedCounts.set(it.slug, stripped.removed);
      if (doc === docs.get(it.slug)) inert.push(it.slug);
    }
    if (inert.length > 0) {
      console.error(
        `[probe] --control is INERT for ${inert.length}/${corpus.length} document(s): ${inert.join(", ")}`
      );
      console.error(
        "[probe] the control document is byte-identical to the real one for those items, so the"
      );
      console.error(
        "[probe] control arm would re-measure the SAME document and report a number that cannot"
      );
      console.error(
        "[probe] fail. Either the stripper no longer matches how assets are referenced, or this"
      );
      console.error("[probe] corpus has no assets to strip. Refusing to report. Exit 1.");
      // Deliberately before `Bun.serve` and before the browser launch: there is
      // nothing to tear down, and nothing worth spending 20s of Chromium on.
      return 1;
    }
  }

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/")
        return new Response(HARNESS, { headers: { "content-type": "text/html" } });
      const m = u.pathname.match(/^\/doc\/(.+)$/);
      if (m) {
        const slug = decodeURIComponent(m[1] as string);
        const body = u.searchParams.get("control") ? controls.get(slug) : docs.get(slug);
        if (body) return new Response(body, { headers: { "content-type": "text/plain" } });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const { launch } = await import("../shared/ts/build/nui-chromium.ts");
  const browser = await launch({ headless: true, log: () => {} });
  const { page } = browser;
  const b: StageB[] = [];

  try {
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    await page.navigate(`http://127.0.0.1:${server.port}/`);
    const ready = await page.evaluate<boolean>("!!window.probe");
    if (!ready) throw new Error("harness page did not initialise");

    const openOnce = async (slug: string, mode: "srcdoc" | "blob") =>
      page.evaluate<{ ms: number; ok: boolean; timeout?: boolean }>(
        `window.probe.open(${JSON.stringify(slug)}, ${JSON.stringify(mode)})`
      );

    for (const it of corpus) {
      // The SHIPPED canvas resolver, so the frame is laid out at the size the
      // real wrapper gives it.
      const canvas = parsePreviewCanvasSize(docs.get(it.slug) as string);
      await page.evaluate(
        `window.probe.load(${JSON.stringify(it.slug)}, ${canvas.w}, ${canvas.h})`
      );

      const json = await page.evaluate<{
        encodeMs: number;
        decodeMs: number;
        wireBytes: number;
        ok: boolean;
      }>(`window.probe.json(${JSON.stringify(it.slug)})`);
      if (!json.ok) throw new Error(`${it.slug}: JSON round trip lost bytes`);

      const first = await openOnce(it.slug, "srcdoc");
      // The in-frame reporter posts at +400ms; wait for it before clearing, or
      // the frame is gone before it can answer and every mode reads "no report"
      // — which would look exactly like a mode that rendered nothing.
      await new Promise((r) => setTimeout(r, 600));
      const srcdocReport = await page.evaluate<FrameReport | null>('window.probe.report("srcdoc")');
      await page.evaluate("window.probe.clear()");
      // A SECOND open of the same document, with the frame destroyed between —
      // this is what "close the preview and open it again" costs, and whether
      // Chromium's image cache survives a data: URI across documents.
      const second = await openOnce(it.slug, "srcdoc");
      await page.evaluate("window.probe.clear()");

      const setOnly = await page.evaluate<number>(
        `window.probe.setOnly(${JSON.stringify(it.slug)})`
      );

      const blob = await openOnce(it.slug, "blob");
      await new Promise((r) => setTimeout(r, 600));
      const blobReport = await page.evaluate<FrameReport | null>('window.probe.report("blob")');
      await page.evaluate("window.probe.clear()");

      let controlMs: number | null = null;
      if (WITH_CONTROL) {
        await page.evaluate(
          `(async()=>{const r=await fetch('/doc/'+encodeURIComponent(${JSON.stringify(it.slug)})+'?control=1');window.__docs[${JSON.stringify(it.slug)}]=await r.text();})()`
        );
        const c = await openOnce(it.slug, "srcdoc");
        controlMs = c.ms;
        await page.evaluate("window.probe.clear()");
      }

      b.push({
        slug: it.slug,
        bytes: it.html.length,
        srcdocMs: first.ms,
        reopenMs: second.ms,
        setOnlyMs: setOnly,
        blobMs: blob.ok ? blob.ms : null,
        blobOk: blob.ok,
        controlMs,
        controlRemoved: WITH_CONTROL ? (removedCounts.get(it.slug) ?? 0) : null,
        jsonMs: json.encodeMs + json.decodeMs,
        wireBytes: json.wireBytes,
        srcdocReport,
        blobReport,
      });
    }
  } finally {
    await browser.close();
    server.stop(true);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ stageA: a, stageB: b }, null, 2));
    return 0;
  }

  console.log("\n── Stage A · string pipeline (bun)");
  console.log(
    `${"slug".padEnd(20)}${"bytes".padStart(10)}${"inlined%".padStart(10)}${"rewrite".padStart(9)}${"canvas".padStart(8)}${"tier".padStart(6)}`
  );
  for (const r of a) {
    console.log(
      r.slug.padEnd(20) +
        String(r.bytes).padStart(10) +
        `${((100 * r.b64Bytes) / r.bytes).toFixed(1)}%`.padStart(10) +
        `${r.rewriteMs.toFixed(2)}ms`.padStart(9) +
        `${r.canvasMs.toFixed(2)}ms`.padStart(8) +
        String(r.tier).padStart(6)
    );
  }

  console.log("\n── Stage B · iframe load, Chromium 103");
  console.log(
    `${"slug".padEnd(20)}${"bytes".padStart(10)}${"srcdoc".padStart(10)}${"reopen".padStart(10)}${"setattr".padStart(10)}${"blob".padStart(10)}${WITH_CONTROL ? "no-assets".padStart(11) + "stripped".padStart(10) : ""}`
  );
  for (const r of b) {
    console.log(
      r.slug.padEnd(20) +
        String(r.bytes).padStart(10) +
        `${r.srcdocMs.toFixed(0)}ms`.padStart(10) +
        `${r.reopenMs.toFixed(0)}ms`.padStart(10) +
        `${r.setOnlyMs.toFixed(1)}ms`.padStart(10) +
        (r.blobOk ? `${(r.blobMs as number).toFixed(0)}ms` : "BLOCKED").padStart(10) +
        (WITH_CONTROL
          ? `${(r.controlMs as number).toFixed(0)}ms`.padStart(11) +
            String(r.controlRemoved ?? 0).padStart(10)
          : "")
    );
  }

  console.log("\n── Stage C · NUI message decode (JSON encode+parse of the document)");
  console.log(`${"slug".padEnd(20)}${"wireBytes".padStart(11)}${"json".padStart(9)}`);
  for (const r of b) {
    console.log(
      r.slug.padEnd(20) + String(r.wireBytes).padStart(11) + `${r.jsonMs.toFixed(1)}ms`.padStart(9)
    );
  }

  console.log("\n── Control · did each mode actually render? (reported BY the frame)");
  console.log(
    `${"slug".padEnd(20)}${"srcdoc imgs/decoded/bound".padStart(26)}${"blob imgs/decoded/bound".padStart(26)}`
  );
  let mismatches = 0;
  for (const r of b) {
    const f = (x: FrameReport | null) =>
      x ? `${x.imgs}/${x.decoded}/${x.bound ? "yes" : "NO"}/w${x.bodyW}` : "no report";
    const same =
      r.srcdocReport &&
      r.blobReport &&
      r.srcdocReport.decoded === r.blobReport.decoded &&
      r.srcdocReport.bound === r.blobReport.bound &&
      r.srcdocReport.bodyW === r.blobReport.bodyW;
    if (!same) mismatches++;
    console.log(
      r.slug.padEnd(20) +
        f(r.srcdocReport).padStart(26) +
        f(r.blobReport).padStart(26) +
        (same ? "" : "  ← DIFFERS")
    );
  }
  console.log(`modes that did not render identically: ${mismatches}/${b.length}`);

  const sum = (f: (r: StageB) => number) => b.reduce((x, r) => x + f(r), 0);
  console.log(
    `\ntotals: srcdoc ${sum((r) => r.srcdocMs).toFixed(0)}ms · reopen ${sum((r) => r.reopenMs).toFixed(0)}ms` +
      ` · blob ${sum((r) => r.blobMs ?? 0).toFixed(0)}ms · json ${sum((r) => r.jsonMs).toFixed(0)}ms` +
      (WITH_CONTROL
        ? ` · no-assets ${sum((r) => r.controlMs ?? 0).toFixed(0)}ms` +
          ` (refs stripped: ${sum((r) => r.controlRemoved ?? 0)})`
        : "")
  );
  return 0;
}

process.exit(await main());
