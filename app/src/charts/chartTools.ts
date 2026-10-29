/**
 * The drawing-tool catalogue — client/src/components/chartTools.js, plus the
 * rail labels / emoji palette of ChartDrawingToolbar.jsx and the style
 * choices of DrawingProperties.jsx.
 *
 * Every tool maps to a geometric FAMILY the engine (src/charts/runtime/
 * drawings.js) renders, hit-tests and resizes, and the number of points it
 * collects: a number → fixed N-tap tool; 'free' → tap to add, double-tap or
 * Finish to end.
 */

export type ToolPoints = number | 'free';

export interface ToolItem {
  tool: string;
  label: string;
  family: string;
  pts: ToolPoints;
  variant?: string;
  glyph?: string;
  hotkey?: string;
}

export interface ToolGroup {
  name: string;
  items: readonly ToolItem[];
}

export const GROUPS: readonly ToolGroup[] = [
  {
    name: 'Lines',
    items: [
      { tool: 'trendline', label: 'Trend Line', family: 'trend', pts: 2, hotkey: 'Alt+T' },
      { tool: 'ray', label: 'Ray', family: 'trend', pts: 2, variant: 'rayR' },
      { tool: 'infoline', label: 'Info Line', family: 'trend', pts: 2, variant: 'info' },
      { tool: 'extended', label: 'Extended Line', family: 'trend', pts: 2, variant: 'extend' },
      { tool: 'trendangle', label: 'Trend Angle', family: 'trend', pts: 2, variant: 'angle' },
      { tool: 'hline', label: 'Horizontal Line', family: 'hline', pts: 1, hotkey: 'Alt+H' },
      { tool: 'hray', label: 'Horizontal Ray', family: 'hray', pts: 1, hotkey: 'Alt+J' },
      { tool: 'vline', label: 'Vertical Line', family: 'vline', pts: 1, hotkey: 'Alt+V' },
      { tool: 'crossline', label: 'Cross Line', family: 'cross', pts: 1, hotkey: 'Alt+C' },
    ],
  },
  {
    name: 'Channels',
    items: [
      { tool: 'parallel', label: 'Parallel Channel', family: 'channel', pts: 3 },
      { tool: 'regression', label: 'Regression Trend', family: 'regression', pts: 2 },
      { tool: 'flatchannel', label: 'Flat Top/Bottom', family: 'channel', pts: 3, variant: 'flat' },
      { tool: 'disjoint', label: 'Disjoint Channel', family: 'channel', pts: 3, variant: 'disjoint' },
    ],
  },
  {
    name: 'Pitchforks',
    items: [
      { tool: 'pitchfork', label: 'Pitchfork', family: 'pitchfork', pts: 3 },
      { tool: 'schiff', label: 'Schiff Pitchfork', family: 'pitchfork', pts: 3, variant: 'schiff' },
      { tool: 'modschiff', label: 'Modified Schiff', family: 'pitchfork', pts: 3, variant: 'modschiff' },
      { tool: 'insidepitchfork', label: 'Inside Pitchfork', family: 'pitchfork', pts: 3, variant: 'inside' },
    ],
  },
  {
    name: 'Fibonacci',
    items: [
      { tool: 'fibretr', label: 'Fib Retracement', family: 'fib', pts: 2, hotkey: 'Alt+F' },
      { tool: 'fibext', label: 'Trend-Based Fib Extension', family: 'fib', pts: 3, variant: 'ext' },
      { tool: 'fibchannel', label: 'Fib Channel', family: 'fibchannel', pts: 3 },
      { tool: 'fibtimezone', label: 'Fib Time Zone', family: 'fibtime', pts: 2 },
      { tool: 'fibfan', label: 'Fib Speed Resistance Fan', family: 'fan', pts: 2, variant: 'fib' },
      { tool: 'fibtimetrend', label: 'Trend-Based Fib Time', family: 'fibtime', pts: 2, variant: 'trend' },
      { tool: 'fibcircles', label: 'Fib Circles', family: 'circles', pts: 2, variant: 'fib' },
      { tool: 'fibspiral', label: 'Fib Spiral', family: 'spiral', pts: 2 },
      { tool: 'fibarcs', label: 'Fib Speed Resistance Arcs', family: 'arcs', pts: 2 },
      { tool: 'fibwedge', label: 'Fib Wedge', family: 'arcs', pts: 2, variant: 'wedge' },
      { tool: 'pitchfan', label: 'Pitchfan', family: 'fan', pts: 2, variant: 'gann' },
    ],
  },
  {
    name: 'Gann',
    items: [
      { tool: 'gannbox', label: 'Gann Box', family: 'rectgrid', pts: 2 },
      { tool: 'gannsquarefixed', label: 'Gann Square Fixed', family: 'gannsquare', pts: 2 },
      { tool: 'gannsquare', label: 'Gann Square', family: 'gannsquare', pts: 2 },
      { tool: 'gannfan', label: 'Gann Fan', family: 'fan', pts: 2, variant: 'gann' },
    ],
  },
  {
    name: 'Patterns',
    items: [
      { tool: 'xabcd', label: 'XABCD Pattern', family: 'poly', pts: 5, variant: 'XABCD' },
      { tool: 'cypher', label: 'Cypher Pattern', family: 'poly', pts: 5, variant: 'XABCD' },
      { tool: 'headshoulders', label: 'Head and Shoulders', family: 'poly', pts: 7, variant: 'HS' },
      { tool: 'abcd', label: 'ABCD Pattern', family: 'poly', pts: 4, variant: 'ABCD' },
      { tool: 'trianglepattern', label: 'Triangle Pattern', family: 'poly', pts: 4, variant: 'closed' },
      { tool: 'threedrives', label: 'Three Drives Pattern', family: 'poly', pts: 7, variant: '3D' },
    ],
  },
  {
    name: 'Elliott Waves',
    items: [
      { tool: 'elliott12345', label: 'Elliott Impulse Wave (12345)', family: 'poly', pts: 6, variant: '12345' },
      { tool: 'elliottabc', label: 'Elliott Correction Wave (ABC)', family: 'poly', pts: 4, variant: 'ABC' },
      { tool: 'elliottabcde', label: 'Elliott Triangle Wave (ABCDE)', family: 'poly', pts: 6, variant: 'ABCDE' },
      { tool: 'elliottwxy', label: 'Elliott Double Combo (WXY)', family: 'poly', pts: 4, variant: 'WXY' },
      { tool: 'elliottwxyxz', label: 'Elliott Triple Combo (WXYXZ)', family: 'poly', pts: 6, variant: 'WXYXZ' },
    ],
  },
  {
    name: 'Cycles',
    items: [
      { tool: 'cyclic', label: 'Cyclic Lines', family: 'fibtime', pts: 2, variant: 'cycle' },
      { tool: 'timecycles', label: 'Time Cycles', family: 'arcs', pts: 2, variant: 'time' },
      { tool: 'sine', label: 'Sine Line', family: 'sine', pts: 2 },
    ],
  },
  {
    name: 'Projection',
    items: [
      { tool: 'longpos', label: 'Long Position', family: 'position', pts: 2, variant: 'long' },
      { tool: 'shortpos', label: 'Short Position', family: 'position', pts: 2, variant: 'short' },
      { tool: 'forecast', label: 'Forecast', family: 'trend', pts: 2, variant: 'arrowR' },
      { tool: 'barspattern', label: 'Bars Pattern', family: 'rect', pts: 2 },
      { tool: 'ghostfeed', label: 'Ghost Feed', family: 'rect', pts: 2 },
      { tool: 'projection', label: 'Projection', family: 'poly', pts: 3, variant: 'closed' },
    ],
  },
  {
    name: 'Volume-based',
    items: [
      { tool: 'anchoredvwap', label: 'Anchored VWAP', family: 'vwap', pts: 1 },
      { tool: 'fixedrangevp', label: 'Fixed Range Volume Profile', family: 'volprofile', pts: 2 },
    ],
  },
  {
    name: 'Measurer',
    items: [
      { tool: 'pricerange', label: 'Price Range', family: 'measure', pts: 2, variant: 'price' },
      { tool: 'daterange', label: 'Date Range', family: 'measure', pts: 2, variant: 'date' },
      { tool: 'datepricerange', label: 'Date and Price Range', family: 'measure', pts: 2, variant: 'both' },
    ],
  },
  {
    name: 'Brushes',
    items: [
      { tool: 'brush', label: 'Brush', family: 'brush', pts: 'free' },
      { tool: 'highlighter', label: 'Highlighter', family: 'brush', pts: 'free', variant: 'hl' },
    ],
  },
  {
    name: 'Arrows',
    items: [
      { tool: 'arrowmarker', label: 'Arrow Marker', family: 'trend', pts: 2, variant: 'arrowR' },
      { tool: 'arrow', label: 'Arrow', family: 'trend', pts: 2, variant: 'arrowR' },
      { tool: 'arrowup', label: 'Arrow Mark Up', family: 'marker', pts: 1, glyph: '⬆' },
      { tool: 'arrowdown', label: 'Arrow Mark Down', family: 'marker', pts: 1, glyph: '⬇' },
      { tool: 'arrowleft', label: 'Arrow Mark Left', family: 'marker', pts: 1, glyph: '⬅' },
      { tool: 'arrowright', label: 'Arrow Mark Right', family: 'marker', pts: 1, glyph: '➡' },
    ],
  },
  {
    name: 'Shapes',
    items: [
      { tool: 'rect', label: 'Rectangle', family: 'rect', pts: 2, hotkey: 'Alt+Shift+R' },
      { tool: 'rotrect', label: 'Rotated Rectangle', family: 'rotrect', pts: 3 },
      { tool: 'path', label: 'Path', family: 'poly', pts: 'free', variant: 'arrow' },
      { tool: 'circle', label: 'Circle', family: 'ellipse', pts: 2, variant: 'circle' },
      { tool: 'ellipse', label: 'Ellipse', family: 'ellipse', pts: 2 },
      { tool: 'polyline', label: 'Polyline', family: 'poly', pts: 'free' },
      { tool: 'triangle', label: 'Triangle', family: 'poly', pts: 3, variant: 'closed' },
    ],
  },
  {
    name: 'Text & Notes',
    items: [
      { tool: 'text', label: 'Text', family: 'text', pts: 1 },
      { tool: 'anchoredtext', label: 'Anchored Text', family: 'text', pts: 1 },
      { tool: 'note', label: 'Note', family: 'marker', pts: 1, variant: 'note', glyph: '🗒' },
      { tool: 'pricenote', label: 'Price Note', family: 'marker', pts: 1, variant: 'note', glyph: '💲' },
      { tool: 'pin', label: 'Pin', family: 'marker', pts: 1, glyph: '📍' },
      { tool: 'table', label: 'Table', family: 'marker', pts: 1, variant: 'note', glyph: '▦' },
      { tool: 'callout', label: 'Callout', family: 'marker', pts: 1, variant: 'callout', glyph: '💬' },
      { tool: 'comment', label: 'Comment', family: 'marker', pts: 1, variant: 'callout', glyph: '💭' },
      { tool: 'pricelabel', label: 'Price Label', family: 'marker', pts: 1, variant: 'note', glyph: '🏷' },
      { tool: 'signpost', label: 'Signpost', family: 'marker', pts: 1, glyph: '⛳' },
      { tool: 'flagmark', label: 'Flag Mark', family: 'marker', pts: 1, glyph: '🚩' },
    ],
  },
];

