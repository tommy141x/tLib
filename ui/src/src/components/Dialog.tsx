/**
 * Dialog — Compact settings-style dialog matching tRadio/tELS panel look.
 * Uses the same settings-panel CSS classes and compact mono-spaced styling.
 */

import { createSignal, For, Show, onMount, onCleanup, createMemo } from "solid-js";
import { onNuiEvent, fetchNui } from "@/lib/nui";
import { applyScopedTheme } from "@/stores/theme-store";
import { Select as ArkSelect, createListCollection } from "@ark-ui/solid";
import IconX from "~icons/lucide/x";
import IconSettings from "~icons/lucide/settings-2";
import IconCheck from "~icons/lucide/check";
import IconChevronDown from "~icons/lucide/chevron-down";

interface DialogField {
	id: string;
	type: "text" | "number" | "password" | "textarea" | "select" | "dropdown" | "radio" | "slider" | "checkbox" | "button";
	label: string;
	description?: string;
	required?: boolean;
	disabled?: boolean;
	placeholder?: string;
	defaultValue?: string | number | boolean;
	min?: number;
	max?: number;
	step?: number;
	options?: { value: string; label: string }[];
	variant?: "default" | "primary" | "destructive";
	/** Section label shown above a group of fields */
	section?: string;
	/** Row group key — fields sharing the same `row` value render side-by-side */
	row?: string;
}

interface DialogData {
	id: string;
	title: string;
	description?: string;
	size: "sm" | "md" | "lg";
	submitLabel?: string;
	cancelLabel?: string;
	theme?: string;
	fields: DialogField[];
}

const SIZE_W: Record<string, string> = { sm: "280px", md: "320px", lg: "400px" };

export default function Dialog() {
	const [dialog, setDialog] = createSignal<DialogData | null>(null);
	const [values, setValues] = createSignal<Record<string, string | number | boolean>>({});
	let panelRef: HTMLDivElement | undefined;

	onNuiEvent<DialogData>("showDialog", (data) => {
		const init: Record<string, string | number | boolean> = {};
		for (const f of data.fields) {
			if (f.type === "button") continue;
			if (f.defaultValue !== undefined) {
				init[f.id] = f.defaultValue;
			} else if (f.type === "checkbox") {
				init[f.id] = false;
			} else if (f.type === "slider") {
				init[f.id] = f.min ?? 0;
			} else {
				init[f.id] = "";
			}
		}
		setValues(init);
		setDialog(data);
		if (panelRef && data.theme) applyScopedTheme(data.theme, panelRef);
	});

	onNuiEvent<{ id: string }>("closeDialog", () => setDialog(null));

	function updateField(id: string, value: string | number | boolean) {
		setValues((prev) => ({ ...prev, [id]: value }));
		fetchNui("dialogChange", { id: dialog()?.id, fieldId: id, value });
	}

	function submit() {
		const d = dialog();
		if (!d) return;
		fetchNui("dialogSubmit", { id: d.id, values: values() });
		setDialog(null);
	}

	function cancel() {
		const d = dialog();
		if (!d) return;
		fetchNui("dialogCancel", { id: d.id });
		setDialog(null);
	}

	function onButtonClick(fieldId: string) {
		fetchNui("dialogButtonClick", { id: dialog()?.id, fieldId });
	}

	onMount(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape" && dialog()) cancel();
		}
		window.addEventListener("keydown", onKeyDown);
		onCleanup(() => window.removeEventListener("keydown", onKeyDown));
	});

	return (
		<Show when={dialog()}>
			{(d) => (
				<div
					class="fixed inset-0 z-[9999] flex items-center justify-center"
					onClick={(e) => { if (e.target === e.currentTarget) cancel(); }}
				>
					<div
						ref={panelRef}
						class="settings-panel flex flex-col overflow-hidden pointer-events-auto"
						style={{ width: SIZE_W[d().size] ?? SIZE_W.md, "max-height": "85vh" }}
						onClick={(e) => e.stopPropagation()}
					>
						{/* Header */}
						<div class="flex items-center justify-between px-3 py-2 border-b border-[hsl(var(--border)/0.6)]">
							<span class="flex items-center gap-1.5 text-[10px] font-mono font-semibold text-[hsl(var(--muted-foreground))]">
								<IconSettings class="w-3 h-3 opacity-60" />
								{d().title}
							</span>
							<button
								class="flex items-center justify-center w-5 h-5 rounded text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))] hover:text-[hsl(var(--foreground))] transition-colors"
								onClick={cancel}
							>
								<IconX class="w-3 h-3" />
							</button>
						</div>

						{/* Body */}
						<div class="flex flex-col gap-4 p-3 overflow-y-auto settings-scroll">
							<For each={groupFieldsByRow(d().fields)}>
								{(group, gIdx) => {
									const firstField = group[0];
									const prevGroup = () => gIdx() > 0 ? groupFieldsByRow(d().fields)[gIdx() - 1] : null;
									const prevSection = () => prevGroup()?.[0]?.section;
									const showSep = () => firstField.section && firstField.section !== prevSection();
									const showSection = () => firstField.section && firstField.section !== prevSection();
									const isRow = group.length > 1;

									return (
										<>
											<Show when={showSep() && gIdx() > 0}>
												<div class="settings-sep" />
											</Show>
											<Show when={showSection()}>
												<span class="text-[9px] font-mono text-[hsl(var(--muted-foreground)/0.5)] uppercase tracking-wide">
													{firstField.section}
												</span>
											</Show>
											{isRow ? (
												<div class="flex gap-2 items-end">
													<For each={group}>
														{(field) => (
															<div class="flex-1 min-w-0">
																<FieldRenderer
																	field={field}
																	values={values}
																	updateField={updateField}
																	onButtonClick={onButtonClick}
																/>
															</div>
														)}
													</For>
												</div>
											) : (
												<FieldRenderer
													field={firstField}
													values={values}
													updateField={updateField}
													onButtonClick={onButtonClick}
												/>
											)}
										</>
									);
								}}
							</For>
						</div>
					</div>
				</div>
			)}
		</Show>
	);
}

