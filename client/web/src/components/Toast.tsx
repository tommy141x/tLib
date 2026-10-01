import { Toast as ArkToast, createToaster, Toaster } from "@ark-ui/solid/toast";
import { CircleCheck, CircleX, Info, LoaderCircle, TriangleAlert } from "lucide-solid";
import { createEffect, createSignal, type JSX, onCleanup, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { type Layout, layoutRect } from "@/layout/geometry";
import { onNuiEvent } from "@/lib/nui";
import {
  createToastLifetime,
  MAX_TOASTS,
  type ToastData,
  type ToastType,
} from "@/lib/toast-lifetime";
import { applyScopedTheme } from "@/stores/theme-store";
import "../../../../shared/ts/nui-kit/nui.css";

const ICONS = {
  success: CircleCheck,
  error: CircleX,
  warning: TriangleAlert,
  info: Info,
  loading: LoaderCircle,
};
const COLORS: Record<ToastType, string> = {
  success: "#63d69b",
  error: "#f08484",
  warning: "#edc46d",
  info: "#8cbcf3",
  loading: "#b8b8b4",
};

/** Noninteractive Lua/NUI notification host. This is not the optional web-app toast registry. */
export default function Toast() {
  const toaster = createToaster({
    placement: "top-end",
    overlap: false,
    gap: 8,
    max: MAX_TOASTS,
    duration: Infinity,
    removeDelay: 0,
    pauseOnPageIdle: false,
    // Zag 1.x uses hotkey.every(): [] matches EVERY key. One key event cannot
    // have both codes, so this disables its focus shortcut without intercepting input.
    hotkey: ["F23", "F24"],
  });
  const lifetime = createToastLifetime({
    upsert(data) {
      toaster.create({
        id: data.id,
        type: data.type,
        title: data.title,
        description: data.description ?? "",
        meta: { theme: data.theme },
        duration: Infinity,
        closable: false,
      });
    },
    remove: (id) => {
      toaster.remove(id);
    },
    clear: () => {
      toaster.remove();
    },
  });
  const [placement, setPlacement] = createSignal<{
    layout: Layout;
    width: number;
    height: number;
  }>();
  const [viewport, setViewport] = createSignal({ width: innerWidth, height: innerHeight });
  const resized = () => setViewport({ width: innerWidth, height: innerHeight });
  window.addEventListener("resize", resized);
  const listeners = [
    onNuiEvent<ToastData>("showToast", (data) => lifetime.show(data)),
    onNuiEvent<{ id: string; changes: Partial<ToastData> }>("updateToast", (data) =>
      lifetime.update(data.id, data.changes)
    ),
    onNuiEvent<{ id: string }>("dismissToast", (data) => lifetime.remove(data.id)),
    onNuiEvent("dismissAllToasts", () => lifetime.clear()),
    onNuiEvent<{ layout: Layout; width: number; height: number }>("toastLayout", setPlacement),
  ];
  onCleanup(() => {
    for (const unsubscribe of listeners) unsubscribe();
    window.removeEventListener("resize", resized);
    lifetime.stop();
  });

  const placementStyle = (): JSX.CSSProperties => {
    const style: JSX.CSSProperties = {
      position: "fixed",
      top: "16px",
      right: "16px",
      bottom: "auto",
      left: "auto",
      width: "min(380px, calc(100vw - 32px))",
      height: "auto",
      padding: "0",
      display: "flex",
      "flex-direction": "column-reverse",
      gap: "8px",
      "justify-content": "flex-end",
      "pointer-events": "none",
      "z-index": 99999,
      transform: "none",
      "max-height": "none",
    };
    const data = placement();
    if (!data) return style;
    const rect = layoutRect(data, data.layout, viewport());
    return {
      ...style,
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      right: "auto",
      width: `${data.width}px`,
      height: `${data.height}px`,
      "transform-origin": "top left",
      transform: `scale(${(viewport().height / 1080) * data.layout.scale})`,
      // Ark returns newest first; reverse flow preserves the existing oldest-first stack.
      "justify-content": data.layout.anchor.startsWith("bottom") ? "flex-start" : "flex-end",
    };
  };

  return (
    <Toaster
      toaster={toaster}
      class="tlib-nui-toasts"
      style={placementStyle()}
      aria-label="Notifications"
      tabIndex={-1}
    >
      {(toast) => (
        <ArkToast.Root
          ref={(el) => createEffect(() => applyScopedTheme(toast().meta?.theme, el))}
          data-toast-id={toast().id}
          tabIndex={-1}
          class="tlib-nui-surface tlib-nui-toast flex shrink-0 items-start gap-3 rounded-xl border border-[var(--nui-border)] bg-[var(--nui-surface)] px-4 py-3 text-[var(--nui-text)]"
          style={{
            position: "relative",
            inset: "auto",
            width: "100%",
            height: "auto",
            "pointer-events": "none",
            "box-shadow": "none",
            "backdrop-filter": "none",
            translate: "none",
            transform: "none",
            opacity: 1,
            "font-family": 'var(--font-sans, Inter, "Segoe UI", Arial, sans-serif)',
          }}
        >
          <span
            aria-hidden="true"
            class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center"
            style={{
              color: `var(--toast-${toast().type}, ${COLORS[toast().type as ToastType] ?? COLORS.info})`,
            }}
          >
            <Dynamic
              component={ICONS[toast().type as ToastType] ?? Info}
              size={18}
              class={toast().type === "loading" ? "animate-spin" : ""}
            />
          </span>
          <div class="min-w-0 flex-1">
            <ArkToast.Title class="break-words text-sm font-semibold leading-5">
              {toast().title}
            </ArkToast.Title>
            <Show when={toast().description}>
              <ArkToast.Description class="mt-1 break-words text-xs leading-5 text-[var(--nui-muted)]">
                {toast().description}
              </ArkToast.Description>
            </Show>
          </div>
        </ArkToast.Root>
      )}
    </Toaster>
  );
}
