/**
 * Telemetry module entry. One call from `server/main.ts`.
 *
 * Installs EAGERLY: the exports must exist before any consumer's Lua runs, and a
 * consumer's `onResourceStart` can beat tLib's own. Every export body is
 * wrapped, because an export that throws returns `undefined` and the real error
 * resurfaces elsewhere as `"undefined" is not valid JSON`.
 * Design notes: docs/internal/telemetry-wire-contract.md.
 */

import { DIMENSION_CAPS, slug, versionSlug } from "../../../shared/ts/telemetry/payload";
import { installId } from "../install-id";
import { resolve, setStoredSwitch, TELEMETRY_CONVAR } from "./consent";
import { fExports, fGetCurrentResourceName, fOn } from "./fivem";
import { createStore } from "./store";
import { createTransport } from "./transport";

let installed = false;

/**
 * Fold a batch's context into every event's dimensions. Done here, not by the
 * sender: these are the dimensions a dashboard filters on, so a sender that
 * omits one makes every figure undercount -- and there are twelve senders. The
 * context is client-supplied and is slugged on arrival rather than trusted.
 */
export function stampContext(events: unknown, context: unknown): unknown[] {
  if (!Array.isArray(events)) return [];
  const c = (context ?? {}) as Record<string, unknown>;
  const common: Record<string, string> = {};
  // `surface`, not `senderKind`: `senderKind` is which process POSTed and is
  // always this one, while `surface` is where the fault happened. Collapsing
  // them makes every client-side fault read as a server fault. There is no
  // `tlibVersion`: tWeb's taxonomy declares no slot for one.
  for (const key of ["resource", "resourceVersion", "surface"] as const) {
    const value =
      key === "resourceVersion"
        ? versionSlug(c[key])
        : slug(c[key], key === "surface" ? 8 : DIMENSION_CAPS.resource);
    if (value) common[key] = value;
  }
  return events.map((event) => {
    const e = (event ?? {}) as Record<string, unknown>;
    return {
      ...e,
      // `common` spread LAST, so it WINS: an event that could overwrite these
      // would be a way to attribute a fault to the wrong product.
      dimensions: { ...(e.dimensions as Record<string, string> | undefined), ...common },
    };
  });
}

/**
 * The studio base URL. `shared/sh_api.lua` is the single definition and it is
 * Lua, in tLib's shared VM -- not reachable from this bundle, so
 * `sv_telemetry.lua` pushes the resolved value in rather than this file keeping
 * a second copy of the normalisation.
 */
let baseUrl = "https://timmygstudios.com";

export function installTelemetry(): void {
  if (installed) return;
  installed = true;

  const store = createStore();
  const transport = createTransport({
    store,
    baseUrl: () => baseUrl,
    enabled: () => resolve().enabled,
    installId: () => installId(),
    log: (line) => console.log(line),
  });
  transport.start();

  // And reaped. `start()` opens a 60s interval that nothing cancelled:
  // `stop()` was on the Transport interface and implemented, and had no caller
  // anywhere, so every tLib restart left the previous run's flush timer alive
  // in the same Node VM — holding a store and a breaker that no longer belong
  // to anything.
  fOn("onResourceStop", (resource: unknown) => {
    if (resource === fGetCurrentResourceName()) transport.stop();
  });

  // The disconnect sweep. Without it every per-client budget keeps one entry
  // per player who has ever connected, for the life of the server.
  fOn("playerDropped", () => {
    const src = Number((globalThis as { source?: unknown }).source ?? 0);
    if (Number.isFinite(src) && src > 0) store.forget(src);
  });

  /** Called by `sv_telemetry.lua` once `StudioApi.baseUrl()` is resolvable. */
  fExports("DiagSetBaseUrl", (url: unknown): boolean => {
    try {
      if (typeof url === "string" && /^https?:\/\//.test(url)) {
        baseUrl = url.replace(/\/+$/, "");
        return true;
      }
      return false;
    } catch {
      return false;
    }
  });

  /**
   * Accept one batch. `payload` is a JSON string, not a table: a Lua table
   * crossing into Node is converted member by member, and 64 event objects with
   * nested maps is a real cost on a path that runs every 15 s per player. It is
   * also one failure mode instead of a partially converted structure.
   */
  fExports("DiagIngest", (src: unknown, payload: unknown): string => {
    try {
      if (!resolve().enabled) return JSON.stringify({ ok: false, reason: "disabled" });
      if (typeof payload !== "string" || payload === "") {
        return JSON.stringify({ ok: false, reason: "empty" });
      }
      const parsed: unknown = JSON.parse(payload);
      if (!parsed || typeof parsed !== "object") {
        return JSON.stringify({ ok: false, reason: "not-an-object" });
      }
      const batch = parsed as { events?: unknown; context?: unknown; dropped?: unknown };
      // The SENDER's own ring losses, said out loud: the taxonomy has no
      // measure slot for them, so the console is where a gap becomes visible.
      if (typeof batch.dropped === "number" && batch.dropped > 0) {
        console.log(
          `[tLib] diagnostics: a client dropped ${batch.dropped} event(s) before sending — ` +
            "its own buffer was full, which means it was producing faults faster than it could report them."
        );
      }
      const source = Number(src);
      const result = store.accept(
        Number.isFinite(source) && source > 0 ? source : 0,
        stampContext(batch.events, batch.context) as never
      );
      return JSON.stringify({ ok: true, ...result });
    } catch (e) {
      return JSON.stringify({
        ok: false,
        reason: "threw",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  });

  /**
   * The consent answer, for the hub.
   *
   *   local c = json.decode(exports.tLib:DiagConsent())
   *   -- { enabled, source, locked, convarValue, convar }
   *
   * `locked` is what hides a switch. There is no `provisioned` field.
   */
  fExports("DiagConsent", (): string => {
    try {
      const c = resolve();
      return JSON.stringify({
        ...c,
        convar: TELEMETRY_CONVAR,
        queued: store.size(),
        transport: { eventsStopped: transport.state().events.permanentlyStopped },
      });
    } catch (e) {
      return JSON.stringify({
        enabled: false,
        source: "default",
        locked: false,
        convarValue: "",
        convar: TELEMETRY_CONVAR,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  /** The hub's switch. Refuses while the convar has decided. */
  fExports("DiagSetConsent", (enabled: unknown): string => {
    try {
      const result = setStoredSwitch(enabled === true);
      if (!result.ok) {
        return JSON.stringify({
          ok: false,
          reason: result.reason,
          detail: result.detail,
          consent: result.consent,
        });
      }
      // Turning it OFF discards what is queued: the alternative is a batch
      // collected while consent was on being sent after it was turned off.
      if (!result.consent.enabled) store.clear();
      return JSON.stringify({ ok: true, consent: result.consent });
    } catch (e) {
      return JSON.stringify({
        ok: false,
        reason: "threw",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  });

  /** Flush now. For a `_diag`-style command and for a suite. */
  fExports("DiagFlushNow", (): string => {
    try {
      return JSON.stringify(transport.flush());
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
