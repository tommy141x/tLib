/**
 * A slider drag reaches the host while it is happening, at a bounded rate.
 *
 * ── WHY THIS TEST EXISTS ───────────────────────────────────────────────────
 *
 * Committing on every `onValueChange` made a drag one NUI -> Lua ->
 * UpdateDialogField round trip PER PIXEL, so the commit was moved to
 * pointer-up. That fixed the cost and removed the feature: a host that applies
 * a setting as it arrives — tLS's bloom size — stopped responding until the
 * pointer came up, so you could not see what you were setting.
 *
 * The throttle is the middle: the host hears the drag, but at a rate it can
 * answer. What these pin is the part that is easy to get subtly wrong — the
 * trailing send, and the commit never being overtaken by a stale queued one.
 */

import { describe, expect, jest, test } from "bun:test";
import { createWirePreview, WIRE_PREVIEW_MS } from "../src/components/ui/nui-field";

function harness() {
  const sent: number[] = [];
  return { sent, wire: createWirePreview((v) => sent.push(v)) };
}

describe("slider wire preview", () => {
  test("the first move goes out immediately", () => {
    const { sent, wire } = harness();
    wire.preview(10);
    expect(sent).toEqual([10]);
  });

  test("a burst inside one interval is collapsed, not dropped", () => {
    jest.useFakeTimers();
    try {
      const { sent, wire } = harness();
      wire.preview(1);
      expect(sent).toEqual([1]);

      // Everything in the same window queues behind the leading send.
      wire.preview(2);
      wire.preview(3);
      wire.preview(4);
      expect(sent).toEqual([1]);

      // ...and the LAST of them lands on the trailing edge. Dropping it would
      // leave a drag that paused mid-move showing a stale value on the host.
      jest.advanceTimersByTime(WIRE_PREVIEW_MS + 1);
      expect(sent).toEqual([1, 4]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a long drag sends at the interval, not per move", () => {
    jest.useFakeTimers();
    try {
      const { sent, wire } = harness();
      // 200 moves spread over four intervals.
      for (let i = 0; i < 200; i++) {
        wire.preview(i);
        jest.advanceTimersByTime(1);
      }
      jest.advanceTimersByTime(WIRE_PREVIEW_MS + 1);
      // The exact count depends on scheduling, but the point is that it is
      // bounded by elapsed time rather than by how many moves arrived.
      expect(sent.length).toBeLessThan(10);
      expect(sent.length).toBeGreaterThan(1);
      expect(sent.at(-1)).toBe(199);
    } finally {
      jest.useRealTimers();
    }
  });

  test("cancel drops a queued send, so a commit is not overtaken", () => {
    jest.useFakeTimers();
    try {
      const { sent, wire } = harness();
      wire.preview(1);
      wire.preview(2); // queued on the trailing edge

      // This is what `commitSlider` does: abandon the queued older value and
      // send the exact one the pointer was released on.
      wire.cancel();
      wire.markSent();
      sent.push(99);

      jest.advanceTimersByTime(WIRE_PREVIEW_MS * 4);
      // 2 never lands — arriving after the commit would overwrite the number
      // the user actually let go on.
      expect(sent).toEqual([1, 99]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("markSent makes the next move wait its turn", () => {
    jest.useFakeTimers();
    try {
      const { sent, wire } = harness();
      wire.markSent();
      wire.preview(5);
      // A commit just went out, so this one queues instead of going immediately.
      expect(sent).toEqual([]);
      jest.advanceTimersByTime(WIRE_PREVIEW_MS + 1);
      expect(sent).toEqual([5]);
    } finally {
      jest.useRealTimers();
    }
  });
});
