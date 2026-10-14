/**
 * `decodeWav`'s contract, with the two prior bodies run against the same checks.
 *
 * The negative controls are the real ones: `unclampedData` is what tRadio's
 * `loadWav`/`loadWavMono` did, and `mergedDiagnostics` is what
 * `audio-render.ts` did. The truncation case is the whole reason this module
 * exists, so it is proved by showing the old body fails it — not by asserting
 * that the new one passes, which it would do even if the clamp were a no-op on
 * a well-formed file.
 */

import { describe, expect, test } from "bun:test";
import { decodeWav, type Wav } from "../../shared/ts/audio/wav.ts";

/** Build a well-formed 16-bit PCM WAV. `declaredDataLen` overrides the honest size. */
function wav(opts: {
  frames: number[][];
  rate?: number;
  bits?: number;
  declaredDataLen?: number;
  truncateBy?: number;
  extraChunk?: boolean;
}): Buffer {
  const { frames, rate = 48000, bits = 16, truncateBy = 0, extraChunk = false } = opts;
  const channels = frames[0]?.length ?? 1;
  const dataBytes = frames.length * channels * 2;
  // An odd-sized LIST chunk before `data`, to exercise the word-alignment pad.
  const extra = extraChunk ? 8 + 3 + 1 : 0;
  const b = Buffer.alloc(12 + 24 + extra + 8 + dataBytes);
  let o = 0;
  b.write("RIFF", o);
  o += 4;
  b.writeUInt32LE(b.length - 8, o);
  o += 4;
  b.write("WAVE", o);
  o += 4;

  b.write("fmt ", o);
  o += 4;
  b.writeUInt32LE(16, o);
  o += 4;
  b.writeUInt16LE(1, o);
  o += 2;
  b.writeUInt16LE(channels, o);
  o += 2;
  b.writeUInt32LE(rate, o);
  o += 4;
  b.writeUInt32LE(rate * channels * 2, o);
  o += 4;
  b.writeUInt16LE(channels * 2, o);
  o += 2;
  b.writeUInt16LE(bits, o);
  o += 2;

  if (extraChunk) {
    b.write("LIST", o);
    o += 4;
    b.writeUInt32LE(3, o);
    o += 4;
    b.write("abc", o);
    o += 3;
    o += 1; // pad byte, not counted in the declared size
  }

  b.write("data", o);
  o += 4;
  b.writeUInt32LE(opts.declaredDataLen ?? dataBytes, o);
  o += 4;
  for (const frame of frames)
    for (const s of frame) {
      b.writeInt16LE(s, o);
      o += 2;
    }
  return truncateBy > 0 ? b.subarray(0, b.length - truncateBy) : b;
}

type Decoder = (bytes: Buffer, label?: string) => Wav;

const CHECKS: Record<string, (decode: Decoder) => void> = {
  "decodes mono samples and the declared rate"(decode) {
    const got = decode(wav({ frames: [[0], [16384], [-32768], [32767]], rate: 22050 }));
    if (got.rate !== 22050) throw new Error(`rate ${got.rate}`);
    if (got.channels !== 1) throw new Error(`channels ${got.channels}`);
    const want = [0, 0.5, -1, 32767 / 32768];
    for (let i = 0; i < want.length; i++) {
      if (Math.abs(got.samples[i] - want[i]) > 1e-9)
        throw new Error(`sample ${i} = ${got.samples[i]}`);
    }
  },

  "downmixes multi-channel by averaging"(decode) {
    const got = decode(
      wav({
        frames: [
          [32767, -32767],
          [16384, 16384],
        ],
      })
    );
    if (got.channels !== 2) throw new Error(`channels ${got.channels}`);
    if (Math.abs(got.samples[0]) > 1e-4) throw new Error(`cancelling frame = ${got.samples[0]}`);
    if (Math.abs(got.samples[1] - 0.5) > 1e-9) throw new Error(`frame 1 = ${got.samples[1]}`);
    if (got.samples.length !== 2) throw new Error(`frames ${got.samples.length}`);
  },

  "skips an unknown chunk and honours its pad byte"(decode) {
    const got = decode(wav({ frames: [[1000], [2000]], extraChunk: true }));
    if (got.samples.length !== 2) throw new Error(`frames ${got.samples.length}`);
    if (Math.abs(got.samples[1] - 2000 / 32768) > 1e-9)
      throw new Error(`frame 1 = ${got.samples[1]}`);
  },

  /**
   * The reason this module exists: a file truncated mid-write declares more
   * data than it holds, and the old bodies read off the end of the buffer.
   */
  "decodes what a truncated file actually contains"(decode) {
    // 8 frames declared, 3 frames' worth of bytes cut off the end.
    const got = decode(
      wav({ frames: Array.from({ length: 8 }, (_, i) => [i * 100]), truncateBy: 6 })
    );
    if (got.samples.length !== 5)
      throw new Error(`expected 5 surviving frames, got ${got.samples.length}`);
    if (Math.abs(got.samples[4] - 400 / 32768) > 1e-9)
      throw new Error(`frame 4 = ${got.samples[4]}`);
  },

  /** The same hazard stated by the header rather than by a short read. */
  "ignores a data chunk that over-declares its size"(decode) {
    const got = decode(wav({ frames: [[100], [200]], declaredDataLen: 4096 }));
    if (got.samples.length !== 2) throw new Error(`frames ${got.samples.length}`);
  },

  "rejects a non-RIFF file by name"(decode) {
    let message = "";
    try {
      decode(Buffer.from("OggS----not a wav at all"), "take.ogg");
    } catch (e) {
      message = (e as Error).message;
    }
    if (!message.includes("take.ogg")) throw new Error(`message did not name the file: ${message}`);
    if (!/RIFF\/WAVE/.test(message)) throw new Error(`message did not say why: ${message}`);
  },

  /** "no data chunk" and "not 16-bit" are different problems and must say so. */
  "distinguishes a missing data chunk from a wrong bit depth"(decode) {
    let bitsMessage = "";
    try {
      decode(wav({ frames: [[1]], bits: 24 }), "deep.wav");
    } catch (e) {
      bitsMessage = (e as Error).message;
    }
    if (!/16-bit/.test(bitsMessage) || !/24/.test(bitsMessage)) {
      throw new Error(`bit-depth error did not report the depth: ${bitsMessage}`);
    }

    // A header with a fmt chunk and no data chunk at all.
    const headerOnly = wav({ frames: [[1]] }).subarray(0, 36);
    let dataMessage = "";
    try {
      decode(headerOnly, "headless.wav");
    } catch (e) {
      dataMessage = (e as Error).message;
    }
    if (!/data chunk/.test(dataMessage)) {
      throw new Error(`missing-data error did not say so: ${dataMessage}`);
    }
  },
};

