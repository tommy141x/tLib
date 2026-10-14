/**
 * A field of world-positioned emitters, heard from one listener.
 *
 * ## What this is for
 *
 * A dash-mounted device — a radar head, a detector, a radio — makes noise that
 * the cabin and the pavement outside should both hear, from the direction of the
 * car it is bolted to. Doing that means a Web Audio graph with a `PannerNode`
 * per emitter and a listener fed from the game camera, plus a transport that
 * decides who is close enough to be told about an emitter at all.
 *
 * tRadio built one of these. tRadar and tDetector each needed one. This is the
 * one copy: it is deliberately written in the vocabulary of EMITTERS and SOUNDS,
 * not of radios, so tRadio can be moved onto it later without the API having to
 * change. Nothing in `tLib/shared/ts/audio3d` imports from any resource.
 *
 * ## The three things a caller has to get right
 *
 * 1. **The emitter is the vehicle, not the person.** These devices are bolted to
 *    a dashboard. tRadio emitted its in-cabin case from the ped and it sounded
 *    like the officer was the radio. This module cannot enforce that — it is
 *    handed positions — but `markLocal` below is shaped around it.
 *
 * 2. **Nobody may hear their own device twice.** The operator's own unit is
 *    already playing dry, un-panned, in their own UI. If the transport also
 *    delivers that emitter to them they get two copies a few milliseconds apart,
 *    which comb-filters — tRadio's voice path shipped exactly that bug. Call
 *    `markLocal(id)` with the emitter the local UI is already sounding and this
 *    field will refuse every sound routed to it, at the door, for as long as the
 *    mark stands. It is not a filter the caller can forget to apply per sound.
 *
 * 3. **Nothing here starts a timer.** `tick()` is called by the host. A NUI that
 *    survives a resource restart must be stoppable from outside, and a module
 *    that owns its own `setInterval` cannot be.
 */

import { falloffGainAt, type SpatialFalloff, spatialFalloff } from "./falloff";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Where the ears are, in world space. `forward`/`up` come from the game camera. */
export interface ListenerPose {
  position: Vec3;
  forward: Vec3;
  up?: Vec3;
}

/** A repeating sound the listener re-derives locally. See `setCadence`. */
export interface Cadence {
  /** Resolved URL of the sample to repeat. */
  url: string;
  /** Milliseconds between repeats. Floored at `MIN_CADENCE_MS`. */
  intervalMs: number;
  /** 0..1, before distance and master volume. */
  volume?: number;
}

/** A continuous synthesised tone. The doppler return is one of these. */
export interface Tone {
  hz: number;
  /** 0..1, before distance and master volume. */
  volume?: number;
  type?: OscillatorType;
}

export interface FieldOptions {
  /**
   * How far this kind of device carries, in metres. MUST come from the
   * consumer's config rather than be defaulted here, and MUST exceed whatever
   * range that resource uses for reading its screen — a device you can read but
   * not hear is backwards.
   */
  range: number;
  /** Near-field radius: inside it an emitter plays at full gain. */
  refDistance?: number;
  /** Master level for everything this field plays, 0..1. */
  volume?: number;
  /** Injected in tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injected in tests. Returning `null` makes the whole field a no-op. */
  createContext?: () => AudioContext | null;
  /** Injected in tests. Fetches and decodes a sample. */
  loadSample?: (ctx: AudioContext, url: string) => Promise<AudioBuffer>;
}

/**
 * An emitter with no position update for this long is abandoned and torn down.
 *
 * The backstop for a lost stop-event. The transport refreshes a live emitter's
 * position many times a second, so this can only fire for one whose vehicle has
 * despawned or whose owner disconnected mid-sound — and for those, a source that
 * loops forever is the failure mode, so the backstop has to exist on this side
 * and not only on the transport's.
 */
export const MAX_EMITTER_AGE_MS = 5000;

/** The tightest repeat a cadence may ask for. Below this it is a buzz, not blips. */
export const MIN_CADENCE_MS = 40;

/** The same sample from the same emitter cannot retrigger faster than this. */
export const MIN_SAMPLE_INTERVAL_MS = 50;

/**
 * Ceiling on simultaneously-decoding-and-playing buffer sources across the field.
 *
 * A per-emitter rate limit bounds one emitter; this bounds the sum of them. Web
 * Audio will happily allocate until the tab dies, and the transport's own caps
 * are on a different machine.
 */
export const MAX_CONCURRENT_SAMPLES = 24;

