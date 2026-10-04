import { describe, expect, test } from "bun:test";
import {
  anchors,
  buildSnapTargets,
  type Component,
  changeAnchor,
  constrainLayout,
  deriveAnchor,
  type Layout,
  layoutRect,
  MAX_OFFSET,
  migrateOffsets,
  moveLayout,
  placeRect,
  reanchor,
  resizeLayout,
  resolveSnap,
  safezoneRect,
  scaleLayout,
} from "../../shared/ts/hud-geometry";
import { LayoutHistory } from "../../client/web/src/layout/history";

const base: Layout = { x: 0, y: 0, scale: 1, visible: true, anchor: "top-left" };
const component: Component = {
  key: "test:status",
  owner: "test",
  id: "status",
  label: "Status",
  width: 200,
  height: 100,
  defaults: base,
  layout: base,
  minScale: 0.5,
  maxScale: 2,
  canScale: true,
  canHide: true,
};
const viewport = { width: 1920, height: 1080 };
/** A placement that is comfortably on screen for the given anchor, so a test can
 *  isolate the behaviour it is about from the clamp that heals bad placements. */
const inward = (anchor: Layout["anchor"], amount = 0.1) => ({
  x: anchor === "center" ? 0 : anchor.endsWith("right") ? -amount : amount,
  y: anchor === "center" ? 0 : anchor.startsWith("bottom") ? -amount : amount,
});

