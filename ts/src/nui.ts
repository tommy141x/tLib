declare global {
  interface Window {
    GetParentResourceName?: () => string;
  }
}

export function isNUI(): boolean {
  return typeof window.GetParentResourceName === "function";
}

export function getResourceName(fallback = "tLib"): string {
  return window.GetParentResourceName?.() ?? fallback;
}

// POSTs to the game's NUI callback endpoint, no-ops in dev
export async function fetchNui<T = unknown>(
  event: string,
  data: unknown = {},
  resource?: string
): Promise<T | null> {
  if (!isNUI()) {
    console.debug(`[NUI dev] fetchNui("${event}")`, data);
    return null;
  }
  try {
    const resp = await fetch(`https://${resource ?? getResourceName()}/${event}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const text = await resp.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

// matches FiveM SendNUIMessage formats:
//   { name: string, args: [payload] }  — cfx structured messages
//   { action: string, ... }            — tRadio/tELS flat messages (SendNuiMessage JSON)
//   { type: string, ... }              — destroyUI etc.
export function onNuiEvent<T = unknown>(action: string, handler: (data: T) => void): () => void {
  const listener = (event: MessageEvent) => {
    if (!event.data || typeof event.data !== "object") return;
    if (typeof event.data.type !== "string" && typeof event.data.name !== "string" && typeof event.data.action !== "string") return;
    const msg = event.data;
    if (!msg) return;
    if (msg.name === action) {
      handler((msg.args?.[0] ?? msg) as T);
    } else if (msg.action === action) {
      handler((msg.data ?? msg) as T);
    } else if (msg.type === action) {
      handler(msg as T);
    }
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

export function onAnyNuiEvent(handler: (action: string, data: unknown) => void): () => void {
  const listener = (event: MessageEvent) => {
    if (!event.data || typeof event.data !== "object") return;
    if (typeof event.data.type !== "string" && typeof event.data.name !== "string" && typeof event.data.action !== "string") return;
    const msg = event.data;
    if (!msg) return;
    if (msg.name) {
      handler(msg.name, msg.args?.[0] ?? msg);
    } else if (msg.action) {
      handler(msg.action, msg.data ?? msg);
    } else if (msg.type) {
      handler(msg.type, msg);
    }
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

// pass your framework's onCleanup to auto-unsubscribe (keeps this file framework-agnostic)
export function createNuiEvent<T = unknown>(
  action: string,
  handler: (data: T) => void,
  onCleanup: (fn: () => void) => void
): void {
  onCleanup(onNuiEvent(action, handler));
}
