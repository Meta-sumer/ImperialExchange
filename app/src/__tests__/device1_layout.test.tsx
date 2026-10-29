/**
 * What the first run on the Android emulator (2026-09-30) found, pinned so
 * it cannot come back. jest lays nothing out and fetches nothing, which is
 * why none of the earlier suites could see these.
 *
 *  1. A gradient drawn as `<Svg style={StyleSheet.absoluteFill}>` with no
 *     width / height covered only the parent's box minus its padding, from
 *     the top-left: the Landing CTAs showed a gradient the size of their
 *     label and white text on white. Now every such background is FillSvg.
 *  2. A coin logo that came back 2xx with an empty body logged a red
 *     "Unexpected end of input" and drew nothing (react-native-svg's SvgUri
 *     does not pass parse errors to onError). Now it is the ticker tile.
 *
 * (The Landing header that scrolled away under the status bar is pinned in
 * stage4_integration's Landing test, which has the navigation around it.)
 */
import fs from 'fs';
import path from 'path';
import React, { act } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));

/* eslint-disable import/first */
import { FillSvg } from '@/components/common/FillSvg';
import { AssetIcon } from '@/components/ui/AssetIcon';
import { Gradient } from '@/screens/landing/LandingArt';
import { ThemeProvider } from '@/theme';
/* eslint-enable import/first */

interface TestNode { type: unknown; props: Record<string, unknown>; parent: TestNode | null; children: (TestNode | string)[]; findAll(pred: (n: TestNode) => boolean): TestNode[] }
interface Renderer { root: TestNode; toJSON(): unknown; unmount(): void }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { create } = require('react-test-renderer') as { create: (el: React.ReactElement) => Renderer };

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const render = async (el: React.ReactElement): Promise<Renderer> => {
  let r: Renderer | null = null;
  await act(async () => { r = create(<ThemeProvider>{el}</ThemeProvider>); });
  await settle();
  return r as unknown as Renderer;
};
const unmount = async (r: Renderer): Promise<void> => { await act(async () => { r.unmount(); }); };
const textOf = (node: unknown): string => {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return textOf((node as { children?: unknown }).children ?? null);
};

/* ── 1. full-bleed SVG backgrounds ── */

const SRC = path.join(__dirname, '..');
const sourceFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === '__tests__' || e.name === 'vendor' ? [] : sourceFiles(p);
  return /\.tsx$/.test(e.name) ? [p] : [];
});
/** Opening `<Svg …>` tags whose attributes stretch it over the parent but give it no size (comments ignored). */
const sizeLessOverlays = (src: string): string[] =>
  [...src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').matchAll(/<Svg\b((?:=>|[^>])*)>/g)]
    .map((m) => m[1] ?? '')
    .filter((attrs) => /absoluteFill/.test(attrs) && !/\bwidth=/.test(attrs));

describe('full-bleed SVG backgrounds', () => {
  it('the scan recognises the pattern that broke on the device, and passes a sized one', () => {
    expect(sizeLessOverlays('<Svg style={[StyleSheet.absoluteFill, style]} preserveAspectRatio="none" viewBox="0 0 100 100">')).toHaveLength(1);
    expect(sizeLessOverlays('<Svg style={StyleSheet.absoluteFill} onLayout={(e) => f(e)}>')).toHaveLength(1);
    expect(sizeLessOverlays('<Svg width={36} height={36} style={StyleSheet.absoluteFill}>')).toHaveLength(0);
  });

  it('no screen draws a size-less Svg over its parent — they use FillSvg', () => {
    const offenders = sourceFiles(SRC).flatMap((f) =>
      sizeLessOverlays(fs.readFileSync(f, 'utf8')).map((a) => `${path.relative(SRC, f)}: <Svg${a}>`));
    expect(offenders).toEqual([]);
  });

  it('FillSvg: an absolute, padding-free View does the stretching; the Svg fills it at 100%', async () => {
    const r = await render(
      <View style={{ padding: 24 }}>
        <FillSvg viewBox="0 0 100 100" preserveAspectRatio="none"><Rect width="100" height="100" /></FillSvg>
      </View>,
    );
    const svg = r.root.findAll((n) => n.type === Svg)[0];
    expect(svg?.props).toMatchObject({ width: '100%', height: '100%', viewBox: '0 0 100 100', preserveAspectRatio: 'none' });
    const wrapper = svg?.parent;
    const style = StyleSheet.flatten(wrapper?.props.style as never) as Record<string, unknown>;
    expect(style).toMatchObject({ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 });
    expect(Object.keys(style).filter((k) => k.startsWith('padding'))).toEqual([]);
    expect(wrapper?.props.pointerEvents).toBe('none');
    await unmount(r);
  });

  it('the Landing Gradient is drawn through FillSvg', async () => {
    const r = await render(<Gradient from="#2563EB" to="#10B981" id="t" horizontal />);
    expect(r.root.findAll((n) => n.type === FillSvg)).toHaveLength(1);
    await unmount(r);
  });
});

/* ── 2. coin logos ── */

describe('coin logos (AssetIcon crypto)', () => {
  const realFetch = global.fetch;
  let errors: jest.SpyInstance;
  beforeEach(() => { errors = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { errors.mockRestore(); global.fetch = realFetch; });

  it('a 200 with an empty body shows the ticker tile, and logs nothing', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => '' })) as never;
    const r = await render(<AssetIcon symbol="BTCUSD" size={32} />);
    expect(global.fetch).toHaveBeenCalledWith('https://cdn.jsdelivr.net/gh/atomiclabs/cryptocurrency-icons@0.18.1/svg/color/btc.svg');
    expect(textOf(r.toJSON())).toContain('BTC');
    expect(r.root.findAll((n) => n.type === Svg)).toHaveLength(0);
    expect(errors).not.toHaveBeenCalled();
    await unmount(r);
  });

  it('a 404 or a network failure: the same tile, no log', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 404, text: async () => 'Not found' })) as never;
    const a = await render(<AssetIcon symbol="SOLUSD" size={32} />);
    expect(textOf(a.toJSON())).toContain('SOL');
    await unmount(a);
    global.fetch = jest.fn(async () => { throw new TypeError('Network request failed'); }) as never;
    const b = await render(<AssetIcon symbol="XRPUSD" size={32} />);
    expect(textOf(b.toJSON())).toContain('XRP');
    await unmount(b);
    expect(errors).not.toHaveBeenCalled();
  });

  it('a real logo is drawn, fetched once however many rows show it', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#627EEA"/></svg>';
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => svg })) as never;
    const r = await render(
      <View>
        <AssetIcon symbol="ETHUSD" size={32} />
        <AssetIcon symbol="ETHUSD" size={24} />
      </View>,
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const drawn = r.root.findAll((n) => n.type === Svg);
    expect(drawn.map((n) => [n.props.width, n.props.height])).toEqual([[32, 32], [24, 24]]);
    expect(textOf(r.toJSON())).not.toContain('ETH');
    expect(errors).not.toHaveBeenCalled();
    await unmount(r);
  });
});
