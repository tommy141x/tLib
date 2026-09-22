export type ToastType = "success" | "error" | "warning" | "info" | "loading";

export interface ToastData {
  id: string;
  type: ToastType;
  title: string;
  description?: string;
  duration?: number;
  theme?: string;
}

export const TOAST_DURATIONS: Record<ToastType, number> = {
  success: 4000,
  error: 6000,
  warning: 5000,
  info: 4000,
  loading: 0,
};
export const MAX_TOASTS = 256; // Same total bound as client/lib/toast/exports.lua; no hidden Ark queue.

export interface ToastSink {
  upsert(data: ToastData): void;
  remove(id: string): void;
  clear(): void;
}
export interface ToastClock {
  set(callback: () => void, delay: number): unknown;
  clear(handle: unknown): void;
}

/**
 * The wire contract, not Ark's defaults, owns browser deadlines. In particular,
 * duration=0 means the type default; loading may have an explicit finite duration;
 * and repeating the SAME type/duration still restarts its deadline. Ark is always
 * fed Infinity and removed explicitly, so there is only one browser expiry clock.
 * Lua's owner/stop cleanup remains authoritative and can remove a toast sooner.
 */
export function createToastLifetime(
  sink: ToastSink,
  clock: ToastClock = {
    set: (callback, delay) => setTimeout(callback, delay),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
) {
  const entries = new Map<string, { data: ToastData; timer?: unknown; revision: number }>();
  let stopped = false;
  const validDuration = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2147483647;
  const validType = (value: unknown): value is ToastType =>
    typeof value === "string" && Object.hasOwn(TOAST_DURATIONS, value);
  function clearTimer(entry: { timer?: unknown; revision: number }) {
    if (entry.timer !== undefined) clock.clear(entry.timer);
    entry.timer = undefined;
    entry.revision++;
  }
  function remove(id: string) {
    const entry = entries.get(id);
    if (!entry) return;
    clearTimer(entry);
    entries.delete(id);
    sink.remove(id);
  }
  function schedule(
    id: string,
    entry: { data: ToastData; timer?: unknown; revision: number },
    duration?: number
  ) {
    clearTimer(entry);
    const delay = duration && duration > 0 ? duration : TOAST_DURATIONS[entry.data.type];
    if (!delay) return;
    const revision = entry.revision;
    entry.timer = clock.set(() => {
      if (entries.get(id) === entry && entry.revision === revision) remove(id);
    }, delay);
  }
  function show(data: ToastData) {
    if (stopped || !data || typeof data.id !== "string" || !data.id) return;
    if (!entries.has(data.id) && entries.size >= MAX_TOASTS) return;
    const previous = entries.get(data.id);
    if (previous) {
      clearTimer(previous);
      sink.remove(data.id); // A fresh show replaces/moves to the newest slot; patches stay put.
    }
    const entry = {
      data: {
        ...data,
        type: validType(data.type) ? data.type : ("info" as ToastType),
        title: typeof data.title === "string" ? data.title : "",
        duration: validDuration(data.duration) ? data.duration : undefined,
      },
      revision: 0,
    };
    entries.set(data.id, entry);
    sink.upsert(entry.data);
    schedule(data.id, entry, entry.data.duration);
  }
  function update(id: string, changes: Partial<ToastData>) {
    const entry = entries.get(id);
    if (stopped || !entry || !changes || typeof changes !== "object") return;
    const patch: Partial<ToastData> = {};
    if (validType(changes.type)) patch.type = changes.type;
    if (validDuration(changes.duration)) patch.duration = changes.duration;
    for (const key of ["title", "description", "theme"] as const) {
      if (typeof changes[key] === "string") patch[key] = changes[key];
    }
    if (!Object.keys(patch).length) return;
    entry.data = { ...entry.data, ...patch, id };
    // Previous explicit durations must not leak into a type-only update.
    if (patch.type !== undefined && patch.duration === undefined) entry.data.duration = undefined;
    sink.upsert(entry.data);
    if (patch.type !== undefined || patch.duration !== undefined)
      schedule(id, entry, patch.duration);
  }
  function clear() {
    for (const entry of entries.values()) clearTimer(entry);
    entries.clear();
    sink.clear();
  }
  return {
    show,
    update,
    remove,
    clear,
    stop() {
      stopped = true;
      clear();
    },
    get size() {
      return entries.size;
    },
  };
}