export const CURSORS: readonly { tool: string; label: string }[] = [
  { tool: 'crosshair', label: 'Cross' },
  { tool: 'dot', label: 'Dot' },
  { tool: 'arrowcur', label: 'Arrow' },
  { tool: 'eraser', label: 'Eraser' },
];

export interface RailButton {
  id: string;
  repIcon: string;
  groups?: readonly string[];
  cursors?: boolean;
  emoji?: boolean;
}

export const RAIL: readonly RailButton[] = [
  { id: 'cursor', repIcon: 'cursor', cursors: true },
  { id: 'lines', repIcon: 'trend', groups: ['Lines', 'Channels', 'Pitchforks'] },
  { id: 'fib', repIcon: 'fib', groups: ['Fibonacci', 'Gann'] },
  { id: 'patterns', repIcon: 'pattern', groups: ['Patterns', 'Elliott Waves', 'Cycles'] },
  { id: 'projection', repIcon: 'position', groups: ['Projection', 'Volume-based', 'Measurer'] },
  { id: 'brush', repIcon: 'brush', groups: ['Brushes', 'Arrows', 'Shapes'] },
  { id: 'text', repIcon: 'text', groups: ['Text & Notes'] },
  { id: 'emoji', repIcon: 'emoji', emoji: true },
];