describe("HUD geometry (no DOM)", () => {
  test("intrinsic pixels at 1080p; height-based uniform sizing at 1440p", () => {
    expect(layoutRect(component, base, viewport)).toEqual({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
    });
    const rect = layoutRect(component, { ...base, scale: 1.5 }, { width: 3440, height: 1440 });
    expect(rect.width).toBe(400);
    expect(rect.height).toBe(200);
  });
  test("offsets are reference pixels over 1080 on both axes, inward when negative", () => {
    const rect = layoutRect(
      component,
      { ...base, anchor: "bottom-right", x: -40 / 1080, y: -32 / 1080 },
      viewport
    );
    expect(rect.left).toBeCloseTo(1920 - 200 - 40);
    expect(rect.top).toBeCloseTo(1080 - 100 - 32);
  });
  test("a corner inset is the same visual distance at every aspect ratio", () => {
    const layout = { ...base, anchor: "bottom-right" as const, x: -40 / 1080, y: -40 / 1080 };
    for (const vp of [
      { width: 1920, height: 1080 }, // 16:9
      { width: 1920, height: 1200 }, // 16:10
      { width: 2560, height: 1080 }, // 21:9
      { width: 3840, height: 1080 }, // 32:9
      { width: 1024, height: 768 }, // 4:3
    ]) {
      const rect = layoutRect(component, layout, vp);
      const scale = vp.height / 1080;
      // Inset scales with the widget, not with how wide the monitor happens to be.
      expect(vp.width - (rect.left + rect.width)).toBeCloseTo(40 * scale);
      expect(vp.height - (rect.top + rect.height)).toBeCloseTo(40 * scale);
    }
  });
  test("centre-anchored x stays proportional to width, because that is what centring means", () => {
    const layout = { ...base, anchor: "center" as const, x: 0.25 };
    for (const vp of [
      { width: 1920, height: 1080 },
      { width: 3840, height: 1080 },
    ]) {
      const rect = layoutRect(component, layout, vp);
      expect(rect.left + rect.width / 2 - vp.width / 2).toBeCloseTo(0.25 * vp.width);
    }
  });
  test("center means widget center, not its upper-left corner", () => {
    expect(layoutRect(component, { ...base, anchor: "center" }, viewport)).toEqual({
      left: 860,
      top: 490,
      width: 200,
      height: 100,
    });
  });
  test("all anchor conversions round-trip across aspect ratios", () => {
    for (const vp of [viewport, { width: 3440, height: 1440 }, { width: 1024, height: 768 }]) {
      for (const anchor of anchors) {
        const layout = { ...base, anchor, x: -0.08, y: 0.04, scale: 1.3 };
        const roundtrip = placeRect(layout, layoutRect(component, layout, vp), vp);
        expect(roundtrip.x).toBeCloseTo(layout.x, 12);
        expect(roundtrip.y).toBeCloseTo(layout.y, 12);
        const changed = changeAnchor(component, layout, vp, "center");
        const before = layoutRect(component, layout, vp),
          after = layoutRect(component, changed, vp);
        expect(after.left).toBeCloseTo(before.left, 10);
        expect(after.top).toBeCloseTo(before.top, 10);
      }
    }
  });
  test("safezone inset is an even margin on both axes, not a proportional one", () => {
    expect(safezoneRect(viewport, 1)).toEqual({ left: 0, top: 0, ...viewport });
    const safe = safezoneRect(viewport, 0.9);
    expect(safe.left).toBeCloseTo(54);
    expect(safe.top).toBeCloseTo(54);
    expect(safe.width).toBeCloseTo(1812);
    expect(safe.height).toBeCloseTo(972);
    // On 32:9 the old proportional inset ate 192px of width per side; this does not.
    const ultrawide = safezoneRect({ width: 3840, height: 1080 }, 0.9);
    expect(ultrawide.left).toBeCloseTo(54);
    expect(safezoneRect(viewport, Number.NaN)).toEqual({ left: 0, top: 0, ...viewport });
  });
  test("snapping pulls the nearest edge, centre or far edge within the threshold", () => {
    const targets = { x: [500, 900], y: [300] };
    // Left edge at 496 is 4px from the 500 line and wins over the 900 line.
    expect(resolveSnap({ left: 496, top: 0, width: 200, height: 100 }, targets).dx).toBeCloseTo(4);
    // Far edge (left 704 + width 200 = 904) snaps back onto 900.
    expect(resolveSnap({ left: 704, top: 0, width: 200, height: 100 }, targets).dx).toBeCloseTo(-4);
    // Centre (top 245 + 50 = 295) reaches for the 300 line.
    expect(resolveSnap({ left: 0, top: 245, width: 200, height: 100 }, targets).dy).toBeCloseTo(5);
    // Nothing within the threshold means no pull and no guide to draw.
    const none = resolveSnap({ left: 0, top: 0, width: 200, height: 100 }, targets);
    expect(none.dx).toBe(0);
    expect(none.guides.x).toBeUndefined();
  });
  test("snap targets cover the safe zone, screen centre and other widgets, never itself", () => {
    const other = { ...component, key: "test:other" };
    const targets = buildSnapTargets(
      [
        { component, layout: base },
        { component: other, layout: { ...base, x: 0.5 } },
      ],
      viewport,
      1,
      component.key
    );
    expect(targets.x).toContain(viewport.width / 2);
    // The dragged widget sits at left 0; its own edge must not be a target.
    expect(
      buildSnapTargets([{ component, layout: base }], viewport, 1, component.key).x
    ).not.toContain(200);
    expect(targets.x).toContain(540); // the other widget's left edge at x = 0.5 * 1080
  });
  test("every component keeps a grabbable part on screen, with no opt-in", () => {
    // 96px or 40% of the rendered extent, whichever is larger, capped by the extent.
    const rect = layoutRect(
      component,
      moveLayout(component, base, viewport, -99999, 99999),
      viewport
    );
    expect(rect.left + rect.width).toBeCloseTo(96);
    expect(rect.top).toBeCloseTo(1080 - 96);
    const huge = { ...component, width: 4000, height: 3000 };
    const big = layoutRect(huge, moveLayout(huge, base, viewport, -99999, 99999), viewport);
    expect(big.left + big.width).toBeCloseTo(1600); // 40% of 4000
    expect(big.top).toBeCloseTo(0); // 3000 tall needs the whole 1080 viewport
  });
  test("a position saved off-screen heals on restore rather than staying lost", () => {
    for (const anchor of anchors) {
      for (const vp of [viewport, { width: 1280, height: 720 }, { width: 3840, height: 1080 }]) {
        const stranded = { ...base, anchor, x: MAX_OFFSET, y: -MAX_OFFSET };
        const rect = layoutRect(component, constrainLayout(component, stranded, vp), vp);
        const visibleX = Math.min(vp.width, rect.left + rect.width) - Math.max(0, rect.left);
        const visibleY = Math.min(vp.height, rect.top + rect.height) - Math.max(0, rect.top);
        expect(visibleX + 1e-8).toBeGreaterThanOrEqual(
          Math.min(rect.width, vp.width, Math.max(96, rect.width * 0.4))
        );
        expect(visibleY + 1e-8).toBeGreaterThanOrEqual(
          Math.min(rect.height, vp.height, Math.max(96, rect.height * 0.4))
        );
      }
    }
  });
  test("oversized geometry never emits offsets outside the backend schema", () => {
    const huge = { ...component, width: 4096, height: 4096, maxScale: 4 };
    const tiny = { width: 640, height: 480 };
    for (const anchor of anchors) {
      const layout = { ...base, anchor, scale: 4 };
      for (const next of [
        placeRect(layout, { left: 99999, top: -99999, width: 99999, height: 99999 }, tiny),
        moveLayout(huge, layout, tiny, -99999, 99999),
        resizeLayout(huge, layout, tiny, "nw", 99999, -99999),
        changeAnchor(huge, layout, tiny, "center"),
        placeRect(layout, { left: 0, top: 0, width: 0, height: 0 }, { width: 0, height: 0 }),
        resizeLayout(huge, layout, { width: 0, height: 0 }, "se", 10, 10),
      ]) {
        expect(Number.isFinite(next.x)).toBe(true);
        expect(Number.isFinite(next.y)).toBe(true);
        expect(next.x).toBeGreaterThanOrEqual(-MAX_OFFSET);
        expect(next.x).toBeLessThanOrEqual(MAX_OFFSET);
        expect(next.y).toBeGreaterThanOrEqual(-MAX_OFFSET);
        expect(next.y).toBeLessThanOrEqual(MAX_OFFSET);
        expect(Number.isFinite(next.scale)).toBe(true);
      }
    }
  });
  test("all corners resize uniformly with the opposite corner fixed", () => {
    for (const corner of ["nw", "ne", "sw", "se"] as const) {
      const sx = corner.endsWith("e") ? 1 : -1,
        sy = corner.startsWith("s") ? 1 : -1;
      const before = layoutRect(component, base, viewport);
      const next = resizeLayout(component, base, viewport, corner, 100 * sx, 50 * sy);
      const after = layoutRect(component, next, viewport);
      expect(next.scale).toBeCloseTo(1.5);
      expect(after.width / after.height).toBe(2);
      expect(sx > 0 ? after.left : after.left + after.width).toBeCloseTo(
        sx > 0 ? before.left : before.left + before.width
      );
      expect(sy > 0 ? after.top : after.top + after.height).toBeCloseTo(
        sy > 0 ? before.top : before.top + before.height
      );
    }
  });
  test("opt-in radio recoverability uses max(100 CSS pixels, 35% of rendered extent)", () => {
    const radio = {
      ...component,
      width: 630,
      height: 440,
      minVisiblePixels: 100,
      minVisibleFraction: 0.35,
    };
    for (const vp of [viewport, { width: 1280, height: 720 }, { width: 3440, height: 1440 }]) {
      for (const anchor of anchors)
        for (const scale of [0.5, 1, 1.5]) {
          for (const direction of [-1, 1]) {
            const layout = { ...base, anchor, scale };
            const moved = moveLayout(radio, layout, vp, direction * 99999, -direction * 99999);
            const rect = layoutRect(radio, moved, vp);
            const visibleX = Math.min(vp.width, rect.left + rect.width) - Math.max(0, rect.left);
            const visibleY = Math.min(vp.height, rect.top + rect.height) - Math.max(0, rect.top);
            expect(visibleX + 1e-8).toBeGreaterThanOrEqual(
              Math.min(rect.width, vp.width, Math.max(100, rect.width * 0.35))
            );
            expect(visibleY + 1e-8).toBeGreaterThanOrEqual(
              Math.min(rect.height, vp.height, Math.max(100, rect.height * 0.35))
            );
          }
        }
    }
  });
  test("a per-component override replaces the universal rule rather than enabling it", () => {
    const offscreen = { ...base, x: MAX_OFFSET, y: MAX_OFFSET };
    // The default component is clamped too -- there is no unclamped path any more.
    const defaulted = layoutRect(
      component,
      constrainLayout(component, offscreen, viewport),
      viewport
    );
    expect(defaulted.left).toBeCloseTo(1920 - 96);
    expect(defaulted.top).toBeCloseTo(1080 - 96);
    const radio = {
      ...component,
      width: 630,
      height: 440,
      minVisiblePixels: 100,
      minVisibleFraction: 0.35,
    };
    const corrected = constrainLayout(radio, offscreen, viewport);
    expect(layoutRect(radio, corrected, viewport).left).toBeCloseTo(1920 - 630 * 0.35);
    expect(layoutRect(radio, corrected, viewport).top).toBeCloseTo(1080 - 440 * 0.35);
    const resized = resizeLayout(radio, corrected, viewport, "nw", 9999, 9999);
    const rect = layoutRect(radio, resized, viewport);
    expect(
      Math.min(viewport.width, rect.left + rect.width) - Math.max(0, rect.left) + 1e-8
    ).toBeGreaterThanOrEqual(Math.min(rect.width, Math.max(100, rect.width * 0.35)));
  });
  test("small widgets retain their whole extent rather than demanding an impossible 100px", () => {
    const small = {
      ...component,
      width: 50,
      height: 20,
      minVisiblePixels: 100,
      minVisibleFraction: 0.35,
    };
    const rect = layoutRect(small, moveLayout(small, base, viewport, 99999, -99999), viewport);
    expect(rect.left).toBeCloseTo(1870);
    expect(rect.top).toBeCloseTo(0);
  });
  test("wheel scaling pins the anchor pivot, so a corner widget stays in its corner", () => {
    for (const anchor of anchors) {
      const layout = { ...base, anchor, ...inward(anchor) };
      const before = layoutRect(component, layout, viewport);
      const after = layoutRect(component, scaleLayout(component, layout, viewport, 1.5), viewport);
      const pivot = {
        x: anchor === "center" ? 0.5 : anchor.endsWith("right") ? 1 : 0,
        y: anchor === "center" ? 0.5 : anchor.startsWith("bottom") ? 1 : 0,
      };
      expect(after.left + after.width * pivot.x).toBeCloseTo(before.left + before.width * pivot.x);
      expect(after.top + after.height * pivot.y).toBeCloseTo(before.top + before.height * pivot.y);
    }
  });
  test("wheel scaling is multiplicative, bounded, and ignores components that cannot scale", () => {
    const up = scaleLayout(component, base, viewport, 1.02);
    expect(scaleLayout(component, up, viewport, 1 / 1.02).scale).toBeCloseTo(1, 3);
    expect(scaleLayout(component, base, viewport, 99).scale).toBe(2);
    expect(scaleLayout(component, base, viewport, 0.001).scale).toBe(0.5);
    expect(scaleLayout({ ...component, canScale: false }, base, viewport, 1.5)).toBe(base);
    expect(scaleLayout(component, base, viewport, Number.NaN)).toBe(base);
  });
  test("anchor is derived from where the widget sits, and re-anchoring never moves it", () => {
    const place = (left: number, top: number) =>
      deriveAnchor({ left, top, width: 200, height: 100 }, viewport);
    expect(place(20, 20)).toBe("top-left");
    expect(place(1700, 20)).toBe("top-right");
    expect(place(20, 960)).toBe("bottom-left");
    expect(place(1700, 960)).toBe("bottom-right");
    expect(place(860, 490)).toBe("center");
    // Dead centre horizontally but high up is a corner, not centre: only the
    // middle third of BOTH axes counts as centred.
    expect(place(860, 20)).toBe("top-right");
    for (const anchor of anchors) {
      const layout = { ...base, anchor, ...inward(anchor), scale: 1.2 };
      const before = layoutRect(component, layout, viewport);
      const after = layoutRect(component, reanchor(component, layout, viewport), viewport);
      expect(after.left).toBeCloseTo(before.left, 6);
      expect(after.top).toBeCloseTo(before.top, 6);
    }
  });
  test("v1 records convert to reference pixels on the 16:9 they were saved at", () => {
    // v1 x = -0.02 meant 2% of 1920 = 38.4px in from the right.
    const migrated = migrateOffsets({ ...base, anchor: "bottom-right", x: -0.02, y: -0.03 });
    expect(migrated.x * 1080).toBeCloseTo(-38.4);
    expect(migrated.y).toBe(-0.03); // y was always a fraction of height
    const rect = layoutRect(component, migrated, viewport);
    expect(1920 - (rect.left + rect.width)).toBeCloseTo(38.4);
    // Centre-anchored x was already proportional to width and must not be touched.
    const centred = { ...base, anchor: "center" as const, x: 0.25 };
    expect(migrateOffsets(centred)).toBe(centred);
  });
  /**
   * 1:1 dragging, which is requirement 4 of the bug report, and the thing the
   * v1/v2 unit mismatch broke: at 3440x1440 a `x`-as-a-fraction-of-WIDTH renderer
   * moved 3440/1440 = 2.389 px for every px the outline moved.
   *
   * Every viewport here, and every UI scale: `moveLayout(dx, dy)` must change the
   * rendered rect by exactly `dx`, `dy`, because the rect IS what both the outline
   * and every consumer draw.
   */
  test("a pixel of drag is a pixel of movement at any viewport, anchor and scale", () => {
    const viewports = [
      { width: 1920, height: 1080 },
      { width: 3440, height: 1440 }, // the reporter's screen
      { width: 1280, height: 720 },
      { width: 2560, height: 1080 }, // 21:9, where width/height diverge most
    ];
    for (const vp of viewports) {
      for (const anchor of anchors) {
        for (const scale of [0.5, 1, 2]) {
          const layout: Layout = { ...base, ...inward(anchor, 0.25), scale, anchor };
          const before = layoutRect(component, layout, vp);
          for (const [dx, dy] of [
            [100, 0],
            [0, 100],
            [-100, -60],
            [37, -13],
          ]) {
            const after = layoutRect(component, moveLayout(component, layout, vp, dx, dy), vp);
            expect(after.left - before.left).toBeCloseTo(dx, 6);
            expect(after.top - before.top).toBeCloseTo(dy, 6);
            // Dragging must never resize: the scale factor is independent of position.
            expect(after.width).toBeCloseTo(before.width, 6);
            expect(after.height).toBeCloseTo(before.height, 6);
          }
        }
      }
    }
  });
  /**
   * Outline/render agreement, with the actual numbers. `layoutRect` is the single
   * definition of where a widget is; tRadar, tELS, tDetector and the tLib SDK all
   * call this exact function, and tRadio's Lua `convert()` is asserted against the
   * same numbers in tRadio's own suite. A regression here is a regression in all
   * five at once, so the expected values are written out rather than derived.
   */
  test("the rendered rect is the same rect at 1080p and at 3440x1440", () => {
    const layout: Layout = {
      x: -48 / 1080,
      y: -48 / 1080,
      scale: 1,
      visible: true,
      anchor: "bottom-right",
    };
    // 1080p: the offset is one reference pixel per pixel, so 48 px in from each edge.
    const hd = layoutRect(component, layout, { width: 1920, height: 1080 });
    expect(hd).toEqual({ left: 1920 - 200 - 48, top: 1080 - 100 - 48, width: 200, height: 100 });
    // 3440x1440: everything scales by 1440/1080 = 4/3 -- the widget AND the inset --
    // and the inset does NOT scale by the width, which is the whole v2 rule.
    const uw = layoutRect(component, layout, { width: 3440, height: 1440 });
    expect(uw.width).toBeCloseTo(200 * (4 / 3), 6);
    expect(uw.height).toBeCloseTo(100 * (4 / 3), 6);
    expect(3440 - (uw.left + uw.width)).toBeCloseTo(48 * (4 / 3), 6);
    expect(1440 - (uw.top + uw.height)).toBeCloseTo(48 * (4 / 3), 6);
    // The v1 reading would have put the right inset at 48 * 3440/1080 = 152.9 px
    // while the outline sat at 64 px -- 88.9 px apart on a static, unmoved widget.
    expect(48 * (3440 / 1080)).toBeCloseTo(152.889, 3);
  });
  /** Clamp on load: a record from another resolution or another unit system heals. */
  test("constrainLayout rescues a record that would otherwise be unreachable", () => {
    const vp = { width: 3440, height: 1440 };
    // What the v1/v2 mismatch actually produced: an x the editor thought was fine.
    const lost: Layout = { x: -4, y: -4, scale: 1, visible: true, anchor: "bottom-right" };
    const rect = layoutRect(component, lost, vp);
    expect(rect.left).toBeLessThan(0); // MUTATION GUARD: it really is off screen
    const healed = constrainLayout(component, lost, vp);
    expect(healed).not.toEqual(lost);
    const after = layoutRect(component, healed, vp);
    const need = Math.min(after.width, vp.width, Math.max(96, after.width * 0.4));
    expect(Math.min(vp.width, after.left + after.width) - Math.max(0, after.left)).toBeGreaterThan(
      need - 1e-6
    );
    // An already-legal placement is returned by identity, so registering a
    // component never rewrites a good saved value by a float epsilon.
    const fine: Layout = { ...base, ...inward("bottom-right", 0.1), anchor: "bottom-right" };
    expect(constrainLayout(component, fine, vp)).toBe(fine);
  });
  test("resize bounds and capability respected", () => {
    expect(resizeLayout(component, base, viewport, "se", 99999, 99999).scale).toBe(2);
    expect(resizeLayout(component, base, viewport, "se", -99999, -99999).scale).toBe(0.5);
    expect(resizeLayout({ ...component, canScale: false }, base, viewport, "se", 100, 50)).toBe(
      base
    );
  });
});

