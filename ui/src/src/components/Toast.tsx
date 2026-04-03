import { createSignal, For, Show } from "solid-js";
import { onNuiEvent } from "@/lib/nui";

interface ToastData {
	id: string;
	type: "success" | "error" | "warning" | "info" | "loading";
	title: string;
	description?: string;
	duration?: number;
}

const DURATIONS: Record<string, number> = {
	success: 4000, error: 6000, warning: 5000, info: 4000, loading: 0,
};

const ICONS: Record<string, string> = {
	success: "✓", error: "✕", warning: "⚠", info: "ℹ", loading: "⟳",
};

const COLORS: Record<string, string> = {
	success: "hsl(142 70% 45%)",
	error: "hsl(0 62% 50%)",
	warning: "hsl(38 92% 50%)",
	info: "hsl(211 80% 55%)",
	loading: "hsl(211 80% 55%)",
};

export default function Toast() {
	const [toasts, setToasts] = createSignal<ToastData[]>([]);

	function dismiss(id: string) {
		setToasts((prev) => prev.filter((t) => t.id !== id));
	}

	onNuiEvent<ToastData>("showToast", (data) => {
		setToasts((prev) => [...prev, data]);
		const dur = data.duration ?? DURATIONS[data.type] ?? 4000;
		if (dur > 0) setTimeout(() => dismiss(data.id), dur);
	});

	onNuiEvent<{ id: string; changes: Partial<ToastData> }>("updateToast", ({ id, changes }) => {
		setToasts((prev) => prev.map((t) => t.id === id ? { ...t, ...changes } : t));
		if (changes.duration && changes.duration > 0) {
			setTimeout(() => dismiss(id), changes.duration);
		}
	});

	onNuiEvent<{ id: string }>("dismissToast", ({ id }) => dismiss(id));
	onNuiEvent("dismissAllToasts", () => setToasts([]));

	return (
		<div class="fixed top-4 right-4 flex flex-col gap-2 z-[99999] pointer-events-none" style={{ "min-width": "280px", "max-width": "380px" }}>
			<For each={toasts()}>
				{(toast) => (
					<div
						class="pointer-events-auto rounded-lg border border-border/60 px-4 py-3 flex gap-3 items-start shadow-lg"
						style={{
							background: "hsl(var(--card) / 0.95)",
							"backdrop-filter": "blur(16px)",
						}}
					>
						<span
							class="text-sm font-bold flex-shrink-0 mt-0.5"
							classList={{ "animate-spin": toast.type === "loading" }}
							style={{ color: COLORS[toast.type] }}
						>
							{ICONS[toast.type]}
						</span>
						<div class="flex-1 min-w-0">
							<p class="text-sm font-medium text-foreground">{toast.title}</p>
							<Show when={toast.description}>
								<p class="text-xs text-muted-foreground mt-0.5">{toast.description}</p>
							</Show>
						</div>
					</div>
				)}
			</For>
		</div>
	);
}