export const RAIL_LABEL: Record<string, string> = {
  cursor: 'Cursor',
  lines: 'Lines, Channels & Pitchforks',
  fib: 'Fibonacci & Gann',
  patterns: 'Patterns, Elliott & Cycles',
  projection: 'Projection, Volume & Measure',
  brush: 'Brushes, Arrows & Shapes',
  text: 'Text & Notes',
  emoji: 'Stickers',
};

export const EMOJI_PALETTE: readonly string[] = ['🚀', '📈', '📉', '🐂', '🐻', '💎', '🔥', '⚡', '💰', '⭐', '👀', '⚠️', '✅', '❌', '🎯', '🛑', '😀', '😎', '😱', '🤔', '👍', '👎', '💡', '🏁'];

export type ToolMeta = ToolItem & { group: string };

export const TOOL_META: Record<string, ToolMeta> = (() => {
  const m: Record<string, ToolMeta> = {};
  for (const g of GROUPS) for (const it of g.items) m[it.tool] = { ...it, group: g.name };
  m.emoji = { tool: 'emoji', label: 'Emoji', family: 'emoji', pts: 1, group: 'Emoji' };
  return m;
})();

export const toolMeta = (tool: string): ToolMeta | null => TOOL_META[tool] ?? null;
export const toolLabel = (tool: string): string => TOOL_META[tool]?.label ?? tool;

