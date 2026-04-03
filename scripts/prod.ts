import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { dirname, join } from "path";
import AdmZip from "adm-zip";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const ZIP_PATH = join(ROOT, "tLib.zip");

// Files and directories to include in the release zip
const INCLUDE = [
	"fxmanifest.lua",
	"client.lua",
	"server.lua",
	"imports.lua",
	"tLibShim.lua",
	"README.md",
	"LICENSE",
	"lua",
	"imports",
	"ui/build",
	"server/bundle.js",
];

function step(label: string) {
	console.log(`\n→ ${label}`);
}

function run(cmd: string, args: string[], cwd: string) {
	const proc = Bun.spawnSync([cmd, ...args], { cwd, stdout: "inherit", stderr: "inherit" });
	if (proc.exitCode !== 0) {
		console.error(`\nFailed: ${cmd} ${args.join(" ")}`);
		process.exit(1);
	}
}

function addToZip(zip: AdmZip, dir: string, zipPrefix: string) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			addToZip(zip, full, `${zipPrefix}/${entry}`);
		} else {
			zip.addLocalFile(full, zipPrefix);
		}
	}
}

// ── Build ─────────────────────────────────────────────────────────────────────

step("Installing UI dependencies");
run("bun", ["install"], join(ROOT, "ui/src"));

step("Building UI and server bundle");
run("bun", ["run", "build"], join(ROOT, "ui/src"));

// ── Stage ─────────────────────────────────────────────────────────────────────

step("Staging release files");
if (existsSync(DIST)) rmSync(DIST, { recursive: true });
mkdirSync(DIST, { recursive: true });

for (const item of INCLUDE) {
	const src = join(ROOT, item);
	const dest = join(DIST, item);
	if (!existsSync(src)) {
		console.warn(`  skip  ${item} (not found)`);
		continue;
	}
	mkdirSync(dirname(dest), { recursive: true });
	cpSync(src, dest, { recursive: true });
	console.log(`  +     ${item}`);
}

// ── Zip ───────────────────────────────────────────────────────────────────────

step("Creating tLib.zip");
if (existsSync(ZIP_PATH)) rmSync(ZIP_PATH);

const zip = new AdmZip();
addToZip(zip, DIST, "tLib");
zip.writeZip(ZIP_PATH);

rmSync(DIST, { recursive: true });

const mb = (statSync(ZIP_PATH).size / 1024 / 1024).toFixed(2);
console.log(`\nDone! tLib.zip — ${mb} MB\n`);
