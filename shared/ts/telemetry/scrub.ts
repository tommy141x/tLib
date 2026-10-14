/**
 * Everything that leaves a player's machine goes through here first.
 *
 * Scrubbing happens before send because the store cannot delete a row: a value
 * that reaches it is there until it expires. Three rules — credential shapes, the
 * user's name out of a path, and values the Lua side declares as the player's —
 * over a payload that collects almost nothing to begin with.
 *
 * Why each rule is narrow, and the two defects the suite caught:
 * docs/internal/telemetry-scrubbing.md
 */

/**
 * Query/JSON keys whose VALUE is blanked. Matched case-insensitively as a whole
 * word, so `tokens` or `keyboard` are not caught by `token`/`key`. Deliberately
 * not derived from `Diag.SECRET_PATTERNS`, which matches key names in a
 * structured document rather than arbitrary prose.
 */
const SECRET_KEYS = [
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "key",
  "secret",
  "password",
  "passwd",
  "pass",
  "auth",
  "authorization",
  "session",
  "sessionid",
  "sid",
  "cookie",
  "credential",
  "credentials",
  "signature",
  "sig",
  "license",
  "licence",
] as const;

const SECRET_KEY_ALT = SECRET_KEYS.join("|");

/** `?token=abc`, `&api_key=abc`, `#secret=abc` — URL query/fragment pairs. */
const QUERY_PAIR = new RegExp(`([?&#;](?:${SECRET_KEY_ALT})=)[^&#\\s"']+`, "gi");

/** `"token": "abc"` / `token=abc` / `token: abc` in a message or JSON blob. */
const ASSIGNED_PAIR = new RegExp(
  `(\\b(?:${SECRET_KEY_ALT})\\b\\s*["']?\\s*[:=]\\s*["']?)[^\\s,;}"']+`,
  "gi"
);

/**
 * The same thing where the key name is a SUFFIX: `adminPassword`, `s3_secret`.
 * `ASSIGNED_PAIR`'s `\b` does not exist inside either spelling, so neither was
 * redacted until this was added.
 *
 * Narrower than `SECRET_KEYS` on purpose — `pass`, `key` and `sig` are common
 * English endings and `low_pass` is a real config key.
 */
const SUFFIX_KEYS = [
  "secretaccesskey",
  "refreshtoken",
  "accesstoken",
  "credentials",
  "authorization",
  "credential",
  "accesskey",
  "secretkey",
  "sessionid",
  "password",
  "apisecret",
  "passwd",
  "licence",
  "license",
  "apikey",
  "cookie",
  "secret",
  "token",
] as const;

/**
 * The camelCase forms, longest first so the longest compound wins. Written out
 * rather than derived from `SUFFIX_KEYS`: capitalising the first letter yields
 * `Secretaccesskey`, which does not match `s3SecretAccessKey`.
 */
const CAMEL_KEYS = [
  "SecretAccessKey",
  "RefreshToken",
  "AccessToken",
  "Authorization",
  "Credentials",
  "Credential",
  "SecretKey",
  "AccessKey",
  "ApiSecret",
  "SessionId",
  "Password",
  "Licence",
  "License",
  "ApiKey",
  "Cookie",
  "Passwd",
  "Secret",
  "Token",
] as const;

const CAMEL_ALT = CAMEL_KEYS.join("|");

const CAMEL_SUFFIX_PAIR = new RegExp(
  `([A-Za-z0-9]*[a-z0-9](?:${CAMEL_ALT})\\b\\s*["']?\\s*[:=]\\s*["']?)[^\\s,;}"']+`,
  "g"
);

const SNAKE_SUFFIX_PAIR = new RegExp(
  `([A-Za-z0-9]+[_.-](?:${SUFFIX_KEYS.join("|")})\\b\\s*["']?\\s*[:=]\\s*["']?)[^\\s,;}"']+`,
  "gi"
);

/** `Authorization: Bearer <jwt>`, and a bare JWT anywhere in the text. */
const BEARER = /\b(bearer|basic)\s+[\w\-._~+/]+=*/gi;
const JWT = /\beyJ[\w-]*\.[\w-]+\.[\w-]+/g;

export const REDACTED = "[redacted]";

/** What replaces the home-directory segment of a path. */
export const HOME = "<home>";

/**
 * Home directories on the three platforms a FiveM client or server runs on. Both
 * separator styles on every one of them: a Windows FXServer logs `C:/Users/…` as
 * often as `C:\Users\…`, so matching only backslashes would miss half.
 */