/** The engine's view of a tool: what `setTool` sends. */
export const engineMeta = (tool: string): Pick<ToolItem, 'family' | 'pts' | 'variant' | 'glyph'> | null => {
  const m = TOOL_META[tool];
  if (!m) return null;
  return { family: m.family, pts: m.pts, ...(m.variant ? { variant: m.variant } : {}), ...(m.glyph ? { glyph: m.glyph } : {}) };
};

/** tool → the rail button that owns it (ChartDrawingToolbar.jsx TOOL_RAIL). */
export const TOOL_RAIL: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const r of RAIL) {
    for (const gName of r.groups ?? []) {
      GROUPS.find((x) => x.name === gName)?.items.forEach((it) => { m[it.tool] = r.id; });
    }
  }
  return m;
})();

export const SELECT_TOOLS: ReadonlySet<string> = new Set(['crosshair', 'magnet', 'dot', 'arrowcur']);
export const CURSOR_TOOLS: ReadonlySet<string> = new Set(['crosshair', 'dot', 'arrowcur', 'eraser']);

export const TEXT_TOOLS: ReadonlySet<string> = new Set(['text', 'anchoredtext', 'note', 'pricenote', 'callout', 'comment', 'pricelabel', 'signpost', 'flagmark', 'table']);
export const HAS_WIDTH: ReadonlySet<string> = new Set(['trend', 'hline', 'hray', 'vline', 'cross', 'rect', 'rectgrid', 'gannsquare', 'rotrect', 'ellipse', 'channel', 'regression', 'fib', 'fibchannel', 'fibtime', 'fan', 'circles', 'spiral', 'arcs', 'pitchfork', 'poly', 'sine', 'vwap', 'measure', 'position', 'brush', 'volprofile']);
export const HAS_STYLE: ReadonlySet<string> = new Set(['trend', 'hline', 'hray', 'vline', 'cross', 'rect', 'rectgrid', 'gannsquare', 'rotrect', 'ellipse', 'channel', 'regression', 'poly', 'sine', 'brush']);
export const HAS_FILL: ReadonlySet<string> = new Set(['rect', 'rectgrid', 'gannsquare', 'rotrect', 'ellipse', 'channel', 'poly', 'position', 'fib', 'fibchannel', 'volprofile']);

