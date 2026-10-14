/**
 * The per-install id — the generation semantics, the storage, and the header.
 *
 * THIS SUITE IS THE SUCCESSOR TO THE INSTALL-ID BLOCK IN
 * `telemetry-consent.test.ts`. The id used to be minted only when telemetry
 * consent was on and lived in `telemetry-install-id.txt`, so its tests lived
 * with consent's. It now lives inside tLib's own `data.json` and rides on every
 * tWeb-bound request regardless of `tlib_telemetry`, so the one thing that must
 * NOT get lost in the move is the generation contract: minted once, 25
 * characters of base36, validated strictly, and never re-randomised per boot.
 * Every assertion that was there is here.
 *
 * WHAT THIS CANNOT PROVE: that tWeb accepts the header. Its
 * `analytics.ingest` flag is off and the route answers 503, and nothing here
 * runs against a live FXServer either. What is proven is what this side sends.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installId, resetInstallIdCache } from "../../server/lib/install-id";
import {
  currentInstallId,
  INSTALL_ID_DATA_FILE,
  INSTALL_ID_HEADER,
  INSTALL_ID_KEY,
  INSTALL_ID_LENGTH,
  installIdHeaders,
  isInstallId,
  mintInstallId,
  setInstallIdResolver,
} from "../../shared/ts/install-id";

const g = globalThis as unknown as Record<string, unknown>;
let root: string;

const dataPath = (): string => join(root, INSTALL_ID_DATA_FILE);
const readDoc = (): Record<string, unknown> =>
  JSON.parse(readFileSync(dataPath(), "utf8")) as Record<string, unknown>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tlib-install-id-"));
  // The FiveM globals the resolver reaches through, stubbed. The REAL module is
  // under test — nothing here substitutes its logic, only its host.
  g.GetCurrentResourceName = () => "tLib";
  g.GetResourcePath = () => root;
  resetInstallIdCache();
  setInstallIdResolver(null);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete g.GetCurrentResourceName;
  delete g.GetResourcePath;
  resetInstallIdCache();
  setInstallIdResolver(null);
});

describe("the shape of an id", () => {
  test("25 characters of base36, and the validator agrees with the minter", () => {
    const id = mintInstallId();
    expect(id).toHaveLength(INSTALL_ID_LENGTH);
    expect(INSTALL_ID_LENGTH).toBe(25);
    expect(id).toMatch(/^[0-9a-z]{25}$/);
    expect(isInstallId(id)).toBe(true);
  });

  /**
   * Deliberately strict. A truncated write, a hand-edit or a stray newline
   * all produce a value that would fail tWeb's own `/^[0-9a-z]{25}$/` and turn
   * an ordinary browse into a 400 — which reads, at the panel, as "the
   * marketplace is down".
   */
  test("anything else is refused", () => {
    expect(isInstallId("")).toBe(false);
    expect(isInstallId("short")).toBe(false);
    expect(isInstallId(`${mintInstallId()}x`)).toBe(false);
    expect(isInstallId(`${mintInstallId().slice(1)}A`)).toBe(false);
    expect(isInstallId(`${mintInstallId()}\n`)).toBe(false);
    expect(isInstallId(null)).toBe(false);
    expect(isInstallId(25)).toBe(false);
  });

  test("two mints differ, so the id is random and not derived", () => {
    // It must not be a hash of the licence key, the endpoint or anything
    // else. Two fresh installs must not collide and must not be relatable.
    expect(mintInstallId()).not.toBe(mintInstallId());
  });
});

describe("storage", () => {
  test("it is minted once, written to data.json, and then stable", () => {
    const first = installId();
    expect(isInstallId(first)).toBe(true);
    expect(readDoc()[INSTALL_ID_KEY]).toBe(first);

    // Memoised, and still the same answer with the memo dropped — the file is
    // the authority, not the cache.
    expect(installId()).toBe(first);
    resetInstallIdCache();
    expect(installId()).toBe(first);
  });

  test("it is a key inside data.json, not a file of its own", () => {
    installId();
    expect(existsSync(join(root, "telemetry-install-id.txt"))).toBe(false);
    expect(INSTALL_ID_DATA_FILE).toBe("data.json");
  });

  /**
   * THE ONE THAT WOULD BE SILENT AND TOTAL. `data.json` is shared — a
   * consumer's props, soundstore's maps, an operator's settings. A write that
   * replaced the document with `{ installId }` would lose all of it, and only a
   * restart would show it.
   */
  test("minting MERGES into the document and loses no other key", () => {
    writeFileSync(
      dataPath(),
      JSON.stringify({ props: [1, 2, 3], settings: { volume: 65 } }, null, 2)
    );
    const id = installId();
    const doc = readDoc();
    expect(doc[INSTALL_ID_KEY]).toBe(id);
    expect(doc.props).toEqual([1, 2, 3]);
    expect(doc.settings).toEqual({ volume: 65 });
  });

  test("a corrupt or truncated value is replaced rather than used", () => {
    writeFileSync(dataPath(), JSON.stringify({ [INSTALL_ID_KEY]: "not-an-id" }));
    const id = installId();
    expect(isInstallId(id)).toBe(true);
    expect(id).not.toBe("not-an-id");
  });

  /**
   * A document that does not PARSE is left alone entirely — no id, no write.
   * The same split `tlib.jsonstore` makes: an empty read is right for a reader,
   * and treating it as "brand new install" is how a one-key document lands on
   * top of somebody's configuration. The id is worth less than their data.
   */
  test("an unparseable data.json is never overwritten, and answers no id", () => {
    writeFileSync(dataPath(), "{ this is not json");
    expect(installId()).toBe("");
    expect(readFileSync(dataPath(), "utf8")).toBe("{ this is not json");
  });

  /**
   * The direction matters. A fresh random id on every boot would look like a
   * brand-new install each time, and the only thing the id exists for — telling
   * one install making a thousand requests from a thousand installs making one
   * — would be silently wrong. An absent header is a state tWeb handles.
   */
  test("an unresolvable path answers '' rather than a per-restart random id", () => {
    g.GetResourcePath = () => null;
    resetInstallIdCache();
    expect(installId()).toBe("");
  });
});

describe("the header", () => {
  test("it is the lower-case name tWeb matches, and carries the resolved id", () => {
    expect(INSTALL_ID_HEADER).toBe("x-install-id");
    setInstallIdResolver(installId);
    const id = currentInstallId();
    expect(isInstallId(id)).toBe(true);
    expect(installIdHeaders()).toEqual({ [INSTALL_ID_HEADER]: id });
  });

  /**
   * OMITTED, never sent blank — an empty value fails tWeb's pattern. And a
   * bundle with no resolver installed (every consumer's, since the reader is
   * tLib's own) sends no header rather than inventing a second id from its own
   * directory.
   */
  test("no resolver, a throwing one, and a malformed answer all omit it", () => {
    expect(installIdHeaders()).toBeUndefined();

    setInstallIdResolver(() => {
      throw new Error("no host");
    });
    expect(currentInstallId()).toBe("");
    expect(installIdHeaders()).toBeUndefined();

    setInstallIdResolver(() => "not-an-id");
    expect(currentInstallId()).toBe("");
    expect(installIdHeaders()).toBeUndefined();
  });
});
