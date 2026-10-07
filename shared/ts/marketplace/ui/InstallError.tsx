import { Show } from "solid-js";
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

export function ErrorPane(props: { message: string }) {
  return (
    <div role="alert" class="mp-empty">
      <span class="mp-inline-error">Failed to load marketplace</span>
      <span class="mp-muted">{props.message}</span>
    </div>
  );
}
