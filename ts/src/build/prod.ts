
import * as fs from "node:fs";
import * as path from "node:path";

export interface StagingConfig {
  sourceDir: string;
  distDir: string;

  /** Exact filenames to exclude in any directory */
  excludeFiles: string[];
  /** Exact directory names to exclude */
  excludeDirs: string[];
  /** Specific relative paths to exclude */
  excludePaths: string[];

  /** Modify fxmanifest.lua during copy */
  manifestMod?: {
    filename: string;
    removeDependencies: string[];
    removeConfigLines: string[];
  };

  /** Strip package.json for production */
  packageJsonMod?: {
    filename: string;
    removeScripts: boolean;
  };

  /** Compress PNG images (pass sharp module) */
  imageCompression?: {
    sharp: (input: string) => {
      png(opts: Record<string, number>): { toFile(dest: string): Promise<void> };
    };
    pngQuality: number;
    compressionLevel: number;
  };

  /** Minify HTML files (pass minify function) */
  htmlMinification?: {
    minify: (html: string, opts: Record<string, unknown>) => Promise<string>;
    opts: Record<string, unknown>;
  };
}

export class ProductionStager {
  private sourceDir: string;
  private distDir: string;
  private config: StagingConfig;

  constructor(config: StagingConfig) {
    this.sourceDir = path.resolve(config.sourceDir);
    this.distDir = path.resolve(config.distDir);
    this.config = config;
  }

  private shouldExcludeFile(fileName: string): boolean {
    return this.config.excludeFiles.includes(fileName);
  }

  private shouldExcludeDir(dirName: string, fullPath: string): boolean {
    if (this.config.excludeDirs.includes(dirName)) return true;
    const rel = path.relative(this.sourceDir, fullPath).replace(/\\/g, "/");
    return this.config.excludePaths.some((p) => p.replace(/\\/g, "/") === rel);
  }

  private isCompressibleImage(fileName: string): boolean {
    return !!this.config.imageCompression && path.extname(fileName).toLowerCase() === ".png";
  }

  private isMinifiableHtml(fileName: string): boolean {
    if (!this.config.htmlMinification) return false;
    const ext = path.extname(fileName).toLowerCase();
    return ext === ".html" || ext === ".htm";
  }

  async stage(): Promise<void> {
    console.log(`📂 Source: ${this.sourceDir}`);
    console.log(`📂 Destination: ${this.distDir}`);

    if (fs.existsSync(this.distDir)) {
      await fs.promises.rm(this.distDir, { recursive: true, force: true });
    }

    await this.copyDirectory(this.sourceDir, this.distDir);
    console.log("✅ Production distribution created successfully!");
  }

  private async copyDirectory(src: string, dest: string): Promise<void> {
    await fs.promises.mkdir(dest, { recursive: true });
    const entries = await fs.promises.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        if (!this.shouldExcludeDir(entry.name, srcPath)) {
          await this.copyDirectory(srcPath, destPath);
        } else {
          console.log(`📁 Excluding directory: ${path.relative(this.sourceDir, srcPath)}`);
        }
      } else if (entry.isFile()) {
        if (this.shouldExcludeFile(entry.name)) {
          console.log(`📄 Excluding file: ${entry.name}`);
          continue;
        }

        if (this.config.manifestMod && entry.name === this.config.manifestMod.filename) {
          await this.copyAndModifyManifest(srcPath, destPath);
        } else if (
          this.config.packageJsonMod &&
          entry.name === this.config.packageJsonMod.filename
        ) {
          await this.copyAndModifyPackageJson(srcPath, destPath);
        } else if (this.isCompressibleImage(entry.name)) {
          await this.compressImage(srcPath, destPath);
        } else if (this.isMinifiableHtml(entry.name)) {
          await this.minifyHtml(srcPath, destPath);
        } else {
          await fs.promises.copyFile(srcPath, destPath);
        }
      }
    }
  }

  private async copyAndModifyManifest(src: string, dest: string): Promise<void> {
    const mod = this.config.manifestMod!;
    const content = await fs.promises.readFile(src, "utf8");
    const lines = content.split("\n");
    const out: string[] = [];
    let skipDeps = false;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      // Skip config lines
      if (mod.removeConfigLines.some((c) => trimmed.startsWith(c))) {
        console.log(`🚫 Removing config line: ${trimmed}`);
        continue;
      }

      // Handle dependencies block
      if (trimmed.startsWith("dependencies {")) {
        skipDeps = true;
        let j = i + 1;
        const remaining: string[] = [];
        while (j < lines.length && !lines[j].trim().startsWith("}")) {
          const depLine = lines[j].trim();
          const shouldRemove = mod.removeDependencies.some(
            (d) => depLine.includes(`'${d}'`) || depLine.includes(`"${d}"`)
          );
          if (shouldRemove) {
            console.log(`🚫 Removing dependency: ${depLine}`);
          } else if (depLine) {
            remaining.push(lines[j]);
          }
          j++;
        }
        if (remaining.length > 0) {
          out.push(lines[i], ...remaining, lines[j]);
        } else {
          console.log("🚫 Removing entire dependencies block");
        }
        i = j;
        skipDeps = false;
        continue;
      }

      if (!skipDeps) out.push(lines[i]);
    }

    await fs.promises.writeFile(dest, out.join("\n"), "utf8");
    console.log(`✏️  Modified ${mod.filename}`);
  }

  private async copyAndModifyPackageJson(src: string, dest: string): Promise<void> {
    const content = await fs.promises.readFile(src, "utf8");
    const json = JSON.parse(content);
    if (this.config.packageJsonMod?.removeScripts) delete json.scripts;
    delete json.devDependencies;
    await fs.promises.writeFile(dest, JSON.stringify(json, null, 2), "utf8");
    console.log("✏️  Modified package.json (stripped scripts + devDeps)");
  }

  private async compressImage(src: string, dest: string): Promise<void> {
    const { sharp, pngQuality, compressionLevel } = this.config.imageCompression!;
    try {
      await sharp(src).png({ quality: pngQuality, compressionLevel }).toFile(dest);
      const orig = (await fs.promises.stat(src)).size;
      const comp = (await fs.promises.stat(dest)).size;
      const pct = (((orig - comp) / orig) * 100).toFixed(1);
      console.log(
        `  🖼️  ${path.basename(src)}: ${(orig / 1024).toFixed(1)}KB → ${(comp / 1024).toFixed(1)}KB (${pct}%)`
      );
    } catch {
      await fs.promises.copyFile(src, dest);
    }
  }

  private async minifyHtml(src: string, dest: string): Promise<void> {
    const { minify, opts } = this.config.htmlMinification!;
    try {
      const raw = await fs.promises.readFile(src, "utf8");
      const min = await minify(raw, opts);
      await fs.promises.writeFile(dest, min, "utf8");
      const pct = (((raw.length - min.length) / raw.length) * 100).toFixed(1);
      console.log(`  🗜️  ${path.basename(src)}: ${pct}% reduction`);
    } catch {
      await fs.promises.copyFile(src, dest);
    }
  }
}
