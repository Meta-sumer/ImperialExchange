import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, TextInput, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { AppText, Badge, Button, IconButton, Select, toast, type BadgeTone } from '@/components/ui';
import { useAppNavigation } from '@/navigation/types';
import { pickProofImage, type ProofImage } from '@/services/proofImage';
import { useTheme } from '@/theme';
import type { UserAccount } from '@/types/user';
import {
  LIVE_RELOAD_DEBOUNCE_MS,
  accountInitials,
  accountKindLabel,
  accountTitle,
  railWarningName,
  sanitizeAmountInput,
  txStatusTone,
  type FlowStep,
  type MethodGlyphKind,
  type PaymentRail,
  type ReviewRow,
} from '@/utils/fundsFlows';
import { currencySymbol } from '@/utils/money';
import { subscribePositions, subscribeWallet, useForeground } from '@/websocket/channels';

export type { PaymentRail } from '@/utils/fundsFlows';
export type { ProofImage } from '@/services/proofImage';

/**
 * The money-flow pieces shared by the deposit and withdraw views:
 *
 *   PayToCard    "Pay to these details" for the chosen rail (Wallet.jsx:1356-1420)
 *   ProofPicker  the payment-screenshot drop zone (Wallet.jsx:1526-1555)
 *
 * and the wizard chrome both flows draw the same way on the web — header,
 * stepper, choice cards, amount field, summary strip, review card, footer.
 */

/* ══ Glyphs ═══════════════════════════════════════════════════════════ */

