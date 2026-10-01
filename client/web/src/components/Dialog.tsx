import { Dialog as ArkDialog } from "@ark-ui/solid/dialog";
import { Tabs } from "@ark-ui/solid/tabs";
import { createForm } from "@tanstack/solid-form";
import type { OpenData } from "@tlib/shared/marketplace/ui";
import { ArrowUpRight, Check, Settings2, X } from "lucide-solid";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { fetchNui, onNuiEvent } from "@/lib/nui";
import {
  type DialogData,
  type DialogField,
  type DialogValue,
  type DialogValues,
  effectiveTabs,
  groupFieldsByRow,
  initialValues,
  matchesDialog,
  validationErrors,
} from "./dialog-model";
import {
  clampOffset,
  DIALOG_NO_TAB,
  forgetDialogView,
  recallDialogView,
  rememberDialogView,
  restoredTab,
} from "./dialog-view-state";
import { MarketplaceBrowser } from "./marketplace/MarketplaceBrowser";
import { NuiButton, NuiField } from "./ui/nui-field";
import { applyNuiTheme } from "./ui/nui-theme";

const SIZE_W = { sm: "300px", md: "360px", lg: "440px", xl: "760px" };

/** Field types NuiField renders without a Field.Label. Beside a labelled field
 * they need the label's space reserved or they sit a line too high. */
const LABELLESS = new Set(["button", "checkbox"]);

/** Lua remains the lifecycle authority. A show creates a fresh keyed form so a
 * replaced dialog can never inherit validation, dirty state or pending replies. */
export default function Dialog() {
  const [session, setSession] = createSignal<{ data: DialogData }>();
  const [open, setOpen] = createSignal(false);
  onCleanup(
    onNuiEvent<DialogData>("showDialog", (data) => {
      // Before the session mounts: DialogSession reads the remembered view in
      // its initialisers, so a reset has to have happened by now.
      if (data.resetState) forgetDialogView(data.id);
      setSession({ data });
      setOpen(true);
    })
  );
  onCleanup(
    onNuiEvent<{ id: string; instance?: number }>("closeDialog", (data) => {
      if (matchesDialog(session()?.data ?? null, data.id, data.instance)) setOpen(false);
    })
  );
  return (
    <Show when={session()} keyed>
      {(entry) => (
        <DialogSession
          initial={entry.data}
          open={open()}
          onCancel={() => {
            if (session() === entry) setOpen(false);
          }}
          onExit={() => {
            if (session() === entry && !open()) setSession(undefined);
          }}
        />
      )}
    </Show>
  );
}

