import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { downloadBundle } from "../../shared/ts/marketplace/download";

let server: Server;
let base: string;
const hash = "a".repeat(64);
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/stall") return;
    if (req.url === "/error") {
      res.writeHead(503);
      res.end();
      return;
    }
    if (req.url !== "/missing")
      res.setHeader("X-Marketplace-File-Hash", req.url === "/bad-hash" ? "bad" : hash);
    if (req.url === "/size") res.setHeader("X-Marketplace-Size-Bytes", "200");
    if (req.url === "/mismatch") res.setHeader("X-Marketplace-Size-Bytes", "8");
    res.writeHead(200);
    res.write(req.url === "/overflow" ? "x".repeat(200) : "data");
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
test("accepts v1 streamed bundle without mandatory size header", async () => {
  const result = await downloadBundle(`${base}/ok`, 100);
  expect(result.buf.toString()).toBe("data");
  expect(result.hash).toBe(hash);
  expect(result.size).toBe(0);
});
test("rejects absent or malformed hash", async () => {
  for (const route of ["missing", "bad-hash"])
    await expect(downloadBundle(`${base}/${route}`, 100)).rejects.toThrow("hash");
});
test("bounds declared size before collecting body", async () => {
  await expect(downloadBundle(`${base}/size`, 100)).rejects.toThrow("size");
});
test("bounds actual streamed bytes", async () => {
  await expect(downloadBundle(`${base}/overflow`, 100)).rejects.toThrow("maximum bundle size");
});
test("rejects mismatching optional size", async () => {
  await expect(downloadBundle(`${base}/mismatch`, 100)).rejects.toThrow("size mismatch");
});
test("absolute deadline closes a stalled request", async () => {
  await expect(downloadBundle(`${base}/stall`, 100, 30)).rejects.toThrow("timed out");
});
test("rejects error status and unsupported URLs", async () => {
  await expect(downloadBundle(`${base}/error`, 100)).rejects.toThrow("503");
  await expect(downloadBundle("file:///tmp/bundle", 100)).rejects.toThrow("unsupported");
  await expect(downloadBundle(`${base}/ok`, Infinity)).rejects.toThrow("byte limit");
});
