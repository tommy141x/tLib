/**
 * What may be spawned, by whom, with which arguments.
 *
 * This file is the security control. `add_unsafe_child_process_permission tLib`
 * is a grant to run *anything*; everything narrower than that is written down
 * here, and nothing outside this file can widen it.
 *
 * ## The order of strength, and where each rung actually stops
 *
 *  1. **Which resource is calling** — `GetInvokingResource()`, taken from the
 *     engine, not from the payload, so a caller cannot claim to be someone
 *     else. Strong *as an identity of the calling script container*. It is NOT
 *     a statement about who wrote that container: a folder named `tAI`
 *     containing hostile code passes this check, exactly as it passes today's
 *     `add_unsafe_child_process_permission tAI`. Consolidating the grants does
 *     not make that worse, and it does not make it better. Nothing here should
 *     ever be described as if it did.
 *
 *  2. **What is being spawned** — the real control, and the reason this is an
 *     improvement over four cfg lines. A caller names a *program declared
 *     below*; it never passes a path. tLib resolves the path itself, requires
 *     it to be inside the caller's own resource directory after `realpath`,
 *     builds the argv from the declared shape, and execs with `shell: false`.
 *     A compromised caller can therefore ask for `pocketbase serve` with
 *     different directories — it cannot ask for `cmd.exe`, cannot reach a
 *     binary in another resource, and cannot append a second command.
 *
 *  3. **The author in the caller's fxmanifest** — `author` metadata. Recorded
 *     and logged when it does not match, never consulted for the decision. A
 *     hostile resource writes whatever author it likes in its own manifest, so
 *     this catches an accidental fork or a copied folder, not an attacker.
 *     Treating a match as authorisation would be a straightforward mistake;
 *     `gate.ts` deliberately has no branch on it.
 *
 * ## Why the programs are not SHA-256 pinned
 *
 * tLib already has a pinned-asset system (`shared/ts/assets`) and it is the
 * right tool when tLib can know the hash. It cannot here:
 *
 *  - PocketBase **updates itself** (`pocketbase update`, tDB's `AutoUpdate`), so
 *    its hash changes underneath any pin tLib could ship.
 *  - `llama-server`, `whisper-server`, `piper` and the vendored Node are fetched
 *    per platform and per upstream release by each product's own setup script,
 *    which verifies them against the publisher's checksums at fetch time. tLib
 *    would have to carry a hash table per product per version per platform and
 *    would block a legitimate upgrade the day it went stale.
 *
 * So pinning is *supported* — set `sha256` on a program and the gate enforces it
 * before the exec — and currently used by nothing. That is a real, stated gap,
 * not an oversight: the integrity guarantee for these binaries lives at fetch
 * time in each product, and the containment rule above is what tLib adds.
 */

/** The two platforms FXServer ships for. */
export type Platform = "win32" | "linux";

/**
 * What one argument token is allowed to look like.
 *
 * `shell: false` and an argv array already mean a metacharacter is just a
 * character — there is no shell to interpret it, so `;` in a filename cannot
 * chain a command. The kinds below are therefore about *shape* rather than
 * quoting, with two exceptions worth stating:
 *
 *  - A NUL byte is rejected everywhere. It is the one character that genuinely
 *    changes meaning at the syscall boundary, by truncating the string the OS
 *    actually sees.
 *  - `text` additionally rejects shell metacharacters. Nothing depends on that
 *    today; it is there so a future caller that does reach a shell inherits a
 *    value that was never allowed to carry one.
 */
export type ValueKind =
  | "path"
  | "int"
  | "port"
  | "loopback"
  | "loopbackAddress"
  | "word"
  | "email"
  | "secret"
  | "text";

export interface FlagSpec {
  /** Including the leading dashes, e.g. `--dir` or `-f`. */
  name: string;
  /**
   * `bare`   — the flag stands alone.
   * `value`  — a separate following token carries the value.
   * `inline` — `--name=value`.
   * `either` — both accepted.
   */
  form: "bare" | "value" | "inline" | "either";
  value?: ValueKind;
  /** Kept out of every log line. Used for the PocketBase superuser password. */
  redact?: boolean;
}

