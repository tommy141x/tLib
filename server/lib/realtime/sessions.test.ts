// The per-session rate limiter, on the one input it must not trust: the wall clock.

import { afterEach, describe, expect, test } from "bun:test";
import { TokenBucket } from "./sessions";

const realNow = Date.now;

afterEach(() => {
  Date.now = realNow;
});

describe("TokenBucket", () => {
  test("spends its burst and then refuses", () => {
    const bucket = new TokenBucket(2, 0.001);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  test("refills with time actually passed", async () => {
    const bucket = new TokenBucket(1, 1000);
    expect(bucket.tryConsume()).toBe(true);
    await Bun.sleep(20);
    expect(bucket.tryConsume()).toBe(true);
  });

  test("a wall clock stepped backwards does not empty the bucket", async () => {
    // A negative elapsed time subtracts tokens: an hour's step at this rate is a
    // debt of 3.6 million, and every frame is dropped until it has been repaid.
    const bucket = new TokenBucket(2, 1000);
    expect(bucket.tryConsume(2)).toBe(true);

    Date.now = () => realNow() - 3_600_000;
    await Bun.sleep(20);

    expect(bucket.tryConsume()).toBe(true);
  });
});
