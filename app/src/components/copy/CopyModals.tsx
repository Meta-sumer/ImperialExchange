import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { copyTradingApi } from '@/api/copyTrading.api';
import { walletApi } from '@/api/wallet.api';
import { AppText, Button, Input, Modal, Select, Toggle, toast } from '@/components/ui';
import { useSelectedAccountStore } from '@/store/selectedAccount';
import { useTheme } from '@/theme';
import {
  LOT_MODE_OPTIONS,
  RISK_OPTIONS,
  copySettingsFromRelation,
  copySettingsPayload,
  defaultCopySettings,
  feeInputToPayload,
  firstFreeAccount,
  validateBoxForm,
  validateCopySettings,
  type CopyBox,
  type CopyPreview,
  type CopyRelation,
  type CopySettings,
  type EligibleAccount,
  type RiskBadge,
} from '@/types/copyTrading';
import type { UserAccount } from '@/types/user';
import type { WalletBalance } from '@/types/wallet';
import { isDemoLike } from '@/utils/accountType';
import { fmtMoney } from '@/utils/money';

/**
 * Copy trading's dialogs — client/src/components/CopySetupModal.jsx,
 * EditCopyModal.jsx, StopCopyModal.jsx, CopySettingsFields.jsx, and the
 * box dialogs of pages/CopyTrade.jsx (BecomeMasterModal, EditBoxModal).
 * Every string and every request body is the web's.
 */

/** What the "Copy" dialog needs to know about the trader being copied. */
export interface CopyTarget {
  userId: string;
  /** The box's source account — the copy is tied to it. */
  accountId: string;
  displayName: string;
  roiPct: number;
  winRate: number;
  followers: number;
  /** The resolved performance fee, when known; else it is read from the trader. */
  fee: number | null;
}

/* ── Shared bits ─────────────────────────────────────────────────────── */

const liveAccounts = (accounts: readonly UserAccount[]): UserAccount[] => accounts.filter((a) => !isDemoLike(a.accountType));

/**
 * CopySetupModal.jsx balanceOf — the account's own wallet in its currency:
 * its free balance (else its balance), or null when it has none on file.
 */
const accountBalance = (a: UserAccount, balances: readonly WalletBalance[]): number | null => {
  const w = balances.find((b) => String(b.accountId) === String(a.id) && b.currency === a.baseCurrency);
  if (!w) return null;
  const v = Number(w.free ?? w.balance ?? 0);
  return Number.isFinite(v) ? v : 0;
};

/** `Nickname · ₹1,234.00` — the account option the web builds (rupees only). */
const accountOption = (a: UserAccount, balances: readonly WalletBalance[]): string => {
  const bal = accountBalance(a, balances);
  return `${a.nickname || a.accountNumber}${bal !== null ? ` · ${fmtMoney(bal)}` : ''}`;
};

function useLiveAccountsWithBalances(): { accounts: UserAccount[]; balances: WalletBalance[] } {
  const all = useSelectedAccountStore((s) => s.accounts);
  const accounts = useMemo(() => liveAccounts(all), [all]);
  const [balances, setBalances] = useState<WalletBalance[]>([]);
  useEffect(() => {
    let dead = false;
    void useSelectedAccountStore.getState().load();
    walletApi.balances()
      .then((rows) => { if (!dead) setBalances(rows); })
      .catch(() => { /* balances are advisory */ });
    return () => { dead = true; };
  }, []);
  return { accounts, balances };
}

function Label({ children }: { children: string }): React.JSX.Element {
  return <AppText variant="micro" weight="700" tone="muted" style={styles.label}>{children.toUpperCase()}</AppText>;
}