describe("gesture history", () => {
  test("one gesture restores its starting snapshot, redo restores its end", () => {
    const history = new LayoutHistory();
    const end = { ...base, x: 0.3, scale: 1.4 };
    history.record("a", base, end);
    expect(history.undo()).toEqual({ key: "a", layout: base });
    expect(history.canUndo).toBe(false);
    expect(history.redo()).toEqual({ key: "a", layout: end });
  });
  test("snapshots are owned copies and returned layouts are not history references", () => {
    const history = new LayoutHistory();
    const start = { ...base },
      end = { ...base, visible: false };
    history.record("a", start, end);
    start.x = 999;
    end.x = 999;
    const undone = history.undo()!;
    undone.layout.x = 999;
    expect(history.redo()!.layout).toEqual({ ...base, visible: false });
    expect(history.undo()!.layout).toEqual(base);
  });
  test("no-op gestures do not clear redo, new edits do", () => {
    const history = new LayoutHistory();
    history.record("a", base, { ...base, x: 1 });
    history.undo();
    history.record("a", base, { ...base });
    expect(history.canRedo).toBe(true);
    history.record("a", base, { ...base, y: 1 });
    expect(history.canRedo).toBe(false);
  });
  test("removal fences undo and redo for a stopped resource", () => {
    const history = new LayoutHistory();
    history.record("a", base, { ...base, x: 1 });
    history.record("b", base, { ...base, y: 1 });
    history.undo();
    history.remove("b");
    expect(history.canRedo).toBe(false);
    expect(history.undo()!.key).toBe("a");
    history.remove("a");
    expect(history.canRedo).toBe(false);
  });
  test("history is bounded and session clear drops both directions", () => {
    const history = new LayoutHistory(2);
    for (let x = 1; x <= 3; x++) history.record("a", { ...base, x: x - 1 }, { ...base, x });
    expect(history.undo()!.layout.x).toBe(2);
    expect(history.undo()!.layout.x).toBe(1);
    expect(history.undo()).toBeUndefined();
    history.clear();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });
});
