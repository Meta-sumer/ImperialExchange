import Constants from 'expo-constants';
import React, { useCallback, useMemo, useState } from 'react';
import {
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type TextStyle,
} from 'react-native';

import { API_URL, WEB_ORIGIN } from '@/constants/env';
import { navigateToPath } from '@/navigation/linking';
import { useTheme, type AppTheme } from '@/theme';

import {
  attrAspectRatio,
  classifyLink,
  collapseWhitespace,
  hasBlockDescendant,
  isBlock,
  parseHtml,
  resolveMediaUrl,
  textContent,
  type HtmlElement,
  type HtmlNode,
} from './htmlParse';

/**
 * Admin-authored HTML, drawn natively — the web's
 * `<div className="cms-content" dangerouslySetInnerHTML={…} />`
 * (NewsArticle.jsx) with `.cms-content`'s look (index.css:357-372): body
 * text in the secondary colour at 1.75 line height, h1-h3 in the primary
 * colour, underlined primary links, disc / decimal lists, a left-ruled
 * italic blockquote, rounded images, bordered tables and a rule for <hr>.
 *
 * Only known elements render (htmlParse drops scripts, styles, frames and
 * embeds with their content; inline styles and handlers are never read), so
 * the body cannot run code or restyle the app. Links: an app path, or a URL
 * on the web app's own origin, opens that screen (navigateToPath); http(s),
 * mailto and tel open outside the app; anything else is not followed. Wide
 * tables and <pre> blocks scroll sideways instead of squeezing.
 *
 * Shared by any screen that shows CMS HTML (the news article here; the CMS
 * page can use it too).
 */

export interface HtmlContentProps {
  html: string | null | undefined;
  /** The web path of the page the HTML sits on — relative links resolve against it. */
  basePath?: string;
  testID?: string;
}

/** Origin for a `/uploads/…` image: the web app's, else the API host's. */
const MEDIA_ORIGIN = WEB_ORIGIN ?? API_URL.replace(/\/api\/?$/, '');
const APP_SCHEME = typeof Constants.expoConfig?.scheme === 'string' ? Constants.expoConfig.scheme : 'equityhub';

interface Ctx {
  t: AppTheme;
  onLink: (href: string) => void;
  /** An enclosing <a> — an image inside a link opens it. */
  href: string | null;
  /** Inside a <blockquote>: muted, italic. */
  quote: boolean;
  /** Nesting depth of lists, for the marker's indent. */
  listDepth: number;
}

const BASE_SIZE = 15.6; // 0.975rem
const LINE = 1.75;

/* ── Inline ───────────────────────────────────────────────────────────── */

const inlineStyle = (tag: string, ctx: Ctx): TextStyle | null => {
  const c = ctx.t.colors;
  switch (tag) {
    case 'strong':
    case 'b':
      return { fontWeight: '700', color: c.textPrimary };
    case 'em':
    case 'i':
    case 'cite':
    case 'dfn':
      return { fontStyle: 'italic' };
    case 'u':
    case 'ins':
      return { textDecorationLine: 'underline' };
    case 's':
    case 'strike':
    case 'del':
      return { textDecorationLine: 'line-through' };
    case 'code':
    case 'kbd':
    case 'samp':
    case 'tt':
      return { fontFamily: ctx.t.font.mono, backgroundColor: c.bgHover, fontSize: BASE_SIZE * 0.9 };
    case 'mark':
      return { backgroundColor: ctx.t.alpha('#FACC15', 0.35), color: c.textPrimary };
    case 'small':
    case 'sub':
    case 'sup':
      return { fontSize: BASE_SIZE * 0.8 };
    case 'a':
      return { color: c.primaryText, textDecorationLine: 'underline' };
    default:
      return null;
  }
};

/** Trim the whitespace at the edges of an inline run, as block layout does. */
const trimRun = (nodes: HtmlNode[]): HtmlNode[] => {
  const out = [...nodes];
  // A trailing <br> ends the block; it does not add an empty line.
  while (out.length && out[out.length - 1]?.type === 'element' && (out[out.length - 1] as HtmlElement).tag === 'br') out.pop();
  const first = out[0];
  if (first && first.type === 'text') out[0] = { type: 'text', text: first.text.replace(/^[\t\n\f\r ]+/, '') };
  const lastIdx = out.length - 1;
  const last = out[lastIdx];
  if (last && last.type === 'text') out[lastIdx] = { type: 'text', text: last.text.replace(/[\t\n\f\r ]+$/, '') };
  return out;
};

