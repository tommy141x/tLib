import fs from "node:fs";

/**
 * 16-bit PCM WAV decoding and encoding for the offline audio tools.
 *
 * `dataLen` is CLAMPED to the bytes actually present: a file truncated mid-write
 * -- which is what a recording tool hands you if you look at it while it is
 * running -- declares more data than it has, and the sample loop then throws
 * `ERR_OUT_OF_RANGE`, naming an offset and not the file.
 *
 * Deliberately narrow: 16-bit PCM only, throwing rather than guessing. A silently
 * mis-decoded file produces a spectrum that looks plausible and is wrong, which is
 * worse than no answer. Add a format deliberately if a corpus needs it.
 *
 * THE WRITER SCALES ASYMMETRICALLY -- `v < 0 ? v * 32768 : v * 32767` -- and that
 * is correct rather than a quirk. int16 runs -32768..32767, so `-1.0 * 32767` is
 * one LSB short of the floor the format has, and the error is DC-shaped rather
 * than noise: every negative sample biased up by the same fraction of an LSB, so
 * it survives averaging and lands in exactly the measurements these tools exist
 * to take. Peak round-trip error -90.3 dBFS. `tests/unit/wav-encode.test.ts` pins
 * it and runs the retired symmetric body as its negative control.
 *
 * Mono callers pass `[samples]`. There is no mono overload: one that accepted both
 * a `Float32Array` and a `Float32Array[]` is one typo away from silently writing a
 * one-sample file.
 */
export interface Wav {
  samples: Float32Array<ArrayBuffer>;
  /** Sample rate from the `fmt ` chunk; 48000 if the file declared none. */
  rate: number;
  /** Channel count the file declared, before the downmix. */
  channels: number;
}

/** De-interleaved decode: one Float32Array per channel, no downmix. */
export interface WavChannels {
  /** One array per channel, -1..1, all the same length. See `Wav.samples` for why the buffer type is named. */
  data: Float32Array<ArrayBuffer>[];
  rate: number;
  channels: number;
}

/**
 * Decode a 16-bit PCM WAV to SEPARATE channels.
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
      // The clamp. See point 1 in the header: a file truncated mid-write
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
        `encodeWav: channel ${c} has ${channelData[c].length} frames, channel 0 has ${frames}`
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
      // ASYMMETRIC, and the whole point of this being one function. int16 is
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