const CHECK_NAMES = Object.keys(CHECKS);

describe("decodeWav", () => {
  for (const name of CHECK_NAMES) {
    test(name, () => {
      CHECKS[name](decodeWav);
    });
  }
});

// Negative controls: the two bodies this replaced

/** tRadio `audio-analyze.ts` / `audio-render.ts`: `dataLen = size`, unclamped. */
const unclampedData: Decoder = (bytes, label = "<buffer>") => {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${label}: not a RIFF/WAVE file`);
  }
  let channels = 1;
  let rate = 48000;
  let bits = 16;
  let dataStart = -1;
  let dataLen = 0;
  let i = 12;
  while (i + 8 <= bytes.length) {
    const id = bytes.toString("ascii", i, i + 4);
    const size = bytes.readUInt32LE(i + 4);
    if (id === "fmt ") {
      channels = bytes.readUInt16LE(i + 10);
      rate = bytes.readUInt32LE(i + 12);
      bits = bytes.readUInt16LE(i + 22);
    } else if (id === "data") {
      dataStart = i + 8;
      dataLen = size;
    }
    i += 8 + size + (size & 1);
  }
  if (dataStart < 0) throw new Error(`${label}: no data chunk`);
  if (bits !== 16) throw new Error(`${label}: only 16-bit PCM supported, got ${bits}`);
  const frames = Math.floor(dataLen / 2 / channels);
  const samples = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += bytes.readInt16LE(dataStart + (f * channels + c) * 2);
    samples[f] = acc / channels / 32768;
  }
  return { samples, rate, channels };
};

/**
 * tRadio `audio-render.ts`: one error for two unrelated problems, and it
 * returned a bare `Float32Array`, so the rate and channel count were simply
 * unavailable to callers (modelled here as zeroes).
 */
const mergedDiagnostics: Decoder = (bytes, label = "<buffer>") => {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${label}: not a RIFF/WAVE file`);
  }
  let channels = 1;
  let bits = 16;
  let dataStart = -1;
  let dataLen = 0;
  let i = 12;
  while (i + 8 <= bytes.length) {
    const id = bytes.toString("ascii", i, i + 4);
    const size = bytes.readUInt32LE(i + 4);
    if (id === "fmt ") {
      channels = bytes.readUInt16LE(i + 10);
      bits = bytes.readUInt16LE(i + 22);
    } else if (id === "data") {
      dataStart = i + 8;
      dataLen = size;
    }
    i += 8 + size + (size & 1);
  }
  if (dataStart < 0 || bits !== 16) throw new Error(`${label}: need 16-bit PCM`);
  const frames = Math.floor(dataLen / 2 / channels);
  const samples = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += bytes.readInt16LE(dataStart + (f * channels + c) * 2);
    samples[f] = acc / channels / 32768;
  }
  // It also dropped the rate and the channel count.
  return { samples, rate: 0, channels: 0 };
};

const CONTROLS: { name: string; decode: Decoder; breaks: string[] }[] = [
  {
    name: "unclamped data length (tRadio loadWav / loadWavMono)",
    decode: unclampedData,
    breaks: [
      "decodes what a truncated file actually contains",
      "ignores a data chunk that over-declares its size",
    ],
  },
  {
    name: "merged diagnostics + dropped rate (tRadio loadWavMono)",
    decode: mergedDiagnostics,
    // NOT in this list, deliberately: "skips an unknown chunk and honours its
    // pad byte". That check reads neither the rate nor the channel count, so
    // this body passes it — and listing it anyway is how a control starts
    // "proving" more than it measures. The suite rejected exactly that draft.
    breaks: [
      "decodes mono samples and the declared rate",
      "downmixes multi-channel by averaging",
      "decodes what a truncated file actually contains",
      "ignores a data chunk that over-declares its size",
      "distinguishes a missing data chunk from a wrong bit depth",
    ],
  },
];

describe("negative controls", () => {
  for (const control of CONTROLS) {
    test(`${control.name}: names only real checks`, () => {
      for (const name of control.breaks) expect(CHECK_NAMES).toContain(name);
      expect(control.breaks.length).toBeGreaterThan(0);
    });

    for (const name of CHECK_NAMES) {
      const mustFail = control.breaks.includes(name);
      test(`${control.name}: ${mustFail ? "FAILS" : "still passes"} "${name}"`, () => {
        let error: unknown;
        try {
          CHECKS[name](control.decode);
        } catch (caught) {
          error = caught;
        }
        if (mustFail) expect(error).toBeDefined();
        else expect(error).toBeUndefined();
      });
    }
  }
});
