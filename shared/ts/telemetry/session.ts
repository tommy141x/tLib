/**
 * The session ledger: how a renderer that was KILLED reports its own death.
 *
 * A clean shutdown can set a flag; a renderer kill cannot. So the ABSENCE of a
 * clean-exit marker on the next boot is the crash, observed directly. Lua is the
 * only side that learns about a `restart`, so until it says so the verdict is
 * deferred rather than guessed.
 * Design notes: docs/internal/telemetry-wire-contract.md.
 */

export interface ResourceSample {
  /** Seconds since session start, so a trajectory is readable without timestamps. */
  t: number;
  /** `-1` when `performance.memory` is absent, never `undefined`. */
  heapMB: number;
  heapLimitMB: number;
  domNodes: number;
  /** Milliseconds the sampling timer overran its interval. */
  driftMs: number;
  /** Whatever the host adds. Flat numbers only — this is written every heartbeat. */
  extra: Record<string, number>;
}

interface SessionRecord {
  /** Monotonic count of boots on this machine. */
  n: number;
  startedAt: number;
  /** Set on beforeunload. Absent/false on the next boot means the page died. */
  clean?: boolean;
  lastUptimeMs?: number;
  lastState?: Record<string, number | boolean | string>;
  trend?: ResourceSample[];
}

/** The facts about a session that did not close cleanly. */
export interface CrashReport {
  /** The dead session's number, so a run of them is visible as a run. */
  session: number;
  uptimeMs: number;
  /** `true` when Lua confirmed an orderly resource stop — i.e. NOT a crash. */
  orderly: boolean;
  /** One of `DIAG_CRASH_VERDICTS`. */
  verdict: CrashVerdict;
  /** Human-readable notes behind the verdict, for the detail record. */
  notes: string[];
  lastState?: Record<string, number | boolean | string>;
  trend: ResourceSample[];
}

export type CrashVerdict =
  | "heap-near-limit"
  | "heap-growth"
  | "main-thread-block"
  | "dom-growth"
  | "inconclusive"
  | "no-samples";

