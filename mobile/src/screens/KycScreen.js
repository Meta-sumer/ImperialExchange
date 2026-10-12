import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, Image } from 'react-native';
import { api, errorMessage } from '../services/api';
import { pickImageBase64 } from '../services/imagePicker';
import { useColors, radius } from '../theme';
import { Card, Button, Row, Pill, Loader } from '../components/ui';

const DOC_TYPES = [
  { id: 'ID_FRONT', label: 'ID (front)' },
  { id: 'ID_BACK', label: 'ID (back)' },
  { id: 'SELFIE', label: 'Selfie' },
  { id: 'ADDRESS_PROOF', label: 'Address proof' },
];
const toneFor = (s) => (s === 'APPROVED' ? 'bull' : s === 'REJECTED' ? 'bear' : 'warn');

export default function KycScreen() {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const [docType, setDocType] = useState('ID_FRONT');
  const [picked, setPicked] = useState(null);
  const [docs, setDocs] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { const { data } = await api.get('/compliance/kyc/documents'); setDocs(data?.data || []); }
    catch { setDocs([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const pick = async () => {
    const img = await pickImageBase64();
    if (img) setPicked(img);
  };

  const upload = async () => {
    if (!picked) { Alert.alert('Image', 'Pick a document image first.'); return; }
    setBusy(true);
    try {
      await api.post('/compliance/kyc/documents', {
        docType,
        filename: picked.fileName,
        mimeType: picked.mimeType,
        dataBase64: picked.base64,
      });
      setPicked(null);
      Alert.alert('Uploaded', 'Document submitted for review.');
      load();
    } catch (e) {
      Alert.alert('Upload failed', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Card>
        <Text style={styles.lbl}>Document type</Text>
        <Row style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {DOC_TYPES.map((d) => (
            <TouchableOpacity key={d.id} onPress={() => setDocType(d.id)} style={[styles.chip, docType === d.id && { borderColor: c.primary500, backgroundColor: c.primarySoft }]}>
              <Text style={[styles.chipText, docType === d.id && { color: c.primary500 }]}>{d.label}</Text>
            </TouchableOpacity>
          ))}
        </Row>

        <TouchableOpacity onPress={pick} style={styles.dropzone}>
          {picked ? (
            <Image source={{ uri: picked.uri }} style={styles.preview} resizeMode="cover" />
          ) : (
            <Text style={{ color: c.textMuted }}>Tap to pick an image</Text>
          )}
        </TouchableOpacity>

        <Button title="Upload document" onPress={upload} loading={busy} disabled={!picked} style={{ marginTop: 12 }} />
      </Card>

      <Text style={styles.secTitle}>Your documents</Text>
      {docs == null ? <Loader /> : docs.length === 0 ? (
        <Card><Text style={{ color: c.textMuted }}>No documents uploaded yet.</Text></Card>
      ) : docs.map((d) => (
        <Card key={d._id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View>
              <Text style={styles.name}>{(d.docType || '').replace(/_/g, ' ')}</Text>
              <Text style={styles.sub}>{d.originalFilename || ''}</Text>
              {d.status === 'REJECTED' && d.rejectionReason ? <Text style={styles.rej}>Reason: {d.rejectionReason}</Text> : null}
            </View>
            <Pill label={d.status} tone={toneFor(d.status)} />
          </Row>
        </Card>
      ))}
      <View style={{ height: 24 }} />
    </ScrollView>
  );
}

const makeStyles = (c) => StyleSheet.create({
  lbl: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
  chip: { borderWidth: 1, borderColor: c.border, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8 },
  chipText: { fontSize: 13, fontWeight: '700', color: c.textSecondary },
  dropzone: { marginTop: 12, height: 170, borderWidth: 1.5, borderStyle: 'dashed', borderColor: c.border, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: c.hover },
  preview: { width: '100%', height: '100%' },
  secTitle: { fontSize: 13, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
  name: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
  sub: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  rej: { fontSize: 12, color: c.bear, marginTop: 3 },
});
