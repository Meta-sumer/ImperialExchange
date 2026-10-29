/**
 * Multi-chart layout templates — client/src/components/chartLayouts.js.
 *
 * Each template is a grid (cols × rows) plus each pane's placement as
 * [colStart, colSpan, rowStart, rowSpan], 1-indexed. The same cells drive
 * the live grid and the picker's preview icon.
 */

export type Cell = readonly [number, number, number, number];

export interface ChartLayout {
  id: string;
  n: number;
  cols: number;
  rows: number;
  cells: readonly Cell[];
}

const grid = (cols: number, rows: number): Cell[] => {
  const cells: Cell[] = [];
  for (let r = 1; r <= rows; r++) for (let c = 1; c <= cols; c++) cells.push([c, 1, r, 1]);
  return cells;
};

export const LAYOUTS: readonly ChartLayout[] = [
  { id: '1', n: 1, cols: 1, rows: 1, cells: [[1, 1, 1, 1]] },

  { id: '2c', n: 2, cols: 2, rows: 1, cells: grid(2, 1) },
  { id: '2r', n: 2, cols: 1, rows: 2, cells: grid(1, 2) },

  { id: '3c', n: 3, cols: 3, rows: 1, cells: grid(3, 1) },
  { id: '3r', n: 3, cols: 1, rows: 3, cells: grid(1, 3) },
  { id: '3lr', n: 3, cols: 2, rows: 2, cells: [[1, 1, 1, 2], [2, 1, 1, 1], [2, 1, 2, 1]] },
  { id: '3tb', n: 3, cols: 2, rows: 2, cells: [[1, 2, 1, 1], [1, 1, 2, 1], [2, 1, 2, 1]] },

  { id: '4g', n: 4, cols: 2, rows: 2, cells: grid(2, 2) },
  { id: '4c', n: 4, cols: 4, rows: 1, cells: grid(4, 1) },
  { id: '4r', n: 4, cols: 1, rows: 4, cells: grid(1, 4) },
  { id: '4lr', n: 4, cols: 2, rows: 3, cells: [[1, 1, 1, 3], [2, 1, 1, 1], [2, 1, 2, 1], [2, 1, 3, 1]] },
  { id: '4tb', n: 4, cols: 3, rows: 2, cells: [[1, 3, 1, 1], [1, 1, 2, 1], [2, 1, 2, 1], [3, 1, 2, 1]] },

  { id: '5tb', n: 5, cols: 6, rows: 2, cells: [[1, 2, 1, 1], [3, 2, 1, 1], [5, 2, 1, 1], [1, 3, 2, 1], [4, 3, 2, 1]] },
  { id: '5c', n: 5, cols: 5, rows: 1, cells: grid(5, 1) },
  { id: '5lr', n: 5, cols: 2, rows: 4, cells: [[1, 1, 1, 4], [2, 1, 1, 1], [2, 1, 2, 1], [2, 1, 3, 1], [2, 1, 4, 1]] },

  { id: '6g', n: 6, cols: 3, rows: 2, cells: grid(3, 2) },
  { id: '6c', n: 6, cols: 6, rows: 1, cells: grid(6, 1) },
  { id: '6r', n: 6, cols: 1, rows: 6, cells: grid(1, 6) },
  { id: '6v', n: 6, cols: 2, rows: 3, cells: grid(2, 3) },

  { id: '7lr', n: 7, cols: 3, rows: 3, cells: [[1, 1, 1, 3], [2, 1, 1, 1], [3, 1, 1, 1], [2, 1, 2, 1], [3, 1, 2, 1], [2, 1, 3, 1], [3, 1, 3, 1]] },
  { id: '7c', n: 7, cols: 7, rows: 1, cells: grid(7, 1) },

  { id: '8g', n: 8, cols: 4, rows: 2, cells: grid(4, 2) },
  { id: '8c', n: 8, cols: 8, rows: 1, cells: grid(8, 1) },
  { id: '8v', n: 8, cols: 2, rows: 4, cells: grid(2, 4) },
];

const BY_ID: Record<string, ChartLayout> = Object.fromEntries(LAYOUTS.map((l) => [l.id, l]));

export const getLayout = (id: string | null | undefined): ChartLayout => (id ? BY_ID[id] : undefined) ?? (LAYOUTS[0] as ChartLayout);

export const LAYOUT_GROUPS: readonly { n: number; items: ChartLayout[] }[] = (() => {
  const m = new Map<number, ChartLayout[]>();
  for (const l of LAYOUTS) {
    const list = m.get(l.n) ?? [];
    list.push(l);
    m.set(l.n, list);
  }
  return [...m.entries()].map(([n, items]) => ({ n, items }));
})();

export type SyncKey = 'symbol' | 'interval' | 'crosshair' | 'time' | 'dateRange';
export type SyncState = Record<SyncKey, boolean>;

export const SYNC_FIELDS: readonly { key: SyncKey; label: string; info: string }[] = [
  { key: 'symbol', label: 'Symbol', info: 'Show the same instrument in every chart' },
  { key: 'interval', label: 'Interval', info: 'Use the same timeframe in every chart' },
  { key: 'crosshair', label: 'Crosshair', info: 'Move the crosshair together across charts' },
  { key: 'time', label: 'Time', info: 'Scroll / zoom the time axis together' },
  { key: 'dateRange', label: 'Date range', info: 'Keep the same visible date range' },
];

export const DEFAULT_SYNC: SyncState = { symbol: false, interval: false, crosshair: true, time: false, dateRange: false };

/**
 * A cell as percentages of the grid box — RN has no CSS grid, so each pane
 * is absolutely positioned from its cell.
 */
export const cellFrame = (layout: ChartLayout, cell: Cell): { left: number; top: number; width: number; height: number } => {
  const [c, cs, r, rs] = cell;
  return {
    left: ((c - 1) / layout.cols) * 100,
    top: ((r - 1) / layout.rows) * 100,
    width: (cs / layout.cols) * 100,
    height: (rs / layout.rows) * 100,
  };
};
