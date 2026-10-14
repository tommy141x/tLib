// What a feedback POST carries, and what it must never carry.
//
// No FiveM globals are touched: `submit` takes its transport as an argument, so
// the whole decision table runs in bun. `buildBody`'s install-id read goes
// through the real resolver, which finds no `GetResourcePath` under bun and
// answers "" — the same answer a host whose data.json cannot be read gives.

import { describe, expect, test } from "bun:test";
import {
  buildBody,
  classify,
  endpointFor,
  type FeedbackResult,
  MESSAGE_MAX,
  submit,
} from "./index";

describe("feedback body", () => {
  test("carries the message, claims source=game, and slugs the context", () => {
    expect(
      buildBody({
        baseUrl: "https://timmygstudios.com",
        message: "  the volume slider does nothing  ",
        resource: "tRadio",
        resourceVersion: "1.14.2",
      })
    ).toEqual({
      message: "the volume slider does nothing",
      source: "game",
      resource: "tradio",
      resourceVersion: "1.14.2",
    });
  });

  test("maps `+` in a version rather than losing the build metadata", () => {
    // `+` is not in the ingest charset, so `1.14.2-rc.3+ab12cd34` is REFUSED
    // outright by tWeb — and the refusal reads like a length problem. The whole
    // string has to survive as something legal.
    expect(
      buildBody({
        baseUrl: "https://x.test",
        message: "hi",
        resource: "tELS",
        resourceVersion: "1.14.2-rc.3+ab12cd34",
      })
    ).toMatchObject({ resourceVersion: "1.14.2-rc.3.ab12cd34" });
  });

  test("omits a context field that slugs to nothing rather than sending it blank", () => {
    const body = buildBody({
      baseUrl: "https://x.test",
      message: "hi",
      resource: "tCAD",
      resourceVersion: "   ",
    });
    expect(body).toEqual({ message: "hi", source: "game", resource: "tcad" });
    expect(body).not.toHaveProperty("resourceVersion");
    // No install id, because this install has none on disk — which is the state
    // of every install that never opted into telemetry.
    expect(body).not.toHaveProperty("installId");
  });

  // MEASURED, and not what it looks like from the field name: `slug` runs
  // `scrubIdentifiers` and REDACTS an identifier shape rather than refusing it,
  // so a forged `resource` arrives as the literal `redacted` — charset-legal,
  // and therefore accepted by tWeb. Nothing leaks, and the attribution is
  // meaningless, which is the right order of priorities.
  //
  // NOT special-cased here. The same input produces the same value on the
  // telemetry path, and a local exception would be the two disagreeing about one
  // field. The real guard is upstream: `server/sv_feedback.lua` only attributes
  // a message to a resource that holds a menu namespace, so a forged name is
  // dropped before it ever reaches this function.
  test("an identifier-shaped resource is redacted, never passed through", () => {
    const body = buildBody({
      baseUrl: "https://x.test",
      message: "hi",
      resource: "steam:110000100000000",
      resourceVersion: "1",
    });
    expect(body?.resource).toBe("redacted");
    expect(body?.resource).not.toContain("110000100000000");
  });

  test("an empty or whitespace message is nothing to send", () => {
    for (const message of ["", "   ", "\n\n", 42, null, undefined]) {
      expect(
        buildBody({ baseUrl: "https://x.test", message, resource: "tCAD", resourceVersion: "1" })
      ).toBeNull();
    }
  });

  test("a long message is capped at tWeb's own maximum rather than 400ing there", () => {
    const body = buildBody({
      baseUrl: "https://x.test",
      message: "x".repeat(MESSAGE_MAX + 500),
      resource: "tCAD",
      resourceVersion: "1",
    });
    expect(body?.message).toHaveLength(MESSAGE_MAX);
  });

  // The whole privacy claim, asserted rather than described.
  test("attaches nothing identifying of its own", () => {
    const body = buildBody({
      baseUrl: "https://timmygstudios.com",
      message: "my licence is license:abc and my ip is 192.168.8.141",
      resource: "tUnit",
      resourceVersion: "2.0.0",
    });
    // Exactly four keys, and `message` is the only free text.
    expect(Object.keys(body ?? {}).sort()).toEqual([
      "message",
      "resource",
      "resourceVersion",
      "source",
    ]);
    // AND THE MESSAGE IS NOT SCRUBBED. A player pastes what they pasted; a
    // client that censored a complaint would quietly destroy the report about
    // the thing being complained of.
    expect(body?.message).toContain("license:abc");
    expect(body?.message).toContain("192.168.8.141");
  });
});