function DialogSession(props: {
  initial: DialogData;
  open: boolean;
  onCancel: () => void;
  onExit: () => void;
}) {
  const [dialog, setDialog] = createSignal(props.initial);
  const [attempted, setAttempted] = createSignal(false);
  const [touched, setTouched] = createSignal<Set<string>>(new Set());
  const [notice, setNotice] = createSignal("");
  // Where this dialog id was last left. Read once, here, because everything it
  // seeds is owned by the session from now on.
  const remembered = recallDialogView(props.initial.id);
  const [offset, setOffset] = createSignal(remembered?.offset ?? { x: 0, y: 0 });
  // Not a signal: the scroll handler writes it on every frame of a scroll and
  // nothing renders from it. The restore reads it through activeTab().
  const scrollByTab: Record<string, number> = { ...remembered?.scroll };
  const [scrollHost, setScrollHost] = createSignal<HTMLDivElement>();
  let panel: HTMLDivElement | undefined;
  let alive = true;
  let drag:
    | { pointer: number; x: number; y: number; ox: number; oy: number; target: HTMLElement }
    | undefined;
  const tabIds = createUniqueId();
  const tabs = createMemo(() => effectiveTabs(dialog()));
  const firstTab = () => restoredTab(tabs(), null);
  // A remembered tab that no longer exists — permissions changed, config
  // changed — falls back to the first real tab instead of selecting nothing.
  const [activeTab, setActiveTab] = createSignal<string | null>(
    restoredTab(tabs(), remembered?.tab)
  );
  const activeTabDef = createMemo(() => tabs().find((tab) => tab.id === activeTab()));
  const errorsFor = (values: DialogValues) => validationErrors(dialog().fields, values);

  // Payload for a `view: "marketplace"` tab. It arrives on its own NUI message
  // rather than inside the dialog schema because it is the answer to a SERVER
  // round trip (which layouts and sounds are on disk) that the consumer fires
  // as it opens the dialog — so it lands after `showDialog`, not with it.
  const [marketplaceData, setMarketplaceData] = createSignal<OpenData | null>(null);
  onCleanup(onNuiEvent<OpenData>("marketplaceData", (data) => setMarketplaceData(data)));
  const form = createForm(() => ({
    // A single record deliberately avoids interpreting consumer ids containing
    // dots/brackets as TanStack nested paths. Controls bind through this adapter.
    defaultValues: { values: initialValues(props.initial.fields) },
    validators: {
      onSubmit: ({ value }) =>
        Object.keys(errorsFor(value.values)).length ? "Check the highlighted fields." : undefined,
      onChange: ({ value }) =>
        attempted() && Object.keys(errorsFor(value.values)).length
          ? "Check the highlighted fields."
          : undefined,
    },
    onSubmit: async ({ value }) => {
      if (!alive || !props.open) return;
      const d = dialog();
      // Never close on HTTP completion: Lua alone sends closeDialog after value
      // validation. This also leaves the form available after rejected submits.
      await fetchNui("dialogSubmit", {
        id: d.id,
        instance: d.instance,
        values: initialValues(d.fields, value.values),
      });
      if (alive && props.open) setNotice("Submitted. Waiting for the game to accept these values.");
    },
  }));
  const values = form.useSelector((state) => state.values.values);
  const submitting = form.useSelector((state) => state.isSubmitting);
  const errors = createMemo(() => errorsFor(values()));
  const currentFields = createMemo(() =>
    !tabs().length
      ? dialog().fields
      : dialog().fields.filter(
          (field) => field.tab === activeTab() || (!field.tab && activeTab() === firstTab())
        )
  );
  const groups = createMemo(() => groupFieldsByRow(currentFields()));
  // For keys are schema IDs, never freshly allocated row/field objects. Label,
  // options and full-schema patches can now update props without destroying DOM.
  const groupKeys = createMemo(() =>
    groups().map((group) => JSON.stringify(group.map((field) => field.id)))
  );
  const fieldById = createMemo(() => new Map(dialog().fields.map((field) => [field.id, field])));

  const isCurrent = (id: string, instance?: number) =>
    alive && props.open && matchesDialog(dialog(), id, instance);
  onCleanup(
    onNuiEvent<{ dialogId: string; instance?: number; fields: DialogField[] }>(
      "updateDialogFields",
      (data) => {
        if (!isCurrent(data.dialogId, data.instance)) return;
        setDialog((d) => ({ ...d, fields: data.fields }));
        form.setFieldValue("values", initialValues(data.fields, values()));
        if (!tabs().some((tab) => !tab.action && tab.id === activeTab())) setActiveTab(firstTab());
      }
    )
  );
  onCleanup(
    onNuiEvent<
      { dialogId: string; instance?: number; fieldId: string } & Partial<
        Pick<DialogField, "options" | "defaultValue" | "disabled" | "label" | "variant">
      >
    >("updateDialogField", (data) => {
      if (!isCurrent(data.dialogId, data.instance)) return;
      const existing = dialog().fields.find((field) => field.id === data.fieldId);
      if (!existing) return;
      const patch = Object.fromEntries(
        ["options", "defaultValue", "disabled", "label", "variant"]
          .filter((key) => data[key as keyof typeof data] !== undefined)
          .map((key) => [key, data[key as keyof typeof data]])
      );
      setDialog((d) => ({
        ...d,
        fields: d.fields.map((field) =>
          field.id === data.fieldId ? { ...field, ...patch } : field
        ),
      }));
      if (data.defaultValue !== undefined)
        form.setFieldValue("values", {
          ...values(),
          [data.fieldId]:
            existing.type === "number" ? String(data.defaultValue) : data.defaultValue,
        });
    })
  );
  function updateField(id: string, value: DialogValue) {
    if (!alive || !props.open) return;
    form.setFieldValue("values", (previous) => ({ ...previous, [id]: value }));
    const d = dialog();
    void fetchNui("dialogChange", { id: d.id, instance: d.instance, fieldId: id, value });
  }
  function action(fieldId: string) {
    if (!alive || !props.open) return;
    const d = dialog();
    void fetchNui("dialogButtonClick", { id: d.id, instance: d.instance, fieldId });
  }
  function cancel() {
    if (!alive || !props.open) return;
    const d = dialog();
    void fetchNui("dialogCancel", { id: d.id, instance: d.instance });
    props.onCancel(); // cancel has no closeDialog echo in the existing Lua contract
  }
  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!alive || !props.open || submitting()) return;
    setAttempted(true);
    setNotice("");
    const firstInvalid = dialog().fields.find((field) => errors()[field.id]);
    if (firstInvalid) {
      setActiveTab(firstInvalid.tab ?? firstTab());
      queueMicrotask(() => {
        if (!alive || !props.open) return;
        const field = Array.from(
          panel?.querySelectorAll<HTMLElement>("[data-field-id]") ?? []
        ).find((element) => element.dataset.fieldId === firstInvalid.id);
        field
          ?.querySelector<HTMLElement>(
            "input:not([type=hidden]):not(:disabled), textarea:not(:disabled), button:not(:disabled), [role=slider]"
          )
          ?.focus();
      });
    }
    void form.handleSubmit();
  }
  function endDrag() {
    if (drag?.target.hasPointerCapture(drag.pointer))
      drag.target.releasePointerCapture(drag.pointer);
    drag = undefined;
  }
  function beginDrag(event: PointerEvent) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const target = event.currentTarget as HTMLElement;
    drag = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      ox: offset().x,
      oy: offset().y,
      target,
    };
    target.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  const dragBounds = () => ({
    panel: { width: panel?.offsetWidth ?? 0, height: panel?.offsetHeight ?? 0 },
    viewport: { width: innerWidth, height: innerHeight },
  });
  function moveDrag(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointer || !panel) return;
    setOffset(
      clampOffset(
        { x: drag.ox + event.clientX - drag.x, y: drag.oy + event.clientY - drag.y },
        dragBounds()
      )
    );
  }
  onCleanup(() => {
    alive = false;
    endDrag();
  });

  // --- "reopen where I left it" -------------------------------------------
  // Saved continuously rather than on close. A dialog can go away by submit,
  // cancel, an authoritative closeDialog, or being replaced outright by a
  // reentrant ShowDialog, and only some of those run through this component's
  // own teardown — reading the state back out at unmount would miss the rest.
  const scrollKey = () => activeTab() ?? DIALOG_NO_TAB;
  function persistView() {
    rememberDialogView(props.initial.id, {
      tab: activeTab(),
      scroll: scrollByTab,
      offset: offset(),
    });
  }
  createEffect(persistView);
  function recordScroll(event: Event) {
    scrollByTab[scrollKey()] = (event.currentTarget as HTMLElement).scrollTop;
    persistView();
  }
  // A restore is clamped again here because the remembered offset was clamped
  // against whatever the window and panel measured last time.
  createEffect(() => {
    if (!props.open || !panel) return;
    setOffset((current) => clampOffset(current, dragBounds()));
  });
  // Per tab, not per dialog: restoring one tab's scroll onto another's panel
  // would land somewhere the player never was. A `view` tab renders no scroll
  // host at all, which is why this reads the host reactively.
  createEffect(() => {
    const host = scrollHost();
    const key = scrollKey();
    if (!host || !props.open) return;
    host.scrollTop = scrollByTab[key] ?? 0;
  });

  createEffect(() => {
    if (props.open) return;
    endDrag();
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && panel?.contains(focused)) focused.blur();
  });

  return (
    <ArkDialog.Root
      open={props.open}
      modal={props.open}
      trapFocus={props.open}
      preventScroll={false}
      restoreFocus={false}
      lazyMount
      unmountOnExit
      onExitComplete={props.onExit}
      onOpenChange={(details) => {
        if (!details.open) cancel();
      }}
      initialFocusEl={() =>
        panel?.querySelector<HTMLElement>(
          "form input:not([type=hidden]):not(:disabled), form textarea:not(:disabled), form [role=combobox]:not([data-disabled])"
        ) ??
        panel?.querySelector<HTMLElement>("form button:not(:disabled)") ??
        panel ??
        null
      }
    >
      <ArkDialog.Positioner
        class="tlib-nui-dialog-positioner fixed inset-0 z-[9999] flex items-center justify-center p-3"
        data-state={props.open ? "open" : "closed"}
      >
        <ArkDialog.Content
          ref={(el) => {
            panel = el;
            createEffect(() => applyNuiTheme(dialog().theme, el));
          }}
          inert={!props.open}
          aria-hidden={!props.open ? true : undefined}
          class="tlib-nui-surface tlib-nui-dialog tlib-nui-lit pointer-events-auto flex max-w-full flex-col overflow-hidden rounded-[var(--nui-radius-lg)] border border-[var(--nui-border)] bg-[var(--nui-surface)] outline-none"
          style={{
            width: SIZE_W[dialog().size] ?? SIZE_W.md,
            "max-height": "85vh",
            transform: `translate(${offset().x}px, ${offset().y}px)`,
          }}
        >
          <header
            class="tlib-nui-ruled-b flex shrink-0 cursor-grab items-start justify-between gap-3 px-4 py-2.5 active:cursor-grabbing"
            onPointerDown={beginDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <div class="min-w-0">
              <ArkDialog.Title class="flex items-center gap-2 text-sm font-semibold">
                <Settings2 size={15} class="shrink-0 text-[var(--nui-muted)]" />
                {dialog().title}
              </ArkDialog.Title>
              <Show when={dialog().description}>
                <ArkDialog.Description class="mt-1 text-xs leading-relaxed text-[var(--nui-muted)]">
                  {dialog().description}
                </ArkDialog.Description>
              </Show>
            </div>
            <ArkDialog.CloseTrigger
              class="tlib-nui-control rounded p-1 text-[var(--nui-muted)] hover:bg-[var(--nui-hover)]"
              aria-label="Close dialog"
            >
              <X size={16} />
            </ArkDialog.CloseTrigger>
          </header>
          <form class="flex min-h-0 flex-col" noValidate onSubmit={submit}>
            <Tabs.Root
              value={activeTab()}
              orientation="vertical"
              onValueChange={(d) => setActiveTab(d.value)}
              class="flex min-h-0 flex-1"
            >
              <Show when={tabs().length}>
                <aside class="tlib-nui-ruled-r flex w-36 shrink-0 flex-col overflow-y-auto p-1.5">
                  <Tabs.List class="flex flex-col gap-0.5">
                    <For each={tabs()}>
                      {(tab) => (
                        <>
                          <Show when={tab.separator}>
                            <hr class="tlib-nui-rule my-1" />
                          </Show>
                          <Show
                            when={tab.action}
                            fallback={
                              <Tabs.Trigger
                                value={tab.id}
                                id={`${tabIds}-${tab.id}-tab`}
                                aria-controls={`${tabIds}-${tab.id}-panel`}
                                class="tlib-nui-control rounded-[var(--nui-radius)] border border-transparent px-2.5 py-1.5 text-left text-sm text-[var(--nui-muted)] data-[selected]:border-[var(--nui-border)] data-[selected]:bg-[var(--nui-hover)] data-[selected]:text-[var(--nui-text)]"
                              >
                                {tab.label}
                              </Tabs.Trigger>
                            }
                          >
                            <button
                              type="button"
                              onClick={() => action(tab.id)}
                              class="tlib-nui-control flex items-center justify-between gap-1 rounded-[var(--nui-radius)] border border-transparent px-2.5 py-1.5 text-left text-sm text-[var(--nui-muted)] hover:bg-[var(--nui-hover)]"
                            >
                              {tab.label}
                              <ArrowUpRight size={13} />
                            </button>
                          </Show>
                        </>
                      )}
                    </For>
                  </Tabs.List>
                </aside>
              </Show>
              {/* A `view` tab owns its whole panel and is not a scroll box: the
                  marketplace browser scrolls its own card grid and has to keep
                  its toolbar and category tabs pinned, which an outer
                  overflow-y-auto would defeat. It is deliberately inside the
                  same Tabs.Root, the same dialog surface and the same close
                  behaviour — no second backdrop, no second focus trap. */}
              <Show
                when={activeTabDef()?.view === "marketplace"}
                fallback={
                  <div
                    ref={(el) => {
                      setScrollHost(el);
                      onCleanup(() =>
                        setScrollHost((current) => (current === el ? undefined : current))
                      );
                    }}
                    onScroll={recordScroll}
                    class="min-w-0 flex-1 overflow-y-auto p-3.5"
                    style={{
                      "min-height": dialog().size === "xl" ? "min(360px, 40vh)" : undefined,
                    }}
                  >
                    <div
                      class="flex flex-col gap-3"
                      role={tabs().length ? "tabpanel" : undefined}
                      id={activeTab() ? `${tabIds}-${activeTab()}-panel` : undefined}
                      aria-labelledby={activeTab() ? `${tabIds}-${activeTab()}-tab` : undefined}
                    >
                      <FieldGroups />
                    </div>
                  </div>
                }
              >
                <div
                  class="flex min-w-0 flex-1 flex-col overflow-hidden p-3.5"
                  role="tabpanel"
                  id={`${tabIds}-${activeTab()}-panel`}
                  aria-labelledby={`${tabIds}-${activeTab()}-tab`}
                >
                  {/* No onEscape: Escape here should dismiss the DIALOG, which
                      is exactly what happens when the browser leaves the key
                      alone. It still swallows the first Escape while a preview
                      is open, which is the layer the user means. */}
                  <MarketplaceBrowser
                    class="mp-embed"
                    data={marketplaceData()}
                    active={props.open}
                  />
                </div>
              </Show>
            </Tabs.Root>
            <footer class="tlib-nui-ruled-t flex shrink-0 flex-wrap items-center justify-end gap-2 px-4 py-2.5">
              <Show when={attempted() && Object.keys(errors()).length}>
                <p role="alert" class="mr-auto text-xs text-[var(--nui-danger)]">
                  Check the highlighted fields.
                </p>
              </Show>
              <Show when={notice()}>
                <p role="status" class="mr-auto text-xs text-[var(--nui-muted)]">
                  {notice()}
                </p>
              </Show>
              <NuiButton onClick={cancel}>{dialog().cancelLabel ?? "Cancel"}</NuiButton>
              <NuiButton type="submit" tone="primary" disabled={submitting()}>
                <Check size={14} />
                {submitting() ? "Submitting…" : (dialog().submitLabel ?? "Submit")}
              </NuiButton>
            </footer>
          </form>
        </ArkDialog.Content>
      </ArkDialog.Positioner>
    </ArkDialog.Root>
  );

  function FieldGroups() {
    return (
      <For each={groupKeys()}>
        {(key, index) => {
          const ids = JSON.parse(key) as string[];
          const first = () => fieldById().get(ids[0]);
          const hasLabelledSibling = () =>
            ids.length > 1 && ids.some((id) => !LABELLESS.has(fieldById().get(id)?.type ?? ""));
          return (
            <>
              <Show
                when={first()?.section && first()?.section !== groups()[index() - 1]?.[0].section}
              >
                <h3 class="tlib-nui-ruled-b pb-1.5 text-xs font-medium tracking-wide text-[var(--nui-muted)]">
                  {first()?.section}
                </h3>
              </Show>
              <div class="tlib-nui-field-row">
                <For each={ids}>
                  {(id) => {
                    const field = () => fieldById().get(id)!;
                    return (
                      <div
                        class="tlib-nui-field-cell"
                        data-shrink={field()?.flex === "shrink"}
                        data-labelless={hasLabelledSibling() && LABELLESS.has(field()?.type ?? "")}
                      >
                        <NuiField
                          field={field()}
                          value={values()[id]}
                          theme={dialog().theme}
                          active={props.open}
                          error={attempted() || touched().has(id) ? errors()[id] : undefined}
                          onBlur={() => {
                            if (props.open) setTouched((previous) => new Set([...previous, id]));
                          }}
                          onChange={(value) => updateField(id, value)}
                          onAction={() => action(id)}
                        />
                      </div>
                    );
                  }}
                </For>
              </div>
            </>
          );
        }}
      </For>
    );
  }
}
