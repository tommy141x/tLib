/**
 * Move Mode — Generic drag-to-reposition + scroll-to-scale for fixed-position UI elements.
 *
 * Framework-agnostic: returns event handlers that can be attached to any DOM element.
 * Position is expressed as { right, bottom, scale } (CSS fixed positioning from bottom-right).
 *
 * Usage with SolidJS:
 *   const drag = createDragHandler({
 *     getPosition: () => store.position,
 *     setPosition: (pos) => setStore("position", pos),
 *     onSave: (pos) => fetchNui("savePosition", pos),
 *     scaleRange: [0.5, 2.0],
 *   });
 *
 *   <div onMouseDown={drag.onMouseDown} onWheel={drag.onWheel} />
 */

export interface DragPosition {
  right: number;
  bottom: number;
  scale: number;
}

export interface DragHandlerOptions {
  /** Get current position */
  getPosition: () => DragPosition;
  /** Update position (called during drag) */
  setPosition: (pos: DragPosition) => void;
  /** Called when drag ends or scale changes — persist the position */
  onSave?: (pos: DragPosition) => void;
  /** Min/max scale [min, max] — default [0.5, 2.0] */
  scaleRange?: [number, number];
  /** Scale step per wheel tick — default 0.05 */
  scaleStep?: number;
}

export interface DragHandlers {
  onMouseDown: (e: MouseEvent) => void;
  onWheel: (e: WheelEvent) => void;
}

/**
 * Create drag handlers for repositioning a fixed-position element.
 * Supports mouse drag (position) and scroll wheel (scale).
 */
export function createDragHandler(opts: DragHandlerOptions): DragHandlers {
  const scaleRange = opts.scaleRange ?? [0.5, 2.0];
  const scaleStep = opts.scaleStep ?? 0.05;

  let startX = 0;
  let startY = 0;
  let startRight = 0;
  let startBottom = 0;

  function onMouseMove(e: MouseEvent) {
    const pos = opts.getPosition();
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    opts.setPosition({
      right: startRight - dx,
      bottom: startBottom - dy,
      scale: pos.scale,
    });
  }

  function onMouseUp() {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    opts.onSave?.(opts.getPosition());
  }

  function onMouseDown(e: MouseEvent) {
    // Only left mouse button
    if (e.button !== 0) return;
    e.preventDefault();
    const pos = opts.getPosition();
    startX = e.clientX;
    startY = e.clientY;
    startRight = pos.right;
    startBottom = pos.bottom;
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const pos = opts.getPosition();
    const delta = e.deltaY > 0 ? -scaleStep : scaleStep;
    const newScale = Math.max(scaleRange[0], Math.min(scaleRange[1], pos.scale + delta));
    opts.setPosition({ ...pos, scale: newScale });
    opts.onSave?.(opts.getPosition());
  }

  return { onMouseDown, onWheel };
}
