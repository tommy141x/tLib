// Wire protocol v1: one WebSocket per client, mixed text and binary frames.
// This file is the source of truth for the format; the shell SDK in
// tTest/shell.js and the iframe SDK served from the Worker both mirror it.
//
// Text frames are the control plane, JSON envelopes:
//   { "t": "<type>", "d": { ... } }
//
//   type         direction  payload
//   hello        s->c       { v:1, serverId, now }
//   auth         c->s       { token }
//   authed       s->c       { playerId, rooms, sessionId }
//   ping         c<->s      { n }
//   pong         c<->s      { n }
//   event        c<->s      { type, payload }             // typed app event
//   sub          s->c       { add?:string[], remove?:string[] }
//   error        s->c       { code, msg }
//
// BINARY frames carry fan-out data. Layout:
//   byte 0     opcode
//   byte 1     roomIdLen (u8)
//   bytes 2..  roomId (utf-8)
//   ...        opcode-specific remainder
//
//   opcode  direction  remainder
//   0x01    c->s       payload[]                               // PUBLISH
//   0x02    s->c       senderId(u32 LE) + payload[]            // FRAME
//
// Hard caps, enforced by the codec; config may lower them further:
//   roomId       <= 255 bytes
//   text frame   <= 16 KiB
//   binary frame <= 2 MiB (payload policy lives at the caller, default 64 KiB)

export const WIRE_VERSION = 1;

export const OP = {
  PUBLISH: 0x01,
  FRAME: 0x02,
} as const;

export const TEXT_TYPE = {
  HELLO: "hello",
  AUTH: "auth",
  AUTHED: "authed",
  PING: "ping",
  PONG: "pong",
  EVENT: "event",
  SUB: "sub",
  ERROR: "error",
} as const;

export const MAX_ROOM_ID_BYTES = 255;
export const MAX_TEXT_FRAME_BYTES = 16 * 1024;
export const MAX_BINARY_FRAME_BYTES = 2 * 1024 * 1024;

export type TextEnvelope<T = unknown> = { t: string; d: T };

export function encodeText<T>(type: string, data: T): string {
  const s = JSON.stringify({ t: type, d: data });
  if (Buffer.byteLength(s, "utf8") > MAX_TEXT_FRAME_BYTES) {
    throw new ProtocolError("text_too_large", `text frame exceeds ${MAX_TEXT_FRAME_BYTES}B`);
  }
  return s;
}

export function decodeText(raw: string): TextEnvelope {
  if (raw.length === 0 || raw.charCodeAt(0) !== 0x7b /* { */) {
    throw new ProtocolError("bad_text", "text frame is not a JSON object");
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new ProtocolError("bad_text", "text frame is not valid JSON");
  }
  if (!obj || typeof obj !== "object" || typeof (obj as TextEnvelope).t !== "string") {
    throw new ProtocolError("bad_text", "text envelope missing 't'");
  }
  return obj as TextEnvelope;
}

export interface PublishFrame {
  op: typeof OP.PUBLISH;
  roomId: string;
  payload: Buffer;
}

export interface FanoutFrame {
  op: typeof OP.FRAME;
  roomId: string;
  senderId: number;
  payload: Buffer;
}

export type BinaryFrame = PublishFrame | FanoutFrame;

export function encodeFanout(roomId: string, senderId: number, payload: Buffer): Buffer {
  const roomBuf = Buffer.from(roomId, "utf8");
  if (roomBuf.length === 0 || roomBuf.length > MAX_ROOM_ID_BYTES) {
    throw new ProtocolError("bad_room_id", `roomId must be 1..${MAX_ROOM_ID_BYTES} bytes`);
  }
  const out = Buffer.allocUnsafe(2 + roomBuf.length + 4 + payload.length);
  out[0] = OP.FRAME;
  out[1] = roomBuf.length;
  roomBuf.copy(out, 2);
  out.writeUInt32LE(senderId >>> 0, 2 + roomBuf.length);
  payload.copy(out, 2 + roomBuf.length + 4);
  return out;
}

export function decodeBinary(buf: Buffer): BinaryFrame {
  // The binary cap, which the header above has always claimed the codec
  // enforces and which it did not. Room id and text frame were both checked;
  // this one was declared and never read. That matters more here than an
  // ordinary unused constant: this file calls itself the source of truth for
  // the wire format and is mirrored by tTest's shell and the Worker iframe SDK,
  // so a mirror that implemented the documented cap would have disagreed with
  // the server about which frames are legal.
  if (buf.length > MAX_BINARY_FRAME_BYTES) {
    throw new ProtocolError("binary_too_large", `binary frame exceeds ${MAX_BINARY_FRAME_BYTES}B`);
  }
  if (buf.length < 2) throw new ProtocolError("bad_binary", "too short");
  const op = buf[0];
  const roomLen = buf[1];
  if (roomLen === 0) throw new ProtocolError("bad_room_id", "roomId empty");
  if (buf.length < 2 + roomLen) throw new ProtocolError("bad_binary", "truncated room id");
  const roomId = buf.toString("utf8", 2, 2 + roomLen);
  const rest = 2 + roomLen;

  switch (op) {
    case OP.PUBLISH:
      return { op: OP.PUBLISH, roomId, payload: buf.subarray(rest) };
    case OP.FRAME: {
      if (buf.length < rest + 4) throw new ProtocolError("bad_binary", "truncated sender id");
      const senderId = buf.readUInt32LE(rest);
      return { op: OP.FRAME, roomId, senderId, payload: buf.subarray(rest + 4) };
    }
    default:
      throw new ProtocolError("bad_opcode", `unknown opcode 0x${op.toString(16)}`);
  }
}

export class ProtocolError extends Error {
  code: string;
  constructor(code: string, msg: string) {
    super(msg);
    this.code = code;
    this.name = "ProtocolError";
  }
}
