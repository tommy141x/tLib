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
 * ── The writer, and the bit that was being lost ──
 *
 * `encodeWav`/`writeWav` below are the writer. There were FOUR copies: tELS's
 * `scripts/audio/wav.ts` and tRadio's `scripts/fix-ambient-assets.ts` took
 * interleaved multi-channel, tRadio's `scripts/audio-render.ts` and
 * `scripts/audio-listen.ts` took mono. That split was not the interesting
 * difference. The two mono copies scaled SYMMETRICALLY — `v * 32767` — and the
 * two multi-channel ones asymmetrically — `v < 0 ? v * 32768 : v * 32767`.
 *
 * The asymmetric one is simply correct and the symmetric one simply loses a
 * bit. int16 runs -32768..32767, so full scale is not the same distance either
 * side of zero: `-1.0 * 32767` is -32767, one LSB short of the floor the format
 * has. A rendered chain that hard-clips — which both mono copies do on purpose,
 * one line above the scale, "exactly as a sound card would" — therefore wrote
 * an asymmetric waveform for a symmetric input. It is small (-90.3 dBFS) and it
 * is a DC-shaped error, not noise: every negative sample is biased up by the
 * same fraction of an LSB, so it survives averaging and lands in exactly the
 * measurements these tools exist to take.
 *
 * Unifying them changes emitted bytes, which is why the earlier reader
 * consolidation deliberately left them alone. They are unified now because
 * "byte-identical" was the wrong test to hold a wrong mapping to: the delta IS
 * the bug. Measured against the retired symmetric body, 48 kHz mono, 48,000
 * frames — the 44-byte header identical in every case, only samples moving:
 *
 *   | input                   | samples differing | file bytes differing |
 *   |-------------------------|-------------------|----------------------|
 *   | full-scale -1..+1 ramp  | 11,978  (24.95%)  | 12,022 / 96,044      |
 *   | 440 Hz full-scale sine  | 15,880  (33.08%)  | 15,880 / 96,044      |
 *   | 440 Hz sine at -20 dB   |     880   (1.83%) |    880 / 96,044      |
 *
 * In all three: max delta exactly 1 LSB, zero non-negative samples affected,
 * and the old body always the less-negative of the two. Peak round-trip error
 * 3.052e-5, i.e. -90.3 dBFS. tests/unit/wav-encode.test.ts pins the ramp row
 * and runs the retired body as its negative control.
 *
 * Mono callers pass `[samples]`. There is no mono overload: an overload that
 * accepts both a `Float32Array` and a `Float32Array[]` is one typo away from
 * silently writing a one-sample file, and the brackets at four call sites are
 * cheaper than that.
 */
export interface Wav {
  /** Mono downmix, -1..1. */
  samples: Float32Array;
  /** Sample rate from the `fmt ` chunk; 48000 if the file declared none. */
  rate: number;
  /** Channel count the file declared, before the downmix. */
  channels: number;
}

/** De-interleaved decode: one Float32Array per channel, no downmix. */
export interface WavChannels {
  /** One array per channel, -1..1, all the same length. */
  data: Float32Array[];
  rate: number;
  channels: number;
}

/**
 * Decode a 16-bit PCM WAV to SEPARATE channels.
 *
 * `decodeWav` downmixes, which is what every analysis caller wants and is
 * destructive for an editing one: tRadio's `fix-ambient-assets.ts` repairs a
 * loop seam per channel and writes the file back, so a downmix would turn a
 * stereo asset mono. That was a real requirement and is why it had its own
 * fifth copy of the chunk walk; it is a parameter now rather than a copy.
 */
export function decodeWavChannels(bytes: Buffer, label = "<buffer>"): WavChannels {
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
  const data = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      data[c][f] = bytes.readInt16LE(dataStart + (f * channels + c) * 2) / 32768;
    }
  }
  return { data, rate, channels };
}

/** Decode a mono or multi-channel 16-bit PCM WAV, downmixing to mono. */
export function decodeWav(bytes: Buffer, label = "<buffer>"): Wav {
  const { data, rate, channels } = decodeWavChannels(bytes, label);
  if (channels === 1) return { samples: data[0], rate, channels };
  const frames = data[0].length;
  const samples = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += data[c][f];
    samples[f] = acc / channels;
  }
  return { samples, rate, channels };
}

/** Read and decode a 16-bit PCM WAV from disk. Errors name the file. */
export function readWav(file: string): Wav {
  return decodeWav(fs.readFileSync(file), file);
}

/** Read and decode a 16-bit PCM WAV from disk without downmixing. */
export function readWavChannels(file: string): WavChannels {
  return decodeWavChannels(fs.readFileSync(file), file);
}

/**
 * Encode interleaved 16-bit PCM. Mono is `[samples]`.
 *
 * Samples are hard-clipped to -1..1 before scaling, exactly as a sound card
 * would, so an overdriven chain produces an audibly clipped file rather than a
 * quietly rescaled one — tRadio's renderers relied on that and it is kept.
 */
export function encodeWav(channelData: Float32Array[], rate: number): Buffer {
  if (channelData.length < 1) throw new Error("encodeWav: no channels");
  const channels = channelData.length;
  const frames = channelData[0].length;
  for (let c = 1; c < channels; c++) {
    if (channelData[c].length !== frames) {
      throw new Error(
        `encodeWav: channel ${c} has ${channelData[c].length} frames, channel 0 has ${frames}`,
      );
    }
  }
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`encodeWav: bad sample rate ${rate}`);

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
      const s = Math.max(-1, Math.min(1, channelData[c][f]));
      // ⚠️ ASYMMETRIC, and the whole point of this being one function. int16 is
      // -32768..32767: -1.0 maps to -32768 and +1.0 to 32767. Scaling both by
      // 32767 loses one LSB on every negative sample; scaling both by 32768
      // wraps +1.0 to -32768. See the header.
      b.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), o);
      o += 2;
    }
  }
  return b;
}

/** Write interleaved channels as a 16-bit PCM WAV. Mono is `[samples]`. */
export function writeWav(file: string, channelData: Float32Array[], rate: number): void {
  fs.writeFileSync(file, encodeWav(channelData, rate));
}