function RiskPicker({ value, onChange }: { value: RiskBadge; onChange: (r: RiskBadge) => void }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={styles.row3}>
      {RISK_OPTIONS.map((r) => {
        const on = value === r.id;
        return (
          <Pressable
            key={r.id}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(r.id)}
            style={[styles.choice, { borderColor: on ? t.colors.primary : t.colors.borderDark, backgroundColor: on ? t.alpha(t.colors.primary, 0.05) : 'transparent' }]}
          >
            <AppText variant="bodyStrong" weight="800" align="center" color={on ? t.colors.primaryText : t.colors.textSecondary}>{r.label}</AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

function FeeField({ value, onChange, placeholder, note }: { value: string; onChange: (v: string) => void; placeholder: string; note: string }): React.JSX.Element {
  return (
    <View>
      <Label>Performance fee</Label>
      <Input value={value} onChangeText={onChange} keyboardType="number-pad" placeholder={placeholder} right={<AppText tone="muted">%</AppText>} mono />
      <AppText variant="caption" tone="muted" style={styles.mt6}>{note}</AppText>
    </View>
  );
}

function PublicRow({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[styles.publicRow, { borderColor: t.colors.borderDark }]}>
      <View style={styles.flex}>
        <AppText variant="bodyStrong" weight="700">List on the leaderboard</AppText>
        <AppText variant="caption" tone="muted">Others can discover this box and copy it.</AppText>
      </View>
      <Toggle value={value} onValueChange={onChange} accessibilityLabel="List on the leaderboard" />
    </View>
  );
}

/* ── Lot size + copy settings (CopySettingsFields.jsx) ───────────────── */

export function CopySettingsFields({
  settings: s,
  set,
  advancedDefault = false,
}: {
  settings: CopySettings;
  set: <K extends keyof CopySettings>(k: K, v: CopySettings[K]) => void;
  advancedDefault?: boolean;
}): React.JSX.Element {
  const t = useTheme();
  const [showAdvanced, setShowAdvanced] = useState(advancedDefault);
  return (
    <>
      <View>
        <Label>Lot size</Label>
        <View style={styles.grid2}>
          {LOT_MODE_OPTIONS.map((m) => {
            const on = s.lotMode === m.id;
            return (
              <Pressable
                key={m.id}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => set('lotMode', m.id)}
                style={[styles.lot, { borderColor: on ? t.colors.primary : t.colors.borderDark, backgroundColor: on ? t.alpha(t.colors.primary, 0.05) : t.colors.surface }]}
              >
                <AppText variant="bodyStrong" weight="800" color={on ? t.colors.primaryText : t.colors.textSecondary}>{m.label}</AppText>
                <AppText variant="micro" tone="muted">{m.note}</AppText>
              </Pressable>
            );
          })}
        </View>
        {s.lotMode === 'CUSTOM' ? (
          <View style={styles.mt8}>
            <Input
              value={s.customLot}
              onChangeText={(v) => set('customLot', v)}
              keyboardType="decimal-pad"
              mono
              right={<AppText variant="small" weight="600" tone="muted">lots</AppText>}
              accessibilityLabel="Custom lot size"
            />
            <AppText variant="caption" tone="muted" style={styles.mt4}>Fixed lot per copied trade — e.g. 0.10, 0.25, 1.00, 1.52.</AppText>
          </View>
        ) : null}
      </View>

      <View>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showAdvanced }} onPress={() => setShowAdvanced((v) => !v)} style={styles.advancedHead}>
          <AppText variant="micro" weight="700" tone="muted">{`${showAdvanced ? '▾' : '▸'}  COPY SETTINGS`}</AppText>
        </Pressable>
        {showAdvanced ? (
          <View style={styles.advanced}>
            <ToggleRow label="Copy Stop Loss" value={s.copySL} onChange={(v) => set('copySL', v)} />
            <ToggleRow label="Copy Take Profit" value={s.copyTP} onChange={(v) => set('copyTP', v)} />
            <ToggleRow label="Copy Pending Orders" value={s.copyPending} onChange={(v) => set('copyPending', v)} />
            <View>
              <AppText variant="micro" weight="700" tone="muted" style={styles.label}>MAX LOT PER TRADE (BLANK = NO LIMIT)</AppText>
              <Input value={s.maxLot} onChangeText={(v) => set('maxLot', v)} keyboardType="decimal-pad" placeholder="—" mono accessibilityLabel="Max lot per trade" />
            </View>
          </View>
        ) : null}
      </View>
    </>
  );
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <View style={styles.toggleRow}>
      <AppText variant="body" style={styles.flex}>{label}</AppText>
      <Toggle value={value} onValueChange={onChange} accessibilityLabel={label} />
    </View>
  );
}