const GLYPH_PATHS = {
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
  shieldCheck: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M9 12l2 2 4-4'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
  qr: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h3v3h-3z', 'M14 20h7', 'M20 14v7'],
  swap: ['M16 3l4 4-4 4', 'M4 7h16', 'M8 21l-4-4 4-4', 'M20 17H4'],
  arrowRight: ['M5 12h14', 'M13 6l6 6-6 6'],
  lock: ['M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  info: ['M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z', 'M12 8v4', 'M12 16h.01'],
  check: ['M5 13l4 4L19 7'],
  upi: ['M7 4l10 8-10 8V4z'],
  bank: ['M3 21h18', 'M5 21V10', 'M9 21V10', 'M15 21V10', 'M19 21V10', 'M2 10l10-7 10 7'],
  chat: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
} as const;

export type FlowGlyphName = keyof typeof GLYPH_PATHS;

/** The flows' inline stroke icons that the kit's Icon set does not carry. */
export function FlowGlyph({
  name,
  size = 16,
  color,
  strokeWidth = 2,
}: {
  name: FlowGlyphName;
  size?: number;
  color: string;
  strokeWidth?: number;
}): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {GLYPH_PATHS[name].map((d) => (
        <Path key={d} d={d} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </Svg>
  );
}

/**
 * Payment-network marks (Wallet.jsx:1660-1680). Their colours are the
 * networks' own and the web's inline hexes — they do not follow the theme.
 */
const MARK: Record<MethodGlyphKind, string> = {
  UPI: '#7C3AED',
  BANK: '#1D4ED8',
  RAZORPAY: '#3B82F6',
  CUSTOM: '#1D4ED8',
};

export function MethodGlyph({ kind, emoji }: { kind: MethodGlyphKind; emoji?: string | null }): React.JSX.Element {
  const t = useTheme();
  const fg = MARK[kind];
  let inner: ReactNode;
  if (kind === 'UPI') inner = <FlowGlyph name="upi" size={20} color={fg} />;
  else if (kind === 'BANK') inner = <FlowGlyph name="bank" size={20} color={fg} />;
  else if (kind === 'RAZORPAY') {
    inner = (
      <Svg width={20} height={20} viewBox="0 0 24 24">
        <Path d="M3 21l4-9 6 1.5 5-12 3 2-7 17z" fill={fg} />
      </Svg>
    );
  } else {
    inner = <AppText style={styles.emoji}>{emoji || '💳'}</AppText>;
  }
  return (
    <View style={[styles.mark, { backgroundColor: kind === 'CUSTOM' ? t.colors.bgHover : t.alpha(fg, 0.1), borderRadius: t.radius.xl }]}>
      {inner}
    </View>
  );
}

/* ══ Pay to these details ═════════════════════════════════════════════ */

const copyValue = async (value: string, label: string): Promise<void> => {
  try {
    await Clipboard.setStringAsync(value);
    toast.success(`${label} copied`);
  } catch {
    toast.error('Copy failed');
  }
};

/**
 * Where to send the money for a manual deposit, for the CHOSEN rail only:
 * the admin's payee rows with Copy where the web has one, the admin's note,
 * then the scan-to-pay QR. With no rows the web refuses to show an empty
 * card a user might pay into, and says so.
 */
export function PayToCard({ rail, label }: { rail: PaymentRail | null; label: string }): React.JSX.Element {
  const t = useTheme();
  if (!rail || rail.rows.length === 0) {
    return (
      <Notice tone="amber">
        {`Payment details for ${railWarningName(rail, label)} aren't set up yet. Please contact support before sending money.`}
      </Notice>
    );
  }
  const accent = t.brand.primary400;
  return (
    <View
      testID="pay-to-card"
      style={[styles.payTo, { backgroundColor: t.colors.bgHover, borderColor: t.colors.borderDark, borderRadius: t.radius.xl }]}
    >
      <View style={styles.payHead}>
        <View style={[styles.payIcon, { backgroundColor: t.alpha(accent, 0.1), borderRadius: t.radius.lg }]}>
          <FlowGlyph name="shieldCheck" size={14} color={accent} />
        </View>
        <AppText variant="bodyStrong" weight="700" style={styles.flexShrink}>Pay to these details</AppText>
        <Badge label="Verified" tone="bull" size="xs" />
        {rail.qr ? (
          <View style={styles.scanBelow}>
            <FlowGlyph name="qr" size={12} color={t.colors.textMuted} />
            <AppText variant="micro" tone="muted" weight="600">Scan below</AppText>
          </View>
        ) : null}
      </View>
      {rail.rows.map((r) => (
        <View key={`${r.label}:${r.value}`} style={styles.payRow}>
          <AppText variant="small" tone="muted">{r.label}</AppText>
          <View style={styles.payValue}>
            <AppText variant="smallStrong" mono selectable numberOfLines={2} align="right" style={styles.flexShrink}>
              {r.value}
            </AppText>
            {r.copyable ? (
              <IconButton
                name="copy"
                size={14}
                accessibilityLabel={`Copy ${r.label}`}
                color={t.colors.textMuted}
                onPress={() => { void copyValue(r.value, r.label); }}
              />
            ) : null}
          </View>
        </View>
      ))}
      {rail.note ? (
        <View style={[styles.payNote, { borderTopColor: t.colors.borderSubtle }]}>
          <AppText variant="caption" tone="secondary">{rail.note}</AppText>
        </View>
      ) : null}
      {rail.qr ? (
        <View style={[styles.payQr, { borderTopColor: t.colors.borderSubtle }]}>
          <Image
            source={{ uri: rail.qr }}
            style={[styles.qrImage, { borderColor: t.colors.borderDark, borderRadius: t.radius.lg }]}
            resizeMode="contain"
            accessibilityLabel="Payment QR"
          />
          <AppText variant="micro" tone="muted">Scan to pay</AppText>
        </View>
      ) : null}
    </View>
  );
}

/* ══ Proof ════════════════════════════════════════════════════════════ */

/**
 * The payment screenshot: picked from the gallery, compressed to fit the
 * server's cap (services/proofImage), previewed, removable.
 */
export function ProofPicker({
  value,
  onChange,
}: {
  value: ProofImage | null;
  onChange: (p: ProofImage | null) => void;
}): React.JSX.Element {
  const t = useTheme();
  const [busy, setBusy] = useState(false);

  const pick = useCallback(async () => {
    setBusy(true);
    const res = await pickProofImage();
    setBusy(false);
    if (res.ok) onChange(res.image);
    else if (res.reason !== 'cancelled') toast.error(res.message);
  }, [onChange]);

  const indigo = t.brand.primary500;
  if (value) {
    return (
      <View style={[styles.drop, { borderColor: t.colors.borderDark, borderRadius: t.radius.xxl }]}>
        <View style={styles.previewWrap}>
          <Image
            source={{ uri: value.uri }}
            style={[styles.preview, { borderColor: t.colors.borderDark, borderRadius: t.radius.xl }]}
            resizeMode="contain"
            accessibilityLabel="Payment screenshot"
          />
          <Pressable
            onPress={() => onChange(null)}
            accessibilityRole="button"
            accessibilityLabel="Remove screenshot"
            hitSlop={8}
            style={[styles.remove, { backgroundColor: t.colors.bear }]}
          >
            <AppText variant="small" weight="700" color="#FFFFFF">✕</AppText>
          </Pressable>
        </View>
        <View style={styles.inline}>
          <FlowGlyph name="check" size={12} color={t.colors.primaryText} strokeWidth={3} />
          <AppText variant="caption" weight="700" color={t.colors.primaryText}>Screenshot ready</AppText>
        </View>
      </View>
    );
  }
  return (
    <Pressable
      onPress={() => { void pick(); }}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel="Upload payment screenshot"
      style={({ pressed }) => [
        styles.drop,
        styles.dashed,
        {
          borderColor: pressed ? t.colors.primary : t.colors.borderDark,
          backgroundColor: pressed ? t.alpha(t.colors.primary, 0.05) : 'transparent',
          borderRadius: t.radius.xxl,
        },
      ]}
    >
      <View style={[styles.uploadIcon, { backgroundColor: t.alpha(indigo, 0.1) }]}>
        {busy ? <ActivityIndicator color={indigo} /> : <FlowGlyph name="upload" size={22} color={indigo} />}
      </View>
      <AppText variant="bodyStrong" weight="700" align="center">Tap to upload a screenshot</AppText>
      <AppText variant="caption" tone="muted" align="center">PNG / JPG · Max 10 MB</AppText>
    </Pressable>
  );
}

/* ══ Live data ════════════════════════════════════════════════════════ */

/**
 * Re-read a flow's own data when the money moves — the web's
 * `wsClient.subscribe('user:wallet' | 'user:positions', () => load())`
 * (Wallet.jsx:133-140), whose reload re-renders the open deposit / withdraw
 * view with fresh balances and withdrawals. A burst of events (a close-all
 * settles many positions; a conversion is a debit AND a credit) becomes one
 * reload. Coming back to the foreground re-reads too, as the hub does.
 *
 * `refreshKey` is the hub's pull-to-refresh counter, when it passes one.
 */
export function useLiveWalletReload(reload: () => void, refreshKey?: number): void {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const nudge = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; reloadRef.current(); }, LIVE_RELOAD_DEBOUNCE_MS);
    };
    const offWallet = subscribeWallet(nudge);
    const offPositions = subscribePositions(nudge);
    return () => {
      offWallet();
      offPositions();
      if (timer) clearTimeout(timer);
    };
  }, []);

  useForeground(() => reloadRef.current());

  // A pull-to-refresh on the hub: every change after the first render.
  const firstKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === undefined || refreshKey === firstKey.current) return;
    firstKey.current = refreshKey;
    reloadRef.current();
  }, [refreshKey]);
}

