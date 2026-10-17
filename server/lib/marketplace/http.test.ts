// Covers the timeout contract of the one marketplace transport.
//
// Against a real loopback server rather than a mocked `fetch`, because the bug
// these pin is in WHERE the handler is attached, not in what it returns: a mock
// that rejects the fetch promise passes the old shape and the new one alike.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as http from "node:http";
import { MarketplaceError } from "./api";
import { request } from "./http";

interface Received {
  method: string;
  contentLength?: string;
  body: string;
}

let base = "";
let server: http.Server;
const received: Received[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const len = req.headers["content-length"];
      received.push({
        method: req.method ?? "",
        ...(typeof len === "string" ? { contentLength: len } : {}),
        body: Buffer.concat(chunks).toString(),
      });
    });

    if (req.url === "/stall-headers") return; // never answers at all
    if (req.url === "/stall-body") {
      res.writeHead(200, { "content-type": "application/json" });
      // A partial chunk and then silence: the headers are through, so the fetch
      // promise has already resolved and only `res.text()` is still waiting.
      res.write('{"par');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => {
  server.close();
});

describe("request", () => {
  test("returns the status and body text of a normal response", async () => {
    const resp = await request(`${base}/ok`, "GET", "", {});
    expect(resp).toEqual({ ok: true, status: 200, body: '{"ok":true}' });
  });

  test("a timeout before the headers arrive is request_timed_out", async () => {
    const err = await request(`${base}/stall-headers`, "GET", "", {}, 150).catch((e) => e);
    expect(err).toBeInstanceOf(MarketplaceError);
    expect((err as MarketplaceError).code).toBe("request_timed_out");
  });

  // The regression this file exists for. The previous shape hung its rejection
  // handler off `fetch(...)`, which had already resolved by the time the body
  // stalled, so `res.text()` rejected past it and the caller got a raw
  // `AbortError: This operation was aborted`.
  test("a timeout DURING the body read is request_timed_out, not AbortError", async () => {
    const err = await request(`${base}/stall-body`, "GET", "", {}, 150).catch((e) => e);
    expect((err as Error).name).not.toBe("AbortError");
    expect(err).toBeInstanceOf(MarketplaceError);
    expect((err as MarketplaceError).code).toBe("request_timed_out");
  });

  // A request body is the sole precondition for the "Invalid state: Reader
  // released" line the host prints — undici tees it and drains the tee with a
  // `for await`, and ending that loop releases the reader. Nothing of ours can
  // handle that rejection, so not creating one on the read paths is the whole
  // mitigation available, and this is what would catch a GET starting to send
  // a body.
  test("a GET sends no request body", async () => {
    await request(`${base}/ok`, "GET", '{"ignored":true}', {});
    const got = received.at(-1);
    expect(got?.method).toBe("GET");
    expect(got?.body).toBe("");
    expect(got?.contentLength).toBeUndefined();
  });
});
