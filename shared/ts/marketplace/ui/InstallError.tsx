import { Show } from "solid-js";
import type { InstallState } from "./types";

export function InstallError(props: { state: InstallState }) {
  const message = () => {
    const state = props.state;
    return state.state === "done" && !state.ok
      ? (state.error ?? "Could not install this item. Try again.")
      : null;
  };
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