/* ══ Wizard chrome ════════════════════════════════════════════════════ */

/**
 * The flow card's header: title, subtitle, Support (→ Helpdesk) and close.
 * The web's "How it works?" button has no handler and is hidden on phones;
 * it is not drawn.
 */
export function FlowHeader({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  return (
    <View style={[styles.header, { borderBottomColor: t.colors.borderSubtle }]}>
      <View style={styles.flex}>
        <AppText variant="h2">{title}</AppText>
        <AppText variant="small" tone="secondary" style={styles.mt2}>{subtitle}</AppText>
      </View>
      <IconButton name="chat" accessibilityLabel="Support" color={t.colors.textSecondary} onPress={() => nav.navigate('Helpdesk')} />
      <IconButton name="close" accessibilityLabel="Close" color={t.colors.textSecondary} onPress={onClose} />
    </View>
  );
}

/** The numbered stepper. Phones show the active step's name under the dots. */
export function StepBar<Id extends string>({
  steps,
  index,
}: {
  steps: readonly FlowStep<Id>[];
  index: number;
}): React.JSX.Element {
  const t = useTheme();
  const accent = t.brand.primary400;
  const current = steps[index];
  return (
    <View style={[styles.stepper, { borderBottomColor: t.colors.borderSubtle }]}>
      <View style={styles.stepDots}>
        {steps.map((s, i) => {
          const active = i === index;
          const done = i < index;
          return (
            <React.Fragment key={s.id}>
              <View
                accessibilityLabel={`Step ${i + 1}: ${s.label}${active ? ' (current)' : done ? ' (done)' : ''}`}
                style={[
                  styles.dot,
                  {
                    backgroundColor: active ? accent : done ? t.alpha(accent, 0.13) : t.colors.bgHover,
                  },
                ]}
              >
                {done ? (
                  <FlowGlyph name="check" size={14} color={accent} strokeWidth={3.4} />
                ) : (
                  <AppText variant="small" weight="700" color={active ? '#FFFFFF' : t.colors.textMuted}>{String(i + 1)}</AppText>
                )}
              </View>
              {i < steps.length - 1 ? <View style={[styles.dash, { borderColor: t.colors.borderDark }]} /> : null}
            </React.Fragment>
          );
        })}
      </View>
      {current ? (
        <AppText variant="caption" tone="muted" style={styles.mt6}>
          {`Step ${index + 1} of ${steps.length} · `}
          <AppText variant="caption" weight="700">{current.label}</AppText>
          {` — ${current.sub}`}
        </AppText>
      ) : null}
    </View>
  );
}

export function StepTitle({ title, sub, large }: { title: string; sub: string; large?: boolean }): React.JSX.Element {
  return (
    <View>
      <AppText variant={large ? 'h3' : 'title'} weight="700">{title}</AppText>
      <AppText variant="small" tone="muted" style={styles.mt2}>{sub}</AppText>
    </View>
  );
}

/** A selectable card with the web's radio dot top-right. */
export function ChoiceCard({
  selected,
  onPress,
  disabled,
  leading,
  title,
  badge,
  sub,
  meta,
  testID,
}: {
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  leading?: ReactNode;
  title: string;
  badge?: ReactNode;
  sub?: string;
  meta?: string;
  testID?: string;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: !!disabled }}
      accessibilityLabel={title}
      style={({ pressed }) => [
        styles.choice,
        {
          borderColor: selected ? t.colors.primary : pressed ? t.alpha(t.colors.primary, 0.4) : t.colors.borderDark,
          backgroundColor: selected ? t.alpha(t.colors.primary, 0.05) : t.colors.surface,
          borderRadius: t.radius.xl,
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      {leading}
      <View style={styles.flex}>
        <View style={styles.inline}>
          <AppText variant="bodyStrong" weight="700" numberOfLines={1} style={styles.flexShrink}>{title}</AppText>
          {badge}
        </View>
        {sub ? <AppText variant="caption" tone="muted" style={styles.mt2}>{sub}</AppText> : null}
        {meta ? <AppText variant="caption" tone="secondary" style={styles.mt4}>{meta}</AppText> : null}
      </View>
      <View
        style={[
          styles.radio,
          { borderColor: selected ? t.colors.primary : t.colors.borderDark, backgroundColor: selected ? t.colors.primary : 'transparent' },
        ]}
      >
        {selected ? <View style={styles.radioDot} /> : null}
      </View>
    </Pressable>
  );
}

/** The account tile both flows open with (Wallet.jsx:1256-1312, 2387-2443). */
export function AccountChoiceCard({
  account,
  selected,
  onPress,
  figure,
  caption,
  chip,
}: {
  account: UserAccount;
  selected: boolean;
  onPress: () => void;
  figure: string;
  caption: string;
  chip: string | null;
}): React.JSX.Element {
  const t = useTheme();
  const accent = t.brand.primary400;
  const tile = t.brand.primary500;
  const live = accountKindLabel(account) !== 'Demo';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={accountTitle(account)}
      style={[
        styles.accountCard,
        {
          borderColor: selected ? accent : t.colors.borderDark,
          backgroundColor: selected ? t.alpha(accent, 0.03) : t.colors.surface,
          borderRadius: t.radius.xxl,
        },
      ]}
    >
      <View style={styles.rowBetween}>
        <View style={[styles.initials, { backgroundColor: t.alpha(tile, 0.06), borderRadius: t.radius.xl }]}>
          <AppText variant="body" weight="800" color={tile}>{accountInitials(account)}</AppText>
        </View>
        <View
          style={[
            styles.check,
            { borderColor: selected ? accent : t.colors.borderDark, backgroundColor: selected ? accent : 'transparent' },
          ]}
        >
          {selected ? <FlowGlyph name="check" size={12} color="#FFFFFF" strokeWidth={3.4} /> : null}
        </View>
      </View>
      <View style={[styles.inline, styles.mt10]}>
        <AppText variant="title" weight="700" numberOfLines={1} style={styles.flexShrink}>{accountTitle(account)}</AppText>
        <Badge label={accountKindLabel(account)} tone={live ? 'primary' : 'info'} size="xs" />
      </View>
      <AppText variant="caption" tone="muted" mono style={styles.mt2}>{account.accountNumber}</AppText>
      <View style={[styles.rowBetween, styles.mt14]}>
        <View style={styles.flexShrink}>
          <AppText variant="h2" mono>{figure}</AppText>
          <AppText variant="caption" tone="muted" style={styles.mt2}>{caption}</AppText>
        </View>
        {chip ? (
          <View style={[styles.ccyChip, { backgroundColor: t.colors.bgHover, borderRadius: t.radius.md }]}>
            <AppText variant="micro" weight="700" mono tone="secondary">{chip}</AppText>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/** A row of preset chips — amounts, or 25 / 50 / 75 / MAX. */
export function PresetGrid({
  options,
  onPick,
  columns = 3,
}: {
  options: readonly { key: string; label: string; selected: boolean; disabled?: boolean }[];
  onPick: (key: string) => void;
  columns?: number;
}): React.JSX.Element {
  const t = useTheme();
  // Rows of `columns` equal cells (the web's grid-cols-N). Percent widths
  // plus a fixed gap overflowed a narrow phone and dropped MAX to a row of
  // its own; equal flex cells per row cannot.
  const rows: (typeof options)[number][][] = [];
  for (let i = 0; i < options.length; i += columns) rows.push(options.slice(i, i + columns));
  return (
    <View style={styles.presets}>
      {rows.map((row) => (
        <View key={row.map((o) => o.key).join('|')} style={styles.presetRow}>
          {row.map((o) => (
            <Pressable
              key={o.key}
              onPress={() => onPick(o.key)}
              disabled={o.disabled}
              accessibilityRole="button"
              accessibilityState={{ selected: o.selected, disabled: !!o.disabled }}
              style={({ pressed }) => [
                styles.preset,
                {
                  borderColor: o.selected ? t.colors.primary : pressed ? t.alpha(t.colors.primary, 0.4) : t.colors.borderDark,
                  backgroundColor: o.selected ? t.alpha(t.colors.primary, 0.05) : 'transparent',
                  borderRadius: t.radius.xl,
                  opacity: o.disabled ? 0.5 : 1,
                },
              ]}
            >
              <AppText
                variant="bodyStrong"
                weight="700"
                numberOfLines={1}
                adjustsFontSizeToFit
                color={o.selected ? t.colors.primaryText : t.colors.textPrimary}
              >
                {o.label}
              </AppText>
            </Pressable>
          ))}
          {/* Keep a short last row's cells the width of the others. */}
          {Array.from({ length: columns - row.length }, (_, i) => <View key={`pad-${i}`} style={styles.presetPad} />)}
        </View>
      ))}
    </View>
  );
}

/**
 * "Custom amount": the ₹ prefix, the figure, and the currency inside the
 * field — a fixed "INR" chip (EquityHub is INR-only, the web's static
 * suffix), or a picker when a caller passes more than one currency.
 */
export function AmountInput({
  label = 'Custom amount',
  value,
  onChangeText,
  currency = 'INR',
  currencies,
  onCurrency,
  error,
  testID,
}: {
  label?: string;
  value: string;
  onChangeText: (v: string) => void;
  currency?: string;
  currencies?: readonly string[];
  onCurrency?: (c: string) => void;
  error?: string | null;
  testID?: string;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <View>
      <AppText variant="label" style={styles.mb6}>{label}</AppText>
      <View
        style={[
          styles.amountField,
          { borderColor: error ? t.colors.bear : t.colors.borderDark, backgroundColor: t.colors.inputBg, borderRadius: t.radius.xl },
        ]}
      >
        <AppText variant="bodyStrong" tone="muted">{currencySymbol(currency).trim()}</AppText>
        <TextInput
          testID={testID}
          value={value}
          onChangeText={(v) => onChangeText(sanitizeAmountInput(v))}
          placeholder="0.00"
          placeholderTextColor={t.colors.textMuted}
          keyboardType="decimal-pad"
          accessibilityLabel={label}
          style={[styles.amountInput, { color: t.colors.textPrimary }]}
        />
        {currencies && currencies.length > 1 && onCurrency ? (
          <Select
            variant="compact"
            value={currency}
            options={currencies.map((c) => ({ value: c, label: c }))}
            onChange={onCurrency}
            title="Currency"
            accessibilityLabel="Currency"
          />
        ) : (
          <View style={[styles.ccyChip, styles.ccyFixed, { backgroundColor: t.colors.bgHover, borderColor: t.colors.borderDark, borderRadius: t.radius.lg }]}>
            <AppText variant="caption" weight="700">{currency}</AppText>
          </View>
        )}
      </View>
      {error ? <AppText variant="caption" tone="bear" weight="600" style={styles.mt6}>{error}</AppText> : null}
    </View>
  );
}

export interface SummaryCell {
  label: string;
  value: string;
  /** A second line under the figure; omitted when there is nothing to add. */
  sub?: string | null;
  tone?: 'bull' | 'bear';
}

/**
 * You Pay / Fees / You Receive. The fee and "receive" figures are the web's
 * client-side preview from the admin's rail config — PORT-RULINGS §6 wants
 * that said: the server books the fee when the request is submitted.
 */
export function SummaryStrip({ cells }: { cells: readonly SummaryCell[] }): React.JSX.Element {
  const t = useTheme();
  return (
    <View>
      <View style={[styles.summary, { backgroundColor: t.colors.bgHover, borderRadius: t.radius.xl }]}>
        {cells.map((c) => (
          <View key={c.label} style={styles.flex}>
            <AppText variant="micro" tone="muted" weight="600" style={styles.upper}>{c.label}</AppText>
            <AppText variant="bodyStrong" weight="700" mono tone={c.tone} style={styles.mt2} numberOfLines={1} adjustsFontSizeToFit>
              {c.value}
            </AppText>
            {c.sub ? <AppText variant="micro" tone="muted" mono style={styles.mt2} numberOfLines={1}>{c.sub}</AppText> : null}
          </View>
        ))}
      </View>
      <AppText variant="micro" tone="muted" style={styles.mt4}>
        Estimate — the server books the fee when the request is submitted.
      </AppText>
    </View>
  );
}

export type NoticeTone = 'info' | 'bear' | 'bull' | 'amber';

/** The flows' tinted callouts: info (`bg-info/10`), bear, bull, and the amber warning. */
export function Notice({
  tone,
  children,
  icon,
  action,
}: {
  tone: NoticeTone;
  children: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}): React.JSX.Element {
  const t = useTheme();
  const look = tone === 'amber'
    ? { bg: t.tw.amber100, border: t.alpha(t.tw.amber700, 0.3), fg: t.tw.amber700 }
    : tone === 'bear'
      ? { bg: t.alpha(t.colors.bear, 0.1), border: t.alpha(t.colors.bear, 0.3), fg: t.colors.textPrimary }
      : tone === 'bull'
        ? { bg: t.alpha(t.colors.bull, 0.1), border: t.alpha(t.colors.bull, 0.3), fg: t.colors.textSecondary }
        : { bg: t.alpha(t.colors.info, 0.1), border: t.alpha(t.colors.info, 0.3), fg: t.colors.textPrimary };
  return (
    <View style={[styles.notice, { backgroundColor: look.bg, borderColor: look.border, borderRadius: t.radius.xl }]}>
      <View style={styles.noticeRow}>
        {icon}
        <View style={styles.flex}>
          {typeof children === 'string'
            ? <AppText variant="small" color={look.fg}>{children}</AppText>
            : children}
        </View>
      </View>
      {action ? <View style={styles.mt10}>{action}</View> : null}
    </View>
  );
}

/** The "Review & confirm" card. */
export function ReviewCard({ rows }: { rows: readonly ReviewRow[] }): React.JSX.Element {
  const t = useTheme();
  return (
    <View
      style={[
        styles.review,
        { borderColor: t.colors.borderDark, backgroundColor: t.alpha(t.colors.bgHover, 0.4), borderRadius: t.radius.xxl },
      ]}
    >
      {rows.map((r) => (
        <View key={r.l} style={styles.reviewRow}>
          <AppText variant="body" tone="muted">{r.l}</AppText>
          <AppText variant="bodyStrong" align="right" numberOfLines={2} style={styles.reviewValue}>{r.v}</AppText>
        </View>
      ))}
    </View>
  );
}

/** The bottom action bar — Cancel / ← Back left, the primary action right. */
export function FlowFooter({
  first,
  onCancel,
  onBack,
  primaryLabel,
  onPrimary,
  primaryDisabled,
  loading,
  note,
}: {
  first: boolean;
  onCancel: () => void;
  onBack: () => void;
  primaryLabel: string;
  onPrimary: () => void;
  primaryDisabled?: boolean;
  loading?: boolean;
  note: string;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[styles.footer, { borderTopColor: t.colors.borderSubtle, backgroundColor: t.alpha(t.colors.bgHover, 0.4) }]}>
      <View style={styles.inline}>
        <FlowGlyph name="lock" size={14} color={t.brand.primary400} strokeWidth={2.2} />
        <AppText variant="caption" tone="secondary" style={styles.flexShrink}>{note}</AppText>
      </View>
      <View style={styles.footerButtons}>
        <Button title={first ? 'Cancel' : '← Back'} variant="secondary" onPress={first ? onCancel : onBack} />
        <Button
          title={primaryLabel}
          onPress={onPrimary}
          disabled={primaryDisabled}
          loading={loading}
          style={styles.flex}
        />
      </View>
    </View>
  );
}

/** Wallet.jsx StatusBadge. */
export function TxStatusBadge({ status }: { status: string }): React.JSX.Element {
  const tone: BadgeTone = txStatusTone(status);
  return <Badge label={status || '—'} tone={tone} size="xs" />;
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  flexShrink: { flexShrink: 1 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowBetween: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  upper: { textTransform: 'uppercase', letterSpacing: 0.6 },
  mt2: { marginTop: 2 },
  mt4: { marginTop: 4 },
  mt6: { marginTop: 6 },
  mt10: { marginTop: 10 },
  mt14: { marginTop: 14 },
  mb6: { marginBottom: 6 },
  mark: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  emoji: { fontSize: 20, lineHeight: 24 },
  payTo: { borderWidth: 1, padding: 16, gap: 8 },
  payHead: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 },
  payIcon: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  scanBelow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 'auto' },
  payRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  payValue: { flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 1 },
  payNote: { borderTopWidth: 1, paddingTop: 8 },
  payQr: { borderTopWidth: 1, paddingTop: 8, alignItems: 'center', gap: 4 },
  qrImage: { width: 128, height: 128, borderWidth: 1, backgroundColor: '#FFFFFF' },
  drop: { borderWidth: 2, padding: 20, alignItems: 'center', gap: 8 },
  dashed: { borderStyle: 'dashed' },
  uploadIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  // The wrapper stretches to the drop zone's width, so the preview is the
  // web's `w-full max-h-56` on any phone (a fixed minWidth overflowed a
  // 320-dp screen).
  previewWrap: { alignSelf: 'stretch' },
  preview: { width: '100%', height: 220, borderWidth: 1, backgroundColor: '#FFFFFF' },
  remove: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 4, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12, borderBottomWidth: 1 },
  stepper: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1 },
  stepDots: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  dash: { flex: 1, height: 0, borderTopWidth: 1, borderStyle: 'dashed', marginHorizontal: 4 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 2, padding: 14 },
  radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
  radioDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#FFFFFF' },
  accountCard: { borderWidth: 2, padding: 16 },
  initials: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  ccyChip: { paddingHorizontal: 8, paddingVertical: 4, alignSelf: 'flex-end' },
  ccyFixed: { alignSelf: 'center', borderWidth: 1 },
  presets: { gap: 8 },
  presetRow: { flexDirection: 'row', gap: 8 },
  preset: { flex: 1, minWidth: 0, borderWidth: 2, paddingVertical: 10, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  presetPad: { flex: 1 },
  amountField: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 2, paddingHorizontal: 12, minHeight: 52 },
  amountInput: { flex: 1, fontSize: 18, fontWeight: '700', paddingVertical: 10 },
  summary: { flexDirection: 'row', gap: 12, padding: 14 },
  notice: { borderWidth: 1, padding: 12 },
  noticeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  review: { borderWidth: 1, padding: 16, gap: 10 },
  reviewRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  reviewValue: { flexShrink: 1 },
  footer: { borderTopWidth: 1, paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  footerButtons: { flexDirection: 'row', gap: 10 },
});
