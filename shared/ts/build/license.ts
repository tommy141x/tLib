/**
 * Dependency licence gate.
 *
 * The version this replaced could not fail for any of the reasons it existed. It
 * read ONLY the root `package.json`'s `dependencies` — 5 packages in tRadio,
 * exactly one (`ws`) in tLib — while tRadio's ~110 bundled packages live in the
 * `client/web`, `server/web`, `shared/ui` and `client/dm32/web` workspaces, none
 * of which it opened. It never walked transitives, so the 80 `@zag-js/*` packages
 * that reach the artifact through `@ark-ui/solid` were invisible. It returned
 * `true` when there was no `package.json` and `true` again when the dependency
 * list was empty, so "I read nothing" and "everything is approved" were the same
 * green. A bare `catch {}` around the per-package read made "not installed"
 * indistinguishable from "approved". Net: 5 of ~110 shipped packages classified,
 * and it could not go red.
 *
 * So: zero packages examined is a FAILURE, an unreadable manifest is a FAILURE,
 * and an unresolvable package is a FAILURE rather than a shrug.
 *
 * Nothing in this estate ships `node_modules`: every workspace is bundled
 * (Vite for the two web UIs, `bun build` for the server), so the artifact's
 * true dependency set is what the bundler emitted. A bundler metafile would be
 * the exact answer, and there is none to read — this gate runs BEFORE the build
 * (tRadio `scripts/prod.ts` step 1, tLib `runProd`), on purpose, because
 * failing a licence check after a 2-minute build wastes the build. Bun's
 * builder emits no esbuild-style metafile either.
 *
 * What is computed instead is the PRODUCTION CLOSURE: the root manifest plus
 * every declared workspace, walked transitively through `node_modules`. That is
 * a SUPERSET of the artifact — tree-shaking can drop a package whose code never
 * lands — which is the safe direction for a licence gate: it can accuse a
 * package that did not ship, never miss one that did. `method` and `confidence`
 * on the report say so in the output, and the known gaps are listed on
 * `confidence` itself.
 *
 * `RESTRICTED_LICENSES` still contains LGPL-2.1 even though tRadio deliberately
 * ships codec2 under it. The breach is recorded per component, with a reason and
 * a review date, in the product's `license-policy.json`, and a vendored exception
 * must point at a licence file that exists on disk.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const APPROVED_LICENSES = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "WTFPL",
  "Python-2.0",
  "Zlib",
  "BlueOak-1.0.0",
  "CC-BY-4.0",
]);

const RESTRICTED_LICENSES = new Set([
  "GPL-2.0",
  "GPL-3.0",
  "LGPL-2.1",
  "LGPL-3.0",
  "AGPL-3.0",
  "MPL-2.0",
  "EPL-1.0",
  "EPL-2.0",
  "CDDL-1.0",
  "CPL-1.0",
  "CC-BY-SA-4.0",
  "CC-BY-SA-3.0",
  "CC-BY-SA-2.0",
  "EUPL-1.2",
]);

const LICENSE_ALIASES = new Map([
  ["MIT License", "MIT"],
  ["The MIT License", "MIT"],
  ["Apache License 2.0", "Apache-2.0"],
  ["Apache 2.0", "Apache-2.0"],
  ["BSD", "BSD-3-Clause"],
  ["BSD License", "BSD-3-Clause"],
  ["ISC License", "ISC"],
  ["Mozilla Public License 2.0", "MPL-2.0"],
  ["GNU General Public License v3.0", "GPL-3.0"],
  ["GNU Lesser General Public License v3.0", "LGPL-3.0"],
]);

export type LicenseStatus = "approved" | "restricted" | "excepted" | "unknown" | "missing";

export type LicenseFailureCode =
  | "NO_MANIFEST"
  | "NO_PACKAGES"
  | "UNRESOLVED"
  | "MISSING_LICENSE"
  | "UNKNOWN_LICENSE"
  | "RESTRICTED_LICENSE"
  | "POLICY_INVALID"
  | "STALE_EXCEPTION"
  | "VENDORED_LICENSE_MISSING";

export interface LicenseFailure {
  code: LicenseFailureCode;
  detail: string;
}

/**
 * A reviewed, deliberate breach of the policy above. `reason` is the record of
 * the decision; `kind: "vendored"` covers a component that is not an npm
 * package at all (codec2, blip25) and must name the licence file that travels
 * with it.
 */