const HOME_DIRS: RegExp[] = [
  /\b[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/g,
  /\/home\/[^\\/\s"']+/g,
  /\/Users\/[^\\/\s"']+/g,
  // The Windows profile root without a `Users` segment, as `%USERPROFILE%`
  // expands on a domain-joined machine.
  /\b[A-Za-z]:[\\/]Documents and Settings[\\/][^\\/\s"']+/g,
];

/**
 * Blank credential-shaped values in an arbitrary string. Exported separately so a
 * future log sink reuses this list rather than inventing a second one.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(JWT, REDACTED)
    .replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(QUERY_PAIR, (_m, lead: string) => `${lead}${REDACTED}`)
    .replace(ASSIGNED_PAIR, (_m, lead: string) => `${lead}${REDACTED}`)
    .replace(CAMEL_SUFFIX_PAIR, (_m, lead: string) => `${lead}${REDACTED}`)
    .replace(SNAKE_SUFFIX_PAIR, (_m, lead: string) => `${lead}${REDACTED}`);
}

/** Replace the home-directory prefix of any absolute path with `<home>`. */
export function scrubPaths(text: string): string {
  let out = text;
  for (const rule of HOME_DIRS) out = out.replace(rule, HOME);
  return out;
}

/**
 * The ingest's charset admits every FiveM player identifier verbatim, so these are
 * blanked here rather than relied on being refused remotely — a refused event is a
 * lost event, and the store cannot delete a row.
 */
const IDENTIFIERS: RegExp[] = [
  // The namespaces from `GetPlayerIdentifiers`; `license2` exists alongside
  // `license`, hence the optional digit.
  /\b(?:steam|license[0-9]?|discord|fivem|live|xbl|ip|playerip|cfx)[:.][0-9a-f]{6,64}\b/gi,
  // A bare Steam id or Discord snowflake. 15–20 digits: narrow enough not to eat a
  // timestamp, wide enough for both id spaces.
  /\b[0-9]{15,20}\b/g,
  // IPv4, in any of the separator forms a naive slugger produces.
  /\b(?:[0-9]{1,3}[._-]){3}[0-9]{1,3}\b/g,
  // `C:Users.Tommy.Documents`, matched on shape so it needs no known account name.
  // The real `\` and `/` are here too, and that is not redundancy with
  // `scrubPaths`: `slug()` calls this function and not that one.
  /\b[A-Za-z]:?[\\/._-]?Users[\\/._-][^\s\\/.:_-]+/g,
  /\bhome[\\/._-][^\s\\/.:_-]+/g,
];

/** Blank anything shaped like a player or machine identifier. */
export function scrubIdentifiers(text: string): string {
  let out = text;
  for (const rule of IDENTIFIERS) out = out.replace(rule, REDACTED);
  return out;
}

/**
 * Values this machine knows to be identifying. A `Set`, because the Lua side can
 * register the same environment twice and the replace list must not grow unbounded
 * over a long session.
 */
const identifying = new Set<string>();

/**
 * Shortest value worth blanking, and the floor is load-bearing: a player named
 * `Al` would turn every `Alignment` and `Alt` in a stack into `[redacted]ignment`,
 * and an unreadable report is the same failure as no report.
 */
const MIN_IDENTIFYING_LENGTH = 3;

/**
 * Declare a value as the reporting player's, so it never leaves the machine.
 * Returns whether it was taken, so a caller can tell "registered" from "too short
 * to be safe to blank".
 */
export function registerScrubValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length < MIN_IDENTIFYING_LENGTH) return false;
  identifying.add(v);
  return true;
}

/** Tests only: a suite that registered a name must not leak it into the next. */
export function resetScrubValues(): void {
  identifying.clear();
}

/** The registered values, longest first. Exported for the suite's benefit. */
export function scrubValues(): string[] {
  return [...identifying].sort((a, b) => b.length - a.length);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Blank every registered identifying value. Longest first. */
export function scrubIdentifying(text: string): string {
  let out = text;
  for (const value of scrubValues()) {
    out = out.replace(new RegExp(escapeRegExp(value), "gi"), REDACTED);
  }
  return out;
}

/**
 * The one function every outbound string goes through. The order is asserted:
 * identifying values first, because a player name commonly IS the Windows account
 * name and collapsing the path to `<home>` would destroy the evidence; credentials
 * last, so a redaction marker cannot be mistaken for a key's value.
 */
export function scrub(text: unknown): string {
  if (typeof text !== "string") return "";
  return redactSecrets(scrubIdentifiers(scrubPaths(scrubIdentifying(text))));
}
