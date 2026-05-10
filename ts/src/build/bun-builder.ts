/**
 * Bun.build wrapper, Vite build runner, HTML minifier, and asset copier.
 * Zero npm deps — heavy dependencies are passed by the caller.
 */

import * as fs from "node:fs";

export interface BuildResult {
  success: boolean;
  errors: string[];
  warnings: string[];
  outputs?: string[];
}

type BuildTarget = "browser" | "node";

export async function bunBuild(
  entryPoint: string,
  outdir: string,
  target: BuildTarget
): Promise<BuildResult> {
  try {
    const buildConfig = {
      entrypoints: [entryPoint],
      outdir,
      target,
      format: (target === "browser" ? "iife" : "cjs") as "iife" | "cjs",
      minify: target === "browser",
      sourcemap: "none" as const,
      naming: "bundle.[ext]",
      loader: { ".node": "file" } as Record<string, import("bun").Loader>,
      packages: "bundle" as "external" | "bundle" | undefined,
      external: undefined as string[] | undefined,
    };

    const result = await Bun.build(buildConfig);

    const errors: string[] = [];
    const warnings: string[] = [];
    const outputs: string[] = [];

    if (result.logs?.length) {
      for (const log of result.logs) {
        if (log.level === "error") errors.push(log.message);
        else if (log.level === "warning") warnings.push(log.message);
      }
    }
    if (result.outputs?.length) {
      for (const output of result.outputs) outputs.push(output.path);
    }

    return { success: result.success, errors, warnings, outputs };
  } catch (error) {
    if (error instanceof AggregateError) {
      return {
        success: false,
        errors: error.errors.map((e: Error) => e.message || String(e)),
        warnings: [],
      };
    }
    return { success: false, errors: [`Bun build error: ${error}`], warnings: [] };
  }
}

export async function viteBuild(cwd: string): Promise<boolean> {
  const proc = Bun.spawn(["bunx", "vp", "build"], {
    cwd,
    stdio: ["inherit", "inherit", "inherit"],
  });
  return (await proc.exited) === 0;
}

export const DEFAULT_HTML_MINIFY_OPTS = {
  removeAttributeQuotes: true,
  removeComments: true,
  removeEmptyAttributes: true,
  removeRedundantAttributes: true,
  removeScriptTypeAttributes: true,
  removeStyleLinkTypeAttributes: true,
  collapseWhitespace: true,
  conservativeCollapse: true,
  useShortDoctype: true,
  minifyCSS: true,
  minifyJS: true,
};

/**
 * Minify an HTML file in-place.
 * @param minifyFn - The `minify` function from `html-minifier-terser`
 */
export async function minifyHtmlFile(
  filePath: string,
  minifyFn: (html: string, opts: Record<string, unknown>) => Promise<string>,
  opts: Record<string, unknown> = DEFAULT_HTML_MINIFY_OPTS
): Promise<void> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    const min = await minifyFn(raw, opts);
    await fs.promises.writeFile(filePath, min, "utf8");
    const pct = (((raw.length - min.length) / raw.length) * 100).toFixed(0);
    console.log(`  🗜️  Minified ${filePath} (${pct}% reduction)`);
  } catch (error) {
    console.warn(`  ⚠️  HTML minification failed for ${filePath}: ${error}`);
  }
}

/**
 * Copy a file to multiple destinations. Non-fatal on failure.
 */
export async function copyAssets(src: string, dests: string[], label?: string): Promise<void> {
  for (const dest of dests) {
    try {
      await fs.promises.copyFile(src, dest);
      const stat = await fs.promises.stat(dest);
      const name = label ?? src.split("/").pop();
      console.log(`  📋 Copied ${name} → ${dest} (${(stat.size / 1024).toFixed(1)} KB)`);
    } catch (error) {
      console.warn(`  ⚠️  Could not copy ${src} to ${dest}: ${error}`);
    }
  }
}

export async function buildServerBundle(
  entry: string,
  outDir: string,
  label = "server bundle"
): Promise<BuildResult> {
  console.log(`🔥 Building ${label} with Bun...`);

  try {
    if (fs.existsSync(`${outDir}/bundle.js`)) await fs.promises.rm(`${outDir}/bundle.js`);
    await fs.promises.mkdir(outDir, { recursive: true });
  } catch {
    // ignore
  }

  const result = await bunBuild(entry, outDir, "node");

  if (result.success) {
    console.log(`✅ ${label} build completed`);
    if (result.outputs?.length) {
      for (const file of result.outputs) console.log(`  - ${file}`);
    }
  } else {
    console.log(`❌ ${label} build failed`);
    for (const err of result.errors) console.error("  Error:", err);
  }
  if (result.warnings.length) {
    for (const warn of result.warnings) console.warn("  Warning:", warn);
  }

  return result;
}
