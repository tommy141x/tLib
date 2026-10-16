/**
 * Launches the Chromium every NUI tool in this stack drives, and attaches CDP to a page.
 *
 * ## Why this is in tLib rather than in tRadio's harness
 *
 * It was `tRadio/scripts/nui-harness/browser.ts` for as long as tRadio was the only
 * resource driving a real NUI bundle in a browser. The shared prop editor changed that:
 * `prop-editor-gallery.ts` beside this file photographs the SAME component out of
 * tRadio's, tRadar's and tDetector's bundles, and a launcher living inside one of the
 * three would have made tLib depend on a consumer. There is still exactly one copy —
 * tRadio's harness imports this one.
 *
 * ## Why a downloaded Chromium 103 and not the system browser
 *
 * FiveM's NUI is CEF, and the CEF shipped by cfx is:
 *
 *     FiveM.app/bin/libcef.dll -> 103.0.0-cfx-m103.2605+g1316dae+chromium-103.0.5060.141
 *
 * i.e. **Chromium 103** (June 2022). Blink's Web Audio implementation — node lifetime,
 * garbage collection of disconnected nodes, AudioParam timeline pruning, AudioWorklet —
 * has changed materially since. Measuring against a current Chrome/Edge (152 on this
 * machine) answers a question about a different engine than the one customers run.
 *
 * Chromium snapshot 1002410 is 103.0.5058.0, two patch builds from cfx's 103.0.5060.141.
 * That is the closest available double short of driving the game itself.
 *
 * ## Autonomy
 *
 * Every flag below exists so an agent can run this unattended: no first-run dialogs, no
 * profile prompts, no permission prompts, no user gesture required to start audio, and a
 * fake media device so the microphone path can be exercised without hardware. The browser
 * is headless and its user-data-dir is a throwaway.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDP, Page } from "./nui-cdp.ts";

export const CHROMIUM_REVISION = "1002410"; // 103.0.5058.0
const SNAPSHOT_URL = `https://commondatastorage.googleapis.com/chromium-browser-snapshots/Win_x64/${CHROMIUM_REVISION}/chrome-win.zip`;

/** Where the harness caches its browser. Outside the repo — it is 500 MB unpacked. */
export function browserDir(): string {
  return path.join(os.tmpdir(), "tradio-nui-harness", `chromium-${CHROMIUM_REVISION}`);
}

export function browserExe(): string {
  return path.join(browserDir(), "chrome-win", "chrome.exe");
}

/** Downloads + unpacks Chromium 103 if it is not already cached. Idempotent. */
export async function ensureBrowser(log = console.log): Promise<string> {
  const exe = browserExe();
  if (fs.existsSync(exe)) return exe;

  const dir = browserDir();
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, "chrome-win.zip");

  log(`[browser] downloading Chromium ${CHROMIUM_REVISION} (~190 MB, one time)...`);
  const res = await fetch(SNAPSHOT_URL);
  if (!res.ok) throw new Error(`chromium download failed: HTTP ${res.status}`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));

  log("[browser] unpacking...");
  // PowerShell's Expand-Archive is always present on Windows; no unzip dependency.
  const unzip = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`,
    ],
    { stdio: "ignore" }
  );
  await new Promise<void>((resolve, reject) => {
    unzip.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`unzip exit ${code}`))));
    unzip.on("error", reject);
  });
  fs.rmSync(zip, { force: true });

  if (!fs.existsSync(exe)) throw new Error(`chromium missing after unpack: ${exe}`);
  log(`[browser] ready: ${exe}`);
  return exe;
}

export interface LaunchedBrowser {
  proc: ChildProcess;
  cdp: CDP;
  page: Page;
  browserPid: number;
  userDataDir: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  headless?: boolean;
  /** Extra flags, e.g. fault-injection or feature toggles. */
  args?: string[];
  log?: (msg: string) => void;
}

export async function launch(opts: LaunchOptions = {}): Promise<LaunchedBrowser> {
  const log = opts.log ?? console.log;
  const exe = await ensureBrowser(log);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tradio-nui-profile-"));

  const args = [
    // Old-style headless — `--headless=new` did not land until ~109, and this build is 103.
    ...(opts.headless === false ? [] : ["--headless"]),
    "--remote-debugging-port=0", // real port lands in DevToolsActivePort
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    // The measurement depends on renderer RSS being attributable to ONE process.
    "--renderer-process-limit=1",
    // Audio must start without a click; there is nobody at the keyboard.
    "--autoplay-policy=no-user-gesture-required",
    // Silence the OUTPUT device. Without this the harness plays tRadio's real tones and
    // voice through the machine's speakers — which is exactly what happened the first
    // time it ran unattended. Chrome implements this by muting the output stream, not by
    // disabling the graph: AudioContext, node processing, buffer allocation and parameter
    // automation all still run, so the numbers this harness measures should be unaffected
    // — `bun scripts/nui-harness/verify-mute.ts` measures a muted and an unmuted run and
    // fails if they diverge, so this is a checked assumption rather than a believed one.
    ...(opts.args?.includes("--no-mute-audio-marker") ? [] : ["--mute-audio"]),
    // getUserMedia without hardware and without a permission prompt.
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    // In-page forced GC, so retained-vs-garbage is separable exactly as Bun.gc(true)
    // does for the node harness. Without this every heap number is an upper bound.
    "--js-flags=--expose-gc",
    "--disable-features=CalculateNativeWinOcclusion",
    ...(opts.args ?? []).filter((a) => a !== "--no-mute-audio-marker"),
    "about:blank",
  ];

  const proc = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
  proc.stderr?.on("data", (b: Buffer) => {
    const s = b.toString();
    if (/ERROR|FATAL/.test(s) && !/Fontconfig|GPU|gpu_|dbus|Failed to read/.test(s)) {
      log(`[chromium] ${s.trim().slice(0, 300)}`);
    }
  });

  const portFile = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + 30_000;
  let wsPath = "";
  let port = 0;
  while (Date.now() < deadline) {
    // The read is inside the try, not guarded by existsSync, because the two together are a
    // race rather than a check: Chromium creates DevToolsActivePort and then writes it, and on
    // Windows opening it in that window throws EBUSY. Existing behaviour let that escape the
    // loop and kill the run outright — intermittently, roughly one launch in ten, across every
    // gallery and thumb script that uses this. A failed read just means "not ready", which is
    // what the next poll is for; the 30s deadline below is still the thing that gives up.
    try {
      const [p, w] = fs.readFileSync(portFile, "utf8").split("\n");
      if (p && w) {
        port = Number(p);
        wsPath = w.trim();
        break;
      }
    } catch {
      // not written yet, or being written right now
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!port) {
    proc.kill();
    throw new Error("chromium never reported a DevTools port");
  }

  const cdp = await CDP.connect(`ws://127.0.0.1:${port}${wsPath}`);

  // Attach to the about:blank tab that launched with the browser.
  const { targetInfos } = await cdp.send<{
    targetInfos: Array<{ targetId: string; type: string }>;
  }>("Target.getTargets");
  const pageTarget = targetInfos.find((t) => t.type === "page");
  if (!pageTarget) throw new Error("no page target");
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId: pageTarget.targetId,
    flatten: true,
  });
  const page = new Page(cdp, sessionId, pageTarget.targetId);
  await page.send("Runtime.enable");

  return {
    proc,
    cdp,
    page,
    browserPid: proc.pid ?? 0,
    userDataDir,
    async close() {
      cdp.close();
      proc.kill();
      await new Promise((r) => setTimeout(r, 300));
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // Chromium can still hold a lock briefly; a stale temp profile is harmless.
      }
    },
  };
}
