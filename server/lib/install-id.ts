/**
 * The per-install id, resolved from tLib's own `data.json`.
 *
 * The id itself — what it is, what it is not, why it is on every tWeb-bound
 * request and why deleting it is not an opt-out — is documented once, in
 * `shared/ts/install-id.ts`. This file is only the storage half.
 *
 * WHY IT IS NOT WRITTEN THROUGH `tlib.jsonstore`
 *
 * `tlib.jsonstore` is the module that owns a resource's `data.json`, and it is
 * the right answer for every Lua consumer. It is also **Lua**, in tLib's shared
 * VM, and the id has to be resolvable from the NODE bundle — that is where every
 * request is built (`shared/ts/marketplace/catalogue.ts`), and the request path
 * cannot wait on a round trip into another VM for a header.
 *
 * So this is a direct read-modify-write, and it is safe for a reason worth
 * stating rather than assuming: **tLib's own `data.json` has exactly one
 * writer, and it is this file.** `tlib.jsonstore`, `CreateServerSettings` and
 * `CreateDiscovery` all write the *invoking* resource's document — tDetector's,
 * tELS's — never tLib's. Nothing in tLib opens a store on tLib.
 *
 * IF THAT EVER CHANGES, it still holds, but only because this write MERGES:
 * it re-reads the whole document, sets one key and writes it back, which is the
 * same contract `Store:write` honours in the other direction ("the consumer
 * keeps unrelated sections in it"). Do not simplify it into a plain write of
 * `{ installId }`. The failure is silent and total: every other section gone,
 * and only a restart shows it.
 *
 * MINTED ON DEMAND, NOT ON CONSENT
 *
 * It used to be minted lazily and **only when telemetry consent was on**, so an
 * install that never opted in had no id on its disk at all. That property is
 * gone by decision, not by accident: the id is now on marketplace browse, on the
 * version check and on community-configs, all of which run regardless of
 * `tlib_telemetry`. The first of those mints it. Pretending otherwise would mean
 * either a request with no id or a fresh random one per restart, and the second
 * makes the only figure the id exists for silently wrong.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  INSTALL_ID_DATA_FILE,
  INSTALL_ID_KEY,
  isInstallId,
  mintInstallId,
} from "../../shared/ts/install-id";
// `telemetry/fivem.ts` rather than one of the other three copies, because it
// is the only one that resolves its globals LAZILY — its own header explains
// why, and the reason applies verbatim here: this module is reachable from the
// header builders before `onResourceStart`, so a handle captured at module
// scope makes "has the host installed its globals" a load-order question.
import { fGetCurrentResourceName, fGetResourcePath } from "./telemetry/fivem";

/** Memoised after the first successful resolve. `""` is never cached. */
let cached: string | null = null;

function dataFile(): string | null {
  try {
    const root = fGetResourcePath(fGetCurrentResourceName());
    return root ? path.join(root, INSTALL_ID_DATA_FILE) : null;
  } catch {
    return null;
  }
}

/**
 * The whole document, or `{}`.
 *
 * An unparseable `data.json` answers `{}` for READING and is handled as a
 * refusal to WRITE below — the same split `tlib.jsonstore` makes, and for its
 * reason: a reader that returns empty is right, and a writer that treats empty
 * as "brand new install" would put a one-key document over the owner's
 * configuration.
 */
function readDocument(target: string): { doc: Record<string, unknown>; parseable: boolean } {
  try {
    if (!fs.existsSync(target)) return { doc: {}, parseable: true };
    const raw = fs.readFileSync(target, "utf8");
    if (raw.trim() === "") return { doc: {}, parseable: true };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { doc: {}, parseable: false };
    }
    return { doc: parsed as Record<string, unknown>, parseable: true };
  } catch {
    return { doc: {}, parseable: false };
  }
}

/**
 * The id, minting and persisting one on the first call that finds none.
 *
 * Answers `""` rather than a fabricated id when the document cannot be read or
 * written — and the direction matters. A fresh random id per boot would look
 * like a brand-new install every time, and the one thing the id exists for —
 * telling one install making a thousand requests from a thousand installs
 * making one — would be silently wrong. An absent header is a state tWeb
 * handles.
 */
export function installId(): string {
  if (cached) return cached;

  const target = dataFile();
  if (!target) return "";

  const { doc, parseable } = readDocument(target);

  const existing = doc[INSTALL_ID_KEY];
  if (isInstallId(existing)) {
    cached = existing;
    return existing;
  }

  // No write over a document that did not parse. The id is worth less than
  // somebody's configuration, and a file a text editor broke is still fixable
  // by hand until something overwrites it.
  if (!parseable) return "";

  const minted = mintInstallId();
  try {
    doc[INSTALL_ID_KEY] = minted;
    fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  } catch {
    // NOT cached, and not returned. A read-only disk would otherwise hand out
    // one id for this session and a different one next boot, which is the
    // per-restart randomness this whole function exists to avoid.
    return "";
  }
  cached = minted;
  return minted;
}

/** Tests only. */
export function resetInstallIdCache(): void {
  cached = null;
}
