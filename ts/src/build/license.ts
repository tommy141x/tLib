
import * as fs from "node:fs";
import * as path from "node:path";

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

interface LicenseResult {
  package: string;
  version: string;
  license: string;
  status: "approved" | "restricted" | "unknown" | "missing";
}

function normalizeLicense(license: string): string {
  if (!license) return "unknown";
  const trimmed = license.trim();
  if (LICENSE_ALIASES.has(trimmed)) return LICENSE_ALIASES.get(trimmed)!;
  if (trimmed.includes(" OR ") || trimmed.includes(" AND ")) return trimmed;
  return (
    trimmed
      .replace(/^License:\s*/i, "")
      .replace(/\s+License$/i, "")
      .replace(/^\(|\)$/g, "") || "unknown"
  );
}

function getStatus(license: string): "approved" | "restricted" | "unknown" {
  const normalized = normalizeLicense(license);
  if (APPROVED_LICENSES.has(normalized)) return "approved";
  if (RESTRICTED_LICENSES.has(normalized)) return "restricted";
  return "unknown";
}

export async function checkLicenseCompliance(cwd = "."): Promise<boolean> {
  console.log("🔍 Checking production dependencies for license compliance...");

  const pkgPath = path.resolve(cwd, "package.json");
  let deps: string[];
  try {
    const content = await fs.promises.readFile(pkgPath, "utf8");
    deps = Object.keys(JSON.parse(content).dependencies || {});
  } catch {
    console.log("⚠️  No package.json found.");
    return true;
  }

  if (deps.length === 0) {
    console.log("⚠️  No production dependencies found.");
    return true;
  }

  console.log(`📦 Found ${deps.length} production dependencies to check...`);

  const results: LicenseResult[] = [];
  for (const name of deps) {
    const depPkg = path.resolve(cwd, "node_modules", name, "package.json");
    try {
      const content = await fs.promises.readFile(depPkg, "utf8");
      const json = JSON.parse(content);
      const license = json.license || json.licenses?.[0]?.type || "missing";
      results.push({
        package: json.name || name,
        version: json.version || "unknown",
        license: normalizeLicense(license),
        status: license === "missing" ? "missing" : getStatus(license),
      });
    } catch {
      // package not found in node_modules
    }
  }

  results.sort((a, b) => {
    const order = { missing: 0, unknown: 1, restricted: 2, approved: 3 };
    return order[a.status] - order[b.status] || a.package.localeCompare(b.package);
  });

  // Report
  const approved = results.filter((r) => r.status === "approved");
  const restricted = results.filter((r) => r.status === "restricted");
  const unknown = results.filter((r) => r.status === "unknown");
  const missing = results.filter((r) => r.status === "missing");

  console.log(`\n📊 Summary:`);
  console.log(`  ✅ Approved: ${approved.length}`);
  console.log(`  ⚠️  Restricted: ${restricted.length}`);
  console.log(`  ❓ Unknown: ${unknown.length}`);
  console.log(`  ❌ Missing: ${missing.length}`);

  for (const group of [
    { label: "⚠️  Restricted", items: restricted },
    { label: "❓ Unknown", items: unknown },
    { label: "❌ Missing", items: missing },
  ]) {
    if (group.items.length) {
      console.log(`\n${group.label}:`);
      for (const r of group.items) console.log(`  ${r.package}@${r.version} - ${r.license}`);
    }
  }

  const hasIssues = restricted.length > 0 || unknown.length > 0 || missing.length > 0;
  console.log(
    hasIssues
      ? "\n⚠️  License compliance issues found."
      : "\n✅ All production dependencies have approved licenses!"
  );
  return !hasIssues;
}
