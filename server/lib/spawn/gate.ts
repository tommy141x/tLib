/**
 * Turning a caller's request into a command line, or refusing it.
 *
 * Everything that decides *whether* a spawn happens is here, and nothing here
 * spawns. The filesystem is reached through an injected `Probes`, so every
 * refusal in `catalog.ts` can be tested — including the ones that need a symlink
 * pointing out of a resource, which is not a thing a unit test can create
 * portably.
 *
 * The rule the whole module exists to enforce: **the caller names a program, not
 * a path.** `request.program` is looked up in the catalog, the path comes from
 * the catalog, and the argv is rebuilt token by token from the declared shape.
 * A caller cannot smuggle a path, a second command, or an extra flag through
 * this, because nothing it sends is ever concatenated into a command line.
 */

import {
  type Caller,
  type FlagSpec,
  findCaller,
  findProgram,
  type Invocation,
  type Platform,
  type ValueKind,
} from "./catalog";

// Re-exported: `gate` is this directory's facade, `catalog` is internal, and
// `Probes.platform()` returns this type.
export type { Platform } from "./catalog";

/** The filesystem and engine facts the gate needs. Injected so it can be faked. */
export interface Probes {
  /** `GetResourcePath`. Empty for a resource the engine does not know. */
  resourcePath(resource: string): string;
  /** Must throw for a path that does not exist. Symlinks fully resolved. */
  realpath(target: string): string;
  isFile(target: string): boolean;
  sha256(target: string): string;
  /** Every `author` the resource's own fxmanifest declares. Possibly empty. */
  authors(resource: string): string[];
  platform(): Platform;
  /** `join`/`resolve`/`sep` for the host, so tests can drive both layouts. */
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  sep: string;
}

export interface Resolved {
  program: string;
  /** Absolute, realpath'd, proven inside the caller's resource directory. */
  binary: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** `argv` with redacted values replaced. The only form that may be logged. */
  loggable: string[];
  /**
   * Set when the caller's fxmanifest `author` is not the expected one. Carried
   * out of the gate rather than acted on inside it: the only correct response
   * is to log it. See `authorWarning` below.
   */
  authorWarning?: string;
}

export interface Refusal {
  error: string;
}

export interface SpawnRequest {
  /** Names a long-lived process, unique within the caller. `serve` only. */
  key?: unknown;
  program?: unknown;
  args?: unknown;
  /** Resource-relative, and must be one the program declares. */
  cwd?: unknown;
  env?: unknown;
  /** Written to the child's stdin, which is then closed. One-shot runs only. */
  stdin?: unknown;
}

// Value shapes

/**
 * A NUL truncates the string the kernel actually receives, so a value carrying
 * one does not mean what it reads as. The other control characters are rejected
 * with it because nothing legitimate here contains one and they wreck logs.
 */
function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Belt and braces. `shell: false` plus an argv array means these are ordinary
 * characters with no power, so this is not what makes the spawn safe — it is
 * here so a value that later reaches a shell was never allowed to carry one.
 */
