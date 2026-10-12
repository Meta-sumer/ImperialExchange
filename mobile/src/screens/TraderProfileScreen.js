import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { api } from '../services/api';
import { useColors, fmtNum } from '../theme';
import { Card, Button, Row, Pill, Loader } from '../components/ui';

export default function TraderProfileScreen({ route, navigation }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const box = route.params.box; // leaderboard item { userId, accountId, displayName, roiPct, winRate, ... }
  const [stats, setStats] = useState(null);
  const [positions, setPositions] = useState([]);

  useEffect(() => {
    navigation.setOptions({ title: box.displayName || 'Trader' });
    const acc = box.accountId ? { accountId: box.accountId } : {};
    api.get(`/copy-trading/trader/${box.userId}`, { params: acc })
      .then(({ data }) => setStats(data?.data || {}))
      .catch(() => setStats({}));
    api.get(`/copy-trading/trader/${box.userId}/positions`, { params: acc })
      .then(({ data }) => setPositions(data?.data || []))
      .catch(() => {});
  }, [box, navigation]);

  if (stats == null) return <Loader label="Loading trader…" />;

  const roi = Number(stats.totalROI ?? box.roiPct ?? 0);
  const win = Number(stats.winRate ?? box.winRate ?? 0);
  const trades = Number(stats.totalTrades ?? box.totalTrades ?? 0);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Card>
        <Row style={{ gap: 12 }}>
          <View style={styles.avatar}><Text style={styles.avatarText}>{(box.displayName || 'T').slice(0, 2).toUpperCase()}</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{box.displayName || box.ownerName || 'Trader'}</Text>
            <Text style={styles.sub}>{box.accountType} · {box.followers || 0} copying</Text>
          </View>
        </Row>
        <Row style={{ marginTop: 14, justifyContent: 'space-between' }}>
          <Stat label="ROI" value={`${roi >= 0 ? '+' : ''}${fmtNum(roi, 2)}%`} tone={roi >= 0 ? c.bull : c.bear} styles={styles} />
          <Stat label="Win rate" value={`${fmtNum(win, 0)}%`} styles={styles} />
          <Stat label="Trades" value={String(trades)} styles={styles} />
        </Row>
      </Card>

      <Button title={`Copy ${box.displayName || 'trader'}`} onPress={() => navigation.navigate('CopySetup', { trader: box })} />

      <Text style={styles.secTitle}>Open positions ({positions.length})</Text>
      {positions.length === 0 ? (
        <Card><Text style={styles.sub}>No open positions right now.</Text></Card>
      ) : positions.map((p, i) => (
        <Card key={p._id || i}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Row style={{ gap: 8 }}>
              <Text style={styles.name}>{p.symbol}</Text>
              <Pill label={p.side === 'BUY' ? 'BUY' : 'SELL'} tone={p.side === 'BUY' ? 'bull' : 'bear'} />
            </Row>
            <Text style={styles.sub}>{fmtNum(p.quantity, 4)} @ {fmtNum(p.entryPrice, 4)}</Text>
          </Row>
        </Card>
      ))}
      <View style={{ height: 24 }} />
    </ScrollView>
  );
}

function Stat({ label, value, tone, styles }) {
  return (
    <View>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, tone && { color: tone }]}>{value}</Text>
    </View>
  );
}

const makeStyles = (c) => StyleSheet.create({
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: c.primary500, fontWeight: '900', fontSize: 18 },
  name: { fontSize: 16, fontWeight: '800', color: c.textPrimary },
  sub: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  statLabel: { fontSize: 12, color: c.textMuted, fontWeight: '600' },
  statValue: { fontSize: 18, fontWeight: '900', color: c.textPrimary, marginTop: 2, fontVariant: ['tabular-nums'] },
  secTitle: { fontSize: 13, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
});
