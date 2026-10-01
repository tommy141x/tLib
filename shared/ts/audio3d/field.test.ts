import { beforeEach, describe, expect, test } from "bun:test";
import { MAX_EMITTER_AGE_MS, MIN_SAMPLE_INTERVAL_MS, PositionalAudioField } from "./field";

/**
 * The field's behaviour, against a stub Web Audio graph.
 *
 * There is no AudioContext under bun, and there would be nothing to assert
 * against if there were — a panner cannot be read back and a speaker cannot be
 * measured from a test. So the graph is stubbed and what is asserted is what the
 * field DID to it: which nodes it built, which it started, which it refused to.
 */

interface StubParam {
  value: number;
  setValueAtTime(v: number): StubParam;
  setTargetAtTime(v: number): StubParam;
}

function param(initial = 0): StubParam {
  const p: StubParam = {
    value: initial,
    setValueAtTime(v) {
      p.value = v;
      return p;
    },
    setTargetAtTime(v) {
      p.value = v;
      return p;
    },
  };
  return p;
}

interface StubPanner {
  distanceModel: string;
  refDistance: number;
  maxDistance: number;
  rolloffFactor: number;
}

interface Stub {
  ctx: unknown;
  panners: number;
  built: StubPanner[];
  oscillators: { started: number; stopped: number; hz: number[] };
  sources: { started: number };
  listener: { x: number; y: number; z: number };
}

function stubContext(): Stub {
  const stub: Stub = {
    ctx: null,
    panners: 0,
    built: [],
    oscillators: { started: 0, stopped: 0, hz: [] },
    sources: { started: 0 },
    listener: { x: 0, y: 0, z: 0 },
  };
  const node = () => ({
    connect(next: unknown) {
      return next;
    },
    disconnect() {},
  });
  stub.ctx = {
    currentTime: 0,
    destination: node(),
    listener: {
      positionX: {
        setValueAtTime(v: number) {
          stub.listener.x = v;
        },
      },
      positionY: {
        setValueAtTime(v: number) {
          stub.listener.y = v;
        },
      },
      positionZ: {
        setValueAtTime(v: number) {
          stub.listener.z = v;
        },
      },
      forwardX: { setValueAtTime() {} },
      forwardY: { setValueAtTime() {} },
      forwardZ: { setValueAtTime() {} },
      upX: { setValueAtTime() {} },
      upY: { setValueAtTime() {} },
      upZ: { setValueAtTime() {} },
    },
    createPanner() {
      stub.panners += 1;
      const p = {
        ...node(),
        panningModel: "HRTF",
        distanceModel: "linear",
        refDistance: 1,
        maxDistance: 10000,
        rolloffFactor: 1,
        positionX: param(),
        positionY: param(),
        positionZ: param(),
      };
      stub.built.push(p);
      return p;
    },
    createGain() {
      return { ...node(), gain: param(1) };
    },
    createOscillator() {
      const osc = {
        ...node(),
        type: "sine",
        frequency: param(),
        start() {
          stub.oscillators.started += 1;
        },
        stop() {
          stub.oscillators.stopped += 1;
        },
      };
      const setTarget = osc.frequency.setTargetAtTime;
      osc.frequency.setTargetAtTime = (v: number) => {
        stub.oscillators.hz.push(v);
        return setTarget(v);
      };
      return osc;
    },
    createBufferSource() {
      return {
        ...node(),
        buffer: null,
        onended: null,
        start() {
          stub.sources.started += 1;
        },
      };
    },
    close: async () => {},
  };
  return stub;
}

let clock = 0;
let stub: Stub;

function makeField(range = 30): PositionalAudioField {
  stub = stubContext();
  return new PositionalAudioField({
    range,
    refDistance: 1.5,
    now: () => clock,
    createContext: () => stub.ctx as AudioContext,
    // Resolves synchronously enough that one microtask drain is sufficient.
    loadSample: async () => ({}) as AudioBuffer,
  });
}