export interface SessionLogOptions {
  /** Storage namespace and console prefix. The resource's own name, lowercased. */
  namespace: string;
  /** How often to write a heartbeat. Defaults to 30 s. */
  heartbeatMs?: number;
  /** The host's live counters, carried across the boundary. */
  state?: () => Record<string, unknown> | null;
  /** Extra numeric samples to fold into the trajectory. */
  extraSample?: () => Record<string, number>;
  /** Host-specific readings of a trajectory, appended to the generic notes. */
  extraNotes?: (samples: ResourceSample[]) => string[];
  /**
   * Called ONCE, at boot, when the previous session left no clean marker and
   * Lua did not claim an orderly stop. Deferred by `graceMs`.
   */
  onCrash?: (report: CrashReport) => void;
  /** Called at boot regardless, so the host can print its own banner. */
  onBanner?: (line: string) => void;
  graceMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 30_000;

/** ~15 minutes of history at the default heartbeat. Enough to show a slope. */
const TREND_KEEP = 30;

/** See the header: it has to outlast the host's init handshake. */
const DEFAULT_GRACE_MS = 15_000;

function human(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const mb = (bytes: number | undefined): number =>
  typeof bytes === "number" && Number.isFinite(bytes) ? Math.round(bytes / 1048576) : -1;

interface MemoryInfo {
  usedJSHeapSize?: number;
  jsHeapSizeLimit?: number;
}

function memory(): MemoryInfo {
  try {
    return ((performance as unknown as { memory?: MemoryInfo }).memory ?? {}) as MemoryInfo;
  } catch {
    return {};
  }
}

/**
 * The three samples that decide WHY a NUI died, regardless of what it was doing.
 */
export function sampleResources(
  elapsedMs: number,
  driftMs: number,
  extra: Record<string, number> = {}
): ResourceSample {
  const m = memory();
  let domNodes = -1;
  try {
    domNodes = document.getElementsByTagName("*").length;
  } catch {
    /* no document — leave -1 */
  }
  return {
    t: Math.round(elapsedMs / 1000),
    heapMB: mb(m.usedJSHeapSize),
    heapLimitMB: mb(m.jsHeapSizeLimit),
    domNodes,
    driftMs: Math.max(0, Math.round(driftMs)),
    extra,
  };
}

/** One compact line per sample — read by a human out of a chat paste. */
export function formatSample(s: ResourceSample): string {
  const extra = Object.entries(s.extra)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return (
    `t=${s.t}s heap=${s.heapMB}/${s.heapLimitMB}MB dom=${s.domNodes} drift=${s.driftMs}ms` +
    (extra ? ` ${extra}` : "")
  );
}

/**
 * Read a trajectory and say what it means.
 */
export function readTrend(samples: ResourceSample[]): { verdict: CrashVerdict; notes: string[] } {
  if (samples.length === 0) return { verdict: "no-samples", notes: [] };
  if (samples.length < 3) {
    return {
      verdict: "inconclusive",
      notes: [`only ${samples.length} samples — a slope needs ~90s of session`],
    };
  }
  const first = samples[0] as ResourceSample;
  const last = samples[samples.length - 1] as ResourceSample;
  const notes: string[] = [];
  let verdict: CrashVerdict = "inconclusive";

  // Ordered by how conclusive each shape is, and the FIRST match wins the enum
  // while every match contributes a note. A heap at the limit is a renderer OOM
  if (last.heapMB > 0 && last.heapLimitMB > 0 && (last.heapMB / last.heapLimitMB) * 100 > 85) {
    verdict = "heap-near-limit";
    notes.push(`heap near limit (${last.heapMB}/${last.heapLimitMB}MB) — a renderer OOM`);
  }

  const worstDrift = Math.max(...samples.map((s) => s.driftMs));
  if (worstDrift > 5000) {
    if (verdict === "inconclusive") verdict = "main-thread-block";
    notes.push(`main thread blocked for ${(worstDrift / 1000).toFixed(1)}s — a UI freeze`);
  }

  if (last.heapMB > 0 && first.heapMB > 0 && last.heapMB - first.heapMB > 100) {
    if (verdict === "inconclusive") verdict = "heap-growth";
    notes.push(
      `heap grew ${last.heapMB - first.heapMB}MB over ${last.t - first.t}s — something is leaking`
    );
  }

  if (last.domNodes > 0 && first.domNodes > 0 && last.domNodes - first.domNodes > 2000) {
    if (verdict === "inconclusive") verdict = "dom-growth";
    notes.push(`DOM grew by ${last.domNodes - first.domNodes} nodes — a UI leak`);
  }

  return { verdict, notes };
}

export interface SessionHandle {
  /**
   * Lua's answer to "was the last teardown an orderly resource stop?".
   *
   * A no-op once the verdict has been resolved, so a second init message — or a
   * late one after the grace window — cannot produce a duplicate or a
   * contradictory report.
   */
  noteOrderlyStop(orderly: boolean): void;
  info(): { n: number; uptimeMs: number; previousEndedCleanly: boolean };
  /** Stops the heartbeat. Tests, and a host that tears its page down itself. */
  stop(): void;
}

export function startSessionLog(opts: SessionLogOptions): SessionHandle {
  const key = `${opts.namespace}.session`;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const banner = opts.onBanner ?? (() => {});

  /** Every localStorage access is wrapped: a diagnostic must never break boot. */
  const read = (): SessionRecord | null => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as SessionRecord) : null;
    } catch {
      return null;
    }
  };
  const write = (rec: SessionRecord): void => {
    try {
      localStorage.setItem(key, JSON.stringify(rec));
    } catch {
      /* storage unavailable — the banner still prints, just without history */
    }
  };

  const snapshot = (): Record<string, number | boolean | string> | undefined => {
    const live = opts.state?.();
    if (!live) return undefined;
    const out: Record<string, number | boolean | string> = {};
    for (const [k, v] of Object.entries(live)) {
      if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const prev = read();
  const rec: SessionRecord = { n: (prev?.n ?? 0) + 1, startedAt: Date.now() };
  write(rec);
  banner(`session #${rec.n}`);

  let previousEndedCleanly = false;
  let pending: { timer: ReturnType<typeof setTimeout>; settle: (orderly: boolean) => void } | null =
    null;

  if (prev) {
    const settle = (orderly: boolean) => {
      previousEndedCleanly = orderly;
      const trend = prev.trend ?? [];
      const { verdict, notes } = readTrend(trend);
      const allNotes = [...notes, ...(opts.extraNotes?.(trend) ?? [])];

      banner(
        `previous session #${prev.n} ${
          orderly
            ? "ended cleanly (resource stop/restart)"
            : "^1ENDED UNEXPECTEDLY^7 (renderer killed / crashed)"
        } after ${human(prev.lastUptimeMs ?? 0)}`
      );
      if (prev.lastState) banner(`state at that point: ${JSON.stringify(prev.lastState)}`);
      // The trajectory, not just the final reading. A heap climbing toward the
      for (const s of trend) banner(`  ${formatSample(s)}`);
      if (allNotes.length > 0) banner(`^3verdict: ${verdict} — ${allNotes.join("; ")}^7`);

      // REPORTED ONLY WHEN IT WAS NOT ORDERLY. A `restart tRadio` is not a
      if (!orderly) {
        opts.onCrash?.({
          session: prev.n,
          uptimeMs: prev.lastUptimeMs ?? 0,
          orderly,
          verdict,
          notes: allNotes,
          lastState: prev.lastState,
          trend,
        });
      }
    };

    if (prev.clean) {
      // A real beforeunload ran — nothing to disambiguate, so do not make the
      // reader (or the report) wait for Lua.
      settle(true);
    } else {
      pending = {
        settle,
        timer: setTimeout(() => {
          pending = null;
          settle(false);
        }, graceMs),
      };
    }
  }

  let due = Date.now() + heartbeatMs;
  const beat = setInterval(() => {
    const now = Date.now();
    const drift = now - due;
    due = now + heartbeatMs;

    const cur = read();
    // Only extend OUR record. If another page wrote in between, leave it alone
    // rather than clobbering a newer session's row.
    if (!cur || cur.n !== rec.n) return;
    cur.lastUptimeMs = now - rec.startedAt;
    const snap = snapshot();
    if (snap) cur.lastState = snap;
    const trend = cur.trend ?? [];
    trend.push(sampleResources(now - rec.startedAt, drift, opts.extraSample?.() ?? {}));
    while (trend.length > TREND_KEEP) trend.shift();
    cur.trend = trend;
    write(cur);
  }, heartbeatMs);

  const onUnload = () => {
    clearInterval(beat);
    const cur = read();
    if (!cur || cur.n !== rec.n) return;
    cur.clean = true;
    cur.lastUptimeMs = Date.now() - rec.startedAt;
    const snap = snapshot();
    if (snap) cur.lastState = snap;
    write(cur);
  };
  try {
    window.addEventListener("beforeunload", onUnload);
  } catch {
    /* no window — the ledger still works, it just cannot mark a clean exit */
  }

  return {
    noteOrderlyStop(orderly: boolean) {
      const p = pending;
      if (!p) return;
      pending = null;
      clearTimeout(p.timer);
      p.settle(orderly);
    },
    /**
     * `previousEndedCleanly` is the VERDICT this function reached, not
     * `read().clean`. Reading the stored flag answers the wrong question: the
     * record on disk is the CURRENT session's, and its `clean` is only ever set
     * by beforeunload — so it is false for every live session and a report built
     * on it always claimed the previous page had crashed.
     */
    info() {
      const cur = read();
      return {
        n: cur?.n ?? 0,
        uptimeMs: cur ? Date.now() - cur.startedAt : 0,
        previousEndedCleanly,
      };
    },
    stop() {
      clearInterval(beat);
      if (pending) clearTimeout(pending.timer);
      pending = null;
      try {
        window.removeEventListener("beforeunload", onUnload);
      } catch {
        /* nothing to remove */
      }
    },
  };
}
