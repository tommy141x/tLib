/**
 * What may be spawned, by whom, with which arguments.
 *
 * THIS FILE IS THE SECURITY CONTROL. `add_unsafe_child_process_permission tLib`
 * is a grant to run anything; everything narrower is written down here, and
 * nothing outside this file can widen it. A caller names a program declared
 * below and never passes a path: tLib resolves it, requires it to be inside the
 * caller's own resource directory after `realpath`, builds the argv from the
 * declared shape, and execs with `shell: false`.
 *
 * The `author` rung is recorded and logged, NEVER consulted for the decision.
 * Design notes, including why nothing is SHA-256 pinned:
 * docs/internal/spawn-gate.md
 */

/** The two platforms FXServer ships for. */
export type Platform = "win32" | "linux";

/**
 * What one argument token is allowed to look like.
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
   */
  paths: Record<Platform, string[]>;
  /**
   * Where a loadable backend lives, if the program has one. See gate.ts's
   * `loaderDir` handling for the cases and why llama.cpp needs it.
   */
  loaderDir?: string;
  /**
   * Resource-relative paths tLib puts in front of the caller's arguments.
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
   * The declaring product no longer ships the feature that runs these, so the
   * startup banner omits it. STILL ALLOWED — this is disclosure, not
   * permission, and a dev build that re-enables the feature keeps working
   * without a catalog edit.
   *
   * Deliberately a flag rather than a check for the binaries on disk: they sit
   * in a working tree whether or not the code that execs them is compiled in,
   * so their presence answers a different question than the one the banner is
   * asking. Remove the flag when the feature returns.
   */
  dormant?: boolean;
  /**
   * The `author` its fxmanifest is expected to declare.
   *
   * Defence in depth only. See rung 3 in the header: this is logged on a
   * mismatch and never gates anything.
   */
  author: string;
  programs: Program[];
}

// Shared argument vocabulary

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
function llamaServer(options: { win32: string; linux: string; loaderDir?: string }): Program {
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

// The first-party family. Hardcoded on purpose: this list is the grant, and it
// must not become operator configuration.

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
         * Vendored, not assumed on PATH, so the runtime sits inside tAI and the
         * containment rule still applies to it. The one duplex program here:
         * caller and child exchange length-prefixed binary frames (audio
         * streamed while the backbone still generates), not lines. `prepend`
         * is what keeps that duplex channel from being a hole — tAI names
         * `tts-sidecar`, tLib supplies the script, so "run this binary" never
         * becomes "run this JavaScript".
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
    // DORMANT since 2026-10-26. These three engines exist only for the AI
    // dispatcher, which was withdrawn from releases after Tebex locked both
    // tRadio packages over it — so a shipped tRadio execs none of them and the
    // banner must not say it will. The declaration stays because the withdrawal
    // is suspension, not deletion; drop this flag when the feature returns.
    dormant: true,
    // tRadio ships three engines, each execed through its bundled loader when
    // the release carries one. Loader directory is per engine, not one shared
    // `server/bin/linux/lib`: llama.cpp and whisper.cpp each ship a `libggml`
    // built from a different revision, and a shared directory hands one of
    // them a library it wasn't linked against. Three ~15 MB closures is the
    // price of avoiding that.
    author: "TIMMYG Studios",
    programs: [
      llamaServer({
        win32: "server/bin/win/llama/llama-server.exe",
        linux: "server/bin/linux/llama/llama-server",
        loaderDir: "server/bin/linux/llama/lib",
      }),
      {
        id: "whisper-server",
        paths: {
          win32: ["server/bin/win/whisper/whisper-server.exe"],
          linux: ["server/bin/linux/whisper/whisper-server"],
        },
        loaderDir: "server/bin/linux/whisper/lib",
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
        loaderDir: "server/bin/linux/piper/lib",
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

export function findCaller(resource: string): Caller | undefined {
  return FAMILY.find((c) => c.resource === resource);
}

export function findProgram(caller: Caller, id: string): Program | undefined {
  return caller.programs.find((p) => p.id === id);
}

/**
 * One line per caller, for the startup banner.
 *
 * `dormant` entries are omitted. They remain in the allowlist above — this is
 * disclosure, not permission — but the banner is read by operators as "what
 * this server will run", and naming a program that the declaring product no
 * longer ships is worse than saying nothing.
 */
export function describeFamily(): string[] {
  return FAMILY.filter((c) => !c.dormant).map(
    (c) => `${c.resource} → ${c.programs.map((p) => p.id).join(", ")}`
  );
}
