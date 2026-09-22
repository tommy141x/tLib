import { describe, expect, test } from "bun:test";
import { Registry } from "./registry";

const text = {
  capability: "text",
  workload: "qwen3-1.7b-q4_k_m",
  url: "http://127.0.0.1:18291/v1/chat/completions",
  model: "local",
};

describe("Registry", () => {
  test("hands back a handle and finds the engine for another resource", () => {
    const registry = new Registry();
    const handle = registry.advertise("tAI", text);
    expect(handle).not.toBe("");

    const found = registry.lookup("tRadio", "text", text.workload);
    expect(found?.resource).toBe("tAI");
    expect(found?.url).toBe("http://127.0.0.1:18291/v1/chat/completions");
  });

  test("never returns a resource its own advertisement", () => {
    const registry = new Registry();
    registry.advertise("tAI", text);
    expect(registry.lookup("tAI", "text", text.workload)).toBeNull();
  });

  test("a different workload is not a match", () => {
    const registry = new Registry();
    registry.advertise("tAI", text);
    expect(registry.lookup("tRadio", "text", "llama-3.2-3b-q4_k_m")).toBeNull();
  });

  test("rejects an endpoint that is not on loopback", () => {
    const registry = new Registry();
    expect(
      registry.advertise("tAI", { ...text, url: "http://10.0.0.5:18291/v1/chat/completions" })
    ).toBe("");
    expect(registry.advertise("tAI", { ...text, url: "https://api.openai.com/v1" })).toBe("");
    expect(registry.lookup("tRadio", "text", text.workload)).toBeNull();
  });

  test("accepts localhost and ::1", () => {
    const registry = new Registry();
    expect(
      registry.advertise("tAI", { ...text, url: "http://localhost:18291/v1/chat/completions" })
    ).not.toBe("");
    expect(
      registry.advertise("tRadio", { ...text, url: "http://[::1]:18291/v1/chat/completions" })
    ).not.toBe("");
  });

  test("rejects an advertisement missing a field", () => {
    const registry = new Registry();
    expect(registry.advertise("tAI", { ...text, workload: "" })).toBe("");
    expect(registry.advertise("", text)).toBe("");
  });

  test("re-advertising the same capability replaces the old entry", () => {
    const registry = new Registry();
    registry.advertise("tAI", text);
    registry.advertise("tAI", { ...text, url: "http://127.0.0.1:18999/v1/chat/completions" });

    expect(registry.list()).toHaveLength(1);
    expect(registry.lookup("tRadio", "text", text.workload)?.url).toBe(
      "http://127.0.0.1:18999/v1/chat/completions"
    );
  });

  test("withdraw only works for the resource that advertised", () => {
    const registry = new Registry();
    const handle = registry.advertise("tAI", text);
    expect(registry.withdraw("tRadio", handle)).toBe(false);
    expect(registry.withdraw("tAI", handle)).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });

  test("a stopping resource takes its engines with it", () => {
    const registry = new Registry();
    registry.advertise("tAI", text);
    registry.advertise("tAI", { ...text, capability: "transcription" });
    registry.advertise("tRadio", { ...text, url: "http://127.0.0.1:18291/v1/chat/completions" });

    expect(registry.withdrawAll("tAI")).toBe(2);
    expect(registry.list().map((entry) => entry.resource)).toEqual(["tRadio"]);
  });

  test("handles are stamped with the boot epoch", () => {
    const registry = new Registry();
    expect(registry.advertise("tAI", text)).toStartWith(`${registry.epoch}:`);
  });
});