export interface LicenseException {
  package: string;
  license: string;
  kind: "npm" | "vendored";
  reason: string;
  reviewed: string;
  reviewedBy: string;
  licenseFile?: string;
}

export interface PackageLicense {
  package: string;
  version: string;
  license: string;
  status: LicenseStatus;
  /** Relative to the product root, so the report says where a package came from. */
  dir: string;
  requiredBy: string[];
  exception?: LicenseException;
}

export interface LicenseReport {
  ok: boolean;
  method: string;
  confidence: string[];
  /** Root plus every declared workspace whose manifest was read, relative. */
  roots: string[];
  examined: number;
  packages: PackageLicense[];
  firstParty: string[];
  vendored: LicenseException[];
  optionalAbsent: string[];
  policyPath: string | null;
  failures: LicenseFailure[];
}

export interface LicenseOptions {
  cwd?: string;
  /** Defaults to `<cwd>/license-policy.json`. Absent is allowed; invalid is not. */
  policyPath?: string;
}

interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  license?: unknown;
  licenses?: { type?: string }[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

function readManifest(file: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

function normalizeLicense(license: string): string {
  const trimmed = license.trim();
  const alias = LICENSE_ALIASES.get(trimmed);
  if (alias) return alias;
  return trimmed
    .replace(/^License:\s*/i, "")
    .replace(/\s+License$/i, "")
    .replace(/-only$/i, "")
    .replace(/-or-later$/i, "")
    .replace(/\+$/, "");
}

/**
 * SPDX expressions are evaluated rather than treated as opaque: `MIT OR
 * GPL-3.0` is dual-licensed and we take the MIT side, and `MIT AND GPL-3.0` is
 * both at once and therefore restricted. The old code string-matched the whole
 * expression, so every dual-licensed package landed in "unknown" and the signal
 * drowned in noise nobody could act on.
 */
function classify(expr: string): LicenseStatus {
  const e = expr
    .trim()
    .replace(/^\(([\s\S]*)\)$/, "$1")
    .trim();
  if (!e) return "missing";
  if (/^see\s+licen[cs]e/i.test(e)) return "unknown";
  if (/\sOR\s/i.test(e)) {
    const parts = e.split(/\sOR\s/i).map(classify);
    if (parts.includes("approved")) return "approved";
    if (parts.includes("restricted")) return "restricted";
    return "unknown";
  }
  if (/\sAND\s/i.test(e)) {
    const parts = e.split(/\sAND\s/i).map(classify);
    if (parts.includes("restricted")) return "restricted";
    return parts.every((p) => p === "approved") ? "approved" : "unknown";
  }
  const id = normalizeLicense(e);
  if (APPROVED_LICENSES.has(id)) return "approved";
  if (RESTRICTED_LICENSES.has(id)) return "restricted";
  return "unknown";
}

function declaredLicense(m: Manifest): string {
  if (typeof m.license === "string") return m.license;
  // Pre-SPDX manifests use `license: { type }` or an array of them.
  if (m.license && typeof m.license === "object") {
    const t = (m.license as { type?: string }).type;
    if (typeof t === "string") return t;
  }
  const legacy = m.licenses?.[0]?.type;
  return typeof legacy === "string" ? legacy : "";
}

function workspaceDirs(root: string, m: Manifest): string[] {
  const patterns = Array.isArray(m.workspaces) ? m.workspaces : (m.workspaces?.packages ?? []);
  const out: string[] = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) {
      out.push(join(root, pattern));
      continue;
    }
    const base = join(root, pattern.slice(0, -2));
    if (!existsSync(base)) {
      // Pushed anyway so the caller records a missing manifest: a workspace
      // glob that matches nothing must not silently shrink the package set.
      out.push(base);
      continue;
    }
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules") out.push(join(base, entry.name));
    }
  }
  return out;
}

