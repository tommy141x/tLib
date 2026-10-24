/**
 * The gate that catches a third-party package compiled into a server bundle and named
 * in no notices file.
 *
 * It exists because tDetector's THIRD-PARTY-NOTICES.md said `server/dist/bundle.js`
 * "contains no third-party code" while `adm-zip` had been compiled into it for three
 * releases — through tLib's marketplace installer, out of tLib's own `node_modules`, so
 * no manifest in tDetector's repo could have revealed it.
 *
 * The third test is the one that matters most: a gate pointed at a path that does not
 * exist found nothing, and "found nothing" is indistinguishable from "clean" unless it
 * is made to throw.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBundledPackagesNamed,
  bundledPackages,
} from "../../shared/ts/build/bundled-packages.ts";

/** The shape bun and rolldown actually emit above an inlined module. */
const BUNDLE = `
// ../tLib/node_modules/adm-zip/util/constants.js
var require_constants = __commonJS(function () {});
// ../tLib/node_modules/adm-zip/zipFile.js
var require_zipFile = __commonJS(function () {});
// ../tLib/node_modules/@scoped/thing/index.js
var require_thing = __commonJS(function () {});
// ../../shared/ts/marketplace/installer.ts
function install() {}
`;

function bundleFile(contents = BUNDLE): string {
  const dir = mkdtempSync(join(tmpdir(), "tlib-bundled-"));
  const file = join(dir, "bundle.js");
  writeFileSync(file, contents);
  return file;
}

describe("bundledPackages", () => {
  test("names every package with a module banner, scopes included", () => {
    const { packages } = bundledPackages([bundleFile()]);
    expect(packages).toEqual(["@scoped/thing", "adm-zip"]);
  });

  test("a first-party path is not a package", () => {
    const { packages } = bundledPackages([
      bundleFile("// ../../shared/ts/marketplace/installer.ts\nfunction x() {}\n"),
    ]);
    expect(packages).toEqual([]);
  });

  test("reports what it actually read", () => {
    const file = bundleFile();
    const { scanned } = bundledPackages([file, join(file, "..", "absent.js")]);
    expect(scanned).toEqual([file]);
  });
});

describe("assertBundledPackagesNamed", () => {
  test("passes when the notices name every bundled package", () => {
    const notices = "| `adm-zip` | 0.6.1 | MIT |\n| `@scoped/thing` | 1.0.0 | MIT |";
    expect(() => assertBundledPackagesNamed([bundleFile()], notices)).not.toThrow();
  });

  test("throws, naming the package, when attribution is missing", () => {
    const notices = "| `@scoped/thing` | 1.0.0 | MIT |";
    expect(() => assertBundledPackagesNamed([bundleFile()], notices)).toThrow(/adm-zip/);
  });

  test("refuses to pass when no path it was given exists", () => {
    // The failure the whole module is shaped around: a stale path reads nothing, and
    // nothing contains no unattributed packages, so the release goes out green.
    expect(() => assertBundledPackagesNamed(["no/such/bundle.js"], "")).toThrow(
      /reads nothing passes everything/
    );
  });
});
