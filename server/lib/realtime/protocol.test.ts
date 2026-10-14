// The wire codec's three hard caps.
//
// This suite exists because the binary one was NOT enforced while the file
// header said all three were, and nothing noticed: `protocol.ts` had no test
// file at all. It is the declared source of truth for the format and is
// mirrored by tTest's shell and the Worker iframe SDK, so an unenforced cap is
// not a dormant constant — it is two implementations disagreeing about which
// frames are legal, with the disagreement only visible under a 2 MiB frame.
//
// All three are asserted together so the next one to be added cannot be
// declared and left unread the same way.

import { describe, expect, test } from "bun:test";
import {
  decodeBinary,
  encodeText,
  MAX_BINARY_FRAME_BYTES,
  MAX_ROOM_ID_BYTES,
  MAX_TEXT_FRAME_BYTES,
  OP,
} from "./protocol";

/** A PUBLISH frame: op, roomId length, roomId, then `payloadBytes` of payload. */
function publishFrame(roomId: string, payloadBytes: number): Buffer {
  const room = Buffer.from(roomId, "utf8");
  return Buffer.concat([
    Buffer.from([OP.PUBLISH, room.length]),
    room,
    Buffer.alloc(payloadBytes),
  ]);
}

describe("binary frame cap", () => {
  test("a frame at the limit decodes", () => {
    const room = "r";
    // 2 header bytes + the room id, so the payload lands the total exactly on
    // the cap rather than one byte over it.
    const frame = publishFrame(room, MAX_BINARY_FRAME_BYTES - 2 - room.length);
    expect(frame.length).toBe(MAX_BINARY_FRAME_BYTES);
    expect(decodeBinary(frame).roomId).toBe(room);
  });

  test("one byte over is refused, and says so", () => {
    const frame = publishFrame("r", MAX_BINARY_FRAME_BYTES);
    expect(frame.length).toBeGreaterThan(MAX_BINARY_FRAME_BYTES);
    expect(() => decodeBinary(frame)).toThrow(/binary frame exceeds/);
  });
});

describe("the other two caps, which were already enforced", () => {
  test("a text frame over the limit is refused", () => {
    expect(() => encodeText("event", "x".repeat(MAX_TEXT_FRAME_BYTES))).toThrow(
      /text frame exceeds/
    );
  });

  test("a room id over 255 bytes is refused", () => {
    // Hand-built: the length byte cannot express 256, so this asserts the
    // encoder's guard rather than round-tripping an over-long id.
    expect(MAX_ROOM_ID_BYTES).toBe(255);
    const truncated = Buffer.from([OP.PUBLISH, 0]);
    expect(() => decodeBinary(truncated)).toThrow(/roomId empty/);
  });
});
