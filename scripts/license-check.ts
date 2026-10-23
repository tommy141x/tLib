#!/usr/bin/env bun
// The licence gate as a standalone command, so every t* resource can run it
// from its own root with `bun run ../tLib/scripts/license-check.ts` instead of
// only getting it as a side effect of a release build.

import { checkLicenses, formatLicenseReport } from "../shared/ts/build/license.ts";

const cwdArg = process.argv.indexOf("--cwd");
const cwd = cwdArg >= 0 ? process.argv[cwdArg + 1] : process.cwd();

const report = checkLicenses({ cwd });
console.log(formatLicenseReport(report));
process.exit(report.ok ? 0 : 1);