const runHasContent = (nodes: readonly HtmlNode[]): boolean =>
  nodes.some((n) => (n.type === 'text' ? n.text.replace(/[\t\n\f\r ]+/g, '') !== '' : n.tag === 'br' || runHasContent(n.children)));

const renderInline = (nodes: readonly HtmlNode[], ctx: Ctx, key: string, pre = false): React.ReactNode[] =>
  nodes.map((n, i) => {
    const k = `${key}.${i}`;
    if (n.type === 'text') return pre ? n.text : collapseWhitespace(n.text);
    if (n.tag === 'br') return '\n';
    if (n.tag === 'a') {
      const href = n.attrs.href ?? '';
      const target = classifyLink(href, { webOrigin: WEB_ORIGIN, appScheme: APP_SCHEME });
      const style = target.kind === 'ignore' ? null : inlineStyle('a', ctx);
      return (
        <Text
          key={k}
          style={style}
          accessibilityRole={target.kind === 'ignore' ? undefined : 'link'}
          onPress={target.kind === 'ignore' ? undefined : () => ctx.onLink(href)}
        >
          {renderInline(n.children, ctx, k, pre)}
        </Text>
      );
    }
    return (
      <Text key={k} style={inlineStyle(n.tag, ctx)}>
        {renderInline(n.children, ctx, k, pre)}
      </Text>
    );
  });

function Paragraph({ nodes, ctx, style }: { nodes: HtmlNode[]; ctx: Ctx; style?: TextStyle }): React.JSX.Element {
  return (
    <Text style={[baseText(ctx), style]}>
      {renderInline(trimRun(nodes), ctx, 'p')}
    </Text>
  );
}

const baseText = (ctx: Ctx): TextStyle => ({
  fontSize: BASE_SIZE,
  lineHeight: Math.round(BASE_SIZE * LINE),
  color: ctx.quote ? ctx.t.colors.textMuted : ctx.t.colors.textSecondary,
  fontStyle: ctx.quote ? 'italic' : 'normal',
  ...(ctx.t.font.sans ? { fontFamily: ctx.t.font.sans } : null),
});

/* ── Blocks ───────────────────────────────────────────────────────────── */

/**
 * Flow content: consecutive inline nodes become one paragraph of nested
 * Text; block elements become Views. An inline element that holds a block
 * (an image in a link, a <p> in a <span>) is laid out as a container.
 */
const renderFlow = (nodes: readonly HtmlNode[], ctx: Ctx, key: string): React.ReactNode[] => {
  const out: React.ReactNode[] = [];
  let run: HtmlNode[] = [];
  const flush = () => {
    if (runHasContent(run)) out.push(<Paragraph key={`${key}.r${out.length}`} nodes={run} ctx={ctx} />);
    run = [];
  };
  nodes.forEach((n, i) => {
    if (n.type === 'element' && isBlock(n)) {
      flush();
      out.push(renderBlock(n, ctx, `${key}.${i}`));
    } else if (n.type === 'element' && hasBlockDescendant(n)) {
      flush();
      const inner = n.tag === 'a' ? { ...ctx, href: n.attrs.href ?? null } : ctx;
      out.push(...renderFlow(n.children, inner, `${key}.${i}`));
    } else {
      run.push(n);
    }
  });
  flush();
  return out;
};

const HEADING: Record<string, { size: number; weight: TextStyle['fontWeight']; top: number; bottom: number }> = {
  h1: { size: 28, weight: '700', top: 24, bottom: 12 },
  h2: { size: 22.4, weight: '700', top: 24, bottom: 9.6 },
  h3: { size: 18.4, weight: '600', top: 20, bottom: 8 },
  h4: { size: 16, weight: '700', top: 16, bottom: 8 },
  h5: { size: 14, weight: '700', top: 16, bottom: 8 },
  h6: { size: 13, weight: '700', top: 16, bottom: 8 },
};

