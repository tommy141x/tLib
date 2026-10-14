/**
 * The per-install random id. Travels as `x-install-id` on every tWeb-bound
 * request, not just diagnostics; the operator-facing statement of what that
 * means is in `docs/content/convars.mdx`.
 *
 * It is derived from nothing — no licence key, no endpoint, no fingerprint —
 * which is a stronger claim than "anonymised" and the reason it is not a hash:
 * hashing `sv_licenseKey` is reversible by whoever holds the licence keys, and
 * would put a credential on a path that reports to a website.
 *
 * `tlib_telemetry` does not govern it. Deleting it is not an opt-out either: it
 * is minted whenever a request needs one, so deletion only makes this install
 * look like a new one.
 */

/** Characters the dimension charset allows and that are unambiguous to read. */
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 25 characters of base36, ~129 bits. A collision means two installs counted as one. */
export const INSTALL_ID_LENGTH = 25;

/**
 * The document the id lives in, relative to tLib's own resource root. Not a file
 * of its own: `R-DATA-FILE` already keeps this basename out of a release at any
 * depth, so the id survives an update and a fresh install mints a new one.
 */
export const INSTALL_ID_DATA_FILE = "data.json";

/** The key inside that document. Not `telemetryInstallId`: the convar does not govern it. */
export const INSTALL_ID_KEY = "installId";

/**
 * The wire header the id travels as. tWeb validates the value against
 * `/^[0-9a-z]{25}$/`; `isInstallId` below is this side's copy of that pattern and
 * the two must not drift.
 */
export const INSTALL_ID_HEADER = "x-install-id";

/**
 * `true` when `value` is a well-formed id. Strict on purpose: a truncated write or
 * a stray newline would travel as a dimension and group nothing, and a fresh id is
 * cheaper than a broken one.
 */
export function isInstallId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length === INSTALL_ID_LENGTH && /^[0-9a-z]+$/.test(value)
  );
}

/**
 * Mint one. The `Math.random` fallback is not a weakness: the id authenticates
 * nothing and grants no access, it only has to be unlikely to collide. Requiring
 * WebCrypto would leave a runtime without it holding no id at all.
 */
export function mintInstallId(random: (n: number) => Uint8Array = defaultRandom): string {
  const bytes = random(INSTALL_ID_LENGTH);
  let out = "";
  for (let i = 0; i < INSTALL_ID_LENGTH; i += 1) {
    // ~1.6% modulo bias on the first four symbols. Fine for collision avoidance;
    // this is not a key derivation.
    out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  }
  return out;
}

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => void } }).crypto;
  if (typeof c?.getRandomValues === "function") {
    c.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < n; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/**
 * A seam, and not for testability: this module is compiled into every consumer's
 * server bundle, so a static import of the reader would give each of them tLib's
 * filesystem access and a DIFFERENT id resolved from its own directory. tLib's
 * `server/main.ts` installs the real resolver at boot; a bundle without one omits
 * the header rather than inventing a second id.
 */
let resolver: (() => string) | null = null;

/** Install the real resolver. Called once, from tLib's `server/main.ts`. */
export function setInstallIdResolver(fn: (() => string) | null): void {
  resolver = fn;
}

/**
 * The id, or `""` when nothing can resolve one. Never throws: the alternative is a
 * marketplace browse failing over a header.
 */
export function currentInstallId(): string {
  if (!resolver) return "";
  try {
    const value = resolver();
    return isInstallId(value) ? value : "";
  } catch {
    return "";
  }
}

/**
 * `{ "x-install-id": <id> }`, or nothing. Omitted rather than sent empty: an empty
 * value fails tWeb's pattern, and a 400 on a browse reads as "the marketplace is
 * down".
 */
export function installIdHeaders(): Record<string, string> | undefined {
  const id = currentInstallId();
  return id ? { [INSTALL_ID_HEADER]: id } : undefined;
}