/**
 * One permitted way of invoking a program.
 *
 * `head` is an exact ordered prefix — this is what stops a positional value kind
 * from turning the whole spec into "anything goes". `pocketbase superuser upsert
 * <email> <secret>` is a shape; an `<email>` on its own is not, so a token that
 * happens to look like an email cannot appear where a subcommand belongs.
 *
 * Everything after `head` is drawn from `flags`, in any order, at most once
 * each.
 */
export interface Invocation {
  /** For refusal messages and logs: `pocketbase serve`, not "invocation 2". */
  label: string;
  head: ({ lit: string } | { val: ValueKind; redact?: boolean })[];
  flags: FlagSpec[];
}

export interface Program {
  id: string;
  /**
   * Resource-relative candidate paths, first existing one wins.
   *
   * Relative and declared here rather than passed in, because a path the caller
   * chooses is a path the caller can aim.
   */
  paths: Record<Platform, string[]>;
  /**
   * A bundled glibc loader to exec instead, when one is present.
   *
   * Some hosts' libc cannot run an `ubuntu-x64` build at all, so the product
   * ships `ld-linux-x86-64.so.2` and its libraries. tLib builds that argv
   * (`<loader> --library-path <dir> <binary> …`) rather than letting the caller
   * hand over a command, which would be a path the caller aims again.
   */
  loaderDir?: string;
  /**
   * Resource-relative paths tLib puts in front of the caller's arguments.
   *
   * For an interpreter: the vendored Node runs `bin/tts-sidecar.js`, and that
   * script is a *path*, which is the one thing a caller may never choose. So the
   * catalog names it, tLib resolves it through the same containment rule as the
   * executable, and the caller's arguments start after it. A caller that could
   * pass the script could run any JavaScript on the box through a binary the
   * gate had already approved.
   */
  prepend?: string[];
  /** Resource-relative working directories the caller may pick. `""` is the root. */
  cwd: string[];
  /** Environment variable names the caller may add. Values must be `path`-shaped. */
  env: string[];
  invocations: Invocation[];
  /**
   * Lowercase hex sha256, any one of which is accepted. Enforced when present.
   * Empty for every program today — see the header for why.
   */
  sha256?: string[];
}

export interface Caller {
  resource: string;
  /**
   * The `author` its fxmanifest is expected to declare.
   *
   * Defence in depth only. See rung 3 in the header: this is logged on a
   * mismatch and never gates anything.
   */
  author: string;
  programs: Program[];
}

// ── Shared argument vocabulary ───────────────────────────────────────────────

/**
 * llama.cpp's server, which tAI and tRadio both run.
 *
 * `--host` is `loopback`, not `text`: an engine that can be told to bind
 * `0.0.0.0` is an unauthenticated model server on the public internet, and it is
 * free to make that unrepresentable here.
 */
const LLAMA_SERVER_FLAGS: FlagSpec[] = [
  { name: "--model", form: "value", value: "path" },
  { name: "--host", form: "value", value: "loopback" },
  { name: "--port", form: "value", value: "port" },
  { name: "--ctx-size", form: "value", value: "int" },
  { name: "--parallel", form: "value", value: "int" },
  { name: "--cont-batching", form: "bare" },
  { name: "--threads", form: "value", value: "int" },
  { name: "--threads-batch", form: "value", value: "int" },
  { name: "--poll", form: "value", value: "int" },
  { name: "--prio", form: "value", value: "int" },
  { name: "--slot-save-path", form: "value", value: "path" },
  { name: "--cache-reuse", form: "value", value: "int" },
  { name: "--n-gpu-layers", form: "value", value: "int" },
  { name: "--cpu-mask", form: "value", value: "word" },
  { name: "--cpu-strict", form: "value", value: "word" },
  { name: "--reasoning", form: "value", value: "word" },
  { name: "--reasoning-budget", form: "value", value: "int" },
  { name: "--jinja", form: "bare" },
  { name: "--chat-template", form: "value", value: "word" },
  { name: "--no-webui", form: "bare" },
  { name: "--no-warmup", form: "bare" },
  { name: "--flash-attn", form: "value", value: "word" },
  { name: "--batch-size", form: "value", value: "int" },
  { name: "--ubatch-size", form: "value", value: "int" },
  { name: "--keep", form: "value", value: "int" },
  { name: "--alias", form: "value", value: "word" },
];