const renderBlock = (n: HtmlElement, ctx: Ctx, key: string): React.ReactNode => {
  const c = ctx.t.colors;
  const h = HEADING[n.tag];
  if (h) {
    if (hasBlockDescendant(n)) return <View key={key} style={{ marginTop: h.top, marginBottom: h.bottom }}>{renderFlow(n.children, ctx, key)}</View>;
    return (
      <Paragraph
        key={key}
        nodes={n.children}
        ctx={ctx}
        style={{
          fontSize: h.size,
          lineHeight: Math.round(h.size * 1.3),
          fontWeight: h.weight,
          color: c.textPrimary,
          marginTop: h.top,
          marginBottom: h.bottom,
          fontStyle: 'normal',
        }}
      />
    );
  }
  switch (n.tag) {
    case 'p':
      return <View key={key} style={styles.p}>{renderFlow(n.children, ctx, key)}</View>;
    case 'ul':
    case 'ol':
      return <HtmlList key={key} node={n} ctx={ctx} path={key} />;
    case 'li':
      return <HtmlList key={key} node={{ ...n, tag: 'ul', children: [n] }} ctx={ctx} path={key} />;
    case 'blockquote':
      return (
        <View key={key} style={[styles.quote, { borderLeftColor: c.borderDark }]}>
          {renderFlow(n.children, { ...ctx, quote: true }, key)}
        </View>
      );
    case 'img':
      return <HtmlImage key={key} node={n} ctx={ctx} />;
    case 'hr':
      return <View key={key} style={[styles.hr, { borderTopColor: c.borderDark }]} />;
    case 'pre':
      return (
        <ScrollView key={key} horizontal style={[styles.pre, { backgroundColor: c.bgHover }]} showsHorizontalScrollIndicator={false}>
          <Text style={[baseText(ctx), { fontFamily: ctx.t.font.mono, fontSize: BASE_SIZE * 0.9 }]}>
            {renderInline(n.children, ctx, key, true)}
          </Text>
        </ScrollView>
      );
    case 'table':
      return <HtmlTable key={key} node={n} ctx={ctx} path={key} />;
    case 'dd':
      return <View key={key} style={styles.dd}>{renderFlow(n.children, ctx, key)}</View>;
    case 'dt':
      return <View key={key}>{renderFlow([{ type: 'element', tag: 'strong', attrs: {}, children: n.children }], ctx, key)}</View>;
    case 'figcaption':
    case 'caption':
      return (
        <Text key={key} style={[baseText(ctx), styles.caption, { color: c.textMuted }]}>
          {collapseWhitespace(textContent(n.children)).trim()}
        </Text>
      );
    default:
      // div, section, article, figure, header, footer, … — a plain container.
      return <View key={key}>{renderFlow(n.children, ctx, key)}</View>;
  }
};

function HtmlList({ node, ctx, path }: { node: HtmlElement; ctx: Ctx; path: string }): React.JSX.Element {
  const ordered = node.tag === 'ol';
  const start = ordered ? parseInt(node.attrs.start ?? '1', 10) || 1 : 1;
  const inner = { ...ctx, listDepth: ctx.listDepth + 1 };
  let index = 0;
  return (
    <View style={ctx.listDepth === 0 ? styles.list : styles.nestedList}>
      {node.children.map((child, i) => {
        const k = `${path}.${i}`;
        if (child.type === 'element' && child.tag === 'li') {
          const marker = ordered ? `${start + index}.` : ctx.listDepth === 0 ? '•' : '◦';
          index += 1;
          return (
            <View key={k} style={styles.li}>
              <Text style={[baseText(ctx), styles.marker]}>{marker}</Text>
              <View style={styles.liBody}>{renderFlow(child.children, inner, k)}</View>
            </View>
          );
        }
        if (child.type === 'text' && !child.text.trim()) return null;
        return <View key={k}>{renderFlow([child], inner, k)}</View>;
      })}
    </View>
  );
}

function HtmlImage({ node, ctx }: { node: HtmlElement; ctx: Ctx }): React.JSX.Element | null {
  const uri = resolveMediaUrl(node.attrs.src, MEDIA_ORIGIN);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const [failed, setFailed] = useState(false);
  const onLayout = useCallback((e: LayoutChangeEvent) => setBoxWidth(e.nativeEvent.layout.width), []);
  if (!uri || failed) return null;
  const ratio = natural ? natural.w / natural.h : attrAspectRatio(node.attrs) ?? 16 / 9;
  // `max-width: 100%` — a small image keeps its own size, a large one fits.
  const width = boxWidth ? Math.min(boxWidth, natural?.w ?? boxWidth) : 0;
  const alt = node.attrs.alt || undefined;
  const image = (
    <Image
      source={{ uri }}
      accessibilityLabel={alt}
      accessible={!!alt}
      resizeMode="cover"
      onLoad={(e) => {
        const s = e.nativeEvent.source;
        if (s && s.width > 0 && s.height > 0) setNatural({ w: s.width, h: s.height });
      }}
      onError={() => setFailed(true)}
      style={[styles.img, width ? { width, height: width / ratio } : { width: '100%', aspectRatio: ratio }]}
    />
  );
  return (
    <View onLayout={onLayout} style={styles.imgBox}>
      {ctx.href ? (
        <Pressable accessibilityRole="link" accessibilityLabel={alt} onPress={() => ctx.onLink(ctx.href as string)}>
          {image}
        </Pressable>
      ) : image}
    </View>
  );
}

