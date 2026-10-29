/**
 * The auth background's candlestick chart — AuthShell.jsx AuthBackground,
 * as data. Purely decorative: the prices are a random walk, not a market,
 * and nothing here is shown as a number.
 *
 * The web draws on a <canvas> every frame. Here the geometry is computed in
 * these pure functions and drawn with react-native-svg; the scroll itself
 * runs on the native driver, so React only re-renders when a candle leaves
 * the left edge and a new one is added (about every 0.4 s).
 */

export interface Candle {
  open: number;
  close: number;
  high: number;
  low: number;
}

/** AuthShell.jsx: 70 candles, starting at 100. */
export const CANDLE_COUNT = 70;
export const START_PRICE = 100;
/** px per frame at 60 fps — AuthShell.jsx `speed`. */
export const SCROLL_PX_PER_FRAME = 0.4;
/** The grid pitch, both ways. */
export const GRID = 48;

/** One step of the walk — AuthShell.jsx genCandle, with the RNG injectable for tests. */
export const nextCandle = (price: number, rng: () => number = Math.random): Candle => {
  const open = price;
  const close = Math.max(20, open + (rng() - 0.48) * 6);
  const high = Math.max(open, close) + rng() * 3;
  const low = Math.min(open, close) - rng() * 3;
  return { open, close, high, low };
};

export const seedCandles = (count = CANDLE_COUNT, rng: () => number = Math.random): Candle[] => {
  const out: Candle[] = [];
  let price = START_PRICE;
  for (let i = 0; i < count; i += 1) {
    const c = nextCandle(price, rng);
    out.push(c);
    price = c.close;
  }
  return out;
};

/** Drop `n` from the left and walk `n` more onto the right. */
export const advanceCandles = (candles: readonly Candle[], n: number, rng: () => number = Math.random): Candle[] => {
  if (n <= 0) return candles.slice();
  const out = candles.slice();
  for (let i = 0; i < n; i += 1) {
    const price = out[out.length - 1]?.close ?? START_PRICE;
    out.shift();
    out.push(nextCandle(price, rng));
  }
  return out;
};

/** Candle width — AuthShell.jsx `cwOf`. */
export const candleWidth = (width: number): number => Math.max(9, width / 46);

export interface CandleShape {
  /** Centre x. */
  x: number;
  up: boolean;
  wickTop: number;
  wickBottom: number;
  bodyTop: number;
  bodyHeight: number;
}

export interface ChartGeometry {
  cw: number;
  shapes: CandleShape[];
  /** The close line, as an SVG polyline `points` string. */
  closeLine: string;
}

/**
 * Layout for a `width` × `height` box, in the box's own coordinates (x from
 * 0 at the first candle; the caller scrolls the whole layer). The vertical
 * scale fits every candle, visible or not, with 15% padding, into the middle
 * 80% of the height — as the web does, so the scale does not jump when a
 * candle scrolls in.
 *
 * Only candles that can be on screen are returned — the width plus `slack`
 * candles, because the layer may have scrolled that far before the next
 * candle is dropped. The rest exist for the scale and to scroll in.
 */
export const chartGeometry = (
  candles: readonly Candle[],
  width: number,
  height: number,
  slack = 3,
): ChartGeometry => {
  const cw = candleWidth(width);
  if (!candles.length || width <= 0 || height <= 0) return { cw, shapes: [], closeLine: '' };

  let min = Infinity;
  let max = -Infinity;
  for (const c of candles) {
    if (c.low < min) min = c.low;
    if (c.high > max) max = c.high;
  }
  const pad = (max - min) * 0.15 || 1;
  min -= pad;
  max += pad;
  const yOf = (p: number): number => height - ((p - min) / (max - min)) * height * 0.8 - height * 0.1;

  const visible = Math.min(candles.length, Math.ceil(width / cw) + Math.max(0, slack));
  const shapes: CandleShape[] = [];
  const points: string[] = [];
  for (let i = 0; i < visible; i += 1) {
    const c = candles[i];
    if (!c) break;
    const x = i * cw + cw / 2;
    const yo = yOf(c.open);
    const yc = yOf(c.close);
    shapes.push({
      x,
      up: c.close >= c.open,
      wickTop: yOf(c.high),
      wickBottom: yOf(c.low),
      bodyTop: Math.min(yo, yc),
      bodyHeight: Math.max(1.5, Math.abs(yc - yo)),
    });
    points.push(`${x.toFixed(1)},${yc.toFixed(1)}`);
  }
  return { cw, shapes, closeLine: points.join(' ') };
};

/**
 * Where the vertical grid lines sit inside a layer that has scrolled `shifted`
 * px: on absolute multiples of GRID, so the grid scrolls with the candles
 * and never jumps when one is dropped.
 */
export const gridLinesX = (shifted: number, width: number): number[] => {
  const phase = ((shifted % GRID) + GRID) % GRID;
  const out: number[] = [];
  for (let x = GRID - phase; x < width + GRID; x += GRID) out.push(x);
  return out;
};

/** The web's speed in px per millisecond (0.4 px a frame at 60 fps). */
export const SCROLL_PX_PER_MS = (SCROLL_PX_PER_FRAME * 60) / 1000;

/** How many whole candles a layer scrolled to `position` (<= 0) has left behind. */
export const shiftsAt = (position: number, cw: number): number =>
  (cw > 0 && position < 0 ? Math.floor(-position / cw) : 0);
