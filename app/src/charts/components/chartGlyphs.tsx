import React from 'react';
import Svg, { Circle, Ellipse, Line, Path, Polyline, Rect } from 'react-native-svg';

import type { ChartType } from '../chartCatalog';

/**
 * The chart's small icons, redrawn from the web's inline SVGs: the chart-type
 * glyphs (PriceChart.jsx:4154-4262), the drawing rail's family icons and
 * tool buttons (ChartDrawingToolbar.jsx:269-307) and the layout preview.
 */

interface GlyphProps { color: string; size?: number }

const S = ({ size = 16, color, children, sw = 1.6 }: { size?: number; color: string; children: React.ReactNode; sw?: number }): React.JSX.Element => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
    {children}
  </Svg>
);

export function ChartTypeGlyph({ type, color, size = 16 }: GlyphProps & { type: ChartType }): React.JSX.Element {
  switch (type) {
    case 'bars':
      return <S size={size} color={color}><Line x1="7" y1="4" x2="7" y2="18" /><Line x1="4" y1="8" x2="7" y2="8" /><Line x1="7" y1="14" x2="10" y2="14" /><Line x1="16" y1="6" x2="16" y2="20" /><Line x1="13" y1="10" x2="16" y2="10" /><Line x1="16" y1="16" x2="19" y2="16" /></S>;
    case 'hollowCandles':
      return <S size={size} color={color}><Rect x="5" y="7" width="4" height="10" /><Line x1="7" y1="4" x2="7" y2="7" /><Line x1="7" y1="17" x2="7" y2="20" /><Rect x="15" y="5" width="4" height="9" fill={color} /><Line x1="17" y1="3" x2="17" y2="5" /><Line x1="17" y1="14" x2="17" y2="18" /></S>;
    case 'line':
      return <S size={size} color={color}><Polyline points="3 17 9 11 13 15 21 7" /></S>;
    case 'lineMarkers':
      return <S size={size} color={color}><Polyline points="3 17 9 11 13 15 21 7" /><Circle cx="9" cy="11" r="1.6" fill={color} /><Circle cx="13" cy="15" r="1.6" fill={color} /><Circle cx="21" cy="7" r="1.6" fill={color} /></S>;
    case 'stepLine':
      return <S size={size} color={color}><Polyline points="3 17 8 17 8 11 13 11 13 14 17 14 17 7 21 7" /></S>;
    case 'area':
      return <S size={size} color={color}><Path d="M3 17l6-6 4 4 8-8v13H3z" fill={color} fillOpacity={0.2} /><Polyline points="3 17 9 11 13 15 21 7" /></S>;
    case 'baseline':
      return <S size={size} color={color}><Line x1="3" y1="12" x2="21" y2="12" strokeDasharray="2 2" /><Polyline points="3 16 8 9 13 14 17 6 21 10" /></S>;
    case 'histogram':
      return <S size={size} color={color}><Rect x="4" y="12" width="3" height="8" /><Rect x="10.5" y="7" width="3" height="13" /><Rect x="17" y="10" width="3" height="10" /></S>;
    case 'heikinAshi':
      return <S size={size} color={color}><Rect x="5" y="8" width="4" height="8" fill={color} fillOpacity={0.35} /><Line x1="7" y1="5" x2="7" y2="8" /><Line x1="7" y1="16" x2="7" y2="19" /><Rect x="15" y="6" width="4" height="8" fill={color} fillOpacity={0.35} /><Line x1="17" y1="3" x2="17" y2="6" /><Line x1="17" y1="14" x2="17" y2="18" /></S>;
    case 'candles':
    default:
      return <S size={size} color={color}><Rect x="5" y="7" width="4" height="10" fill={color} /><Line x1="7" y1="4" x2="7" y2="7" /><Line x1="7" y1="17" x2="7" y2="20" /><Rect x="15" y="5" width="4" height="9" /><Line x1="17" y1="3" x2="17" y2="5" /><Line x1="17" y1="14" x2="17" y2="18" /></S>;
  }
}

