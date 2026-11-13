import { Show } from "solid-js";
import { FAILURE_COPY, type MarketplaceFailureKind } from "../failure";
import { installError } from "../install-machine";
import type { InstallState } from "./types";

export function InstallError(props: { state: InstallState }) {
  // `installError` owns the fallback now. This file and `ItemCard.tsx` each had
  // their own, and they did not match.
  const message = () => installError(props.state);
  return (
    <Show when={message()}>
      <p role="alert" class="mp-inline-error">
        {message()}
      </p>
    </Show>
  );
}

/** `kind` is absent for a host still passing only a message; it then reads as a generic failure. */
export function ErrorPane(props: { message: string; kind?: MarketplaceFailureKind }) {
  const copy = () => FAILURE_COPY[props.kind ?? "error"];
  return (
    <div role="alert" class="mp-empty">
      <span class="mp-inline-error">{copy().title}</span>
      <span class="mp-muted">{copy().advice}</span>
      <span class="mp-muted">{props.message}</span>
    </div>
  );
}
