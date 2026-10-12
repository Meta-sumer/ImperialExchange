import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, TouchableOpacity, Switch, Alert } from 'react-native';
import { api, errorMessage } from '../services/api';
import { useAccounts } from '../store/account';
import { useColors, radius } from '../theme';
import { Card, Button, Row } from '../components/ui';

const isDemo = (t) => ['DEMO', 'VIRTUAL'].includes(String(t || '').toUpperCase());
const LOT_MODES = [
  { id: 'LOW', label: '0.5× master' },
  { id: 'MEDIUM', label: '1× master' },
  { id: 'HIGH', label: '1.5× master' },
  { id: 'CUSTOM', label: 'Fixed lot' },
];

export default function CopySetupScreen({ route, navigation }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const trader = route.params.trader; // { accountId, userId, displayName }
  const { accounts, selectedId, select } = useAccounts();
  // Copy only into REAL accounts.
  const real = accounts.filter((a) => !isDemo(a.accountType));
  const [followerId, setFollowerId] = useState(real.find((a) => a._id === selectedId)?._id || real[0]?._id || null);

  const [lotMode, setLotMode] = useState('MEDIUM');
  const [customLot, setCustomLot] = useState('0.10');
  const [maxLot, setMaxLot] = useState('');
  const [copySL, setCopySL] = useState(true);
  const [copyTP, setCopyTP] = useState(true);
  const [copyPending, setCopyPending] = useState(false);
  const [busy, setBusy] = useState(false);

  React.useEffect(() => { navigation.setOptions({ title: `Copy ${trader.displayName || 'trader'}` }); }, [navigation, trader]);

  const submit = async () => {
    if (!followerId) { Alert.alert('Account', 'Select a real account to copy into.'); return; }
    if (lotMode === 'CUSTOM' && !(Number(customLot) > 0)) { Alert.alert('Lot', 'Enter a custom lot > 0.'); return; }
    setBusy(true);
    try {
      await api.post('/copy-trading/copy', {
        masterAccountId: trader.accountId,
        followerAccountId: followerId,
        lotMode,
        customLot: lotMode === 'CUSTOM' ? customLot : null,
        maxLot: maxLot.trim() === '' ? '' : maxLot,
        copySL, copyTP, copyPending,
      });
      Alert.alert('Copying', `Now copying ${trader.displayName}.`, [{ text: 'OK', onPress: () => navigation.goBack() }]);
    } catch (e) {
      Alert.alert('Failed', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
      <Card>
        <Text style={styles.lbl}>Copy into account</Text>
        {real.length === 0 ? (
          <Text style={styles.note}>You need a live (real) account to copy. Create one first.</Text>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
            {real.map((a) => {
              const on = a._id === followerId;
              return (
                <TouchableOpacity key={a._id} onPress={() => { setFollowerId(a._id); select(a._id); }} style={[styles.acct, on && { borderColor: c.primary500, backgroundColor: c.primarySoft }]}>
                  <Text style={[styles.acctName, on && { color: c.primary500 }]}>{a.nickname || a.accountNumber}</Text>
                  <Text style={styles.acctNum}>{a.baseCurrency}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}
      </Card>

      <Card>
        <Text style={styles.lbl}>Lot size</Text>
        <View style={{ gap: 8, marginTop: 8 }}>
          {LOT_MODES.map((m) => (
            <TouchableOpacity key={m.id} onPress={() => setLotMode(m.id)} style={[styles.lot, lotMode === m.id && { borderColor: c.primary500, backgroundColor: c.primarySoft }]}>
              <Text style={[styles.lotLabel, lotMode === m.id && { color: c.primary500 }]}>{m.label}</Text>
              <View style={[styles.radio, lotMode === m.id && { borderColor: c.primary500 }]}>{lotMode === m.id ? <View style={styles.radioOn} /> : null}</View>
            </TouchableOpacity>
          ))}
        </View>
        {lotMode === 'CUSTOM' && (
          <View style={{ marginTop: 10 }}>
            <Text style={styles.sublbl}>Fixed lot per trade</Text>
            <TextInput value={customLot} onChangeText={setCustomLot} keyboardType="decimal-pad" style={styles.input} />
          </View>
        )}
        <View style={{ marginTop: 10 }}>
          <Text style={styles.sublbl}>Max lot (optional)</Text>
          <TextInput value={maxLot} onChangeText={setMaxLot} keyboardType="decimal-pad" placeholder="No cap" placeholderTextColor={c.textMuted} style={styles.input} />
        </View>
      </Card>

      <Card>
        <Toggle label="Copy Stop Loss" value={copySL} onValueChange={setCopySL} styles={styles} c={c} />
        <Toggle label="Copy Take Profit" value={copyTP} onValueChange={setCopyTP} styles={styles} c={c} />
        <Toggle label="Copy pending orders" value={copyPending} onValueChange={setCopyPending} styles={styles} c={c} />
      </Card>

      <Text style={styles.note}>The master's performance fee (if any) applies to profitable copied trades. Copying uses your account's own margin.</Text>
      <Button title={`Copy ${trader.displayName || 'trader'}`} onPress={submit} loading={busy} disabled={real.length === 0} />
      <View style={{ height: 24 }} />
    </ScrollView>
  );
}

function Toggle({ label, value, onValueChange, styles, c }) {
  return (
    <Row style={{ justifyContent: 'space-between', paddingVertical: 8 }}>
      <Text style={styles.tgl}>{label}</Text>
      <Switch value={value} onValueChange={onValueChange} trackColor={{ true: c.primary500 }} />
    </Row>
  );
}

const makeStyles = (c) => StyleSheet.create({
  lbl: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
  sublbl: { fontSize: 12, fontWeight: '700', color: c.textSecondary, marginBottom: 6 },
  input: { height: 46, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, fontSize: 15, color: c.textPrimary, backgroundColor: c.card },
  acct: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8, marginRight: 8 },
  acctName: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
  acctNum: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  lot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12 },
  lotLabel: { fontSize: 14, fontWeight: '700', color: c.textSecondary },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  radioOn: { width: 10, height: 10, borderRadius: 5, backgroundColor: c.primary500 },
  tgl: { fontSize: 15, fontWeight: '600', color: c.textPrimary },
  note: { fontSize: 12, color: c.textMuted, lineHeight: 18 },
});