/**
 * The same engine, declared twice because the two products lay it out
 * differently — tAI at `bin/<platform>/`, tRadio one level deeper under an
 * engine name. Only the paths differ; the argument vocabulary is upstream's and
 * is therefore shared.
 */
function llamaServer(options: {
  win32: string;
  linux: string;
  loaderDir?: string;
}): Program {
  return {
    id: "llama-server",
    paths: { win32: [options.win32], linux: [options.linux] },
    loaderDir: options.loaderDir,
    // The resource root, or the directory the binary sits in — llama.cpp loads
    // its own DLLs from beside itself on Windows.
    cwd: ["", dirOf(options.win32), dirOf(options.linux)],
    env: ["LD_LIBRARY_PATH"],
    invocations: [{ label: "llama-server", head: [], flags: LLAMA_SERVER_FLAGS }],
  };
}

function dirOf(relative: string): string {
  const cut = relative.lastIndexOf("/");
  return cut === -1 ? "" : relative.slice(0, cut);
}

// ── The first-party family ───────────────────────────────────────────────────
//
// Hardcoded, not operator configuration. Making this a config file would move
// four `server.cfg` lines into a fifth file and gain nothing: an operator who
// can edit that file can edit server.cfg, and a resource that can edit it has
// already won. The point of the consolidation is that the *operator* stops
// having to write a grant per resource — not that the grant becomes editable.