interface Emitter {
  position: Vec3;
  /** Host clock of the last position update. Drives `MAX_EMITTER_AGE_MS`. */
  lastSeen: number;
  panner: PannerNode | null;
  gain: GainNode | null;
  cadence: Cadence | null;
  /** Host clock at which the cadence next fires. */
  cadenceNextAt: number;
  tone: { osc: OscillatorNode; gain: GainNode; volume: number } | null;
  /** url -> host clock of last play, for the per-emitter retrigger limit. */
  lastSample: Map<string, number>;
}

/** Apply a pose to a context's listener, on both the modern and the legacy API. */
function applyListener(ctx: AudioContext, pose: ListenerPose): void {
  const l = ctx.listener;
  const up = pose.up ?? { x: 0, y: 0, z: 1 };
  const t = ctx.currentTime;
  // positionX et al are the spec'd AudioParams and are present in CEF 103. The
  // deprecated setPosition/setOrientation are kept as the fallback because a
  // context that has neither should be silent rather than throw on every frame.
  if (l.positionX) {
    l.positionX.setValueAtTime(pose.position.x, t);
    l.positionY.setValueAtTime(pose.position.y, t);
    l.positionZ.setValueAtTime(pose.position.z, t);
    l.forwardX.setValueAtTime(pose.forward.x, t);
    l.forwardY.setValueAtTime(pose.forward.y, t);
    l.forwardZ.setValueAtTime(pose.forward.z, t);
    l.upX.setValueAtTime(up.x, t);
    l.upY.setValueAtTime(up.y, t);
    l.upZ.setValueAtTime(up.z, t);
    return;
  }
  const legacy = l as unknown as {
    setPosition?: (x: number, y: number, z: number) => void;
    setOrientation?: (
      fx: number,
      fy: number,
      fz: number,
      ux: number,
      uy: number,
      uz: number
    ) => void;
  };
  legacy.setPosition?.(pose.position.x, pose.position.y, pose.position.z);
  legacy.setOrientation?.(pose.forward.x, pose.forward.y, pose.forward.z, up.x, up.y, up.z);
}

/** Apply a position to a panner, on both the modern and the legacy API. */
function applyPanner(ctx: AudioContext, panner: PannerNode, p: Vec3): void {
  if (panner.positionX) {
    const t = ctx.currentTime;
    panner.positionX.setValueAtTime(p.x, t);
    panner.positionY.setValueAtTime(p.y, t);
    panner.positionZ.setValueAtTime(p.z, t);
    return;
  }
  (panner as unknown as { setPosition?: (x: number, y: number, z: number) => void }).setPosition?.(
    p.x,
    p.y,
    p.z
  );
}

function finite(n: unknown, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function vec3(v: unknown): Vec3 | null {
  if (v === null || typeof v !== "object") return null;
  const c = v as Partial<Vec3>;
  if (!Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.z)) return null;
  return { x: c.x as number, y: c.y as number, z: c.z as number };
}

export class PositionalAudioField {
  private ctx: AudioContext | null = null;
  private contextFailed = false;
  private emitters = new Map<string, Emitter>();
  private buffers = new Map<string, AudioBuffer>();
  private failedUrls = new Set<string>();
  private playing = 0;
  private localId: string | null = null;
  private listener: ListenerPose | null = null;
  private falloff: SpatialFalloff;
  private range: number;
  private refDistance: number;
  private volume: number;
  private readonly now: () => number;
  private readonly makeContext: () => AudioContext | null;
  private readonly load: (ctx: AudioContext, url: string) => Promise<AudioBuffer>;

  constructor(options: FieldOptions) {
    this.range = finite(options.range, 0);
    this.refDistance = finite(options.refDistance, 1.5);
    this.volume = Math.min(1, Math.max(0, finite(options.volume, 1)));
    this.now = options.now ?? (() => Date.now());
    this.makeContext =
      options.createContext ??
      (() => {
        try {
          return new AudioContext();
        } catch {
          return null;
        }
      });
    this.load = options.loadSample ?? defaultLoadSample;
    this.falloff = spatialFalloff(this.range, this.refDistance);
  }

  /** The solved curve currently in force. Diagnostics and tests. */
  getFalloff(): SpatialFalloff {
    return this.falloff;
  }

  /** The gain distance alone applies at `d`. The reporting oracle. */
  gainAt(d: number): number {
    return falloffGainAt(this.falloff, d);
  }

  /** Live emitter ids. Diagnostics and tests. */
  activeEmitters(): string[] {
    return [...this.emitters.keys()];
  }

