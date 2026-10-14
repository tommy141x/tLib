import { normalizeSnapshot, parseMessage, snapshotError } from "./protocol";
import type { NuiMessage, NuiResult } from "./types";

declare global {
  interface Window {
    GetParentResourceName?: () => string;
  }
}

export const inGame = typeof window.GetParentResourceName === "function";
export const preview = import.meta.env.DEV && !inGame;

export async function request(
  event:
    | "ready"
    | "resync"
    | "close"
    | "action"
    | "input"
    | "navigate"
    | "highlight"
    | "selftest"
    | "sound"
    // The shared feedback dialog. Not an "action": it addresses no row on any
    // page, so it carries no menuId and nothing validates it against one.
    | "feedback",
  data: unknown = {}
): Promise<NuiResult> {
  if (preview) return (await import("./preview")).previewRequest(event, data);
  if (!inGame) return { ok: false, error: "Open the Vite development server for browser preview." };
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), event === "action" ? 91000 : 12000);
  try {
    const response = await fetch(`https://${window.GetParentResourceName!()}/menu_${event}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(data),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`NUI request failed (${response.status}).`);
    const result: unknown = await response.json();
    if (
      typeof result !== "object" ||
      result === null ||
      !("ok" in result) ||
      typeof result.ok !== "boolean"
    ) {
      throw new Error("Invalid runtime response.");
    }
    const payload = result as NuiResult;
    const snapshot =
      payload.snapshot === undefined ? undefined : normalizeSnapshot(payload.snapshot);
    if (payload.snapshot !== undefined && !snapshot)
      throw new Error(snapshotError(payload.snapshot));
    const delta =
      payload.menus === undefined
        ? undefined
        : normalizeSnapshot({ version: 1, visible: false, menus: payload.menus });
    if (payload.menus !== undefined && !delta)
      throw new Error(snapshotError({ menus: payload.menus }));
    return {
      ok: payload.ok,
      nextMenu:
        typeof payload.nextMenu === "string" && payload.nextMenu.length <= 128
          ? payload.nextMenu
          : undefined,
      error: typeof payload.error === "string" ? payload.error : undefined,
      snapshot,
      menus: delta?.menus,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof DOMException && error.name === "AbortError"
          ? "The game did not respond in time. Check the action before retrying."
          : error instanceof Error
            ? error.message
            : "Unable to reach the game.",
    };
  } finally {
    window.clearTimeout(timer);
  }
}

// Cosmetic one-shots: they must not occupy the request path's timeout, abort and
// response handling, and a dropped one is never worth reporting to the player.
export function post(event: "sound", data: unknown) {
  if (!inGame) return;
  void fetch(`https://${window.GetParentResourceName!()}/menu_${event}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(data),
  }).catch(() => undefined);
}

export function listen(
  handler: (message: NuiMessage) => void,
  onRejected?: (reason: string) => void
) {
  const receive = (event: MessageEvent<unknown>) => {
    // FiveM posts from the native host. Browser preview accepts only its own window.
    if (!inGame && (event.source !== window || event.origin !== window.location.origin)) return;
    const wire = event.data as { name?: unknown; args?: unknown } | null;
    if (typeof wire?.name !== "string" || !wire.name.startsWith("menu:")) return;
    const data = { action: wire.name, data: Array.isArray(wire.args) ? wire.args[0] : undefined };
    const message = parseMessage(data);
    if (message) {
      handler(message);
      return;
    }
    // Dropping a malformed push silently leaves the page stale, and a stale
    // contextKey makes every later navigation fail. Report it so we can resync.
    const action = data.action;
    if (action === "menu:snapshot") onRejected?.(snapshotError(data!.data));
    else if (action === "menu:menu") onRejected?.(snapshotError({ menus: [data!.data] }));
  };
  window.addEventListener("message", receive);
  return () => window.removeEventListener("message", receive);
}
