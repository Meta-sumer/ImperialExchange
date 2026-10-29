import React from 'react';
import Svg, { Circle, Line, Path, Polyline, Rect } from 'react-native-svg';

import { useTheme } from '@/theme';

/**
 * Profile.jsx's own icon set (its ICONS block), drawn with the same shapes.
 * The page defines these locally rather than using the chrome's icons, and
 * most of them (shield, monitor, gift, upload, folder, file, warning) have
 * no counterpart in the kit's Icon, so they stay local here too.
 */
export type ProfileIconName =
  | 'user'
  | 'shieldCheck'
  | 'lock'
  | 'monitor'
  | 'check'
  | 'warn'
  | 'mail'
  | 'gift'
  | 'upload'
  | 'folder'
  | 'file'
  | 'idCard'
  | 'copy'
  | 'camera'
  | 'image';

export function ProfileIcon({
  name,
  size = 16,
  color,
  strokeWidth = 2,
}: {
  name: ProfileIconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}): React.JSX.Element {
  const t = useTheme();
  const c = color ?? t.colors.textSecondary;
  const p: P = { stroke: c, strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {shapes(name, p)}
    </Svg>
  );
}

type P = { stroke: string; strokeWidth: number; strokeLinecap: 'round'; strokeLinejoin: 'round'; fill: 'none' };

const shapes = (name: ProfileIconName, p: P): React.ReactNode => {
  switch (name) {
    case 'user':
      return (<><Path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" {...p} /><Circle cx="12" cy="7" r="4" {...p} /></>);
    case 'shieldCheck':
      return (<><Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" {...p} /><Path d="M9 12l2 2 4-4" {...p} /></>);
    case 'lock':
      return (<><Rect x="3" y="11" width="18" height="11" rx="2" {...p} /><Path d="M7 11V7a5 5 0 0 1 10 0v4" {...p} /></>);
    case 'monitor':
      return (
        <>
          <Rect x="2" y="3" width="20" height="14" rx="2" {...p} />
          <Line x1="8" y1="21" x2="16" y2="21" {...p} />
          <Line x1="12" y1="17" x2="12" y2="21" {...p} />
        </>
      );
    case 'check':
      return <Polyline points="20 6 9 17 4 12" {...p} />;
    case 'warn':
      return (
        <>
          <Path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" {...p} />
          <Line x1="12" y1="9" x2="12" y2="13" {...p} />
          <Line x1="12" y1="17" x2="12.01" y2="17" {...p} />
        </>
      );
    case 'mail':
      return (<><Rect x="2" y="4" width="20" height="16" rx="2" {...p} /><Polyline points="22,6 12,13 2,6" {...p} /></>);
    case 'gift':
      return (
        <>
          <Polyline points="20 12 20 22 4 22 4 12" {...p} />
          <Rect x="2" y="7" width="20" height="5" {...p} />
          <Line x1="12" y1="22" x2="12" y2="7" {...p} />
          <Path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" {...p} />
          <Path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" {...p} />
        </>
      );
    case 'upload':
      return (
        <>
          <Path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" {...p} />
          <Polyline points="17 8 12 3 7 8" {...p} />
          <Line x1="12" y1="3" x2="12" y2="15" {...p} />
        </>
      );
    case 'folder':
      return <Path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" {...p} />;
    case 'file':
      return (<><Path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" {...p} /><Polyline points="14 2 14 8 20 8" {...p} /></>);
    case 'idCard':
      // Profile.jsx IconIdCard — the PAN card step, and a PAN card on file.
      return (
        <>
          <Rect x="2" y="5" width="20" height="14" rx="2" {...p} />
          <Circle cx="8" cy="11" r="2" {...p} />
          <Path d="M5 16a3 3 0 0 1 6 0" {...p} />
          <Line x1="14" y1="10" x2="18" y2="10" {...p} />
          <Line x1="14" y1="14" x2="18" y2="14" {...p} />
        </>
      );
    case 'copy':
      // Profile.jsx — the User ID chip's copy glyph.
      return (
        <>
          <Rect x="9" y="9" width="13" height="13" rx="2" ry="2" {...p} />
          <Path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" {...p} />
        </>
      );
    case 'camera':
      // The document picker's source sheet (a phone's file input offers these).
      return (
        <>
          <Path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" {...p} />
          <Circle cx="12" cy="13" r="4" {...p} />
        </>
      );
    case 'image':
    default:
      return (
        <>
          <Rect x="3" y="3" width="18" height="18" rx="2" ry="2" {...p} />
          <Circle cx="8.5" cy="8.5" r="1.5" {...p} />
          <Polyline points="21 15 16 10 5 21" {...p} />
        </>
      );
  }
};