/** Let the awaited sample loader settle. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  clock = 1000;
});

describe("the dedup — nobody hears their own device twice", () => {
  test("a marked emitter accepts no position, no sample, no cadence and no tone", async () => {
    const f = makeField();
    f.markLocal("veh:7");
    f.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 } });

    f.setEmitter("veh:7", { x: 1, y: 0, z: 0 });
    expect(f.activeEmitters()).toEqual([]);

    f.playSample("veh:7", "lock.wav");
    f.setCadence("veh:7", { url: "blip.wav", intervalMs: 100 });
    f.setTone("veh:7", { hz: 400 });
    await settle();

    expect(stub.sources.started).toBe(0);
    expect(stub.oscillators.started).toBe(0);
  });

  test("marking an id that is ALREADY sounding tears it down", async () => {
    const f = makeField();
    f.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 } });
    f.setEmitter("veh:7", { x: 2, y: 0, z: 0 });
    f.setTone("veh:7", { hz: 400 });
    expect(stub.oscillators.started).toBe(1);

    // The player just moved from the back seat into the driver's seat: their own
    // UI starts sounding this unit dry, so the panned copy must stop.
    f.markLocal("veh:7");
    expect(stub.oscillators.stopped).toBe(1);
    expect(f.activeEmitters()).toEqual([]);

    f.setCadence("veh:7", { url: "blip.wav", intervalMs: 50 });
    clock += 500;
    f.tick();
    await settle();
    expect(stub.sources.started).toBe(0);
  });

  test("clearing the mark lets the emitter be heard again", async () => {
    const f = makeField();
    f.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 } });
    f.markLocal("veh:7");
    f.setEmitter("veh:7", { x: 2, y: 0, z: 0 });
    expect(f.activeEmitters()).toEqual([]);

    f.markLocal(null);
    expect(f.getLocal()).toBeNull();
    f.setEmitter("veh:7", { x: 2, y: 0, z: 0 });
    f.playSample("veh:7", "lock.wav");
    await settle();
    expect(f.activeEmitters()).toEqual(["veh:7"]);
    expect(stub.sources.started).toBe(1);
  });

  test("an empty-string mark is not a mark", () => {
    const f = makeField();
    f.markLocal("");
    expect(f.getLocal()).toBeNull();
    expect(f.isLocal("")).toBe(false);
  });

  test("other emitters are untouched by the mark", async () => {
    const f = makeField();
    f.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 } });
    f.markLocal("veh:7");
    f.setEmitter("veh:9", { x: 3, y: 0, z: 0 });
    f.playSample("veh:9", "lock.wav");
    await settle();
    expect(f.activeEmitters()).toEqual(["veh:9"]);
    expect(stub.sources.started).toBe(1);
  });
});

describe("the safety rails", () => {
  test("a sample beyond the field's range is not played at all", async () => {
    const f = makeField(30);
    f.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 } });
    f.setEmitter("veh:1", { x: 100, y: 0, z: 0 });
    f.playSample("veh:1", "lock.wav");
    await settle();
    expect(stub.sources.started).toBe(0);

    f.setEmitter("veh:1", { x: 10, y: 0, z: 0 });
    f.playSample("veh:1", "lock.wav");
    await settle();
    expect(stub.sources.started).toBe(1);
  });

  test("a cadence beyond range schedules nothing, and resumes when the listener closes", async () => {
    const f = makeField(30);
    f.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 } });
    f.setEmitter("veh:1", { x: 200, y: 0, z: 0 });
    f.setCadence("veh:1", { url: "blip.wav", intervalMs: 100 });
    for (let i = 0; i < 5; i++) {
      clock += 100;
      f.setEmitter("veh:1", { x: 200, y: 0, z: 0 });
      f.tick();
    }
    await settle();
    expect(stub.sources.started).toBe(0);

    f.setEmitter("veh:1", { x: 5, y: 0, z: 0 });
    f.tick();
    await settle();
    expect(stub.sources.started).toBe(1);
  });

  test("the same sample cannot retrigger inside the per-emitter floor", async () => {
    const f = makeField();
    f.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 } });
    f.setEmitter("veh:1", { x: 2, y: 0, z: 0 });
    f.playSample("veh:1", "lock.wav");
    clock += MIN_SAMPLE_INTERVAL_MS - 1;
    f.playSample("veh:1", "lock.wav");
    await settle();
    expect(stub.sources.started).toBe(1);

    clock += 2;
    f.playSample("veh:1", "lock.wav");
    await settle();
    expect(stub.sources.started).toBe(2);
  });

  test("an emitter with no position update for MAX_EMITTER_AGE_MS is reaped", () => {
    const f = makeField();
    f.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 } });
    f.setEmitter("veh:1", { x: 2, y: 0, z: 0 });
    f.setTone("veh:1", { hz: 300 });

    clock += MAX_EMITTER_AGE_MS - 1;
    f.tick();
    expect(f.activeEmitters()).toEqual(["veh:1"]);

    clock += 2;
    f.tick();
    expect(f.activeEmitters()).toEqual([]);
    expect(stub.oscillators.stopped).toBe(1);
  });

  test("stopAll silences everything and forgets every emitter", () => {
    const f = makeField();
    f.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 } });
    for (const id of ["a", "b", "c"]) {
      f.setEmitter(id, { x: 1, y: 0, z: 0 });
      f.setTone(id, { hz: 200 });
    }
    expect(stub.oscillators.started).toBe(3);
    f.stopAll();
    expect(stub.oscillators.stopped).toBe(3);
    expect(f.activeEmitters()).toEqual([]);
  });

  test("a cadence is floored — it cannot be asked for a buzz", () => {
    const f = makeField();
    f.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 } });
    f.setEmitter("veh:1", { x: 1, y: 0, z: 0 });
    f.setCadence("veh:1", { url: "blip.wav", intervalMs: 0 });
    let fired = 0;
    for (let i = 0; i < 10; i++) {
      clock += 4;
      f.setEmitter("veh:1", { x: 1, y: 0, z: 0 });
      f.tick();
      fired = stub.sources.started;
    }
    // 40 ms of clock at the 40 ms floor: two blips at most, not ten.
    expect(fired).toBeLessThanOrEqual(2);
  });

  test("a sound for an emitter that was never positioned plays nowhere rather than at the origin", async () => {
    const f = makeField();
    f.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 } });
    f.playSample("ghost", "lock.wav");
    f.setCadence("ghost", { url: "blip.wav", intervalMs: 50 });
    f.setTone("ghost", { hz: 400 });
    clock += 500;
    f.tick();
    await settle();
    expect(stub.sources.started).toBe(0);
    expect(stub.oscillators.started).toBe(0);
  });
});

describe("the graph it actually builds", () => {
  test("every emitter gets one panner, shaped by the solved curve", () => {
    const f = makeField(30);
    f.setEmitter("veh:1", { x: 1, y: 2, z: 3 });
    f.setEmitter("veh:1", { x: 4, y: 5, z: 6 });
    f.setEmitter("veh:2", { x: 1, y: 1, z: 1 });
    expect(stub.panners).toBe(2);
    expect(f.getFalloff().maxDistance).toBe(30);
    expect(f.getFalloff().distanceModel).toBe("exponential");
  });

  test("the listener is moved on the context", () => {
    const f = makeField();
    f.setEmitter("veh:1", { x: 0, y: 0, z: 0 });
    f.setListener({ position: { x: 11, y: 22, z: 33 }, forward: { x: 0, y: 1, z: 0 } });
    expect(stub.listener).toEqual({ x: 11, y: 22, z: 33 });
  });

  test("a malformed listener pose is ignored rather than moving the ears to NaN", () => {
    const f = makeField();
    f.setEmitter("veh:1", { x: 0, y: 0, z: 0 });
    f.setListener({ position: { x: 11, y: 22, z: 33 }, forward: { x: 0, y: 1, z: 0 } });
    f.setListener({
      position: { x: Number.NaN, y: 0, z: 0 },
      forward: { x: 0, y: 1, z: 0 },
    });
    expect(stub.listener).toEqual({ x: 11, y: 22, z: 33 });
  });

  test("a tone is retuned, not restarted", () => {
    const f = makeField();
    f.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 } });
    f.setEmitter("veh:1", { x: 1, y: 0, z: 0 });
    f.setTone("veh:1", { hz: 200 });
    f.setTone("veh:1", { hz: 400 });
    f.setTone("veh:1", { hz: 900 });
    expect(stub.oscillators.started).toBe(1);
    expect(stub.oscillators.hz).toEqual([200, 400, 900]);
  });

  test("clearing a tone fades it rather than leaving it running", () => {
    const f = makeField();
    f.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 } });
    f.setEmitter("veh:1", { x: 1, y: 0, z: 0 });
    f.setTone("veh:1", { hz: 200 });
    f.setTone("veh:1", null);
    // Still one oscillator, now at zero gain — a stopped one would pop.
    expect(stub.oscillators.stopped).toBe(0);
    f.drop("veh:1");
    expect(stub.oscillators.stopped).toBe(1);
  });

  test("a context that cannot be created makes the field an inert no-op", async () => {
    const dead = new PositionalAudioField({
      range: 30,
      now: () => clock,
      createContext: () => null,
      loadSample: async () => ({}) as AudioBuffer,
    });
    dead.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 } });
    dead.setEmitter("veh:1", { x: 1, y: 0, z: 0 });
    dead.setTone("veh:1", { hz: 300 });
    dead.playSample("veh:1", "lock.wav");
    dead.tick();
    await settle();
    dead.stopAll();
    expect(dead.activeEmitters()).toEqual([]);
  });

  test("the panner is shaped by the solved curve, not left at Web Audio's defaults", () => {
    const f = makeField(30);
    f.setEmitter("veh:1", { x: 1, y: 0, z: 0 });
    const p = stub.built[0];
    expect(p.distanceModel).toBe("exponential");
    expect(p.refDistance).toBe(1.5);
    expect(p.maxDistance).toBe(30);
    expect(p.rolloffFactor).toBeCloseTo(f.getFalloff().rolloff, 9);
  });

  test("setRange re-shapes emitters that already exist", () => {
    const f = makeField(30);
    f.setEmitter("veh:1", { x: 1, y: 0, z: 0 });
    expect(f.gainAt(30)).toBeCloseTo(0.003, 6);
    f.setRange(80);
    expect(f.getFalloff().maxDistance).toBe(80);
    expect(f.gainAt(80)).toBeCloseTo(0.003, 6);
    expect(f.gainAt(30)).toBeGreaterThan(0.003);
    // The panner that already existed follows, not only new ones. An owner who
    // widens the range and hears it on the next car but not the one beside them
    // would reasonably call that a bug.
    const p = stub.built[0];
    expect(p.maxDistance).toBe(80);
    expect(p.rolloffFactor).toBeCloseTo(f.getFalloff().rolloff, 9);
  });
});