// The id itself is `server/lib/install-id.ts`'s and is tested in
// tests/unit/install-id.test.ts. What belongs HERE is that this path omits the
// field rather than sending a blank one when nothing resolves — under bun there
// is no `GetResourcePath`, which is the same answer a host whose data.json
// cannot be read gives, and tWeb treats absent and "" as one state only because
// this end keeps it that way.
describe("install id", () => {
  test("an unresolvable id is omitted from the body, never sent blank", () => {
    const body = buildBody({
      baseUrl: "https://timmygstudios.com",
      message: "hello",
      resource: "tRadio",
      resourceVersion: "1.0.0",
    });
    expect(body).not.toBeNull();
    expect(body).not.toHaveProperty("installId");
  });
});

describe("endpoint and status", () => {
  test("only an http(s) origin yields an endpoint", () => {
    expect(endpointFor("https://timmygstudios.com")).toBe("https://timmygstudios.com/api/feedback");
    expect(endpointFor("https://timmygstudios.com///")).toBe(
      "https://timmygstudios.com/api/feedback"
    );
    for (const bad of ["", "timmygstudios.com", "javascript:alert(1)", 7, null]) {
      expect(endpointFor(bad)).toBeNull();
    }
  });

  test("429 is its own reason, and a 5xx is not the player's text being wrong", () => {
    expect(classify(201)).toEqual({ ok: true });
    expect(classify(200)).toEqual({ ok: true });
    expect(classify(429)).toEqual({ ok: false, reason: "rate-limited" });
    expect(classify(400)).toEqual({ ok: false, reason: "refused" });
    expect(classify(403)).toEqual({ ok: false, reason: "refused" });
    expect(classify(500)).toEqual({ ok: false, reason: "unreachable" });
    expect(classify(502)).toEqual({ ok: false, reason: "unreachable" });
    // This module's own timeout.
    expect(classify(0)).toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("submit", () => {
  const run = (over: Record<string, unknown>, status = 201) => {
    let sentTo = "";
    let sentBody = "";
    let result!: FeedbackResult;
    submit(
      {
        baseUrl: "https://timmygstudios.com",
        message: "hi",
        resource: "tCAD",
        resourceVersion: "1.0.0",
        ...over,
      },
      (r) => {
        result = r;
      },
      (url, body, done) => {
        sentTo = url;
        sentBody = body;
        done(status);
      }
    );
    return { sentTo, sentBody, result };
  };

  test("posts JSON to /api/feedback and reports the verdict", () => {
    const { sentTo, sentBody, result } = run({});
    expect(sentTo).toBe("https://timmygstudios.com/api/feedback");
    expect(JSON.parse(sentBody)).toMatchObject({ source: "game", message: "hi" });
    expect(result).toEqual({ ok: true });
  });

  test("a 429 answers `rate-limited`, which is what keeps the player's text", () => {
    expect(run({}, 429).result).toEqual({ ok: false, reason: "rate-limited" });
  });

  // `invalid` and not `refused`: nothing left this server, so there is nothing
  // for the player to retry.
  test("nothing is sent when there is no endpoint or no message", () => {
    const noUrl = run({ baseUrl: "ftp://nope" });
    expect(noUrl.sentTo).toBe("");
    expect(noUrl.result).toEqual({ ok: false, reason: "invalid" });
    const noMessage = run({ message: " " });
    expect(noMessage.sentTo).toBe("");
    expect(noMessage.result).toEqual({ ok: false, reason: "invalid" });
  });
});
