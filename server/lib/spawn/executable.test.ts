/**
 * The mode bit, driven on both platforms from a Windows development machine.
 *
 * `ensureExecutable` takes its filesystem as an argument for exactly this: the
 * branch that matters runs on Linux, nothing here does, and a suite that only
 * exercised `process.platform` would assert the no-op and call it covered.
 */

import { describe, expect, it } from "bun:test";
import { ensureExecutable, type ModeBits } from "./executable";

interface Recorder extends ModeBits {
  asked: string[];
  chmodded: string[];
}

function recorder(options: {
  platform: string;
  executable: boolean;
  chmodFails?: boolean;
}): Recorder {
  const asked: string[] = [];
  const chmodded: string[] = [];
  return {
    platform: options.platform,
    asked,
    chmodded,
    canExecute(target) {
      asked.push(target);
      if (!options.executable) throw new Error(`EACCES: ${target}`);
    },
    makeExecutable(target) {
      chmodded.push(target);
      if (options.chmodFails) throw new Error(`EPERM: ${target}`);
    },
  };
}

const BINARY = "/opt/fxserver/resources/[tScripts]/tRadio/server/bin/linux/llama/llama-server";

describe("the mode bit on Linux", () => {
  it("chmods a binary the release delivered without the bit", () => {
    const fs = recorder({ platform: "linux", executable: false });
    ensureExecutable(BINARY, fs);
    expect(fs.chmodded).toEqual([BINARY]);
  });

  it("leaves an already-executable binary alone", () => {
    // Not cosmetic: the common case is a correctly-extracted release, and a
    // chmod on every start would rewrite the mode of a file an operator may
    // have deliberately locked down.
    const fs = recorder({ platform: "linux", executable: true });
    ensureExecutable(BINARY, fs);
    expect(fs.asked).toEqual([BINARY]);
    expect(fs.chmodded).toEqual([]);
  });

  it("swallows a chmod it is not allowed to make", () => {
    // A read-only mount or a file owned by someone else. The spawn that follows
    // reports the failure with the file name and the syscall in it, which is a
    // better message than anything this could produce.
    const fs = recorder({ platform: "linux", executable: false, chmodFails: true });
    expect(() => ensureExecutable(BINARY, fs)).not.toThrow();
    expect(fs.chmodded).toEqual([BINARY]);
  });

  it("fixes the loader, which is what the loader form actually execs", () => {
    // The whole reason this lives in tLib rather than in each product: with a
    // bundled loader the product's own binary is an *argument*, and the file
    // handed to execve is one the product never names.
    const loader =
      "/opt/fxserver/resources/[tScripts]/tRadio/server/bin/linux/llama/lib/ld-linux-x86-64.so.2";
    const fs = recorder({ platform: "linux", executable: false });
    ensureExecutable(loader, fs);
    expect(fs.chmodded).toEqual([loader]);
  });
});

describe("the mode bit on Windows", () => {
  it("does nothing at all, including asking", () => {
    // `accessSync(X_OK)` on Windows answers for the *read* bit, so it would
    // succeed on a .dll and a .txt alike; calling it would be noise with a
    // chance of being read as meaningful.
    const fs = recorder({ platform: "win32", executable: false });
    ensureExecutable(
      "C:\\fxserver\\resources\\[tScripts]\\tRadio\\server\\bin\\win\\llama\\llama-server.exe",
      fs
    );
    expect(fs.asked).toEqual([]);
    expect(fs.chmodded).toEqual([]);
  });
});
