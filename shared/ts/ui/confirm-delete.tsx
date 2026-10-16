import type { JSX } from "@solidjs/web";
import { cn } from "@tlib/shared/cn";
import type { Component } from "solid-js";
import { children, createSignal, omit, onCleanup, Show } from "solid-js";
import IconTrash from "~icons/lucide/trash-2";
import { Button } from "./button";

/**
 * ConfirmDelete — arm-then-commit. One control, two clicks, no dialog.
 *
 * Promoted verbatim (behaviour and idle/armed class strings) from tELS's
 * `client/web/src/components/ui/confirm-button.tsx`, which is now deleted. It
 * moved under rule 1 in `./meta.ts`: two surfaces need it, so it is common, and
 * "it does not become resource-specific by being written in a resource first".
 * There is no shim left behind at the old path — rule 3.
 *
 * It is a SPECIALISED control, not a second button kit: it owns one behaviour (a
 * 2.5 s arm window) and no palette, size axis or variant table. The LABELLED form
 * renders through `Button`. The ICON form stays a bare `<button>` because
 * `Button` cannot express it -- `size="icon"` is a fixed 32px square and forces
 * every descendant svg to 16px, which would grow every row these sit in.
 *
 * The focus affordance is an `outline`, not a ring: `presetWind3` compiles `ring-*`
 * to a `box-shadow` and CEF clips a shadow to nothing inside the `overflow: hidden`
 * ancestor every panel here is. The offset is POSITIVE, unlike `buttonVariants`,
 * because this control's box IS the glyph and an inset ring would paint over it.
 *
 * `data-armed` is a PRESENCE attribute: Solid 2 writes a boolean `true` as the
 * empty string, so an equality selector never matches.
 *
 * What the arm state does NOT do: it does not survive unmount (`onCleanup`
 * disarms), it does not disarm on blur (tELS's behaviour, kept), and it is not a
 * toggle -- `aria-pressed` is deliberately absent. The state is announced by
 * `title`/`aria-label` changing, which is the only channel a bare `<button>` has
 * that does not claim the wrong role.
 */

/** Default arm window. tELS's 2.5 s, which is what six live call sites are tuned to. */
export const CONFIRM_DELETE_TIMEOUT_MS = 2500;

/**
 * The focus affordance, as four tokens. Passed through `cn()` with everything
 * else — `cn`'s `outline-*` shield is what makes the offset and the colour
 * survive the merge together. See the note above.
 */
const FOCUS_RING =
  "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring/40 focus-visible:outline-offset-2";

const IDLE_TITLE = "Delete";
const ARMED_TITLE = "Click again to confirm delete";

export interface ConfirmDeleteProps {
  /** Runs on the SECOND click. Never on the first. */
  onConfirm: () => void;
  /**
   * Label. Omit entirely for the icon-only row-action form, which is what every
   * tELS call site uses.
   */
  children?: JSX.Element;
  /** Label while armed. Omitted means the label does not change; only the title does. */
  armedChildren?: JSX.Element;
  /** Tooltip / accessible name at rest. Default "Delete". */
  title?: string;
  /** Tooltip / accessible name while armed. Default "Click again to confirm delete". */
  armedTitle?: string;
  /** Arm window in ms. Default `CONFIRM_DELETE_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Button variant for the LABELLED form only. Default `destructive`. */
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
  class?: string;
  /** Glyph size for the ICON form only. Default a 12px square. */
  iconClass?: string;
  disabled?: boolean;
  /**
   * Spelled out for the same reason `ButtonProps` spells it out: TypeScript only
   * exempts hyphenated attributes on intrinsic elements, and `PropEditor` passes
   * `data-prop-editor-remove` as the hook three shipped consumers' CSS selects on.
   */
  [key: `data-${string}`]: string | number | boolean | undefined;
}

export const ConfirmDelete: Component<ConfirmDeleteProps> = (props) => {
  const [armed, setArmed] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Drop the pending arm window. Safe to call from ANY phase, which is the
   * reason it is split out from `disarm` below.
   */
  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function disarm() {
    clearTimer();
    setArmed(false);
  }

  function handleClick(e: MouseEvent) {
    e.stopPropagation();
    if (armed()) {
      // Disarm BEFORE the callback. `onConfirm` is what closes the editor at the
      // PropEditor call site, and a pending timeout firing into an unmounted
      // component is the one way this leaks.
      disarm();
      props.onConfirm();
      return;
    }
    setArmed(true);
    timer = setTimeout(disarm, props.timeoutMs ?? CONFIRM_DELETE_TIMEOUT_MS);
  }

  /*
   * ⚠️ `clearTimer`, NOT `disarm`. Disposal must not write a signal.
   *
   * `onCleanup(disarm)` called `setArmed(false)` from inside the disposal pass,
   * which Solid 2 rejects with [REACTIVE_WRITE_IN_OWNED_SCOPE] — and it throws
   * rather than warning. Because disposal runs *during* the render that unmounts
   * the row, the throw propagates to the host's error boundary: in tELS,
   * deleting a trigger rule removed the rule and then replaced the ENTIRE editor
   * with the boundary's fallback. Measured in a browser, not reasoned about.
   * Every consumer of this control had it, on every unmount — a row delete, a
   * tab switch away, closing the panel.
   *
   * Clearing the timeout is the whole job here anyway: the component is going
   * away, so there is nothing for `armed` to be read by, while a live timer
   * firing into a disposed scope is the actual leak (see `handleClick`, which
   * still disarms for real because it runs while mounted).
   */
  onCleanup(clearTimer);

  const tip = () => (armed() ? (props.armedTitle ?? ARMED_TITLE) : (props.title ?? IDLE_TITLE));

  // `children()` rather than reading `props.children` twice. The form test below
  // and the idle slot would otherwise both evaluate the children getter, which
  // instantiates the JSX twice; a string survives that and a DOM node does not.
  const label = children(() => props.children);
  const armedLabel = children(() => props.armedChildren);

  // Everything this component interprets itself; whatever is left is `data-*` and
  // native button attributes, and those are forwarded.
  const rest = omit(
    props,
    "onConfirm",
    "children",
    "armedChildren",
    "title",
    "armedTitle",
    "timeoutMs",
    "variant",
    "class",
    "iconClass",
    "disabled"
  );

  return (
    <Show
      when={label() !== undefined}
      fallback={
        <button
          type="button"
          disabled={props.disabled}
          data-armed={armed() ? "" : undefined}
          class={cn(
            "shrink-0 rounded-sm", // no transition: one of these per list row
            FOCUS_RING,
            armed() ? "text-destructive" : "text-muted-foreground hover:text-destructive/60",
            props.class
          )}
          onClick={handleClick}
          title={tip()}
          aria-label={tip()}
          {...rest}
        >
          <IconTrash class={props.iconClass ?? "w-3 h-3"} />
        </button>
      }
    >
      <Button
        variant={props.variant ?? "destructive"}
        disabled={props.disabled}
        data-armed={armed() ? "" : undefined}
        class={props.class}
        onClick={handleClick}
        title={tip()}
        {...rest}
      >
        <Show when={armed() && armedLabel() !== undefined} fallback={label()}>
          {armedLabel()}
        </Show>
      </Button>
    </Show>
  );
};

export default ConfirmDelete;
