import { fetchNui } from "@/lib/nui";
import type { Layout, Viewport } from "./geometry";

type Status = "pending" | "ok" | "failed";

/**
 * Draft placements on their way to Lua. Coalesced to one message per key per
 * frame, fenced by a per-key revision so a slow reply cannot overwrite a newer
 * one, and holding every in-flight request so Finish can wait for them.
 *
 * Owns no Solid state: the editor decides what a failure means to the user.
 */
export class PreviewChannel {
  private queued = new Map<string, Layout>();
  private inFlight = new Set<Promise<unknown>>();
  private sent = new Map<string, { revision: number; status: Status }>();
  private frame = 0;
  private revision = 0;
  private session: number | null = null;

  constructor(
    private readonly viewport: () => Viewport,
    private readonly onFailure: () => void
  ) {}

  open(session: number) {
    this.reset();
    this.session = session;
  }
  reset() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.queued.clear();
    this.inFlight.clear();
    this.sent.clear();
    this.revision = 0;
    this.session = null;
  }
  /** Stop sending, but keep what has already been sent: Discard needs no results. */
  cancel() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.queued.clear();
  }
  drop(key: string) {
    this.queued.delete(key);
    this.sent.delete(key);
  }
  queue(key: string, layout: Layout) {
    if (this.session === null) return;
    this.queued.set(key, layout);
    if (!this.frame) this.frame = requestAnimationFrame(() => this.flush());
  }
  /** A retry of Finish re-sends whatever the game refused the first time. */
  retryFailed(layouts: (key: string) => Layout | undefined) {
    for (const [key, preview] of this.sent) {
      const layout = preview.status === "failed" ? layouts(key) : undefined;
      if (layout) this.queued.set(key, layout);
    }
  }
  flush() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    const token = this.session;
    if (token === null) {
      this.queued.clear();
      return;
    }
    for (const [key, layout] of this.queued) {
      const revision = ++this.revision;
      this.sent.set(key, { revision, status: "pending" });
      const request = fetchNui<{ ok: boolean }>("layoutPreview", {
        session: token,
        key,
        layout,
        revision,
        viewport: this.viewport(),
      }).then((response) => {
        if (this.session !== token || this.sent.get(key)?.revision !== revision) return;
        const ok = response?.ok === true;
        this.sent.set(key, { revision, status: ok ? "ok" : "failed" });
        if (!ok) this.onFailure();
      });
      this.inFlight.add(request);
      void request.finally(() => this.inFlight.delete(request));
    }
    this.queued.clear();
  }
  settle() {
    return Promise.all([...this.inFlight]);
  }
  get allApplied() {
    return [...this.sent.values()].every((preview) => preview.status === "ok");
  }
}
