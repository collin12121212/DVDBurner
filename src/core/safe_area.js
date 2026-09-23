/**
 * Where an element is allowed to sit on a slide.
 *
 * One rule, in one place. There were two copies of it and they had already
 * drifted apart: the editor held an element inside the television-safe area, and
 * the authoring side did its own arithmetic, and the two disagreed about what
 * happens when an element is larger than the area it is being held inside. Only
 * one of them was ever called, so the disagreement was invisible until a picture
 * was scaled up too far and would not move.
 *
 * Loaded as a plain script by the editor and required as a module by the
 * authoring side, in the same shape as slide_draw.js, so the numbers that decide
 * whether a picture ends up on the disc exist once.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BurnhouseSafeArea = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** The DVD raster every slide is drawn on. */
  const RASTER = { width: 720, height: 480 };

  /**
   * How far in from the edge anything worth reading has to stay.
   *
   * Televisions overscan: they crop the outer edge of the picture, by an amount
   * that varies between sets. A word inside that band is a word that is not on
   * some televisions at all. The editor draws this as the blue guide.
   */
  const SAFE_MARGIN = 40;

  /**
   * The lowest a video tile may reach.
   *
   * The navigation row — `< Menu` and `Next >` — sits at y = 408..440, so a
   * tile's bottom edge stops short of it. This is the one limit that is about
   * something other than overscan.
   */
  const VIDEO_BOTTOM = 396;

  const MIN_WIDTH = 40;
  const MIN_HEIGHT = 24;

  /** Kinds that must keep their proportions, or the picture on the disc looks stretched. */
  const SHAPE_LOCKED = new Set(['video', 'image']);

  /**
   * Whether an element may be larger than the safe area.
   *
   * A picture may. A photograph filling the frame, with its edges cropped by the
   * television, is an ordinary thing to want, and there is nothing on it that a
   * cropped edge could hide.
   *
   * Nothing else may. Text half off the edge is text that is simply not on the
   * disc, and a button outside the area cannot be relied on with a remote.
   */
  function mayOverflow(kind) {
    return kind === 'image';
  }

  /**
   * Where an element's edge may sit along one axis.
   *
   * Two cases, and the difference between them is the whole point. An element
   * that fits inside the limits is held entirely within them. An element LARGER
   * than the limits cannot satisfy both edges at once, so the rule turns around:
   * the limits are held inside the element, and moving it chooses which part of
   * the picture shows through the frame.
   *
   * The version this replaces applied the first case unconditionally, as
   * `min(max(lo, v), hi - size)`. With an element wider than the area, `hi -
   * size` came out *below* `lo`, so the two halves fought each other and every
   * value collapsed to the same negative number. A picture scaled up too far
   * could not be dragged at all: it sat pinned with its top-left corner off the
   * slide, and every drag snapped it straight back there.
   */
  function clampEdge(start, size, boxStart, boxEnd) {
    const value = Math.round(Number(start) || 0);
    const extent = Number(size) || 0;

    if (extent <= boxEnd - boxStart) {
      return Math.min(Math.max(boxStart, value), boxEnd - extent);
    }
    return Math.min(Math.max(boxEnd - extent, value), boxStart);
  }

  /**
   * Move and size an element so that it is where it can be seen.
   *
   * Mutates and returns the element: every caller has one in hand and wants it
   * adjusted, not replaced. This runs on every mutation rather than only when
   * drawing, so an element that cannot be placed on a television cannot be saved
   * or burned either.
   */
  function clampElement(element, width, height) {
    if (!element) return element;

    const rasterWidth = Number(width) || RASTER.width;
    const rasterHeight = Number(height) || RASTER.height;
    const boxRight = rasterWidth - SAFE_MARGIN;
    const boxBottom = element.kind === 'video' ? VIDEO_BOTTOM : rasterHeight - SAFE_MARGIN;

    let w = Math.max(MIN_WIDTH, Math.round(Number(element.width) || MIN_WIDTH));
    let h = Math.max(MIN_HEIGHT, Math.round(Number(element.height) || MIN_HEIGHT));

    if (mayOverflow(element.kind)) {
      /*
        Free to be bigger than the safe area, and free to move within it, so she
        can choose which part of the picture the frame shows. The limits are
        still respected — the picture cannot be pulled so far that a blank strip
        appears inside the safe area — but they no longer pin it in one place.
      */
      element.width = w;
      element.height = h;
      element.x = clampEdge(element.x, w, SAFE_MARGIN, boxRight);
      element.y = clampEdge(element.y, h, SAFE_MARGIN, boxBottom);
      return element;
    }

    /*
      Everything else is held wholly inside, which means the size gives way
      rather than the position.

      Resizing past the safe area used to leave an element too big to be placed
      anywhere: every position was illegal, so every position collapsed to the
      same one and the element could not be moved at all. Pulling it back to fit
      makes the blue guide a real limit she can feel, rather than a line the
      element crosses and then stops responding to.
    */
    const maxWidth = boxRight - SAFE_MARGIN;
    const maxHeight = boxBottom - SAFE_MARGIN;

    if (w > maxWidth || h > maxHeight) {
      if (SHAPE_LOCKED.has(element.kind)) {
        // A tile keeps its shape, so both sides come down together rather than
        // one being squashed to fit — which is what puts a stretched face on the
        // disc.
        const scale = Math.min(maxWidth / w, maxHeight / h);
        if (scale > 0 && Number.isFinite(scale)) {
          w = Math.max(MIN_WIDTH, Math.round(w * scale));
          h = Math.max(MIN_HEIGHT, Math.round(h * scale));
        }
      } else {
        w = Math.min(w, maxWidth);
        h = Math.min(h, maxHeight);
      }
    }

    element.width = w;
    element.height = h;
    element.x = clampEdge(element.x, w, SAFE_MARGIN, boxRight);
    element.y = clampEdge(element.y, h, SAFE_MARGIN, boxBottom);
    return element;
  }

  return {
    RASTER,
    SAFE_MARGIN,
    VIDEO_BOTTOM,
    MIN_WIDTH,
    MIN_HEIGHT,
    SHAPE_LOCKED,
    mayOverflow,
    clampEdge,
    clampElement,
  };
});