const SHELL_METACHARACTERS = /[;&|`$><\n\r(){}[\]!*?~]/;

const WORD = /^[A-Za-z0-9_.:,+=/-]+$/;
const INTEGER = /^-?\d{1,10}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function valueOk(kind: ValueKind, value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  if (hasControlCharacters(value)) return false;
  switch (kind) {
    case "path":
      // Not containment-checked: `--dir` is a PocketBase data directory an
      // operator may legitimately point at another disk. The control that
      // matters is which *executable* runs, enforced separately in full.
      return true;
    case "int":
      return INTEGER.test(value);
    case "port": {
      if (!INTEGER.test(value)) return false;
      const port = Number(value);
      return port >= 1 && port <= 65535;
    }
    case "loopback":
      return LOOPBACK_HOSTS.has(value);
    case "loopbackAddress": {
      const cut = value.lastIndexOf(":");
      if (cut <= 0) return false;
      const host = value.slice(0, cut);
      const port = value.slice(cut + 1);
      if (!LOOPBACK_HOSTS.has(host)) return false;
      return valueOk("port", port);
    }
    case "word":
      return WORD.test(value);
    case "email":
      return EMAIL.test(value);
    case "secret":
      // Unconstrained apart from control characters: it is a generated
      // password, and a character class here would silently reject a valid one.
      return true;
    case "text":
      return !SHELL_METACHARACTERS.test(value);
  }
}

// Argument matching

interface Matched {
  argv: string[];
  loggable: string[];
}

const REDACTED = "«redacted»";

function matchFlag(
  spec: FlagSpec,
  tokens: readonly string[],
  index: number
): { consumed: number; value?: string } | null {
  const token = tokens[index];
  if (token === undefined) return null;

  if (token === spec.name) {
    if (spec.form === "bare") return { consumed: 1 };
    if (spec.form === "value" || spec.form === "either") {
      const value = tokens[index + 1];
      if (value === undefined) return null;
      if (!spec.value || !valueOk(spec.value, value)) return null;
      return { consumed: 2, value };
    }
    return null;
  }

  if ((spec.form === "inline" || spec.form === "either") && token.startsWith(`${spec.name}=`)) {
    const value = token.slice(spec.name.length + 1);
    if (!spec.value || !valueOk(spec.value, value)) return null;
    return { consumed: 1, value };
  }

  return null;
}

/** One invocation's attempt at the whole token list. Null means "not this shape". */
function matchInvocation(shape: Invocation, tokens: readonly string[]): Matched | null {
  const argv: string[] = [];
  const loggable: string[] = [];
  let i = 0;

  for (const step of shape.head) {
    const token = tokens[i];
    if (token === undefined) return null;
    if ("lit" in step) {
      if (token !== step.lit) return null;
    } else if (!valueOk(step.val, token)) {
      return null;
    }
    argv.push(token);
    loggable.push("lit" in step || !step.redact ? token : REDACTED);
    i++;
  }

  const used = new Set<string>();
  while (i < tokens.length) {
    let progressed = false;
    for (const spec of shape.flags) {
      if (used.has(spec.name)) continue;
      const hit = matchFlag(spec, tokens, i);
      if (!hit) continue;
      used.add(spec.name);
      for (let k = 0; k < hit.consumed; k++) {
        const token = tokens[i + k];
        if (token === undefined) return null;
        argv.push(token);
        loggable.push(spec.redact && k > 0 ? REDACTED : token);
      }
      i += hit.consumed;
      progressed = true;
      break;
    }
    // A token no declared flag accepts — an unknown flag, a repeat, a bad
    // value, or a stray positional. All four are refusals, not warnings.
    if (!progressed) return null;
  }

  return { argv, loggable };
}

// Containment

/**
 * Where a resource-relative path really is, or "" when it is not the caller's.
 *
 * `realpath` on both sides, not a string prefix test — a prefix test passes
 * `tRadio/../tCAD/x` before normalisation, and a symlink resolving to
 * `/usr/bin/bash` after it. This is the only thing standing between "tLib may
 * spawn" and "any resource may run anything".
 */
function contained(probes: Probes, root: string, relative: string): string {
  try {
    const realRoot = probes.realpath(root);
    const target = probes.realpath(probes.resolve(realRoot, relative));
    if (target !== realRoot && !target.startsWith(realRoot + probes.sep)) return "";
    return target;
  } catch {
    return "";
  }
}

function pickPath(probes: Probes, root: string, candidates: readonly string[]): string {
  for (const candidate of candidates) {
    const resolved = contained(probes, root, candidate);
    if (resolved && probes.isFile(resolved)) return resolved;
  }
  return "";
}

// The bundled loader

/**
 * glibc's interpreter, by the only name it has on x86-64.
 *
 * Hard-coded, not read from the binary's `PT_INTERP`: the name is the ABI —
 * every x86-64 glibc build uses it — so tLib never has to parse an ELF header
 * to decide what to exec. The bundling script installs the real interpreter
 * under this name at build time for the same reason.
 */
const LOADER_NAME = "ld-linux-x86-64.so.2";

interface BundledLoader {
  /** Absolute, realpath'd, proven inside the caller's resource directory. */
  path: string;
  /** What `--library-path` is given, for a binary the gate has already resolved. */
  searchPath(binary: string): string;
}

/**
 * The bundled loader, or nothing — in which case the binary is exec'd directly.
 *
 * "Nothing" is normal, not an error: no declared `loaderDir`, one the release
 * doesn't carry, an empty directory, or (a symlink escape) one that resolves
 * outside the resource. Falling back in the escape case is deliberate: the
 * *binary* is already proven contained, and refusing would let a planted
 * symlink deny service to a working engine for nothing.
 *
 * The loader path itself goes through `contained`, not a plain `join` onto a
 * contained directory — a symlink inside the resource could point the loader
 * (which gets exec'd) at `/bin/sh` otherwise.
 */
function loaderFor(probes: Probes, root: string, loaderDir: string): BundledLoader | undefined {
  const libraryDir = contained(probes, root, loaderDir);
  if (!libraryDir) return undefined;
  const loader = contained(probes, root, `${loaderDir}/${LOADER_NAME}`);
  if (!loader || !probes.isFile(loader)) return undefined;

  return {
    path: loader,
    /**
     * Two directories, in that order.
     *
     * `--library-path` *replaces* `LD_LIBRARY_PATH` (ld.so(8)), so the bundled
     * glibc closure alone isn't enough — each engine's own shared objects
     * (llama.cpp's 13 dlopen'd ggml CPU backends among them) sit beside the
     * binary, where `LD_LIBRARY_PATH` used to point. Omitting it starts the
     * process with no backend, which reads as a broken model, not a bad path.
     *
     * `:` is ld.so's separator, so a directory containing one is dropped from
     * the list rather than corrupting it — doesn't occur under FXServer today.
     */
    searchPath(binary: string): string {
      const beside = probes.join(binary, "..");
      if (beside === libraryDir || beside.includes(":") || libraryDir.includes(":")) {
        return libraryDir;
      }
      return `${libraryDir}:${beside}`;
    },
  };
}

// The decision

function strings(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    out.push(entry);
  }
  return out;
}

/**
 * Identify the caller, or refuse.
 *
 * `resource` comes from `GetInvokingResource()` — engine-filled, caller
 * cannot set it — so it trustworthily answers "which container is calling"
 * but not "who wrote it" (see catalog.ts). A rogue folder named `tAI` passes,
 * same as today's `add_unsafe_child_process_permission tAI`.
 */
export function admit(resource: string): Caller | Refusal {
  if (!resource) return { error: "the calling resource could not be identified" };
  const caller = findCaller(resource);
  if (!caller) {
    return {
      error:
        `${resource} is not in tLib's spawn family. Spawning through tLib is for ` +
        "first-party t* resources only; run your own child processes with your own " +
        "add_unsafe_child_process_permission line.",
    };
  }
  return caller;
}