/* ── Start copying (CopySetupModal.jsx) ──────────────────────────────── */

export function CopySetupModal({ trader, onClose, onStarted }: { trader: CopyTarget; onClose: () => void; onStarted: () => void }): React.JSX.Element {
  const t = useTheme();
  const { accounts, balances } = useLiveAccountsWithBalances();
  const [accountId, setAccountId] = useState('');
  const [settings, setSettings] = useState<CopySettings>(defaultCopySettings);
  const set = <K extends keyof CopySettings>(k: K, v: CopySettings[K]): void => setSettings((p) => ({ ...p, [k]: v }));
  const [preview, setPreview] = useState<CopyPreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [feePct, setFeePct] = useState<number | null>(trader.fee);

  // Default to the first live account once the list is in.
  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  // The fee, when the card did not carry it, comes from the trader's page.
  useEffect(() => {
    if (feePct !== null) return undefined;
    let dead = false;
    copyTradingApi.trader(trader.userId)
      .then((a) => { const p = a?.earnings.performanceFeePercent; if (!dead && p !== null && p !== undefined) setFeePct(p); })
      .catch(() => { /* leave the disclosure hidden */ });
    return () => { dead = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!accountId) { setPreview(null); return undefined; }
    let dead = false;
    copyTradingApi.copyPreview({ followerAccountId: accountId, masterAccountId: trader.accountId })
      .then((p) => { if (!dead) setPreview(p); })
      .catch(() => { if (!dead) setPreview(null); });
    return () => { dead = true; };
  }, [accountId, trader.accountId]);

  const submit = async (): Promise<void> => {
    if (!accountId) { toast.error('Select a trading account'); return; }
    const refusal = validateCopySettings(settings);
    if (refusal) { toast.error(refusal); return; }
    setSaving(true);
    try {
      await copyTradingApi.startCopy({ masterAccountId: trader.accountId, followerAccountId: accountId, settings: copySettingsPayload(settings) });
      toast.success(`Now copying ${trader.displayName}`);
      onStarted();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const title = (
    <View style={styles.titleRow}>
      <View style={[styles.avatar, { backgroundColor: t.alpha(t.colors.primary, 0.15) }]}>
        <AppText variant="bodyStrong" weight="800" color={t.colors.primaryText}>{(trader.displayName || 'T').slice(0, 2).toUpperCase()}</AppText>
      </View>
      <View style={styles.flex}>
        <AppText variant="bodyStrong" weight="800" numberOfLines={1}>{`Copy ${trader.displayName}`}</AppText>
        <AppText variant="caption" tone="muted" numberOfLines={1}>
          {`ROI ${trader.roiPct.toFixed(1)}% · ${trader.winRate.toFixed(0)}% win · ${trader.followers} followers`}
        </AppText>
      </View>
    </View>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={(
        <View style={styles.footer}>
          <Button title="Cancel" variant="ghost" onPress={onClose} disabled={saving} />
          <Button title={saving ? 'Starting…' : 'Start copy'} onPress={() => { void submit(); }} disabled={saving || !accountId} />
        </View>
      )}
    >
      <View style={styles.stack}>
        <View>
          <Label>Trading account</Label>
          <AppText variant="caption" tone="muted" style={styles.hint}>Copied trades open in this account — its balance, margin, swaps and P&amp;L.</AppText>
          {accounts.length === 0 ? (
            <AppText variant="body" tone="muted">No live trading account found.</AppText>
          ) : (
            <Select value={accountId} title="Trading account" options={accounts.map((a) => ({ value: a.id, label: accountOption(a, balances) }))} onChange={setAccountId} />
          )}
        </View>

        {preview ? <PreviewBox preview={preview} /> : null}

        <CopySettingsFields settings={settings} set={set} />

        {feePct !== null ? (
          <View style={[styles.fee, { borderColor: '#FDE68A', backgroundColor: 'rgba(254,243,199,0.7)' }]}>
            <View style={styles.feeHead}>
              <AppText variant="micro" weight="700" color="#B45309">{feePct > 0 ? 'PERFORMANCE FEE' : 'PROFIT SETTLEMENT'}</AppText>
              {feePct > 0 ? <AppText variant="bodyStrong" weight="800" color="#B45309">{`${feePct}%`}</AppText> : null}
            </View>
            <AppText variant="caption" color="#92400E" style={styles.mt4}>
              {feePct > 0
                ? `${trader.displayName} earns ${feePct}% of your profit on winning copied trades. No fee on losses. The rest of your profit stays in this trading account.`
                : 'No performance fee on this trader.'}
            </AppText>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

function PreviewBox({ preview }: { preview: CopyPreview }): React.JSX.Element {
  const t = useTheme();
  const low = preview.lowBalance;
  return (
    <View style={[styles.preview, low ? { borderColor: '#FCD34D', backgroundColor: 'rgba(254,243,199,0.7)' } : { borderColor: t.colors.borderDark, backgroundColor: t.alpha(t.colors.bgHover, 0.4) }]}>
      <View style={styles.previewRow}>
        <View style={styles.previewCell}>
          <AppText variant="micro" weight="700" tone="muted">CURRENT BALANCE</AppText>
          <AppText variant="title" weight="800" mono>{fmtMoney(preview.currentBalance, preview.currency)}</AppText>
        </View>
        <View style={styles.previewCell}>
          <AppText variant="micro" weight="700" tone="muted">RECOMMENDED</AppText>
          <AppText variant="title" weight="800" mono tone="secondary">{fmtMoney(preview.recommendedBalance, preview.currency)}</AppText>
        </View>
      </View>
      {low ? (
        <AppText variant="caption" color="#B45309" style={styles.mt8}>
          {'⚠ '}
          <AppText variant="caption" weight="600" color="#B45309">Low balance.</AppText>
          {' Future copied trades may fail from insufficient margin — you can still copy.'}
        </AppText>
      ) : null}
    </View>
  );
}

/* ── Edit a copy in place (EditCopyModal.jsx) ────────────────────────── */

export function EditCopyModal({ rel, onClose, onSaved }: { rel: CopyRelation; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const { accounts, balances } = useLiveAccountsWithBalances();
  const [accountId, setAccountId] = useState(rel.followerAccountId);
  const [settings, setSettings] = useState<CopySettings>(() => copySettingsFromRelation(rel));
  const set = <K extends keyof CopySettings>(k: K, v: CopySettings[K]): void => setSettings((p) => ({ ...p, [k]: v }));
  const [saving, setSaving] = useState(false);
  const [confirmAccount, setConfirmAccount] = useState(false);

  const accountChanged = accountId !== rel.followerAccountId;
  const openCount = rel.openMirrors.length;
  const hasOpen = openCount > 0;

  const doSave = async (closePositions: boolean): Promise<void> => {
    setSaving(true);
    try {
      await copyTradingApi.editCopy(rel.id, { followerAccountId: accountId, closePositions, settings: copySettingsPayload(settings) });
      toast.success('Copy updated');
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const onSaveClick = (): void => {
    const refusal = validateCopySettings(settings);
    if (refusal) { toast.error(refusal); return; }
    if (accountChanged && hasOpen) { setConfirmAccount(true); return; }
    void doSave(false);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit copy · ${rel.master?.displayName || 'Trader'}`}
      footer={confirmAccount ? (
        <View style={styles.footer}>
          <Button title="Cancel" variant="ghost" onPress={() => setConfirmAccount(false)} disabled={saving} />
        </View>
      ) : (
        <View style={styles.footer}>
          <Button title="Cancel" variant="ghost" onPress={onClose} disabled={saving} />
          <Button title={saving ? 'Saving…' : 'Save changes'} onPress={onSaveClick} disabled={saving} />
        </View>
      )}
    >
      {confirmAccount ? (
        <View style={styles.stack}>
          <View>
            <AppText variant="bodyStrong" weight="800">You are changing the trading account.</AppText>
            <AppText variant="body" tone="secondary" style={styles.mt4}>
              {'What should happen to the '}
              <AppText variant="body" weight="600">{`${openCount} open copied position(s)`}</AppText>
              {' in the current account? Future copied trades go to the new account either way.'}
            </AppText>
          </View>
          <ChoiceCard
            title="Close automatically"
            desc="Market-close all open copied positions now, then switch account."
            danger
            disabled={saving}
            onPress={() => { void doSave(true); }}
          />
          <ChoiceCard
            title="I will close manually"
            desc="Leave them open — you close them yourself from the Trade page."
            disabled={saving}
            onPress={() => { void doSave(false); }}
          />
        </View>
      ) : (
        <View style={styles.stack}>
          <View>
            <Label>Trading account</Label>
            <Select value={accountId} title="Trading account" options={accounts.map((a) => ({ value: a.id, label: accountOption(a, balances) }))} onChange={setAccountId} />
            {accountChanged && hasOpen ? (
              <AppText variant="caption" color="#B45309" style={styles.mt6}>Changing account — you'll choose what happens to open positions on save.</AppText>
            ) : null}
          </View>
          <CopySettingsFields settings={settings} set={set} advancedDefault />
        </View>
      )}
    </Modal>
  );
}

function ChoiceCard({ title, desc, danger = false, disabled, onPress }: { title: string; desc: string; danger?: boolean; disabled?: boolean; onPress: () => void }): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.choiceCard, {
        borderColor: danger ? t.alpha(t.colors.bear, pressed ? 1 : 0.4) : pressed ? t.colors.primary : t.colors.borderDark,
        backgroundColor: danger ? t.alpha(t.colors.bear, 0.05) : 'transparent',
        opacity: disabled ? 0.5 : 1,
      }]}
    >
      <AppText variant="bodyStrong" weight="700">{title}</AppText>
      <AppText variant="small" tone="secondary">{desc}</AppText>
    </Pressable>
  );
}

/* ── Stop copying (StopCopyModal.jsx) ────────────────────────────────── */

export function StopCopyModal({ rel, onClose, onConfirm }: { rel: CopyRelation; onClose: () => void; onConfirm: (closePositions: boolean) => Promise<void> }): React.JSX.Element {
  const t = useTheme();
  const [choice, setChoice] = useState<'close' | 'keep'>('keep');
  const [saving, setSaving] = useState(false);
  const openCount = rel.openMirrors.length;

  const confirm = async (): Promise<void> => {
    setSaving(true);
    try { await onConfirm(choice === 'close'); } finally { setSaving(false); }
  };

  const Option = ({ id, title, desc, danger = false }: { id: 'close' | 'keep'; title: string; desc: string; danger?: boolean }): React.JSX.Element => {
    const on = choice === id;
    const hex = danger ? t.colors.bear : t.colors.primary;
    return (
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ checked: on }}
        onPress={() => setChoice(id)}
        style={[styles.choiceCard, { borderColor: on ? hex : t.colors.borderDark, backgroundColor: on ? t.alpha(hex, 0.05) : 'transparent' }]}
      >
        <View style={styles.optionHead}>
          <View style={[styles.radio, { borderColor: on ? hex : t.colors.borderDark }]}>
            {on ? <View style={[styles.radioDot, { backgroundColor: hex }]} /> : null}
          </View>
          <AppText variant="bodyStrong" weight="700">{title}</AppText>
        </View>
        <AppText variant="small" tone="secondary" style={styles.optionDesc}>{desc}</AppText>
      </Pressable>
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Stop copy trading?"
      footer={(
        <View style={styles.footer}>
          <Button title="Cancel" variant="ghost" onPress={onClose} disabled={saving} />
          <Button title={saving ? 'Stopping…' : 'Confirm stop'} onPress={() => { void confirm(); }} disabled={saving} />
        </View>
      )}
    >
      <View style={styles.stack}>
        <AppText variant="body" tone="secondary">
          {openCount > 0
            ? `This copy has ${openCount} open position(s). Choose what happens to them:`
            : 'New trades will stop being copied. You can resume this session later with the same settings.'}
        </AppText>
        {openCount > 0 ? (
          <>
            {Option({ id: 'close', title: 'Close automatically', desc: 'Market-close all open copied positions now.', danger: true })}
            {Option({ id: 'keep', title: 'Keep open (close manually)', desc: "Leave positions open — you'll close them yourself." })}
          </>
        ) : null}
      </View>
    </Modal>
  );
}

/* ── Create a copy box (CopyTrade.jsx BecomeMasterModal) ─────────────── */

export function BecomeMasterModal({ initialFee, onClose, onCreated }: { initialFee: number | null; onClose: () => void; onCreated: () => void }): React.JSX.Element {
  const [accounts, setAccounts] = useState<EligibleAccount[]>([]);
  const [accountId, setAccountId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [riskBadge, setRiskBadge] = useState<RiskBadge>('MEDIUM');
  const [isPublic, setIsPublic] = useState(true);
  const [feePct, setFeePct] = useState(initialFee === null ? '' : String(initialFee));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let dead = false;
    copyTradingApi.eligibleAccounts()
      .then((list) => {
        if (dead) return;
        setAccounts(list);
        const first = firstFreeAccount(list);
        if (first) setAccountId(first);
      })
      .catch((e: unknown) => { if (!dead) toast.error(errorMessage(e)); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, []);

  const create = async (): Promise<void> => {
    if (!accountId) { toast.error('Select a trading account'); return; }
    setSaving(true);
    try {
      await copyTradingApi.createBox({ accountId, displayName: displayName.trim(), riskBadge, isPublic, performanceFeePercent: feeInputToPayload(feePct) });
      toast.success('Copy box created');
      onCreated();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Become a master trader"
      footer={(
        <View style={styles.footer}>
          <Button title="Cancel" variant="ghost" onPress={onClose} disabled={saving} />
          <Button title={saving ? 'Creating…' : 'Create copy box'} onPress={() => { void create(); }} disabled={saving || !accountId} />
        </View>
      )}
    >
      <View style={styles.stack}>
        <View>
          <Label>Source trading account</Label>
          <AppText variant="caption" tone="muted" style={styles.hint}>
            {"Pick the account to copy from. Only this account's trades are mirrored to followers."}
          </AppText>
          {loading ? (
            <AppText variant="body" tone="muted">Loading accounts…</AppText>
          ) : accounts.length === 0 ? (
            <AppText variant="body" tone="muted">No active trading accounts found.</AppText>
          ) : (
            <Select
              value={accountId || null}
              placeholder="Select an account…"
              title="Source trading account"
              options={accounts.map((a) => ({
                value: a.accountId,
                label: `${a.accountNumber} (${a.accountType}) · INR${a.hasBox ? ' · box exists' : ''}${!a.acceptsFollowers ? ' · inactive' : ''}`,
                disabled: a.hasBox,
              }))}
              onChange={setAccountId}
            />
          )}
        </View>
        <View>
          <Label>Box name</Label>
          <Input value={displayName} onChangeText={setDisplayName} placeholder="e.g. Aggressive NIFTY Scalper" maxLength={40} />
        </View>
        <View>
          <Label>Risk badge</Label>
          <RiskPicker value={riskBadge} onChange={setRiskBadge} />
        </View>
        <PublicRow value={isPublic} onChange={setIsPublic} />
        <FeeField
          value={feePct}
          onChange={setFeePct}
          placeholder="Platform default"
          note="Your cut of each follower's profit on winning copied trades — credited to your Main Wallet. No fee on losses. Blank = platform default. This fee applies to this box only."
        />
      </View>
    </Modal>
  );
}

/* ── Edit a copy box (CopyTrade.jsx EditBoxModal) ────────────────────── */

export function EditBoxModal({ box, onClose, onSaved }: { box: CopyBox; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const t = useTheme();
  const [displayName, setDisplayName] = useState(box.displayName);
  const [riskBadge, setRiskBadge] = useState<RiskBadge>(box.riskBadge ?? 'MEDIUM');
  const [isPublic, setIsPublic] = useState(box.isPublic);
  const [feePct, setFeePct] = useState(box.feeOverride !== null ? String(box.feeOverride) : '');
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    const refusal = validateBoxForm({ displayName, isPublic });
    if (refusal) { toast.error(refusal); return; }
    setSaving(true);
    try {
      await copyTradingApi.updateBox(box.id, { displayName: displayName.trim(), riskBadge, isPublic, performanceFeePercent: feeInputToPayload(feePct) });
      toast.success('Copy box updated');
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit copy box"
      footer={(
        <View style={styles.footer}>
          <Button title="Cancel" variant="ghost" onPress={onClose} disabled={saving} />
          <Button title={saving ? 'Saving…' : 'Save changes'} onPress={() => { void save(); }} disabled={saving} />
        </View>
      )}
    >
      <View style={styles.stack}>
        <View style={[styles.source, { backgroundColor: t.colors.bgHover }]}>
          <AppText variant="small" tone="secondary">
            <AppText variant="small" weight="600">{box.accountType}</AppText>
            {` · ${box.accountNumber}`}
            <AppText variant="small" tone="muted">{" · source account can't be changed"}</AppText>
          </AppText>
        </View>
        <View>
          <Label>Box name</Label>
          <Input value={displayName} onChangeText={setDisplayName} placeholder="e.g. Aggressive NIFTY Scalper" maxLength={40} />
        </View>
        <View>
          <Label>Risk badge</Label>
          <RiskPicker value={riskBadge} onChange={setRiskBadge} />
        </View>
        <PublicRow value={isPublic} onChange={setIsPublic} />
        <FeeField
          value={feePct}
          onChange={setFeePct}
          placeholder={box.effectiveFee !== null ? `Default (${box.effectiveFee}%)` : 'Platform default'}
          note="Your cut of each follower's profit on winning copied trades — credited to your Main Wallet. No fee on losses. Blank = platform default. Applies to this box only."
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  stack: { gap: 16 },
  mt4: { marginTop: 4 },
  mt6: { marginTop: 6 },
  mt8: { marginTop: 8 },
  label: { letterSpacing: 0.8, marginBottom: 6 },
  hint: { marginBottom: 8 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  row3: { flexDirection: 'row', gap: 8 },
  choice: { flex: 1, borderWidth: 2, borderRadius: 12, paddingVertical: 8 },
  grid2: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  lot: { width: '48%', flexGrow: 1, borderWidth: 2, borderRadius: 12, padding: 10 },
  advancedHead: { paddingVertical: 4 },
  advanced: { gap: 12, marginTop: 8 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fee: { borderWidth: 1, borderRadius: 12, padding: 12 },
  feeHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  preview: { borderWidth: 1, borderRadius: 12, padding: 12 },
  previewRow: { flexDirection: 'row', gap: 12 },
  previewCell: { flex: 1, alignItems: 'center' },
  publicRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  choiceCard: { borderWidth: 2, borderRadius: 12, padding: 12, gap: 2 },
  optionHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  optionDesc: { marginLeft: 24, marginTop: 2 },
  radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 8, height: 8, borderRadius: 4 },
  source: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
});
