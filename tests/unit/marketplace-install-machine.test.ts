import { describe, expect, test } from "bun:test";
import {
  INSTALL_ACTION_LABEL,
  INSTALL_FAILED_FALLBACK,
  type InstallState,
  installAction,
  installError,
  isInstallBusy,
  isInstalled,
} from "../../shared/ts/marketplace/install-machine";

const STATES: InstallState[] = [
  { state: "idle" },
  { state: "installing" },
  { state: "uninstalling" },
  { state: "installed" },
  { state: "done", ok: true },
  { state: "done", ok: false },
];

describe("isInstallBusy", () => {
  test("both directions count as busy", () => {
    // The bug this guards: reading only `installing` left the controls live
    // during a removal, so a second request could be fired at an item that was
    // mid-uninstall.
    expect(isInstallBusy({ state: "installing" })).toBe(true);
    expect(isInstallBusy({ state: "uninstalling" })).toBe(true);
  });

  test("a settled state is never busy", () => {
    expect(isInstallBusy({ state: "idle" })).toBe(false);
    expect(isInstallBusy({ state: "installed" })).toBe(false);
    expect(isInstallBusy({ state: "done", ok: true })).toBe(false);
    expect(isInstallBusy({ state: "done", ok: false })).toBe(false);
  });
});

describe("isInstalled", () => {
  test("only the installed state", () => {
    expect(isInstalled({ state: "installed" })).toBe(true);
    // A SUCCESSFUL attempt is not the same as "installed". `done` means the
    // request finished; the installed set is updated separately, and conflating
    // them is how a card showed a delete button for something that was not there.
    expect(isInstalled({ state: "done", ok: true })).toBe(false);
    expect(isInstalled({ state: "idle" })).toBe(false);
  });
});

describe("installError", () => {
  test("a failed attempt carries its own message", () => {
    expect(installError({ state: "done", ok: false, error: "disk full" })).toBe("disk full");
  });

  test("a failed attempt with no message gets the ONE fallback", () => {
    // The drift this replaces: `ItemCard` said "Could not install this item"
    // and `InstallError` said "Could not install this item. Try again." for the
    // same state, so one item worded its failure two ways.
    expect(installError({ state: "done", ok: false })).toBe(INSTALL_FAILED_FALLBACK);
  });

  test("every state that is not a failure is undefined, never a blank string", () => {
    // Call sites render this behind a presence check; "" would paint an empty
    // alert box rather than nothing.
    for (const state of STATES) {
      if (state.state === "done" && !state.ok) continue;
      expect(installError(state)).toBeUndefined();
    }
  });
});

describe("installAction", () => {
  test("names the four things the primary button offers", () => {
    expect(installAction({ state: "idle" })).toBe("install");
    expect(installAction({ state: "installing" })).toBe("installing");
    expect(installAction({ state: "installed" })).toBe("reinstall");
    expect(installAction({ state: "done", ok: false })).toBe("retry");
  });

  test("a successful finish offers an install, not a reinstall", () => {
    // `done, ok` is a finished REQUEST. Until the installed set says otherwise
    // the button is back to its resting state.
    expect(installAction({ state: "done", ok: true })).toBe("install");
  });

  test("an in-flight uninstall offers an install", () => {
    // Documented: the button is disabled by `isInstallBusy` anyway, so what
    // matters is what it will offer once the removal lands.
    expect(installAction({ state: "uninstalling" })).toBe("install");
  });

  test("is total — every state resolves to a label", () => {
    for (const state of STATES) {
      const action = installAction(state);
      expect(INSTALL_ACTION_LABEL[action]).toBeTruthy();
    }
  });
});