/** One glyph per geometric family (ChartDrawingToolbar.jsx FamilyIcon). */
export function FamilyIcon({ family, color, size = 16 }: GlyphProps & { family: string }): React.JSX.Element {
  switch (family) {
    case 'trend': return <S size={size} color={color}><Circle cx="5" cy="19" r="1.5" /><Circle cx="19" cy="5" r="1.5" /><Line x1="6" y1="18" x2="18" y2="6" /></S>;
    case 'hline': return <S size={size} color={color}><Line x1="3" y1="12" x2="21" y2="12" /><Circle cx="5" cy="12" r="1.5" /><Circle cx="19" cy="12" r="1.5" /></S>;
    case 'hray': return <S size={size} color={color}><Line x1="3" y1="12" x2="21" y2="12" /><Circle cx="5" cy="12" r="1.5" /></S>;
    case 'vline': return <S size={size} color={color}><Line x1="12" y1="3" x2="12" y2="21" /><Circle cx="12" cy="5" r="1.5" /></S>;
    case 'cross': return <S size={size} color={color}><Line x1="12" y1="3" x2="12" y2="21" /><Line x1="3" y1="12" x2="21" y2="12" /></S>;
    case 'channel': return <S size={size} color={color}><Line x1="4" y1="18" x2="20" y2="8" /><Line x1="4" y1="14" x2="20" y2="4" /></S>;
    case 'regression': return <S size={size} color={color}><Line x1="4" y1="18" x2="20" y2="6" /><Line x1="4" y1="20" x2="20" y2="8" strokeDasharray="2 2" /><Line x1="4" y1="16" x2="20" y2="4" strokeDasharray="2 2" /></S>;
    case 'pitchfork': return <S size={size} color={color}><Circle cx="4" cy="6" r="1.5" /><Circle cx="20" cy="6" r="1.5" /><Circle cx="12" cy="18" r="1.5" /><Path d="M4 6L12 18L20 6" /></S>;
    case 'fib': return <S size={size} color={color}><Line x1="3" y1="5" x2="21" y2="5" /><Line x1="3" y1="9" x2="21" y2="9" strokeDasharray="2 2" /><Line x1="3" y1="13" x2="21" y2="13" /><Line x1="3" y1="17" x2="21" y2="17" strokeDasharray="2 2" /></S>;
    case 'fibchannel': return <S size={size} color={color}><Line x1="4" y1="18" x2="20" y2="8" /><Line x1="4" y1="14" x2="20" y2="4" strokeDasharray="2 2" /></S>;
    case 'fibtime': return <S size={size} color={color}><Line x1="6" y1="4" x2="6" y2="20" /><Line x1="11" y1="4" x2="11" y2="20" /><Line x1="18" y1="4" x2="18" y2="20" /></S>;
    case 'fan': return <S size={size} color={color}><Path d="M4 20L20 4M4 20L20 10M4 20L20 16" /></S>;
    case 'circles': return <S size={size} color={color}><Circle cx="12" cy="12" r="9" /><Circle cx="12" cy="12" r="5" /></S>;
    case 'spiral': return <S size={size} color={color}><Path d="M12 12a3 3 0 1 1 3-3 5 5 0 1 1-5 5 7 7 0 1 1 7-7" /></S>;
    case 'arcs': return <S size={size} color={color}><Path d="M3 20a9 9 0 0 1 18 0" /><Path d="M7 20a5 5 0 0 1 10 0" /></S>;
    case 'rectgrid': return <S size={size} color={color}><Rect x="4" y="5" width="16" height="14" /><Line x1="4" y1="12" x2="20" y2="12" /><Line x1="12" y1="5" x2="12" y2="19" /></S>;
    case 'gannsquare': return <S size={size} color={color}><Rect x="4" y="5" width="16" height="14" /><Line x1="4" y1="19" x2="20" y2="5" /><Line x1="4" y1="5" x2="20" y2="19" /></S>;
    case 'rect': return <S size={size} color={color}><Rect x="4" y="6" width="16" height="12" rx="1" /></S>;
    case 'rotrect': return <S size={size} color={color}><Path d="M3 13l8-8 10 6-8 8z" /></S>;
    case 'ellipse': return <S size={size} color={color}><Ellipse cx="12" cy="12" rx="9" ry="6" /></S>;
    case 'poly':
    case 'pattern': return <S size={size} color={color}><Path d="M3 17l5-7 4 4 5-8 4 5" /></S>;
    case 'sine': return <S size={size} color={color}><Path d="M3 12c3-8 6 8 9 0s6-8 9 0" /></S>;
    case 'position': return <S size={size} color={color}><Line x1="4" y1="6" x2="20" y2="6" /><Line x1="4" y1="12" x2="20" y2="12" strokeDasharray="2 2" /><Line x1="4" y1="18" x2="20" y2="18" /></S>;
    case 'volprofile': return <S size={size} color={color}><Line x1="4" y1="4" x2="4" y2="20" /><Line x1="4" y1="7" x2="14" y2="7" /><Line x1="4" y1="12" x2="18" y2="12" /><Line x1="4" y1="17" x2="10" y2="17" /></S>;
    case 'measure': return <S size={size} color={color}><Path d="M21 6l-7-3-11 11 3 7z" /><Path d="M8 9l-2 2M11 12l-2 2M14 6l-2 2" /></S>;
    case 'brush': return <S size={size} color={color}><Path d="M9 11l-6 6a2 2 0 0 0 2.83 2.83l6-6" /><Path d="M16 4l4 4-9 9-4-4z" /></S>;
    case 'marker': return <S size={size} color={color}><Path d="M12 3l3 7h-6z" /><Line x1="12" y1="10" x2="12" y2="21" /></S>;
    case 'text': return <S size={size} color={color}><Path d="M4 7V5h16v2" /><Line x1="12" y1="5" x2="12" y2="20" /><Line x1="8" y1="20" x2="16" y2="20" /></S>;
    case 'emoji': return <S size={size} color={color}><Circle cx="12" cy="12" r="9" /><Path d="M8 14a4 4 0 0 0 8 0" /><Line x1="9" y1="9" x2="9.01" y2="9" /><Line x1="15" y1="9" x2="15.01" y2="9" /></S>;
    case 'cursor':
    case 'crosshair': return <S size={size} color={color}><Line x1="12" y1="2" x2="12" y2="6" /><Line x1="12" y1="18" x2="12" y2="22" /><Line x1="2" y1="12" x2="6" y2="12" /><Line x1="18" y1="12" x2="22" y2="12" /><Circle cx="12" cy="12" r="3" /></S>;
    default: return <S size={size} color={color}><Line x1="5" y1="19" x2="19" y2="5" /></S>;
  }
}

