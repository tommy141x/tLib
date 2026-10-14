/**
 * Consent — one fact, one control.
 *
 * THE MODEL THIS SUITE DEFENDS, which is the owner's and not an
 * implementation detail:
 *
 *     tlib_telemetry SET   -> the convar is the answer, the hub switch is HIDDEN
 *     tlib_telemetry UNSET -> the switch is visible and owns the answer
 *     neither              -> OFF
 *
 * It is deliberately **not** an OR of two switches. A switch that is visible,
 * reads "off", and is overridden by a convar the operator forgot they set is a
 * control that lies — so `resolve()` answers the state AND which source decided
 * it, and the `locked` flag is what hides the control.
 *
 * AND THE DEFAULT IS THE OTHER HALF OF THE CONTRACT. A diagnostics feature
 * whose default is on is not opt-in, whatever its documentation says. The
 * `source: "default"` case below is the one that must never be allowed to drift.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONSENT_FILE,
  readStoredSwitch,
  resolve,
  setStoredSwitch,
  TELEMETRY_CONVAR,
} from "../../server/lib/telemetry/consent";

const g = globalThis as unknown as Record<string, unknown>;
let root: string;
let convars: Record<string, string>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tlib-consent-"));
  convars = {};
  // The FiveM globals `consent.ts` reaches through, stubbed. The REAL module is
  // under test — nothing here substitutes its logic, only its host.
  g.GetConvar = (name: string, fallback: string) => convars[name] ?? fallback;
  g.GetCurrentResourceName = () => "tLib";
  g.GetResourcePath = () => root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete g.GetConvar;
  delete g.GetCurrentResourceName;
  delete g.GetResourcePath;
});

describe("the default", () => {
  test("nothing set is OFF, and says the default decided", () => {
    const c = resolve();
    expect(c.enabled).toBe(false);
    expect(c.source).toBe("default");
    // Not locked: the hub must SHOW the switch so somebody can opt in.
    expect(c.locked).toBe(false);
  });

  test("no file is written by merely asking", () => {
    // "We do not send anything" and "we do not store a decision" are
    // different promises, and only the second is honest about an opt-in default.
    //
    // THE INSTALL ID IS NOT PART OF THIS ANY MORE. It used to be asserted
    // here — no id minted until consent said yes — and it is now minted by any
    // tWeb-bound request, consent or not. See tests/unit/install-id.test.ts.
    resolve();
    expect(existsSync(join(root, CONSENT_FILE))).toBe(false);
  });
});

describe("the convar hides the switch", () => {
  const truthy = ["1", "true", "TRUE", "yes", "on", "enabled"];
  for (const value of truthy) {
    test(`'${value}' enables it, and locks the switch`, () => {
      convars[TELEMETRY_CONVAR] = value;
      const c = resolve();
      expect(c.enabled).toBe(true);
      expect(c.source).toBe("convar");
      expect(c.locked).toBe(true);
      expect(c.convarValue).toBe(value);
    });
  }

  const falsy = ["0", "false", "no", "off", "disabled"];
  for (const value of falsy) {
    test(`'${value}' disables it, and still locks the switch`, () => {
      convars[TELEMETRY_CONVAR] = value;
      const c = resolve();
      expect(c.enabled).toBe(false);
      expect(c.locked).toBe(true);
    });
  }

  test("an UNPARSEABLE value is still a decision — off, and locked", () => {
    /**
     * UNSET and SET-TO-NONSENSE are different answers and both matter. An
     * operator who wrote `set tlib_telemetry maybe` plainly intended to decide;
     * treating that as unset would show them a switch whose state they think
     * they already chose. So the value they wrote is reported back instead of a
     * control.
     */
    convars[TELEMETRY_CONVAR] = "maybe";
    const c = resolve();
    expect(c.enabled).toBe(false);
    expect(c.source).toBe("convar");
    expect(c.locked).toBe(true);
    expect(c.convarValue).toBe("maybe");
  });

  test("whitespace and case do not change the answer", () => {
    convars[TELEMETRY_CONVAR] = "  True  ";
    expect(resolve().enabled).toBe(true);
  });

  test("an EMPTY convar is unset, not false — the switch stays visible", () => {
    convars[TELEMETRY_CONVAR] = "";
    expect(resolve().source).toBe("default");
    expect(resolve().locked).toBe(false);
  });

  test("the convar WINS over a stored switch, and is not an OR with it", () => {
    writeFileSync(join(root, CONSENT_FILE), JSON.stringify({ enabled: true }));
    convars[TELEMETRY_CONVAR] = "0";
    const c = resolve();
    // An OR would answer `true` here. That is the bug this model exists to avoid.
    expect(c.enabled).toBe(false);
    expect(c.source).toBe("convar");
  });
});

describe("the stored switch", () => {
  test("it owns the answer when the convar is unset", () => {
    writeFileSync(join(root, CONSENT_FILE), JSON.stringify({ enabled: true }));
    const c = resolve();
    expect(c.enabled).toBe(true);
    expect(c.source).toBe("switch");
    expect(c.locked).toBe(false);
  });

  test("setting it writes a file the next resolve reads", () => {
    expect(setStoredSwitch(true).ok).toBe(true);
    expect(readStoredSwitch()).toBe(true);
    expect(resolve().enabled).toBe(true);
    expect(setStoredSwitch(false).ok).toBe(true);
    expect(resolve().enabled).toBe(false);
    // Off is a real stored state, distinct from unset.
    expect(resolve().source).toBe("switch");
  });

  test("a corrupt file is UNSET rather than off", () => {
    // Off and unset differ in what the hub renders, and a corrupt file is not
    // evidence of a decision. Showing the switch again is the recoverable way
    // to be wrong.
    writeFileSync(join(root, CONSENT_FILE), "{not json");
    expect(readStoredSwitch()).toBeNull();
    expect(resolve().source).toBe("default");
  });

  test("a file with the wrong shape is UNSET rather than truthy", () => {
    writeFileSync(join(root, CONSENT_FILE), JSON.stringify({ enabled: "yes" }));
    expect(readStoredSwitch()).toBeNull();
  });

  test("⚠️ writing is REFUSED while the convar has decided", () => {
    /**
     * A hub showing no switch cannot reach this, but an export can — and an
     * export that silently stored an unused preference is exactly how "I turned
     * it off and it kept sending" happens.
     */
    convars[TELEMETRY_CONVAR] = "1";
    const r = setStoredSwitch(false);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("locked");
    expect(r.ok === false && r.detail).toContain(TELEMETRY_CONVAR);
    expect(existsSync(join(root, CONSENT_FILE))).toBe(false);
  });

  test("it is NOT named data.json, which a release archive refuses", () => {
    // shared/ts/build/runtime-state-contract.ts refuses that basename in a
    // release, because an update is an unzip over the live install.
    expect(CONSENT_FILE).not.toBe("data.json");
    expect(CONSENT_FILE.startsWith("data.json")).toBe(false);
  });
});