export const FAMILY: Caller[] = [
  {
    resource: "tDB",
    author: "TIMMYG Studios",
    programs: [
      {
        id: "pocketbase",
        // `.runtime/` is where tDB's fetch-runtime.ts puts the verified binary.
        paths: {
          win32: [".runtime/pocketbase-win.exe"],
          linux: [".runtime/pocketbase-linux"],
        },
        cwd: [""],
        env: [],
        invocations: [
          {
            label: "pocketbase serve",
            head: [{ lit: "serve" }],
            flags: [
              // Inline only, and loopback only: tDB reaches the outside world
              // through tLib's router, never by binding another address.
              { name: "--http", form: "inline", value: "loopbackAddress" },
              { name: "--dir", form: "either", value: "path" },
              { name: "--publicDir", form: "either", value: "path" },
              { name: "--migrationsDir", form: "either", value: "path" },
              { name: "--hooksDir", form: "either", value: "path" },
              { name: "--dev", form: "bare" },
              { name: "--automigrate", form: "inline", value: "word" },
            ],
          },
          {
            label: "pocketbase superuser upsert",
            head: [
              { lit: "superuser" },
              { lit: "upsert" },
              { val: "email" },
              { val: "secret", redact: true },
            ],
            flags: [{ name: "--dir", form: "either", value: "path" }],
          },
          {
            label: "pocketbase migrate up",
            head: [{ lit: "migrate" }, { lit: "up" }],
            flags: [
              { name: "--dir", form: "either", value: "path" },
              { name: "--migrationsDir", form: "either", value: "path" },
            ],
          },
          { label: "pocketbase update", head: [{ lit: "update" }], flags: [] },
          { label: "pocketbase --version", head: [{ lit: "--version" }], flags: [] },
        ],
      },
    ],
  },
  {
    resource: "tAI",
    author: "TIMMYG Studios",
    programs: [
      // tAI keeps its binaries under bin/win and bin/linux, and ships a glibc
      // loader beside the Linux build for hosts whose own libc is too old.
      llamaServer({
        win32: "bin/win/llama-server.exe",
        linux: "bin/linux/llama-server",
        loaderDir: "bin/linux/lib",
      }),
      {
        /**
         * The speech process: tAI's vendored Node running tAI's own sidecar.
         *
         * Vendored rather than assumed on PATH — a server owner has no reason to
         * have Node installed — which also means the runtime is inside tAI and
         * the containment rule applies to it unchanged.
         *
         * This is the one duplex program: the caller and the child exchange
         * length-prefixed binary frames, not lines, because audio is decoded and
         * sent while the backbone is still generating. `prepend` is what keeps
         * that from being a hole — tAI names `tts-sidecar` and tLib supplies the
         * script, so "run this binary" never becomes "run this JavaScript".
         */
        id: "tts-sidecar",
        paths: { win32: ["bin/win/node.exe"], linux: ["bin/linux/node"] },
        prepend: ["bin/tts-sidecar.js"],
        cwd: [""],
        env: [],
        invocations: [
          {
            // <resourcePath> <threads>, optionally followed by the backend name.
            label: "tts-sidecar <resource path> <threads> [backend]",
            head: [{ val: "path" }, { val: "int" }],
            flags: [],
          },
          {
            label: "tts-sidecar <resource path> <threads> <backend>",
            head: [{ val: "path" }, { val: "int" }, { val: "word" }],
            flags: [],
          },
        ],
      },
    ],
  },
  {
    resource: "tRadio",
    author: "TIMMYG Studios",
    programs: [
      llamaServer({
        win32: "server/bin/win/llama/llama-server.exe",
        linux: "server/bin/linux/llama/llama-server",
      }),
      {
        id: "whisper-server",
        paths: {
          win32: ["server/bin/win/whisper/whisper-server.exe"],
          linux: ["server/bin/linux/whisper/whisper-server"],
        },
        cwd: ["", "server/bin/win/whisper", "server/bin/linux/whisper"],
        env: ["LD_LIBRARY_PATH"],
        invocations: [
          {
            label: "whisper-server",
            head: [],
            flags: [
              { name: "--model", form: "value", value: "path" },
              { name: "--host", form: "value", value: "loopback" },
              { name: "--port", form: "value", value: "port" },
              { name: "--threads", form: "value", value: "int" },
              { name: "--processors", form: "value", value: "int" },
              { name: "--convert", form: "bare" },
              { name: "--no-timestamps", form: "bare" },
              { name: "--language", form: "value", value: "word" },
            ],
          },
        ],
      },
      {
        id: "piper",
        paths: {
          win32: ["server/bin/win/piper/piper.exe"],
          linux: ["server/bin/linux/piper/piper"],
        },
        cwd: ["", "server/bin/win/piper", "server/bin/linux/piper"],
        env: ["LD_LIBRARY_PATH"],
        invocations: [
          {
            label: "piper",
            head: [],
            flags: [
              { name: "--model", form: "value", value: "path" },
              { name: "--config", form: "value", value: "path" },
              { name: "--espeak_data", form: "value", value: "path" },
              { name: "-f", form: "value", value: "path" },
              { name: "--output_file", form: "value", value: "path" },
              { name: "--json-input", form: "bare" },
            ],
          },
        ],
      },
    ],
  },
];

// There were two "probes" here: fixed PowerShell command lines tLib ran on a
// caller's behalf, to resolve a live PID's executable and to count physical
// cores. They are gone, and nothing replaced them — both questions are now
// answered in-process by the callers themselves, the same way on every platform.
//
// Removed for two reasons, neither of which is that they were exploitable. They
// were not: tLib owned every byte of those command lines and a caller supplied at
// most one integer. But tLib is a public MIT library, and shipping *any*
// `powershell.exe` invocation in one is a thing a reader stops at — which is a
// real cost even when the code is fine. And they were Windows-only, so the same
// question had two implementations, of which the Linux one is the one nobody
// exercises on a Windows dev box. Most FiveM hosting is Linux containers. One
// cross-platform path beats two correct ones.
//
// Do not add another. If a caller needs an OS fact, find the in-process answer.

export function findCaller(resource: string): Caller | undefined {
  return FAMILY.find((c) => c.resource === resource);
}

export function findProgram(caller: Caller, id: string): Program | undefined {
  return caller.programs.find((p) => p.id === id);
}

/** One line per caller, for the startup banner. */
export function describeFamily(): string[] {
  return FAMILY.map((c) => `${c.resource} → ${c.programs.map((p) => p.id).join(", ")}`);
}