export type ToolIconName =
  | 'crosshair' | 'dot' | 'arrowcur' | 'eraser' | 'magnet' | 'ruler' | 'zoomIn' | 'zoomOut' | 'zoomReset'
  | 'undo' | 'redo' | 'locked' | 'unlocked' | 'eye' | 'eyeOff' | 'trash' | 'chevronLeft' | 'chevronRight'
  | 'indicators' | 'clock' | 'expand' | 'collapse' | 'gear' | 'pencil' | 'check' | 'layers';

export function ToolIcon({ name, color, size = 16 }: GlyphProps & { name: ToolIconName }): React.JSX.Element {
  switch (name) {
    case 'crosshair': return <FamilyIcon family="crosshair" color={color} size={size} />;
    case 'dot': return <S size={size} color={color}><Circle cx="12" cy="12" r="2.5" fill={color} /></S>;
    case 'arrowcur': return <S size={size} color={color}><Path d="M5 3l7 16 2-7 7-2z" /></S>;
    case 'eraser': return <S size={size} color={color}><Path d="M16 3l5 5L10 19H5l-2-2z" /><Path d="M9 11l4 4" /></S>;
    case 'magnet': return <S size={size} color={color}><Path d="M6 4h4v8a2 2 0 1 0 4 0V4h4v8a6 6 0 1 1-12 0z" /><Line x1="6" y1="8" x2="10" y2="8" /><Line x1="14" y1="8" x2="18" y2="8" /></S>;
    case 'ruler': return <S size={size} color={color}><Path d="M3 8l5-5 13 13-5 5z" /><Path d="M8 5l2 2M11 8l2 2M14 11l2 2" /></S>;
    case 'zoomIn': return <S size={size} color={color}><Circle cx="11" cy="11" r="7" /><Line x1="21" y1="21" x2="16.65" y2="16.65" /><Line x1="11" y1="8" x2="11" y2="14" /><Line x1="8" y1="11" x2="14" y2="11" /></S>;
    case 'zoomOut': return <S size={size} color={color}><Circle cx="11" cy="11" r="7" /><Line x1="21" y1="21" x2="16.65" y2="16.65" /><Line x1="8" y1="11" x2="14" y2="11" /></S>;
    case 'zoomReset': return <S size={size} color={color}><Polyline points="15 3 21 3 21 9" /><Polyline points="9 21 3 21 3 15" /><Line x1="21" y1="3" x2="14" y2="10" /><Line x1="3" y1="21" x2="10" y2="14" /></S>;
    case 'undo': return <S size={size} color={color}><Path d="M9 14L4 9l5-5" /><Path d="M4 9h11a5 5 0 0 1 0 10h-1" /></S>;
    case 'redo': return <S size={size} color={color}><Path d="M15 14l5-5-5-5" /><Path d="M20 9H9a5 5 0 0 0 0 10h1" /></S>;
    case 'locked': return <S size={size} color={color}><Rect x="4" y="11" width="16" height="10" rx="2" /><Path d="M8 11V7a4 4 0 0 1 8 0v4" /></S>;
    case 'unlocked': return <S size={size} color={color}><Rect x="4" y="11" width="16" height="10" rx="2" /><Path d="M8 11V7a4 4 0 0 1 7.46-2" /></S>;
    case 'eye': return <S size={size} color={color}><Path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z" /><Circle cx="12" cy="12" r="3" /></S>;
    case 'eyeOff': return <S size={size} color={color}><Path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-10-7-10-7a17.61 17.61 0 0 1 3.94-5" /><Path d="M9.9 4.24A10 10 0 0 1 12 4c7 0 10 7 10 7a17.6 17.6 0 0 1-2.13 3.36" /><Line x1="1" y1="1" x2="23" y2="23" /></S>;
    case 'trash': return <S size={size} color={color}><Polyline points="3 6 5 6 21 6" /><Path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><Path d="M10 11v6M14 11v6" /><Path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /></S>;
    case 'chevronLeft': return <S size={size} color={color} sw={2.6}><Polyline points="15 18 9 12 15 6" /></S>;
    case 'chevronRight': return <S size={size} color={color} sw={2.6}><Polyline points="9 18 15 12 9 6" /></S>;
    case 'indicators': return <S size={size} color={color} sw={2}><Path d="M3 3v18h18" /><Path d="M7 15l4-4 4 4 6-7" /></S>;
    case 'clock': return <S size={size} color={color} sw={2}><Circle cx="12" cy="12" r="10" /><Path d="M12 6v6l4 2" /></S>;
    case 'expand': return <S size={size} color={color} sw={2}><Path d="M3 3h6v2H5v4H3V3z" /><Path d="M21 3v6h-2V5h-4V3h6z" /><Path d="M3 21v-6h2v4h4v2H3z" /><Path d="M21 21h-6v-2h4v-4h2v6z" /></S>;
    case 'collapse': return <S size={size} color={color} sw={2}><Path d="M8 3v3a2 2 0 0 1-2 2H3" /><Path d="M21 8h-3a2 2 0 0 1-2-2V3" /><Path d="M3 16h3a2 2 0 0 1 2 2v3" /><Path d="M16 21v-3a2 2 0 0 1 2-2h3" /></S>;
    case 'gear': return <S size={size} color={color} sw={2}><Circle cx="12" cy="12" r="3" /><Path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></S>;
    case 'pencil': return <S size={size} color={color} sw={2}><Path d="M12 20h9" /><Path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></S>;
    case 'check': return <S size={size} color={color} sw={3}><Polyline points="20 6 9 17 4 12" /></S>;
    case 'layers':
    default: return <S size={size} color={color} sw={2}><Path d="M12 2l9 5-9 5-9-5 9-5z" /><Path d="M3 12l9 5 9-5" /><Path d="M3 17l9 5 9-5" /></S>;
  }
}