// ── Helpers ──

/** Groups consecutive fields sharing the same `row` key into arrays. */
function groupFieldsByRow(fields: DialogField[]): DialogField[][] {
	const groups: DialogField[][] = [];
	for (const field of fields) {
		if (field.row && groups.length > 0) {
			const last = groups[groups.length - 1];
			if (last[0].row === field.row) {
				last.push(field);
				continue;
			}
		}
		groups.push([field]);
	}
	return groups;
}

// ── Sub-components (matching tRadio's compact style) ──

function SectionLabel(props: { label: string }) {
	return (
		<span class="text-[9px] font-mono text-[hsl(var(--muted-foreground)/0.5)] uppercase tracking-wide">
			{props.label}
		</span>
	);
}

function FieldRenderer(props: {
	field: DialogField;
	values: () => Record<string, string | number | boolean>;
	updateField: (id: string, value: string | number | boolean) => void;
	onButtonClick: (id: string) => void;
}) {
	const { field } = props;
	const val = () => props.values()[field.id];

	if (field.type === "button") {
		const isDestructive = field.variant === "destructive";
		const isPrimary = field.variant === "primary";
		return (
			<div class="flex flex-col gap-1" classList={{ "justify-end h-full": !!field.row }}>
				{/* Show a spacer label when in a row, so the button aligns with sibling input areas */}
				<Show when={field.row}>
					<span class="text-[10px] font-mono text-transparent select-none">&nbsp;</span>
				</Show>
				<button
					class="w-full py-1 px-2 text-[9px] font-mono rounded transition-colors whitespace-nowrap"
					classList={{
						"bg-destructive text-destructive-foreground hover:bg-destructive/90": isDestructive,
						"bg-primary text-primary-foreground hover:bg-primary/90": isPrimary,
						"bg-secondary/60 text-muted-foreground hover:bg-secondary": !isDestructive && !isPrimary,
					}}
					disabled={field.disabled}
					onClick={() => props.onButtonClick(field.id)}
				>
					{field.label}
				</button>
				<Show when={field.description}>
					<span class="text-[8px] font-mono text-[hsl(var(--muted-foreground)/0.35)] pl-0.5">
						{field.description}
					</span>
				</Show>
			</div>
		);
	}

	if (field.type === "checkbox") {
		return (
			<div class="flex items-center justify-between">
				<div class="flex flex-col">
					<span class="text-[10px] font-mono text-[hsl(var(--muted-foreground))]">
						{field.label}
					</span>
					<Show when={field.description}>
						<span class="text-[8px] font-mono text-[hsl(var(--muted-foreground)/0.4)]">
							{field.description}
						</span>
					</Show>
				</div>
				<div class="flex gap-1">
					<button
						class="px-2 py-0.5 text-[9px] font-mono rounded transition-colors"
						classList={{
							"bg-primary text-primary-foreground": !!val(),
							"bg-secondary/60 text-muted-foreground hover:bg-secondary": !val(),
						}}
						disabled={field.disabled}
						onClick={() => props.updateField(field.id, true)}
					>
						On
					</button>
					<button
						class="px-2 py-0.5 text-[9px] font-mono rounded transition-colors"
						classList={{
							"bg-primary text-primary-foreground": !val(),
							"bg-secondary/60 text-muted-foreground hover:bg-secondary": !!val(),
						}}
						disabled={field.disabled}
						onClick={() => props.updateField(field.id, false)}
					>
						Off
					</button>
				</div>
			</div>
		);
	}

	if (field.type === "slider") {
		const min = field.min ?? 0;
		const max = field.max ?? 100;
		const step = field.step ?? 1;
		return (
			<div class="flex flex-col gap-1.5">
				<div class="flex items-center justify-between">
					<span class="text-[10px] font-mono text-[hsl(var(--muted-foreground))]">
						{field.label}
					</span>
					<span class="text-[10px] font-mono text-primary tabular-nums">
						{Math.round(Number(val()))}
					</span>
				</div>
				<input
					type="range"
					class="settings-range"
					min={min}
					max={max}
					step={step}
					value={Number(val())}
					disabled={field.disabled}
					onInput={(e) => props.updateField(field.id, Number(e.currentTarget.value))}
				/>
			</div>
		);
	}

	if (field.type === "select") {
		return (
			<div class="flex flex-col gap-1.5">
				<span class="text-[10px] font-mono text-[hsl(var(--muted-foreground))]">
					{field.label}
				</span>
				<div class="flex gap-1">
					<For each={field.options ?? []}>
						{(opt) => (
							<button
								class="flex-1 py-0.5 text-[9px] font-mono rounded transition-colors"
								classList={{
									"bg-primary text-primary-foreground": String(val()) === opt.value,
									"bg-secondary/60 text-muted-foreground hover:bg-secondary": String(val()) !== opt.value,
								}}
								disabled={field.disabled}
								onClick={() => props.updateField(field.id, opt.value)}
							>
								{opt.label}
							</button>
						)}
					</For>
				</div>
			</div>
		);
	}

	if (field.type === "dropdown") {
		const items = (field.options ?? []).map((o) => ({ value: o.value, label: o.label }));
		const collection = createListCollection({
			items,
			itemToValue: (item) => item.value,
			itemToString: (item) => item.label,
		});
		return (
			<div class="flex flex-col gap-1.5">
				<span class="text-[10px] font-mono text-[hsl(var(--muted-foreground))]">
					{field.label}
				</span>
				<ArkSelect.Root
					collection={collection}
					value={val() != null ? [String(val())] : []}
					onValueChange={(details) => {
						if (details.value[0] !== undefined) {
							props.updateField(field.id, details.value[0]);
						}
					}}
					positioning={{ sameWidth: true }}
					disabled={field.disabled}
				>
					<ArkSelect.Control>
						<ArkSelect.Trigger class="w-full flex items-center justify-between px-2 py-1 text-[10px] font-mono rounded bg-[hsl(var(--input))] border border-[hsl(var(--border)/0.8)] text-[hsl(var(--foreground))] hover:border-[hsl(var(--ring)/0.5)] transition-colors cursor-pointer focus:outline-none focus-visible:outline-none [&]:ring-0 [&]:outline-none">
							<ArkSelect.ValueText placeholder={field.placeholder ?? "Select..."} class="flex-1 text-left truncate" />
							<ArkSelect.Indicator class="shrink-0 ml-1 transition-transform duration-200 data-[state=open]:rotate-180">
								<IconChevronDown class="w-3 h-3 opacity-60" />
							</ArkSelect.Indicator>
						</ArkSelect.Trigger>
					</ArkSelect.Control>
					<ArkSelect.Positioner>
						<ArkSelect.Content class="z-[10000] overflow-hidden rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-0.5 shadow-md max-h-[200px] overflow-y-auto">
							<For each={items}>
								{(item) => (
									<ArkSelect.Item
										item={item}
										class="flex items-center justify-between px-2 py-1 text-[9px] font-mono rounded-sm cursor-pointer select-none hover:bg-[hsl(var(--secondary))] data-highlighted:bg-[hsl(var(--secondary))] transition-colors"
									>
										<ArkSelect.ItemText>{item.label}</ArkSelect.ItemText>
										<ArkSelect.ItemIndicator class="shrink-0 ml-2">
											<IconCheck class="w-3 h-3 text-primary" />
										</ArkSelect.ItemIndicator>
									</ArkSelect.Item>
								)}
							</For>
						</ArkSelect.Content>
					</ArkSelect.Positioner>
					<ArkSelect.HiddenSelect />
				</ArkSelect.Root>
			</div>
		);
	}

	if (field.type === "radio") {
		return (
			<div class="flex flex-col gap-1.5">
				<span class="text-[10px] font-mono text-[hsl(var(--muted-foreground))]">
					{field.label}
				</span>
				<div class="flex gap-1">
					<For each={field.options ?? []}>
						{(opt) => (
							<button
								class="flex-1 py-0.5 text-[9px] font-mono rounded transition-colors"
								classList={{
									"bg-primary text-primary-foreground": val() === opt.value,
									"bg-secondary/60 text-muted-foreground hover:bg-secondary": val() !== opt.value,
								}}
								disabled={field.disabled}
								onClick={() => props.updateField(field.id, opt.value)}
							>
								{opt.label}
							</button>
						)}
					</For>
				</div>
			</div>
		);
	}

	// text / number / password / textarea
	return (
		<div class="flex flex-col gap-1.5">
			<span class="text-[10px] font-mono text-[hsl(var(--muted-foreground))]">
				{field.label}
			</span>
			{field.type === "textarea" ? (
				<textarea
					class="w-full px-2 py-1 text-[10px] font-mono rounded bg-[hsl(var(--input))] border border-[hsl(var(--border)/0.8)] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:border-[hsl(var(--ring))] resize-y"
					rows={3}
					placeholder={field.placeholder}
					disabled={field.disabled}
					onInput={(e) => props.updateField(field.id, e.currentTarget.value)}
				>{(val() as string) ?? ""}</textarea>
			) : (
				<input
					type={field.type}
					class="w-full px-2 py-1 text-[10px] font-mono rounded bg-[hsl(var(--input))] border border-[hsl(var(--border)/0.8)] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:border-[hsl(var(--ring))]"
					placeholder={field.placeholder}
					value={(val() as string) ?? ""}
					min={field.min}
					max={field.max}
					disabled={field.disabled}
					onInput={(e) => props.updateField(field.id, field.type === "number" ? Number(e.currentTarget.value) : e.currentTarget.value)}
				/>
			)}
		</div>
	);
}
