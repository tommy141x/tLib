/**
 * `encodeWav`'s contract, and the bit the copies it replaces were losing.
 *
 * The negative control is `symmetricEncode` — byte-for-byte what tRadio's
 * `audio-render.ts` and `audio-listen.ts` did. It is run against the same
 * checks, and the suite asserts it FAILS the full-scale and ramp cases. That is
 * the only way round this proof works: asserting that `encodeWav` writes
 * -32768 for -1.0 passes just as well against a writer that happens to be
 * right on one sample, whereas showing the old body misses the floor on 23,968
 * of 48,000 ramp samples is the measurement.
 *
 * `COVERED` names the scenarios rather than counting them, so adding one here
 * cannot leave a stale expected total refusing its own run.
 */

import { describe, expect, test } from "bun:test";
import { decodeWav, encodeWav, writeWav } from "../../shared/ts/audio/wav.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** ⚠️ NEGATIVE CONTROL — the retired mono writer, verbatim. Never call this for real. */
function symmetricEncode(channelData: Float32Array[], rate: number): Buffer {
  const channels = channelData.length;
  const frames = channelData[0].length;
  const dataLen = frames * channels * 2;
  const b = Buffer.alloc(44 + dataLen);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + dataLen, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(dataLen, 40);
  let o = 44;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, channelData[c][f]));
      b.writeInt16LE(Math.round(v * 32767), o);
      o += 2;
    }
  }
  return b;
}

type Encoder = (ch: Float32Array[], rate: number) => Buffer;

/** Every int16 sample in a header-prefixed PCM buffer. */
function pcm(b: Buffer): number[] {
  const out: number[] = [];
  for (let o = 44; o + 1 < b.length; o += 2) out.push(b.readInt16LE(o));
  return out;
}

/** A full-scale -1..+1 ramp, 48000 frames — a renderer's worst case for this. */
function ramp(n = 48000): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = (i / (n - 1)) * 2 - 1;
  return a;
}

// ── The scenarios, as a SET of names ────────────────────────────────────────
const COVERED = new Set([
  "negative full scale reaches the int16 floor",
  "positive full scale does not wrap",
  "a full-scale ramp uses the whole range",
]);

/** scenario -> does the encoder satisfy it. The control must fail some of these. */
function evaluate(enc: Encoder): Map<string, boolean> {
  const r = new Map<string, boolean>();

  r.set(
    "negative full scale reaches the int16 floor",
    pcm(enc([new Float32Array([-1])], 48000))[0] === -32768,
  );
  r.set("positive full scale does not wrap", pcm(enc([new Float32Array([1])], 48000))[0] === 32767);
  r.set("a full-scale ramp uses the whole range", (() => {
    const s = pcm(enc([ramp()], 48000));
    return Math.min(...s) === -32768 && Math.max(...s) === 32767;
  })());

  return r;
}