/** DrawingProperties.jsx choices. */
export const DRAWING_PALETTE: readonly string[] = ['#2962FF', '#3B82F6', '#0EA5E9', '#10B981', '#22C55E', '#F59E0B', '#EF4444', '#EC4899', '#8B5CF6', '#7C3AED', '#64748B', '#111827'];
export const DRAWING_WIDTHS: readonly number[] = [1, 1.5, 2, 3, 4];
export const DRAWING_STYLES: readonly { k: 'solid' | 'dashed' | 'dotted'; label: string }[] = [
  { k: 'solid', label: '──' },
  { k: 'dashed', label: '- -' },
  { k: 'dotted', label: '··' },
];
export const DRAWING_EMOJIS: readonly string[] = ['🚀', '📈', '📉', '🐂', '🐻', '💎', '🔥', '⚡', '💰', '⭐', '👀', '⚠️'];

/** A drawing as the engine stores it (useChartDrawings.js normalize). */
export interface ChartDrawing {
  id: string;
  kind: string;
  family?: string;
  variant?: string;
  glyph?: string;
  pts: { logical: number | null; time: number | null; price: number }[];
  color?: string;
  width?: number;
  style?: 'solid' | 'dashed' | 'dotted';
  fill?: boolean;
  locked?: boolean;
  text?: string;
  emoji?: string;
  fontSize?: number;
}

/** Is this a text-bearing drawing (the properties' Text field)? */
export const isTextDrawing = (d: Pick<ChartDrawing, 'family' | 'variant' | 'kind'>): boolean =>
  d.family === 'text'
  || (d.family === 'marker' && (d.variant === 'note' || d.variant === 'callout'))
  || TEXT_TOOLS.has(d.kind);

/** The default font size the size slider starts from (DrawingProperties.jsx). */
export const defaultFontSize = (family: string | undefined): number =>
  family === 'emoji' ? 20 : family === 'marker' ? 18 : 13;

/** Rail → the groups its flyout lists, searched (GroupFlyout). */
export const railGroups = (railId: string, query: string): { name: string; items: ToolItem[] }[] => {
  const r = RAIL.find((x) => x.id === railId);
  const q = query.trim().toLowerCase();
  return (r?.groups ?? [])
    .map((gn) => GROUPS.find((g) => g.name === gn))
    .filter((g): g is ToolGroup => !!g)
    .map((g) => ({ name: g.name, items: g.items.filter((it) => !q || it.label.toLowerCase().includes(q)) }))
    .filter((g) => g.items.length > 0);
};

/** The rail's first tool per button — what it picks before the user chose one. */
export const initialRailLast = (): Record<string, string> => {
  const m: Record<string, string> = {};
  for (const r of RAIL) {
    const first = r.groups?.[0];
    const g = first ? GROUPS.find((x) => x.name === first) : undefined;
    const tool = g?.items[0]?.tool;
    if (tool) m[r.id] = tool;
  }
  return m;
};
