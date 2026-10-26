/**
 * The marketplace's delete control: arm on the first click, delete on the second.
 *
 * The four delete triggers this replaced were bare trash glyphs that removed server
 * content on one click, with no arming step and no undo.
 *
 * IT DOES NOT IMPORT THE KIT'S `ConfirmDelete`, AND MUST NOT. That component lives in
 * `internal/shared-ts/ui/`, a private nested repo; this folder is published under MIT with
 * the rest of `shared/`, and no public file imports a private one. What IS duplicated is
 * one number, below.
 */

import { createSignal, onCleanup, Show } from "solid-js";
import IconLoaderCircle from "~icons/lucide/loader-circle";
import IconTrash2 from "~icons/lucide/trash-2";
import { NuiButton } from "../../nui-kit/NuiButton";

/**
 * Matches `CONFIRM_DELETE_TIMEOUT_MS` in `internal/shared-ts/ui/confirm-delete.tsx`.
 *
 * If that value moves, move this one: six live call sites in tLS are tuned to 2.5 s, and a
 * delete that arms for a different length of time in two places reads as a broken control.
 */
const ARM_MS = 2500;

export interface DeleteFromServerProps {
  /** Fired on the SECOND click only. */
  onConfirm: () => void;
  /** Any in-flight state that should block the control. */
  disabled?: boolean;
  /** True while this item's own delete is running: swaps in the spinner. */
  uninstalling?: boolean;
}

export function DeleteFromServer(props: DeleteFromServerProps) {
  const [armed, setArmed] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const disarm = () => {
    setArmed(false);
    timer = undefined;
  };

  // Disarm on unmount as well as on timeout: a card can be filtered out of the grid
  // between the two clicks, and a signal left armed behind a destroyed node is a delete
  // waiting for a click that lands on whatever takes its place.
  onCleanup(() => {
    if (timer) clearTimeout(timer);
  });

  const handleClick = () => {
    if (props.disabled || props.uninstalling) return;
    if (armed()) {
      if (timer) clearTimeout(timer);
      disarm();
      props.onConfirm();
      return;
    }
    setArmed(true);
    timer = setTimeout(disarm, ARM_MS);
  };

  const label = () =>
    armed() ? "Click again to delete this from the server" : "Delete from server";

  return (
    <NuiButton
      class="mp-action mp-delete"
      data-armed={armed() ? "" : undefined}
      aria-label={label()}
      title={label()}
      disabled={props.disabled}
      aria-busy={props.uninstalling ? "true" : "false"}
      onClick={handleClick}
    >
      <Show when={props.uninstalling} fallback={<IconTrash2 class="w-3 h-3" />}>
        <IconLoaderCircle class="w-3 h-3 animate-spin" />
      </Show>
      <Show when={props.uninstalling}>Deleting…</Show>
      <Show when={armed() && !props.uninstalling}>Confirm?</Show>
    </NuiButton>
  );
}