/** Node resolution, stopped at the product root: a package outside it is not in this install. */
function resolveFrom(fromDir: string, root: string, name: string): string | null {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadPolicy(
  root: string,
  policyPath: string,
  failures: LicenseFailure[]
): { exceptions: LicenseException[]; roots: string[]; path: string | null } {
  if (!existsSync(policyPath)) return { exceptions: [], roots: [], path: null };

  let parsed: { exceptions?: unknown; roots?: unknown };
  try {
    parsed = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch (err) {
    failures.push({ code: "POLICY_INVALID", detail: `${policyPath}: ${(err as Error).message}` });
    return { exceptions: [], roots: [], path: policyPath };
  }

  // `roots` exists because bun workspaces are not the only shape in the estate:
  // tLib's client/web and shared/ts are separately installed trees that the root
  // manifest never mentions, and without them the gate examined ONE package
  // (`ws`) for a release that bundles ~40. A declared root that has no manifest
  // fails, so this list cannot rot into a shorter scan.
  const roots =
    Array.isArray(parsed.roots) && parsed.roots.every((r) => typeof r === "string")
      ? (parsed.roots as string[])
      : [];
  if (parsed.roots !== undefined && roots.length !== (parsed.roots as unknown[]).length) {
    failures.push({
      code: "POLICY_INVALID",
      detail: `${policyPath}: "roots" must be an array of strings`,
    });
  }

  if (!Array.isArray(parsed.exceptions)) {
    failures.push({
      code: "POLICY_INVALID",
      detail: `${policyPath}: "exceptions" must be an array`,
    });
    return { exceptions: [], roots, path: policyPath };
  }

  const exceptions: LicenseException[] = [];
  for (const [i, raw] of parsed.exceptions.entries()) {
    const e = raw as Partial<LicenseException>;
    const missing = (["package", "license", "kind", "reason", "reviewed", "reviewedBy"] as const)
      .filter((k) => typeof e[k] !== "string" || !(e[k] as string).trim())
      .join(", ");
    if (missing) {
      failures.push({
        code: "POLICY_INVALID",
        detail: `exceptions[${i}] (${e.package ?? "unnamed"}) is missing: ${missing}`,
      });
      continue;
    }
    if (e.kind !== "npm" && e.kind !== "vendored") {
      failures.push({
        code: "POLICY_INVALID",
        detail: `exceptions[${i}] (${e.package}): kind must be "npm" or "vendored"`,
      });
      continue;
    }
    if (Number.isNaN(Date.parse(e.reviewed as string))) {
      failures.push({
        code: "POLICY_INVALID",
        detail: `exceptions[${i}] (${e.package}): reviewed "${e.reviewed}" is not a date`,
      });
      continue;
    }
    if (e.kind === "vendored") {
      if (!e.licenseFile) {
        failures.push({
          code: "POLICY_INVALID",
          detail: `exceptions[${i}] (${e.package}): a vendored exception must name its licenseFile`,
        });
        continue;
      }
      if (!existsSync(resolve(root, e.licenseFile))) {
        failures.push({
          code: "VENDORED_LICENSE_MISSING",
          detail: `${e.package}: licenseFile "${e.licenseFile}" does not exist`,
        });
        continue;
      }
    }
    exceptions.push(e as LicenseException);
  }
  return { exceptions, roots, path: policyPath };
}

export function checkLicenses(opts: LicenseOptions = {}): LicenseReport {
  const root = resolve(opts.cwd ?? ".");
  const rel = (p: string) => (p === root ? "." : p.slice(root.length + 1).replace(/\\/g, "/"));

  const failures: LicenseFailure[] = [];
  const packages: PackageLicense[] = [];
  const firstParty: string[] = [];
  const optionalAbsent: string[] = [];
  const roots: string[] = [];

  const rootManifest = readManifest(join(root, "package.json"));
  if (!rootManifest) {
    failures.push({
      code: "NO_MANIFEST",
      detail: `no readable package.json at ${root} — the gate cannot know what ships, which is a failure and not an empty pass`,
    });
    return {
      ok: false,
      method: "none — the root manifest could not be read",
      confidence: [],
      roots,
      examined: 0,
      packages,
      firstParty,
      vendored: [],
      optionalAbsent,
      policyPath: null,
      failures,
    };
  }

  interface Pending {
    name: string;
    fromDir: string;
    requiredBy: string;
    optional: boolean;
  }
  const queue: Pending[] = [];
  const enqueue = (m: Manifest, fromDir: string, requiredBy: string) => {
    for (const name of Object.keys(m.dependencies ?? {})) {
      queue.push({ name, fromDir, requiredBy, optional: false });
    }
    // `optionalDependencies` may legitimately not be installed on this
    // platform, so an absent one is reported rather than failed. Declared
    // `peerDependencies` are deliberately NOT traversed: a bundler either
    // externalises them or the dependent lists them in `dependencies` too, so
    // walking them would invent packages that are not in this install.
    for (const name of Object.keys(m.optionalDependencies ?? {})) {
      queue.push({ name, fromDir, requiredBy, optional: true });
    }
  };

  const policy = loadPolicy(root, opts.policyPath ?? join(root, "license-policy.json"), failures);

  for (const dir of [
    root,
    ...workspaceDirs(root, rootManifest),
    ...policy.roots.map((r) => resolve(root, r)),
  ]) {
    const m = dir === root ? rootManifest : readManifest(join(dir, "package.json"));
    if (!m) {
      failures.push({
        code: "NO_MANIFEST",
        detail: `declared workspace "${rel(dir)}" has no readable package.json — its dependencies would have been skipped silently`,
      });
      continue;
    }
    roots.push(rel(dir));
    enqueue(m, dir, `${rel(dir)} (workspace)`);
  }

  const visited = new Map<string, PackageLicense | null>();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const item = queue[cursor];
    const dir = resolveFrom(item.fromDir, root, item.name);
    if (!dir) {
      if (item.optional) {
        optionalAbsent.push(`${item.name} (optional, required by ${item.requiredBy})`);
        continue;
      }
      failures.push({
        code: "UNRESOLVED",
        detail: `${item.name}, required by ${item.requiredBy}, is not installed under ${rel(item.fromDir)} — run \`bun install\`; an unreadable package is not an approved one`,
      });
      continue;
    }

    const already = visited.get(dir);
    if (already !== undefined) {
      if (already && !already.requiredBy.includes(item.requiredBy)) {
        already.requiredBy.push(item.requiredBy);
      }
      continue;
    }

    const m = readManifest(join(dir, "package.json"));
    if (!m) {
      visited.set(dir, null);
      failures.push({
        code: "UNRESOLVED",
        detail: `${item.name}: package.json at ${rel(dir)} could not be parsed`,
      });
      continue;
    }

    if (m.private === true) {
      // A workspace package linked into node_modules. First-party, so it is
      // counted and named but not classified — it carries the product's own
      // licence, not a third party's.
      visited.set(dir, null);
      firstParty.push(m.name ?? item.name);
      enqueue(m, dir, m.name ?? item.name);
      continue;
    }

    const raw = declaredLicense(m);
    const record: PackageLicense = {
      package: m.name ?? item.name,
      version: m.version ?? "unknown",
      license: raw ? normalizeLicense(raw) : "none declared",
      status: raw ? classify(raw) : "missing",
      dir: rel(dir),
      requiredBy: [item.requiredBy],
    };
    visited.set(dir, record);
    packages.push(record);
    enqueue(m, dir, `${record.package}@${record.version}`);
  }

  const npmExceptions = policy.exceptions.filter((e) => e.kind === "npm");
  const vendored = policy.exceptions.filter((e) => e.kind === "vendored");

  const used = new Set<LicenseException>();
  for (const record of packages) {
    if (record.status === "approved") continue;
    const match = npmExceptions.find(
      (e) => e.package === record.package && normalizeLicense(e.license) === record.license
    );
    if (match) {
      used.add(match);
      record.status = "excepted";
      record.exception = match;
    }
  }

  for (const e of npmExceptions) {
    if (used.has(e)) continue;
    failures.push({
      code: "STALE_EXCEPTION",
      detail: `exception for ${e.package} @ ${e.license} matched no package needing it — remove it, or correct the licence it was reviewed against`,
    });
  }

  // An empty result set is the shape every one of the old gate's false passes had.
  if (packages.length === 0) {
    failures.push({
      code: "NO_PACKAGES",
      detail: `examined zero third-party packages across ${roots.length} manifest(s) — a resolver that read nothing looks exactly like a tree with nothing to check, so this is a failure`,
    });
  }

  for (const r of packages) {
    if (r.status === "restricted") {
      failures.push({
        code: "RESTRICTED_LICENSE",
        detail: `${r.package}@${r.version} is ${r.license} (via ${r.requiredBy.join(", ")}) — restricted, and no reviewed exception covers it`,
      });
    } else if (r.status === "unknown") {
      failures.push({
        code: "UNKNOWN_LICENSE",
        detail: `${r.package}@${r.version} declares "${r.license}", which is neither approved nor restricted`,
      });
    } else if (r.status === "missing") {
      failures.push({
        code: "MISSING_LICENSE",
        detail: `${r.package}@${r.version} (${r.dir}) declares no licence at all`,
      });
    }
  }

  return {
    ok: failures.length === 0,
    method: `production closure: root manifest + ${Math.max(roots.length - 1, 0)} further manifest(s) (workspaces and policy-declared roots), walked transitively through node_modules`,
    confidence: [
      "Superset of the artifact, not an exact match: every workspace is bundled, and tree-shaking can drop a package whose code never lands in the output.",
      "No bundler metafile is read — this gate runs before the build so that a licence failure does not cost a build, and Bun's builder emits none.",
      "peerDependencies are not traversed; optionalDependencies absent from this install are listed, not classified.",
      "Vendored (non-npm) components are only as complete as license-policy.json declares them; nothing here discovers them.",
    ],
    roots,
    examined: packages.length,
    packages,
    firstParty,
    vendored,
    optionalAbsent,
    policyPath: policy.path,
    failures,
  };
}

export function formatLicenseReport(report: LicenseReport): string {
  const order: Record<LicenseStatus, number> = {
    missing: 0,
    unknown: 1,
    restricted: 2,
    excepted: 3,
    approved: 4,
  };
  const sorted = [...report.packages].sort(
    (a, b) => order[a.status] - order[b.status] || a.package.localeCompare(b.package)
  );
  const count = (s: LicenseStatus) => sorted.filter((r) => r.status === s).length;

  const lines: string[] = [];
  lines.push(`Method: ${report.method}`);
  lines.push(`Manifests read: ${report.roots.join(", ") || "none"}`);
  lines.push(
    `Policy: ${report.policyPath ?? "none (no license-policy.json; no exceptions declared)"}`
  );
  lines.push("");
  lines.push(`Third-party packages examined: ${report.examined}`);
  lines.push(`  approved: ${count("approved")}`);
  lines.push(`  excepted: ${count("excepted")}`);
  lines.push(`  restricted: ${count("restricted")}`);
  lines.push(`  unknown: ${count("unknown")}`);
  lines.push(`  no licence declared: ${count("missing")}`);
  lines.push(`First-party workspace packages: ${report.firstParty.length}`);

  if (report.vendored.length > 0) {
    lines.push("");
    lines.push("Vendored components (declared, licence file verified on disk):");
    for (const v of report.vendored) {
      lines.push(`  ${v.package} — ${v.license} — ${v.licenseFile}`);
      lines.push(`    reviewed ${v.reviewed} by ${v.reviewedBy}: ${v.reason}`);
    }
  }

  const excepted = sorted.filter((r) => r.status === "excepted");
  if (excepted.length > 0) {
    lines.push("");
    lines.push("Reviewed npm exceptions:");
    for (const r of excepted) {
      lines.push(`  ${r.package}@${r.version} — ${r.license}: ${r.exception?.reason}`);
    }
  }

  if (report.optionalAbsent.length > 0) {
    lines.push("");
    lines.push("Optional dependencies not installed here (not classified):");
    for (const o of report.optionalAbsent) lines.push(`  ${o}`);
  }

  lines.push("");
  lines.push("Confidence:");
  for (const c of report.confidence) lines.push(`  - ${c}`);

  if (report.failures.length > 0) {
    lines.push("");
    lines.push(`Failures (${report.failures.length}):`);
    for (const f of report.failures) lines.push(`  [${f.code}] ${f.detail}`);
    lines.push("");
    lines.push("License compliance FAILED.");
  } else {
    lines.push("");
    lines.push(`License compliance PASSED on ${report.examined} third-party packages.`);
  }
  return lines.join("\n");
}

/** Kept for tRadio's `scripts/prod.ts`, which awaits a boolean. */
export async function checkLicenseCompliance(cwd = "."): Promise<boolean> {
  const report = checkLicenses({ cwd });
  console.log(formatLicenseReport(report));
  return report.ok;
}
