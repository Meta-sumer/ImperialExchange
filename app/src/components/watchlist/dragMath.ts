/**
 * The arithmetic behind the long-press drag lists — DraggableList.jsx's
 * placeholder / neighbour-slide / auto-scroll, restated as pure functions.
 *
 * Every function is a worklet so the gesture and frame callbacks can call
 * it on the UI thread; each is also plain JS for the tests.
 *
 * Indices are positions in the order the list had when the drag began
 * (`from` is the lifted item's, `hover` the slot it would drop into).
 */

/** DraggableList.jsx constants, in dp / ms. */
export const FLIP_MS = 240;
export const DROP_MS = 220;
export const EDGE = 64;
export const MAX_SCROLL = 16;
/** How long a press is held before the row lifts. */
export const LONG_PRESS_MS = 300;

export const clamp = (v: number, lo: number, hi: number): number => {
  'worklet';
  return Math.max(lo, Math.min(hi, v));
};

/**
 * Where an item that started at `base` shows while `from` is dragged to
 * `hover`: the lifted one at the hover slot, the ones it passed shifted one
 * place towards where it came from, everything else still.
 */
export const visualIndex = (base: number, from: number, hover: number): number => {
  'worklet';
  if (from < 0 || hover < 0) return base;
  if (base === from) return hover;
  if (from < base && base <= hover) return base - 1;
  if (hover <= base && base < from) return base + 1;
  return base;
};

/** The final order: `ids` with `from` moved to `hover` (Watchlist.jsx moveInArray). */
export const reorderedIds = (ids: readonly string[], from: number, hover: number): string[] => {
  const c = [...ids];
  const [x] = c.splice(from, 1);
  if (x === undefined) return [...ids];
  c.splice(hover, 0, x);
  return c;
};

export const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/* ── Vertical list (uniform rows) ─────────────────────────────────────── */

/**
 * The slot nearest the lifted row's top edge. `offset` is that edge in list
 * content coordinates, measured from the first row's top.
 */
export const nearestSlot = (offset: number, stride: number, count: number): number => {
  'worklet';
  if (count <= 0 || stride <= 0) return 0;
  return clamp(Math.round(offset / stride), 0, count - 1);
};

/**
 * Auto-scroll step for the dragged extent [lo, hi] inside a viewport of
 * `size` — DraggableList.jsx autoScroll: up to MAX_SCROLL per frame, faster
 * the deeper into the EDGE band. Negative scrolls back.
 */
export const edgeScrollDelta = (lo: number, hi: number, size: number, edge = EDGE, max = MAX_SCROLL): number => {
  'worklet';
  if (size <= 0) return 0;
  if (lo < edge) return -Math.ceil(max * clamp((edge - lo) / edge, 0, 1));
  if (hi > size - edge) return Math.ceil(max * clamp((hi - (size - edge)) / edge, 0, 1));
  return 0;
};

/* ── Horizontal rail (pills of different widths) ──────────────────────── */

/**
 * Where the lifted pill rests at `hover`, in content x, given every pill's
 * x and width when the drag began and the gap between them.
 */
export const railSlotX = (hover: number, from: number, xs: readonly number[], ws: readonly number[]): number => {
  'worklet';
  const wf = ws[from] ?? 0;
  if (hover <= from) return xs[hover] ?? 0;
  return (xs[hover] ?? 0) + (ws[hover] ?? 0) - wf;
};

/** The slot whose resting x is nearest `x` (the lifted pill's current left edge). */
export const railNearest = (x: number, from: number, xs: readonly number[], ws: readonly number[]): number => {
  'worklet';
  let best = from;
  let bestD = Number.POSITIVE_INFINITY;
  for (let h = 0; h < xs.length; h++) {
    const d = Math.abs(x - railSlotX(h, from, xs, ws));
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
};

/** How far a pill that is not being dragged slides while `from` sits at `hover`. */
export const railShift = (base: number, from: number, hover: number, ws: readonly number[], gap: number): number => {
  'worklet';
  if (from < 0 || hover < 0 || base === from) return 0;
  const step = (ws[from] ?? 0) + gap;
  if (from < base && base <= hover) return -step;
  if (hover <= base && base < from) return step;
  return 0;
};