  /**
   * Re-aim the curve at a new range, e.g. because config was reloaded.
   *
   * Applied to every live panner rather than only to new ones: an owner who
   * widens the range and hears the change on the next car but not on the one
   * beside them would reasonably call that a bug.
   */
  setRange(range: number, refDistance?: number): void {
    this.range = finite(range, this.range);
    if (refDistance !== undefined) this.refDistance = finite(refDistance, this.refDistance);
    this.falloff = spatialFalloff(this.range, this.refDistance);
    for (const e of this.emitters.values()) {
      if (e.panner) this.shapePanner(e.panner);
    }
  }

  /** Master level, 0..1. Takes effect on the next sound and on live tones now. */
  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.volume = Math.min(1, Math.max(0, volume));
    const ctx = this.ctx;
    if (ctx === null) return;
    for (const e of this.emitters.values()) {
      if (e.tone)
        e.tone.gain.gain.setTargetAtTime(e.tone.volume * this.volume, ctx.currentTime, 0.05);
    }
  }

  /**
   * Name the emitter this client's own UI is already sounding dry.
   *
   * THE dedup. Every entry point below returns early for this id, and marking an
   * id also tears down anything already running under it — a player who climbs
   * from the back seat into the driver's seat was hearing the panned copy a
   * moment ago and must not keep hearing it underneath their own.
   *
   * `null` clears the mark, which is what leaving the vehicle does.
   */
  markLocal(id: string | null): void {
    const next = typeof id === "string" && id.length > 0 ? id : null;
    if (next === this.localId) return;
    this.localId = next;
    if (next !== null) this.drop(next);
  }

  /** The currently-marked local emitter, if any. Diagnostics and tests. */
  getLocal(): string | null {
    return this.localId;
  }

  /** True when `id` is this client's own device and must not be spatialised. */
  isLocal(id: string): boolean {
    return this.localId !== null && this.localId === id;
  }

  /** Move the ears. Cheap enough to call every frame; does nothing before a context exists. */
  setListener(pose: ListenerPose): void {
    const position = vec3(pose?.position);
    const forward = vec3(pose?.forward);
    if (position === null || forward === null) return;
    this.listener = { position, forward, up: vec3(pose.up ?? null) ?? { x: 0, y: 0, z: 1 } };
    const ctx = this.ctx;
    if (ctx !== null) applyListener(ctx, this.listener);
  }

  /**
   * Create or move an emitter.
   *
   * This is also the heartbeat: `MAX_EMITTER_AGE_MS` is measured from the last
   * call for that id, so a transport that stops talking about an emitter reaps it
   * without having to send a stop.
   */
  setEmitter(id: string, position: Vec3): void {
    if (typeof id !== "string" || id.length === 0 || this.isLocal(id)) return;
    const p = vec3(position);
    if (p === null) return;
    const e = this.emitter(id);
    if (e === null) return;
    e.position = p;
    e.lastSeen = this.now();
    const ctx = this.ctx;
    if (ctx !== null && e.panner !== null) applyPanner(ctx, e.panner, p);
  }

  /**
   * Play one sample from an emitter, once.
   *
   * Silently dropped when: the emitter is this client's own, the emitter has no
   * position yet (a sound from nowhere would play at the origin, which is
   * somewhere), the listener is out of range, the same url retriggered inside
   * `MIN_SAMPLE_INTERVAL_MS`, or the field is already at `MAX_CONCURRENT_SAMPLES`.
   */
  playSample(id: string, url: string, volume = 1): void {
    if (typeof url !== "string" || url.length === 0) return;
    if (this.isLocal(id) || this.failedUrls.has(url)) return;
    const e = this.emitters.get(id);
    if (e === undefined) return;
    if (this.outOfRange(e)) return;
    const now = this.now();
    const last = e.lastSample.get(url);
    if (last !== undefined && now - last < MIN_SAMPLE_INTERVAL_MS) return;
    e.lastSample.set(url, now);
    void this.startSample(e, url, volume);
  }

  /**
   * Set (or clear, with `null`) a repeating sound the LISTENER derives locally.
   *
   * This is the packet-rate decision made concrete. A device that blips four
   * times a second would, streamed beep by beep, cost four events per emitter
   * per second per receiver; tDetector's own `client/cl_cabin.lua` already
   * refused that shape for its in-cabin relay. A cadence is one descriptor that
   * stands until it changes, and the repeats are generated here.
   *
   * The consequence is honest and worth stating: repeats are phase-independent
   * between listeners. Two bystanders hear the same rate, not the same instants.
   * For a geiger-counter cadence that is inaudible; for a lock tone it would not
   * be, which is why one-shots go through `playSample` instead.
   */
  setCadence(id: string, cadence: Cadence | null): void {
    if (this.isLocal(id)) return;
    const e = this.emitters.get(id);
    if (e === undefined) return;
    if (cadence === null || typeof cadence.url !== "string" || cadence.url.length === 0) {
      e.cadence = null;
      return;
    }
    const intervalMs = Math.max(MIN_CADENCE_MS, finite(cadence.intervalMs, MIN_CADENCE_MS));
    const changed =
      e.cadence === null || e.cadence.url !== cadence.url || e.cadence.intervalMs !== intervalMs;
    e.cadence = { url: cadence.url, intervalMs, volume: finite(cadence.volume, 1) };
    // Fire the first blip immediately on a change rather than after one whole
    // interval: a detector that has just alarmed should be heard now, and at one
    // blip per second "now" and "in a second" are different events.
    if (changed) e.cadenceNextAt = 0;
  }

  /**
   * Set (or clear, with `null`) a continuous synthesised tone on an emitter.
   *
   * Retuned rather than restarted, because a doppler return slides: stopping and
   * starting an oscillator per pitch change clicks audibly.
   */
  setTone(id: string, tone: Tone | null): void {
    if (this.isLocal(id)) return;
    const e = this.emitters.get(id);
    if (e === undefined) return;
    const ctx = this.ctx;
    if (tone === null || !Number.isFinite(tone.hz) || tone.hz <= 0) {
      if (e.tone !== null && ctx !== null) {
        // Fade rather than stop: killing a running oscillator pops.
        e.tone.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      }
      return;
    }
    if (this.outOfRange(e)) {
      if (e.tone !== null && ctx !== null)
        e.tone.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      return;
    }
    const live = this.ensureContext();
    if (live === null || e.panner === null) return;
    const volume = Math.min(1, Math.max(0, finite(tone.volume, 1)));
    const t = live.currentTime;
    if (e.tone === null) {
      const osc = live.createOscillator();
      const gain = live.createGain();
      osc.type = tone.type ?? "sawtooth";
      osc.frequency.setValueAtTime(tone.hz, t);
      gain.gain.setValueAtTime(0, t);
      osc.connect(gain).connect(e.panner);
      osc.start();
      e.tone = { osc, gain, volume };
    }
    e.tone.volume = volume;
    e.tone.osc.frequency.setTargetAtTime(tone.hz, t, 0.12);
    e.tone.gain.gain.setTargetAtTime(volume * this.volume, t, 0.12);
  }

  /** Tear one emitter down: tone stopped, cadence cleared, nodes disconnected. */
  drop(id: string): void {
    const e = this.emitters.get(id);
    if (e === undefined) return;
    this.emitters.delete(id);
    this.teardown(e);
  }

  /**
   * Stop everything, immediately.
   *
   * The resource-restart escape hatch. A NUI frame can outlive the Lua that was
   * driving it, and the new script instance starts with an empty emitter table
   * and so will never send a stop for anything the old one started — a looping
   * cadence would then run for the rest of the session. The Lua side calls this
   * from `onResourceStop` before it goes away.
   */
  stopAll(): void {
    for (const e of this.emitters.values()) this.teardown(e);
    this.emitters.clear();
    this.playing = 0;
  }

  /**
   * One step of the field: fire due cadence repeats, reap abandoned emitters.
   *
   * Called by the host at whatever rate it is already running at. Doing nothing
   * when there are no emitters is the common case and costs one `.size` read.
   */
  tick(): void {
    if (this.emitters.size === 0) return;
    const now = this.now();
    for (const [id, e] of this.emitters) {
      if (now - e.lastSeen > MAX_EMITTER_AGE_MS) {
        this.emitters.delete(id);
        this.teardown(e);
        continue;
      }
      const far = this.outOfRange(e);
      if (far) {
        // The client-side distance cull. The panner would already have this
        // emitter below EDGE_GAIN, so this is not about loudness — it is about
        // not decoding and scheduling buffers for something nobody can hear.
        if (e.tone !== null && this.ctx !== null) {
          e.tone.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
        }
        continue;
      }
      if (e.tone !== null && this.ctx !== null) {
        e.tone.gain.gain.setTargetAtTime(e.tone.volume * this.volume, this.ctx.currentTime, 0.05);
      }
      const c = e.cadence;
      if (c === null) continue;
      if (now < e.cadenceNextAt) continue;
      e.cadenceNextAt = now + c.intervalMs;
      if (this.failedUrls.has(c.url)) continue;
      void this.startSample(e, c.url, c.volume ?? 1);
    }
  }

  /** Release the audio context. The field is unusable afterwards. */
  dispose(): void {
    this.stopAll();
    const ctx = this.ctx;
    this.ctx = null;
    this.buffers.clear();
    void ctx?.close().catch(() => {});
  }

  // internals

  /**
   * The context, created on first real need.
   *
   * Lazily, because a page that constructs an AudioContext before any user
   * gesture gets a suspended one — and in NUI there is no gesture to wait for.
   * A failure is latched: a runtime that cannot give us a context will not start
   * being able to, and retrying per frame would throw thousands of times a minute.
   */
  private ensureContext(): AudioContext | null {
    if (this.ctx !== null) return this.ctx;
    if (this.contextFailed) return null;
    const ctx = this.makeContext();
    if (ctx === null) {
      this.contextFailed = true;
      return null;
    }
    this.ctx = ctx;
    if (this.listener !== null) applyListener(ctx, this.listener);
    return ctx;
  }

  private shapePanner(panner: PannerNode): void {
    panner.distanceModel = this.falloff.distanceModel;
    panner.refDistance = this.falloff.refDistance;
    panner.maxDistance = this.falloff.maxDistance;
    panner.rolloffFactor = this.falloff.rolloff;
  }

  private emitter(id: string): Emitter | null {
    const existing = this.emitters.get(id);
    if (existing !== undefined) return existing;
    const e: Emitter = {
      position: { x: 0, y: 0, z: 0 },
      lastSeen: this.now(),
      panner: null,
      gain: null,
      cadence: null,
      cadenceNextAt: 0,
      tone: null,
      lastSample: new Map(),
    };
    const ctx = this.ensureContext();
    if (ctx !== null) {
      const panner = ctx.createPanner();
      // HRTF is the default and is present in CEF 103. It is assigned through a
      // read-back check rather than blindly, because a context where the
      // assignment silently does not take would otherwise leave every emitter
      // unpannable and say nothing about it; equalpower still carries direction.
      try {
        panner.panningModel = "HRTF";
        if (panner.panningModel !== "HRTF") panner.panningModel = "equalpower";
      } catch {
        panner.panningModel = "equalpower";
      }
      this.shapePanner(panner);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(1, ctx.currentTime);
      panner.connect(gain).connect(ctx.destination);
      e.panner = panner;
      e.gain = gain;
    }
    this.emitters.set(id, e);
    return e;
  }

  /** True when the listener is beyond this field's range of `e`, or unknown. */
  private outOfRange(e: Emitter): boolean {
    const l = this.listener;
    if (l === null) return false;
    const dx = l.position.x - e.position.x;
    const dy = l.position.y - e.position.y;
    const dz = l.position.z - e.position.z;
    return dx * dx + dy * dy + dz * dz > this.range * this.range;
  }

  private async startSample(e: Emitter, url: string, volume: number): Promise<void> {
    if (this.playing >= MAX_CONCURRENT_SAMPLES) return;
    const ctx = this.ensureContext();
    if (ctx === null || e.panner === null) return;
    let buffer = this.buffers.get(url);
    if (buffer === undefined) {
      this.playing += 1;
      try {
        buffer = await this.load(ctx, url);
        this.buffers.set(url, buffer);
      } catch {
        // Latched: a missing or undecodable file will not start existing, and a
        // cadence pointed at one would otherwise refetch it several times a
        // second for as long as the emitter lives.
        this.failedUrls.add(url);
        return;
      } finally {
        this.playing -= 1;
      }
    }
    // The emitter may have been dropped while the sample was decoding.
    if (e.panner === null || this.ctx === null) return;
    this.playing += 1;
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = buffer;
    gain.gain.setValueAtTime(Math.min(1, Math.max(0, volume)) * this.volume, ctx.currentTime);
    src.connect(gain).connect(e.panner);
    src.onended = () => {
      this.playing -= 1;
      try {
        src.disconnect();
        gain.disconnect();
      } catch {
        /* already torn down */
      }
    };
    src.start();
  }

  private teardown(e: Emitter): void {
    if (e.tone !== null) {
      try {
        e.tone.osc.stop();
      } catch {
        /* already stopped */
      }
      try {
        e.tone.osc.disconnect();
        e.tone.gain.disconnect();
      } catch {
        /* already torn down */
      }
      e.tone = null;
    }
    e.cadence = null;
    try {
      e.panner?.disconnect();
      e.gain?.disconnect();
    } catch {
      /* already torn down */
    }
    e.panner = null;
    e.gain = null;
  }
}

/** fetch + decode. Split out so tests can supply buffers without a network. */
async function defaultLoadSample(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sample ${url}: HTTP ${res.status}`);
  return await ctx.decodeAudioData(await res.arrayBuffer());
}
