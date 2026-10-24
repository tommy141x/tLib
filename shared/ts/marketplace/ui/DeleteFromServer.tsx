/**
 * The marketplace's delete control: arm on the first click, delete on the second.
 *
 * UNTIL 2026-10-24 THIS WAS A BARE TRASH GLYPH THAT DELETED SERVER CONTENT ON ONE
 * CLICK, with no arming step and no undo — `handleUninstall` went straight to
 * `fetchNui("marketplaceUninstall", …)` and the word "confirm" did not appear anywhere in
 * MarketplaceBrowser.tsx. Four triggers shared that behaviour. In the same estate, tELS
 * guards the strictly less destructive "un-share a listing" with a two-step confirm, and
 * tRadio confirms its own uninstall, so this was the outlier rather than the convention.
 *
 * IT DOES NOT IMPORT THE KIT'S `ConfirmDelete`, AND MUST NOT. That component lives in
 * `internal/shared-ts/ui/`, which is a private nested repo; this folder is published under
 * MIT with the rest of `shared/`. No public file imports a private one today (checked:
 * every `internal/` mention under `shared/ts` is prose in a comment) and that boundary is
 * worth more than the duplication. What IS duplicated is one number, below.
 */

import { createSignal, onCleanup, Show } from "solid-js";
import IconLoaderCircle from "~icons/lucide/loader-circle";
import IconTrash2 from "~icons/lucide/trash-2";
import { NuiButton } from "../../nui-kit/NuiButton";

/**
 * Matches `CONFIRM_DELETE_TIMEOUT_MS` in `internal/shared-ts/ui/confirm-delete.tsx`.
 *
 * Duplicated across the public/private boundary deliberately, not by accident. If that
 * value moves, move this one: six live call sites in tELS are tuned to 2.5 s, and a
 * delete that arms for a different length of time in two places is the inconsistency this
 * whole control exists to remove.
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