describe("encodeWav", () => {
  test("covers every scenario it claims to", () => {
    expect(new Set(evaluate(encodeWav).keys())).toEqual(COVERED);
  });

  for (const name of COVERED) {
    test(name, () => {
      expect(evaluate(encodeWav).get(name)).toBe(true);
    });
  }

  test("⚠️ control: the symmetric mono writer fails the full-scale scenarios", () => {
    const ctrl = evaluate(symmetricEncode);
    // Named, not counted. If a future scenario is added that the control also
    // passes, this fails and says which — rather than a total going stale.
    const failed = [...ctrl].filter(([, ok]) => !ok).map(([n]) => n);
    expect(new Set(failed)).toEqual(
      new Set([
        "negative full scale reaches the int16 floor",
        "a full-scale ramp uses the whole range",
      ]),
    );
    // And the one it passes, it passes for the right reason, not by accident:
    // +1.0 * 32767 is 32767 in both bodies, so this scenario cannot discriminate.
    expect(ctrl.get("positive full scale does not wrap")).toBe(true);
  });

  test("the measured delta against the symmetric writer is one LSB, negatives only", () => {
    const input = [ramp()];
    const good = pcm(encodeWav(input, 48000));
    const bad = pcm(symmetricEncode(input, 48000));
    expect(good.length).toBe(48000);

    let differing = 0;
    let maxAbsDelta = 0;
    let nonNegativeDifferences = 0;
    let wrongDirection = 0;
    for (let i = 0; i < good.length; i++) {
      if (good[i] === bad[i]) continue;
      differing++;
      maxAbsDelta = Math.max(maxAbsDelta, Math.abs(good[i] - bad[i]));
      if (input[0][i] >= 0) nonNegativeDifferences++;
      // The old body was always the HIGHER (less negative) of the two.
      if (bad[i] <= good[i]) wrongDirection++;
    }

    // The ramp row of the table in shared/ts/audio/wav.ts's header. If a change
    // moves these, that header is now wrong and this is where it says so.
    expect(differing).toBe(11978);
    expect(maxAbsDelta).toBe(1);
    expect(nonNegativeDifferences).toBe(0);
    expect(wrongDirection).toBe(0);

    // And the file-level figure in the same row: more BYTES move than samples,
    // because a 1-LSB change carries into the high byte 44 times over this ramp.
    const goodBytes = encodeWav(input, 48000);
    const badBytes = symmetricEncode(input, 48000);
    let byteDelta = 0;
    for (let i = 0; i < goodBytes.length; i++) if (goodBytes[i] !== badBytes[i]) byteDelta++;
    expect(goodBytes.length).toBe(96044);
    expect(byteDelta).toBe(12022);
  });

  test("headers are byte-identical to the retired copies", () => {
    const input = [ramp(64)];
    // Only the 44-byte header, which is what "changes emitted bytes" must NOT
    // have meant: the RIFF/fmt/data framing is unchanged, only the samples are.
    expect(encodeWav(input, 48000).subarray(0, 44)).toEqual(
      symmetricEncode(input, 48000).subarray(0, 44),
    );
  });

  test("multi-channel interleaves frame-major", () => {
    const l = new Float32Array([1, 0, -1]);
    const r = new Float32Array([-1, 0, 1]);
    expect(pcm(encodeWav([l, r], 44100))).toEqual([32767, -32768, 0, 0, -32768, 32767]);
  });

  test("declares the channel count and derived rates it was given", () => {
    const b = encodeWav([new Float32Array(8), new Float32Array(8)], 22050);
    expect(b.readUInt16LE(22)).toBe(2); // channels
    expect(b.readUInt32LE(24)).toBe(22050); // sample rate
    expect(b.readUInt32LE(28)).toBe(22050 * 2 * 2); // byte rate
    expect(b.readUInt16LE(32)).toBe(4); // block align
    expect(b.readUInt32LE(40)).toBe(8 * 2 * 2); // data length
  });

  test("clips rather than wrapping on out-of-range input", () => {
    expect(pcm(encodeWav([new Float32Array([2, -2])], 48000))).toEqual([32767, -32768]);
  });

  test("refuses ragged channels and a bad rate instead of writing a wrong header", () => {
    expect(() => encodeWav([new Float32Array(4), new Float32Array(5)], 48000)).toThrow(
      /channel 1 has 5 frames/,
    );
    expect(() => encodeWav([], 48000)).toThrow(/no channels/);
    expect(() => encodeWav([new Float32Array(4)], 0)).toThrow(/bad sample rate/);
  });

  test("round-trips through decodeWav", () => {
    const src = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const w = decodeWav(encodeWav([src], 32000));
    expect(w.rate).toBe(32000);
    expect(w.channels).toBe(1);
    // -1 is exact (-32768/32768); +1 is one LSB short, which is the format's
    // limit and not this writer's.
    expect([...w.samples]).toEqual([0, 16384 / 32768, -16384 / 32768, 32767 / 32768, -1]);
  });

  test("writeWav puts exactly encodeWav's bytes on disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlib-wav-"));
    const file = path.join(dir, "out.wav");
    try {
      const input = [new Float32Array([0.25, -0.25])];
      writeWav(file, input, 48000);
      expect(fs.readFileSync(file)).toEqual(encodeWav(input, 48000));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("decodeWavChannels", () => {
  test("does not downmix, where decodeWav does", async () => {
    const { decodeWavChannels } = await import("../../shared/ts/audio/wav.ts");
    const l = new Float32Array([1, -1]);
    const r = new Float32Array([-1, 1]);
    const bytes = encodeWav([l, r], 48000);

    const ch = decodeWavChannels(bytes);
    expect(ch.channels).toBe(2);
    expect(ch.data).toHaveLength(2);
    expect([...ch.data[0]]).toEqual([32767 / 32768, -1]);
    expect([...ch.data[1]]).toEqual([-1, 32767 / 32768]);

    // The downmix of that is very nearly silence, which is precisely why an
    // editing caller cannot use it.
    const mono = decodeWav(bytes);
    expect(Math.abs(mono.samples[0])).toBeLessThan
      (1 / 32768);
  });
});
