import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, TouchableOpacity, Alert, Image } from 'react-native';
import { api, errorMessage } from '../services/api';
import { pickImageBase64 } from '../services/imagePicker';
import { useAccounts } from '../store/account';
import { useColors, radius, currencySymbol, fmtNum } from '../theme';
import { Card, Button, Row } from '../components/ui';

const isDemo = (t) => ['DEMO', 'VIRTUAL'].includes(String(t || '').toUpperCase());
const METHODS = ['UPI', 'BANK', 'CRYPTO'];

export default function FundScreen({ route, navigation }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const [mode, setMode] = useState(route.params?.mode || 'deposit'); // deposit | withdraw
  const { accounts, selectedId, select } = useAccounts();
  const account = accounts.find((a) => a._id === selectedId) || accounts[0] || null;
  const demo = isDemo(account?.accountType);
  const cur = account?.baseCurrency || 'USD';

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('UPI');
  const [reference, setReference] = useState('');
  const [upiId, setUpiId] = useState('');
  const [bankNo, setBankNo] = useState('');
  const [bankIfsc, setBankIfsc] = useState('');
  const [bankHolder, setBankHolder] = useState('');
  const [bankName, setBankName] = useState('');
  const [cryptoAddr, setCryptoAddr] = useState('');
  const [proof, setProof] = useState(null);
  const [busy, setBusy] = useState(false);

  const pickProof = async () => { const img = await pickImageBase64(); if (img) setProof(img); };

  React.useEffect(() => { navigation.setOptions({ title: mode === 'deposit' ? 'Deposit' : 'Withdraw' }); }, [mode, navigation]);

  const submit = async () => {
    const amt = Number(amount);
    if (!account) { Alert.alert('Account', 'Select a trading account.'); return; }
    if (!(amt > 0)) { Alert.alert('Amount', 'Enter an amount greater than 0.'); return; }
    setBusy(true);
    try {
      if (mode === 'deposit') {
        const payload = { accountId: account._id, currency: cur, amount: String(amt), method, txReference: reference };
        if (!demo && proof) { payload.screenshot = proof.base64; payload.screenshotMimeType = proof.mimeType; }
        await api.post('/wallet/deposits', payload);
        Alert.alert('Submitted', demo ? 'Demo balance added.' : 'Deposit submitted — pending verification.', [{ text: 'OK', onPress: () => navigation.goBack() }]);
      } else {
        const payload = { accountId: account._id, currency: cur, amount: String(amt), method };
        if (method === 'UPI') payload.upiId = upiId.trim();
        if (method === 'BANK') { payload.bankAccountNumber = bankNo.trim(); payload.bankIFSC = bankIfsc.trim().toUpperCase(); payload.bankAccountHolderName = bankHolder.trim(); payload.bankName = bankName.trim(); }
        if (method === 'CRYPTO') { payload.cryptoAddress = cryptoAddr.trim(); payload.cryptoNetwork = 'TRC20'; }
        await api.post('/wallet/withdrawals', payload);
        Alert.alert('Submitted', 'Withdrawal request submitted.', [{ text: 'OK', onPress: () => navigation.goBack() }]);
      }
    } catch (e) {
      Alert.alert(mode === 'deposit' ? 'Deposit failed' : 'Withdrawal failed', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
      <Row style={{ gap: 10 }}>
        <Seg styles={styles} c={c} active={mode === 'deposit'} onPress={() => setMode('deposit')} label="Deposit" />
        <Seg styles={styles} c={c} active={mode === 'withdraw'} onPress={() => setMode('withdraw')} label="Withdraw" />
      </Row>

      <Card>
        <Text style={styles.lbl}>Account</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
          {accounts.map((a) => {
            const on = a._id === account?._id;
            return (
              <TouchableOpacity key={a._id} onPress={() => select(a._id)} style={[styles.acct, on && { borderColor: c.primary500, backgroundColor: c.primarySoft }]}>
                <Text style={[styles.acctName, on && { color: c.primary500 }]}>{a.nickname || a.accountNumber}</Text>
                <Text style={styles.acctNum}>{a.baseCurrency}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </Card>

      <Card>
        <Text style={styles.lbl}>Amount ({cur})</Text>
        <Row style={{ alignItems: 'center', marginTop: 6 }}>
          <Text style={styles.cur}>{currencySymbol(cur)}</Text>
          <TextInput value={amount} onChangeText={setAmount} placeholder="0.00" placeholderTextColor={c.textMuted} keyboardType="decimal-pad" style={[styles.input, { flex: 1 }]} />
        </Row>

        <Text style={[styles.lbl, { marginTop: 14 }]}>Method</Text>
        <Row style={{ gap: 8, marginTop: 8 }}>
          {METHODS.map((mth) => (
            <TouchableOpacity key={mth} onPress={() => setMethod(mth)} style={[styles.mchip, method === mth && { borderColor: c.primary500, backgroundColor: c.primarySoft }]}>
              <Text style={[styles.mchipText, method === mth && { color: c.primary500 }]}>{mth}</Text>
            </TouchableOpacity>
          ))}
        </Row>

        {mode === 'deposit' ? (
          <Field styles={styles} c={c} label="Reference / txn id (optional)" value={reference} onChangeText={setReference} />
        ) : method === 'UPI' ? (
          <Field styles={styles} c={c} label="UPI ID" value={upiId} onChangeText={setUpiId} placeholder="name@bank" />
        ) : method === 'BANK' ? (
          <>
            <Field styles={styles} c={c} label="Account number" value={bankNo} onChangeText={setBankNo} />
            <Field styles={styles} c={c} label="IFSC" value={bankIfsc} onChangeText={setBankIfsc} />
            <Field styles={styles} c={c} label="Account holder" value={bankHolder} onChangeText={setBankHolder} />
            <Field styles={styles} c={c} label="Bank name" value={bankName} onChangeText={setBankName} />
          </>
        ) : (
          <Field styles={styles} c={c} label="Crypto address (TRC20)" value={cryptoAddr} onChangeText={setCryptoAddr} />
        )}
      </Card>

      {mode === 'deposit' && !demo ? (
        <Card>
          <Text style={styles.lbl}>Payment proof</Text>
          <TouchableOpacity onPress={pickProof} style={styles.dropzone}>
            {proof ? <Image source={{ uri: proof.uri }} style={styles.preview} resizeMode="cover" /> : <Text style={{ color: c.textMuted }}>Tap to attach the UPI/bank receipt</Text>}
          </TouchableOpacity>
          <Text style={styles.note}>Admin verifies the deposit against this receipt.</Text>
        </Card>
      ) : null}

      <Button title={mode === 'deposit' ? 'Submit deposit' : 'Request withdrawal'} onPress={submit} loading={busy} />
      <View style={{ height: 24 }} />
    </ScrollView>
  );
}

function Seg({ active, onPress, label, styles, c }) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.seg, active && { backgroundColor: c.primary500, borderColor: c.primary500 }]}>
      <Text style={[styles.segText, active && { color: '#fff' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Field({ label, value, onChangeText, placeholder, styles, c }) {
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={styles.lbl}>{label}</Text>
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={c.textMuted} autoCapitalize="none" style={styles.input} />
    </View>
  );
}

const makeStyles = (c) => StyleSheet.create({
  seg: { flex: 1, height: 44, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  segText: { fontSize: 15, fontWeight: '800', color: c.textSecondary },
  lbl: { fontSize: 13, fontWeight: '700', color: c.textSecondary },
  input: { height: 48, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 16, color: c.textPrimary, backgroundColor: c.card, marginTop: 6 },
  cur: { fontSize: 18, fontWeight: '800', color: c.textMuted, marginRight: 8 },
  acct: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8, marginRight: 8 },
  acctName: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
  acctNum: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  mchip: { borderWidth: 1, borderColor: c.border, borderRadius: radius.pill, paddingHorizontal: 16, paddingVertical: 8 },
  mchipText: { fontSize: 13, fontWeight: '700', color: c.textSecondary },
  note: { fontSize: 12, color: c.textMuted, lineHeight: 18, marginTop: 8 },
  dropzone: { marginTop: 8, height: 150, borderWidth: 1.5, borderStyle: 'dashed', borderColor: c.border, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: c.hover },
  preview: { width: '100%', height: '100%' },
});
