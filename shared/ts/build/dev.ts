export interface WatcherDef {
  /** Display name (e.g. "Server files") */
  name: string;
  /** Glob patterns to watch */
  patterns: string[];
  /** Rebuild function to call on change */
  rebuild: () => Promise<void>;
}

export interface DevConfig {
  /** Run a full build before starting watchers */
  buildAll: () => Promise<{ success: boolean }>;
  /** Watcher definitions */
  watchers: WatcherDef[];
  /** Debounce time in ms (default: 300) */
  debounceMs?: number;
  /** chokidar module — pass `await import("chokidar")` or `require("chokidar")` */
  chokidar: { watch(paths: string[], opts?: Record<string, unknown>): ChokidarWatcher };
}

interface ChokidarWatcher {
  on(event: string, cb: (...args: unknown[]) => void): ChokidarWatcher;
  close(): void;
}

function debounce(fn: () => void, ms: number): () => void {
  let timeout: ReturnType<typeof setTimeout>;
  return () => {
    clearTimeout(timeout);
    timeout = setTimeout(fn, ms);
  };
}

export async function startDevMode(config: DevConfig): Promise<void> {
  const wait = config.debounceMs ?? 300;
  let isBuilding = false;

  console.log("Starting development mode with file watching...\n");

  // Initial build
  const result = await config.buildAll();
  if (!result.success) {
    console.log("\nInitial build failed!");
    process.exit(1);
  }

  const activeWatchers: ChokidarWatcher[] = [];

  for (const def of config.watchers) {
    const watcher = config.chokidar.watch(def.patterns, { ignoreInitial: true });

    const rebuild = debounce(async () => {
      if (isBuilding) return;
      isBuilding = true;
      console.log(`\n${def.name} changed, rebuilding...`);
      try {
        await def.rebuild();
      } finally {
        isBuilding = false;
      }
    }, wait);

    watcher.on("change", rebuild);
    watcher.on("add", rebuild);
    watcher.on("unlink", rebuild);
    activeWatchers.push(watcher);
  }

  console.log("\nWatching for file changes...");
  for (const def of config.watchers) {
    console.log(`${def.name}: ${def.patterns.join(", ")}`);
  }
  console.log("\nPress Ctrl+C to stop watching");

  process.on("SIGINT", () => {
    console.log("\nStopping file watchers...");
    for (const w of activeWatchers) w.close();
    console.log("Development mode stopped");
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}
