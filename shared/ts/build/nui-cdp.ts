/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Hand-rolled rather than puppeteer-core because the harness drives **Chromium 103**
 * (to match FiveM's CEF — see browser.ts), and modern puppeteer assumes CDP surface
 * that milestone does not have. Everything used here (Target/Page/Runtime/Performance)
 * has been stable since Chrome 60-ish, so there is no version risk to manage.
 */

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class CDP {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("CDP socket closed"));
      this.pending.clear();
    });
  }

  static async connect(url: string, timeoutMs = 20_000): Promise<CDP> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timeout: ${url}`)), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`CDP connect failed: ${url}`));
      });
    });
    return new CDP(ws);
  }

  private onMessage(raw: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message: string };
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }

    if (msg.method) {
      for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params ?? {});
    }
  }

  on(method: string, fn: (params: Record<string, unknown>) => void): void {
    const list = this.listeners.get(method) ?? [];
    list.push(fn);
    this.listeners.set(method, list);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CDP socket closed"));
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * A page target, with `evaluate` returning real values.
 *
 * `awaitPromise: true` + `returnByValue: true` means an async in-page function is awaited
 * browser-side and its resolved value comes back as JSON, so the harness never has to
 * poll for a result it wrote to a global.
 */
export class Page {
  constructor(
    readonly cdp: CDP,
    readonly sessionId: string,
    readonly targetId: string
  ) {}

  async send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId);
  }

  async evaluate<T = unknown>(fn: string, awaitPromise = true): Promise<T> {
    const res = await this.send<{
      result: { value?: T; description?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression: fn,
      awaitPromise,
      returnByValue: true,
      // Errors inside the page should surface as harness failures, not silent undefined.
      throwOnSideEffect: false,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`in-page exception: ${d.exception?.description ?? d.text}`);
    }
    return res.result.value as T;
  }

  async navigate(url: string): Promise<void> {
    await this.send("Page.enable");
    const loaded = new Promise<void>((resolve) => {
      const handler = (p: Record<string, unknown>) => {
        if (p.sessionId === this.sessionId || p.sessionId === undefined) resolve();
      };
      this.cdp.on("Page.loadEventFired", handler);
    });
    await this.send("Page.navigate", { url });
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 30_000))]);
  }

  /**
   * Install a script that runs before any page script on every navigation — this is how
   * the FiveM environment shim gets in ahead of the bundle's own module code.
   */
  async addInitScript(source: string): Promise<void> {
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source });
  }
}