/**
 * Rung 3, and the weakest check in this file: not wired into any decision,
 * only printed by `index.ts`. A resource writes its own fxmanifest, so an
 * attacker just copies the expected author in — a match authorises nothing.
 * It catches the honest case (fork, vendored copy, accidental rename) and no
 * more than that.
 *
 * Checks every declared author, not index 0: these manifests carry a person
 * and a studio line in varying order, and checking only the first warned on
 * every boot for two of the three.
 */
function authorWarning(probes: Probes, caller: Caller): string | undefined {
  const declared = probes.authors(caller.resource);
  if (declared.includes(caller.author)) return undefined;
  return (
    `${caller.resource} declares author ${declared.length ? declared.map((a) => `"${a}"`).join(", ") : "(none)"} ` +
    `rather than "${caller.author}". Allowed anyway, and on purpose: a resource writes its own ` +
    "fxmanifest, so this can only ever flag an accident — a fork or a copied folder — and is " +
    "never evidence of anything. Check that this is your copy of it."
  );
}

export function resolveSpawn(
  resource: string,
  request: SpawnRequest,
  probes: Probes
): Resolved | Refusal {
  const caller = admit(resource);
  if ("error" in caller) return caller;

  if (typeof request.program !== "string" || !request.program) {
    return { error: "no program named" };
  }
  const program = findProgram(caller, request.program);
  if (!program) {
    return {
      error:
        `${caller.resource} may not run "${request.program}" — it declares ` +
        `${caller.programs.map((p) => p.id).join(", ") || "no programs"}.`,
    };
  }

  const root = probes.resourcePath(caller.resource);
  if (!root) return { error: `the engine does not know where ${caller.resource} is` };

  const platform = probes.platform();
  const binary = pickPath(probes, root, program.paths[platform]);
  if (!binary) {
    return {
      error:
        `${program.id} is not present inside ${caller.resource} at ` +
        `${program.paths[platform].join(" or ")}`,
    };
  }

  if (program.sha256 && program.sha256.length > 0) {
    let digest = "";
    try {
      digest = probes.sha256(binary).toLowerCase();
    } catch (err) {
      return { error: `${program.id} could not be hashed: ${(err as Error).message}` };
    }
    if (!program.sha256.includes(digest)) {
      return {
        error: `${program.id} does not match its pin (sha256 ${digest})`,
      };
    }
  }

  const tokens = strings(request.args);
  if (!tokens) return { error: "args must be an array of strings" };

  let matched: Matched | null = null;
  for (const shape of program.invocations) {
    matched = matchInvocation(shape, tokens);
    if (matched) break;
  }
  if (!matched) {
    return {
      error:
        `those arguments are not a declared way of running ${program.id}. Permitted: ` +
        program.invocations.map((s) => s.label).join("; "),
    };
  }

  // Paths the catalog supplies, resolved through the same containment rule as
  // the executable and inserted in front of whatever the caller sent. A missing
  // one is a refusal, not a silent omission: running the interpreter without its
  // script would drop tAI's vendored Node into a REPL on the server's stdin.
  const prefix: string[] = [];
  for (const relative of program.prepend ?? []) {
    const resolved = contained(probes, root, relative);
    if (!resolved || !probes.isFile(resolved)) {
      return { error: `${program.id} needs ${relative}, which is not in ${caller.resource}` };
    }
    prefix.push(resolved);
  }

  // The loader form, built here rather than accepted from the caller: a command
  // the caller chooses is a path the caller aims.
  let argv = [...prefix, ...matched.argv];
  let loggable = [...prefix, ...matched.loggable];
  let command = binary;
  if (platform === "linux" && program.loaderDir) {
    const loader = loaderFor(probes, root, program.loaderDir);
    if (loader) {
      const head = ["--library-path", loader.searchPath(binary), binary];
      command = loader.path;
      argv = [...head, ...argv];
      loggable = [...head, ...loggable];
    }
  }

  // Absent means the binary's own directory; `""` is NOT absent — it is the
  // resource root. The difference is load-bearing: PocketBase's
  // `--dir=.runtime/pb_data` and `--hooksDir=pb_hooks` are relative to tDB's
  // root, so running from `.runtime/` instead resolves both a level too deep
  // — PocketBase starts, `/api/health` answers 200, and every hook route is
  // simply absent.
  let cwd = probes.join(binary, "..");
  if (request.cwd !== undefined && request.cwd !== null) {
    if (typeof request.cwd !== "string") return { error: "cwd must be a string" };
    const wanted = request.cwd;
    if (!program.cwd.includes(wanted)) {
      return {
        error: `${program.id} may only run in ${program.cwd.map((c) => c || "<resource root>").join(", ")}`,
      };
    }
    const resolvedCwd = contained(probes, root, wanted);
    if (!resolvedCwd) return { error: `cwd ${wanted} is not inside ${caller.resource}` };
    cwd = resolvedCwd;
  }

  const env: Record<string, string> = {};
  if (request.env !== undefined && request.env !== null) {
    if (typeof request.env !== "object") return { error: "env must be an object" };
    for (const [name, raw] of Object.entries(request.env as Record<string, unknown>)) {
      if (!program.env.includes(name)) {
        return { error: `${program.id} may not set ${name}` };
      }
      if (typeof raw !== "string" || !valueOk("path", raw)) {
        return { error: `${name} is not a usable value` };
      }
      env[name] = raw;
    }
  }

  return {
    program: program.id,
    binary: command,
    argv,
    cwd,
    env,
    loggable,
    authorWarning: authorWarning(probes, caller),
  };
}
