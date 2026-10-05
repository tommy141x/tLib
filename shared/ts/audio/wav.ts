import fs from "node:fs";

/**
 * 16-bit PCM WAV decoding for the offline audio tools.
 *
 * tELS had this as `loadWav` (`scripts/audio/wav.ts`), tRadio had it twice —
 * `loadWav` in `scripts/audio-analyze.ts` and `loadWavMono` in
 * `scripts/audio-render.ts`. All three walked the chunk list identically. The
 * three differences were not requirements, they were a safety ladder, and this
 * is the top of it:
 *
 *   1. ⚠️ `dataLen` is CLAMPED to the bytes that are actually present. Both
 *      tRadio copies trusted the `data` chunk's declared size, and a file
 *      truncated mid-write — which is exactly what a recording tool hands you
 *      if you look at it while it is running — declares more data than it has.
 *      The sample loop then reads past the end of the buffer and Node throws
 *      `ERR_OUT_OF_RANGE` from `readInt16LE`, which names an offset and not the
 *      file. With the clamp the same file decodes to the audio it does contain.
 *      tELS already had this, with the note that is now the paragraph above.
 *
 *   2. The diagnostics are the specific ones. `audio-render.ts` folded "no data
 *      chunk" and "not 16-bit" into a single `need 16-bit PCM`, which sends you
 *      looking at the bit depth of a file whose real problem is that the
 *      chunk walk never found `data` at all.
 *
 *   3. `channels` is reported. tELS returned it, both tRadio copies dropped it,
 *      and a caller that wants to know whether it just downmixed a stereo file
 *      had no way to ask.
 *
 * ── Deliberately narrow ──
 *
 * 16-bit PCM only, and it throws rather than guessing on anything else: every
 * file these tools read is either a reference recording or one of their own
 * renders. A silently mis-decoded file produces a spectrum that looks plausible
 * and is wrong, which is worse than no answer. No 24-bit, no float, no
 * `WAVE_FORMAT_EXTENSIBLE`, no ADPCM — add one deliberately if a corpus ever
 * needs it, rather than widening this to "probably fine".
 *
 * Writers are NOT here. tELS writes interleaved multi-channel and tRadio writes
 * mono, and they disagree about the negative full-scale mapping; unifying them
 * changes emitted bytes, so it is a decision rather than a consolidation.
 */
export interface Wav {
  /** Mono downmix, -1..1. */
  samples: Float32Array;
  /** Sample rate from the `fmt ` chunk; 48000 if the file declared none. */
  rate: number;
  /** Channel count the file declared, before the downmix. */
  channels: number;
}

/** Decode a mono or multi-channel 16-bit PCM WAV, downmixing to mono. */
export function decodeWav(bytes: Buffer, label = "<buffer>"): Wav {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${label}: not a RIFF/WAVE file`);
  }

  let channels = 1;
  let rate = 48000;
  let bits = 16;
  let dataStart = -1;
  let dataLen = 0;

  // RIFF chunks are word-aligned: an odd-sized chunk carries one pad byte that
  // is not counted in its declared size, hence the `size & 1`.
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString("ascii", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === "fmt ") {
      channels = bytes.readUInt16LE(at + 10);
      rate = bytes.readUInt32LE(at + 12);
      bits = bytes.readUInt16LE(at + 22);
    } else if (id === "data") {
      dataStart = at + 8;
      // ⚠️ The clamp. See point 1 in the header: a file truncated mid-write
      // declares more data than it has, so trust the bytes that are there.
      dataLen = Math.min(size, bytes.length - dataStart);
    }
    at += 8 + size + (size & 1);
  }

  if (dataStart < 0) throw new Error(`${label}: no data chunk`);
  if (bits !== 16) throw new Error(`${label}: only 16-bit PCM supported, got ${bits}`);
  if (channels < 1) throw new Error(`${label}: fmt chunk declares ${channels} channels`);

  const frames = Math.floor(dataLen / 2 / channels);
  const samples = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += bytes.readInt16LE(dataStart + (f * channels + c) * 2);
    samples[f] = acc / channels / 32768;
  }
  return { samples, rate, channels };
}

/** Read and decode a 16-bit PCM WAV from disk. Errors name the file. */
export function readWav(file: string): Wav {
  return decodeWav(fs.readFileSync(file), file);
}