/** Rows of a table, wherever they sit (thead / tbody / tfoot or directly). */
const tableRows = (table: HtmlElement): HtmlElement[] => {
  const rows: HtmlElement[] = [];
  const walk = (nodes: readonly HtmlNode[]) => {
    for (const n of nodes) {
      if (n.type !== 'element') continue;
      if (n.tag === 'tr') rows.push(n);
      else if (n.tag === 'thead' || n.tag === 'tbody' || n.tag === 'tfoot') walk(n.children);
    }
  };
  walk(table.children);
  return rows;
};

function HtmlTable({ node, ctx, path }: { node: HtmlElement; ctx: Ctx; path: string }): React.JSX.Element {
  const c = ctx.t.colors;
  const rows = tableRows(node);
  const caption = node.children.find((n): n is HtmlElement => n.type === 'element' && n.tag === 'caption');
  return (
    <View style={styles.tableBox}>
      {caption ? renderBlock(caption, ctx, `${path}.cap`) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={[styles.table, { borderColor: c.borderDark }]}>
          {rows.map((tr, r) => (
            <View key={`${path}.tr${r}`} style={styles.tr}>
              {tr.children
                .filter((cell): cell is HtmlElement => cell.type === 'element' && (cell.tag === 'td' || cell.tag === 'th'))
                .map((cell, ci) => (
                  <View key={`${path}.tr${r}.${ci}`} style={[styles.cell, { borderColor: c.borderDark }]}>
                    {cell.tag === 'th'
                      ? renderFlow([{ type: 'element', tag: 'strong', attrs: {}, children: cell.children }], ctx, `${path}.${r}.${ci}`)
                      : renderFlow(cell.children, ctx, `${path}.${r}.${ci}`)}
                  </View>
                ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

export function HtmlContent({ html, basePath = '/', testID }: HtmlContentProps): React.JSX.Element {
  const t = useTheme();
  const nodes = useMemo(() => parseHtml(html), [html]);

  const onLink = useCallback((href: string) => {
    const target = classifyLink(href, { webOrigin: WEB_ORIGIN, appScheme: APP_SCHEME, basePath });
    if (target.kind === 'internal') navigateToPath(target.path);
    else if (target.kind === 'external') Linking.openURL(target.url).catch(() => undefined);
  }, [basePath]);

  const ctx: Ctx = { t, onLink, href: null, quote: false, listDepth: 0 };
  return <View testID={testID}>{renderFlow(nodes, ctx, 'h')}</View>;
}

const styles = StyleSheet.create({
  p: { marginBottom: 16 },
  list: { marginBottom: 16, paddingLeft: 8 },
  nestedList: { paddingLeft: 4 },
  li: { flexDirection: 'row', marginVertical: 4 },
  marker: { width: 22, textAlign: 'left' },
  liBody: { flex: 1, minWidth: 0 },
  quote: { borderLeftWidth: 3, paddingLeft: 16, marginVertical: 16 },
  imgBox: { marginVertical: 16 },
  img: { borderRadius: 8 },
  hr: { borderTopWidth: 1, marginVertical: 24 },
  pre: { borderRadius: 8, padding: 12, marginBottom: 16 },
  tableBox: { marginVertical: 16 },
  table: { borderLeftWidth: 1, borderTopWidth: 1 },
  tr: { flexDirection: 'row' },
  cell: { minWidth: 120, maxWidth: 280, paddingHorizontal: 12, paddingVertical: 8, borderRightWidth: 1, borderBottomWidth: 1 },
  dd: { marginLeft: 24 },
  caption: { fontSize: 13, marginTop: 6 },
});
