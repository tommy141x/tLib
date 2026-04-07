import { createSignal, For, Show } from "solid-js";
import { onNuiEvent, fetchNui } from "@/lib/nui";
import { applyScopedTheme } from "@/stores/theme-store";

interface MenuItem {
	id: string;
	type: "button" | "checkbox" | "list" | "slider" | "separator";
	label: string;
	description?: string;
	disabled?: boolean;
	rightLabel?: string;
	isSubmenu?: boolean;
	checked?: boolean;
	values?: string[];
	index?: number;
	min?: number;
	max?: number;
	value?: number;
	step?: number;
}

interface MenuData {
	id: string;
	title: string;
	subtitle?: string;
	items: MenuItem[];
	focusedIndex: number;
	canGoBack: boolean;
	position: string;
	size: string;
	banner?: string;
	theme?: string;
	itemHeight?: number;
}

const POS_CLASSES: Record<string, string> = {
	"top-left": "top-4 left-4",
	"top-center": "top-4 left-1/2 -translate-x-1/2",
	"top-right": "top-4 right-4",
	"center-left": "top-1/2 left-4 -translate-y-1/2",
	"center": "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
	"center-right": "top-1/2 right-4 -translate-y-1/2",
	"bottom-left": "bottom-4 left-4",
	"bottom-center": "bottom-4 left-1/2 -translate-x-1/2",
	"bottom-right": "bottom-4 right-4",
};

const SIZE_W: Record<string, string> = { sm: "240px", md: "320px", lg: "420px" };

export default function Menu() {
	const [menu, setMenu] = createSignal<MenuData | null>(null);
	const [visible, setVisible] = createSignal(false);
	let containerRef: HTMLDivElement | undefined;

	onNuiEvent<MenuData>("setMenu", (data) => {
		setMenu(data);
		if (containerRef && data.theme) applyScopedTheme(data.theme, containerRef);
	});
	onNuiEvent<boolean>("setVisible", setVisible);

	onNuiEvent<{ itemId: string; changes: Partial<MenuItem> }>("patchItem", ({ itemId, changes }) => {
		setMenu((prev) => {
			if (!prev) return prev;
			return {
				...prev,
				items: prev.items.map((it) => it.id === itemId ? { ...it, ...changes } : it),
			};
		});
	});

	onNuiEvent<{ changes: Partial<MenuData> }>("patchMenu", ({ changes }) => {
		setMenu((prev) => prev ? { ...prev, ...changes } : prev);
	});

	onNuiEvent<{ dir: string }>("navigate", ({ dir }) => {
		setMenu((prev) => {
			if (!prev) return prev;
			let idx = prev.focusedIndex;
			const len = prev.items.length;
			if (dir === "up") {
				do { idx = (idx - 1 + len) % len; } while (prev.items[idx]?.type === "separator" && idx !== prev.focusedIndex);
			} else {
				do { idx = (idx + 1) % len; } while (prev.items[idx]?.type === "separator" && idx !== prev.focusedIndex);
			}
			// Scroll focused item into view
			setTimeout(() => {
				document.querySelector(`[data-item-idx="${idx}"]`)?.scrollIntoView({ block: "nearest" });
			}, 0);
			return { ...prev, focusedIndex: idx };
		});
	});

	return (
		<Show when={visible() && menu()}>
			{(m) => (
				<div
					ref={containerRef}
					class={`fixed z-[9998] ${POS_CLASSES[m().position] ?? POS_CLASSES["top-left"]}`}
					style={{ width: SIZE_W[m().size] ?? SIZE_W.md }}
				>
					<div
						class="rounded-lg border border-border/60 overflow-hidden shadow-lg"
						style={{
							background: "hsl(var(--card))",
						}}
					>
						{/* Banner */}
						<Show when={m().banner}>
							<img src={m().banner!} class="w-full h-auto" alt="" />
						</Show>

						{/* Header */}
						<div class="px-3 py-2 border-b border-border/40">
							<h2 class="text-sm font-semibold text-foreground">{m().title}</h2>
							<Show when={m().subtitle}>
								<p class="text-xs text-muted-foreground">{m().subtitle}</p>
							</Show>
						</div>

						{/* Items */}
						<div class="max-h-[60vh] overflow-y-auto py-1">
							<For each={m().items}>
								{(item, idx) => {
									if (item.type === "separator") {
										return <div class="my-1 mx-3 h-px bg-border/40" />;
									}
									const focused = () => idx() === m().focusedIndex;
									return (
										<div
											data-item-idx={idx()}
											class="px-3 py-1.5 mx-1 rounded-md flex items-center justify-between gap-2 text-sm transition-colors cursor-pointer"
											classList={{
												"bg-primary/15 text-primary": focused(),
												"text-foreground hover:bg-secondary/60": !focused() && !item.disabled,
												"text-muted-foreground opacity-50 pointer-events-none": item.disabled,
											}}
											style={item.disabled ? undefined : { "min-height": m().itemHeight ? `${m().itemHeight}px` : undefined }}
										>
											<div class="flex-1 min-w-0">
												<span class="block truncate">{item.label}</span>
												<Show when={item.description}>
													<span class="block text-xs text-muted-foreground truncate">{item.description}</span>
												</Show>
											</div>

											{/* Right side */}
											<Show when={item.type === "checkbox"}>
												<div class={`w-4 h-4 rounded border flex items-center justify-center text-xs ${item.checked ? "bg-primary border-primary text-primary-foreground" : "border-border"}`}>
													{item.checked ? "✓" : ""}
												</div>
											</Show>

											<Show when={item.type === "list" && item.values}>
												<span class="text-xs text-muted-foreground flex items-center gap-1">
													<span class="opacity-50">◂</span>
													<span class="text-foreground">{item.values![item.index ?? 0]}</span>
													<span class="opacity-50">▸</span>
												</span>
											</Show>

											<Show when={item.type === "slider"}>
												<div class="flex items-center gap-2">
													<div class="w-16 h-1.5 rounded-full bg-secondary relative">
														<div
															class="h-full rounded-full bg-primary"
															style={{
																width: `${((item.value ?? item.min ?? 0) - (item.min ?? 0)) / ((item.max ?? 100) - (item.min ?? 0)) * 100}%`,
															}}
														/>
													</div>
													<span class="text-xs text-muted-foreground w-8 text-right">{item.value}</span>
												</div>
											</Show>

											<Show when={item.isSubmenu}>
												<span class="text-muted-foreground text-xs">▸</span>
											</Show>

											<Show when={item.rightLabel && !item.isSubmenu && item.type === "button"}>
												<span class="text-xs text-muted-foreground">{item.rightLabel}</span>
											</Show>
										</div>
									);
								}}
							</For>
						</div>

						{/* Footer hint */}
						<div class="px-3 py-1.5 border-t border-border/40 flex justify-between text-[10px] text-muted-foreground/60">
							<span>↑↓ Navigate</span>
							<span>{m().canGoBack ? "⌫ Back" : "⌫ Close"}</span>
						</div>
					</div>
				</div>
			)}
		</Show>
	);
}
