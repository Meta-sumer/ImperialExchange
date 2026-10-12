import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { api, errorMessage } from '../services/api';
import { useAccounts } from '../store/account';
import { usePrice } from '../hooks/usePrice';
import { useAccountPlans, feeGroupOf, planForType } from '../hooks/useAccountPlans';
import { useColors, radius, fmtNum, currencySymbol } from '../theme';
import { Card, Button, Row, Pill } from '../components/ui';

export default function OrderTicketScreen({ route, navigation }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const inst = route.params.instrument;
  const { accounts, selectedId, select } = useAccounts();
  const byCode = useAccountPlans();

  const [side, setSide] = useState(route.params.side || 'BUY');
  const [mode, setMode] = useState('MARKET'); // MARKET | LIMIT
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');
  const [busy, setBusy] = useState(false);

  const account = accounts.find((a) => a._id === selectedId) || accounts[0] || null;
  const quote = inst.quoteCurrency || 'USD';
  const qsym = currencySymbol(quote);
  const prec = inst.pricePrecision ?? 4;
  const live = usePrice(inst.symbol, inst.lastPrice);
  const last = Number(live) || 0;
  const qtyNum = Number(qty) || 0;
  const notional = last * qtyNum;
  const leverage = Number(account?.leverage) || 100;

  // ── Live fee breakdown (same model as the web) ──
  const fee = useMemo(() => {
    const plan = planForType(byCode, account?.accountType);
    const kind = String(plan?.feeKind || plan?.feeModel?.kind || '').toUpperCase();
    const val = Number(plan?.feeValue ?? plan?.feeModel?.value ?? 0);
    const group = feeGroupOf(kind);
    const rule = plan?.feeDisplay || '';
    const spreadAbs = inst.spreadType === 'PERCENTAGE'
      ? last * (Number(inst.spreadValue) || 0) / 100
      : Number(inst.spreadValue) || 0;
    const spreadCost = qtyNum > 0 ? spreadAbs * qtyNum : 0;
    let commission = 0, charges = 0, pending = false;
    if (group === 'Commission') commission = qtyNum > 0 ? notional * val : 0;
    else if (group === 'Charges') {
      if (kind === 'PCT_OF_PROFIT') pending = qtyNum > 0;
      else if (qtyNum > 0) charges = val;
    }
    const total = pending ? null : commission + charges + spreadCost;
    return { group, rule, commission, charges, spreadCost, pending, total };
  }, [byCode, account, notional, qtyNum, last, inst]);

  const submit = async () => {
    if (!account) { Alert.alert('No account', 'Select a trading account first.'); return; }
    if (qtyNum <= 0) { Alert.alert('Volume', 'Enter a volume greater than 0.'); return; }
    if (mode === 'LIMIT' && !(Number(price) > 0)) { Alert.alert('Price', 'Enter a limit price.'); return; }
    setBusy(true);
    try {
      const payload = {
        accountId: account._id,
        symbol: inst.symbol,
        side,
        orderMode: mode,
        quantity: String(qtyNum),
        leverage,
        idempotencyKey: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      };
      if (mode === 'LIMIT') payload.price = String(price);
      if (Number(sl) > 0) payload.stopLoss = String(sl);
      if (Number(tp) > 0) payload.takeProfit = String(tp);
      const { data } = await api.post('/trading/orders', payload);
      Alert.alert('Order placed', `${side} ${qtyNum} ${inst.symbol} — ${data.data.status}`, [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      Alert.alert('Order failed', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const buy = side === 'BUY';

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
      {/* Side + live price */}
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.sym}>{inst.symbol}</Text>
          <Text style={styles.last}>{qsym}{fmtNum(last, prec)}</Text>
        </Row>
        <Row style={{ marginTop: 12, gap: 10 }}>
          <Seg styles={styles} active={!buy} onPress={() => setSide('SELL')} label="SELL" tone={c.bear} />
          <Seg styles={styles} active={buy} onPress={() => setSide('BUY')} label="BUY" tone={c.bull} />
        </Row>
        <Row style={{ marginTop: 10, gap: 10 }}>
          <Seg styles={styles} active={mode === 'MARKET'} onPress={() => setMode('MARKET')} label="Market" tone={c.primary500} small />
          <Seg styles={styles} active={mode === 'LIMIT'} onPress={() => setMode('LIMIT')} label="Limit" tone={c.primary500} small />
        </Row>
      </Card>

      {/* Account picker */}
      <Card>
        <Text style={styles.lbl}>Trading account</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
          {accounts.map((a) => {
            const on = a._id === (account?._id);
            return (
              <TouchableOpacity key={a._id} onPress={() => select(a._id)} style={[styles.acct, on && { borderColor: c.primary500, backgroundColor: c.primarySoft }]}>
                <Text style={[styles.acctName, on && { color: c.primary500 }]}>{a.nickname || a.accountNumber}</Text>
                <Text style={styles.acctNum}>{a.baseCurrency} · {a.accountNumber}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </Card>

      {/* Inputs */}
      <Card>
        <Field styles={styles} c={c} label="Volume (lots)" value={qty} onChangeText={setQty} placeholder="e.g. 0.10" />
        {mode === 'LIMIT' && <Field styles={styles} c={c} label="Limit price" value={price} onChangeText={setPrice} placeholder={fmtNum(last, prec)} />}
        <Row style={{ gap: 12 }}>
          <View style={{ flex: 1 }}><Field styles={styles} c={c} label="Stop Loss" value={sl} onChangeText={setSl} placeholder="—" /></View>
          <View style={{ flex: 1 }}><Field styles={styles} c={c} label="Take Profit" value={tp} onChangeText={setTp} placeholder="—" /></View>
        </Row>
        <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
          <Text style={styles.metaLabel}>Notional</Text>
          <Text style={styles.metaValue}>{qsym}{fmtNum(notional, 2)}</Text>
        </Row>
        <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
          <Text style={styles.metaLabel}>Leverage</Text>
          <Text style={styles.metaValue}>1:{leverage}</Text>
        </Row>
      </Card>

      {/* Fee breakdown */}
      <Card>
        <Text style={styles.secTitle}>Estimated fee</Text>
        <FeeRow styles={styles} label="Commission" rule={fee.group === 'Commission' ? fee.rule : '—'} value={`${qsym}${fmtNum(fee.commission, 2)}`} />
        <FeeRow styles={styles} label="Charges" rule={fee.group === 'Charges' ? fee.rule : '—'} value={fee.pending ? 'Pending' : `${qsym}${fmtNum(fee.charges, 2)}`} />
        <FeeRow styles={styles} label="Spread Cost" rule="(ask − bid) × qty" value={`${qsym}${fmtNum(fee.spreadCost, 2)}`} />
        <View style={styles.hr} />
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.totalLbl}>Total ≈</Text>
          <Text style={styles.totalVal}>{fee.pending ? 'Pending' : `${qsym}${fmtNum(fee.total, 2)}`}</Text>
        </Row>
      </Card>

      <Button
        title={`${buy ? 'Buy' : 'Sell'} ${inst.symbol}`}
        onPress={submit}
        loading={busy}
        style={{ backgroundColor: buy ? c.bull : c.bear }}
      />
      <View style={{ height: 24 }} />
    </ScrollView>
  );
}

function Seg({ active, onPress, label, tone, small, styles }) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.seg, { height: small ? 36 : 44 }, active && { backgroundColor: tone, borderColor: tone }]}>
      <Text style={[styles.segText, active && { color: '#fff' }, small && { fontSize: 13 }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Field({ label, value, onChangeText, placeholder, styles, c }) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.lbl}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={c.textMuted}
        keyboardType="decimal-pad"
        style={styles.input}
      />
    </View>
  );
}

function FeeRow({ label, rule, value, styles }) {
  return (
    <Row style={{ justifyContent: 'space-between', marginBottom: 8 }}>
      <View style={{ flex: 1 }}>
        <Text style={styles.metaValue}>{label}</Text>
        <Text style={styles.metaLabel}>{rule}</Text>
      </View>
      <Text style={styles.metaValue}>{value}</Text>
    </Row>
  );
}

const makeStyles = (c) => StyleSheet.create({
  sym: { fontSize: 18, fontWeight: '800', color: c.textPrimary },
  last: { fontSize: 18, fontWeight: '800', color: c.textPrimary, fontVariant: ['tabular-nums'] },
  seg: { flex: 1, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  segText: { fontSize: 15, fontWeight: '800', color: c.textSecondary },
  lbl: { fontSize: 13, fontWeight: '700', color: c.textSecondary },
  input: { height: 48, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 16, color: c.textPrimary, backgroundColor: c.card, marginTop: 6 },
  acct: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8, marginRight: 8 },
  acctName: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
  acctNum: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  secTitle: { fontSize: 13, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase', marginBottom: 10, letterSpacing: 0.5 },
  metaLabel: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  metaValue: { fontSize: 14, color: c.textPrimary, fontWeight: '600' },
  hr: { height: 1, backgroundColor: c.borderSubtle, marginVertical: 8 },
  totalLbl: { fontSize: 15, fontWeight: '800', color: c.textPrimary },
  totalVal: { fontSize: 16, fontWeight: '900', color: c.textPrimary },
});
