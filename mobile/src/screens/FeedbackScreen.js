import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { useColors, radius } from '../theme';
import { Loader, Empty, Button } from '../components/ui';

/**
 * FeedbackScreen — native port of the web client's Feedback page
 * (client/src/pages/Feedback.jsx). Mirrors it section-for-section:
 *   • header      ("Leave Feedback" + intro copy)
 *   • form        (category chips · subject · message + char counter ·
 *                  optional star rating · submit)
 *   • history     ("Your Submissions" — latest 50 with status badges and
 *                  team replies)
 *
 * The web lays form + history side-by-side (lg:grid-cols-5); on mobile the two
 * columns stack vertically inside one ScrollView. Same endpoints, same params:
 *   GET  /user/feedback        → latest 50 submissions
 *   POST /user/feedback        → { category, subject, message, rating, context }
 *   WS   user:tickets          → admin reply / status change merged into history
 */

const CATEGORIES = [
  { value: 'BUG', label: '🐛 Bug Report', hint: 'Something broken or crashing' },
  { value: 'FEATURE', label: '✨ Feature Request', hint: 'New capability or idea' },
  { value: 'UX', label: '🎨 UX / Design', hint: 'Layout, copy, friction points' },
  { value: 'SUPPORT', label: '🤝 Support', hint: 'Account or trade-specific help' },
  { value: 'OTHER', label: '💬 Other', hint: 'General comments' },
];

// Client-snapshot context sent with each submission (admins use it to
// reproduce). The web sends window.location.pathname + VITE_APP_VERSION; the
// native adaptation flags the source app instead.
const APP_VERSION = 'mobile';

// ─── Pure helpers (take `c` as a param — never a module-scope colour) ───────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');
function fmtDate(d) {
  if (!d) return '-';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '-';
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}, ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
}

// Status → accent colour (mirrors the web STATUS_STYLES). info/warn are the
// same blue in the mobile palette, so OPEN + IN_PROGRESS share c.warn.
function statusTone(status, c) {
  const map = {
    OPEN: c.warn,
    TRIAGED: c.primary500,
    IN_PROGRESS: c.warn,
    RESOLVED: c.bull,
    WONT_FIX: c.bear,
  };
  return map[status] || c.warn;
}

// ─── Five-star picker (native: tap-to-set, tap-again-to-clear; no hover) ────
function StarPicker({ value, onChange, styles, c }) {
  return (
    <View style={styles.starRow}>
      {[1, 2, 3, 4, 5].map((n) => (
        <TouchableOpacity
          key={n}
          activeOpacity={0.7}
          onPress={() => onChange(value === n ? 0 : n)}
          hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
          style={styles.starBtn}
          accessibilityLabel={`Rate ${n} star${n > 1 ? 's' : ''}`}
        >
          <Text style={[styles.star, { color: n <= value ? c.primary500 : c.textMuted }]}>
            {n <= value ? '★' : '☆'}
          </Text>
        </TouchableOpacity>
      ))}
      {value > 0 && (
        <TouchableOpacity onPress={() => onChange(0)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.clear}>Clear</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─── One history row (subject · meta · status badge · team reply) ───────────
function SubmissionRow({ item, first, styles, c }) {
  const tone = statusTone(item.status, c);
  const stars = item.rating != null ? '★'.repeat(item.rating) : '';
  return (
    <View style={[styles.subRow, !first && styles.subDivider]}>
      <View style={styles.subTop}>
        <View style={styles.subMain}>
          <Text style={styles.subSubject} numberOfLines={1}>{item.subject}</Text>
          <Text style={styles.subMeta} numberOfLines={1}>
            {fmtDate(item.createdAt)} · {item.category}{stars ? ` · ${stars}` : ''}
          </Text>
        </View>
        <View style={[styles.badge, { backgroundColor: tone + '26', borderColor: tone + '4D' }]}>
          <Text style={[styles.badgeTxt, { color: tone }]}>
            {String(item.status || 'OPEN').replace(/_/g, ' ')}
          </Text>
        </View>
      </View>
      {item.adminReply ? (
        <View style={[styles.reply, { borderLeftColor: c.primary500 + '66' }]}>
          <Text style={styles.replyTxt}>
            <Text style={[styles.replyTeam, { color: c.primary500 }]}>Team: </Text>
            {item.adminReply}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// ─── Screen ─────────────────────────────────────────────────────────────────
export default function FeedbackScreen() {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  // Form state
  const [category, setCategory] = useState('FEATURE');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [rating, setRating] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    try {
      const { data } = await api.get('/user/feedback');
      setItems(data.data);
    } catch (_) { /* keep previous list on transient error */ }
    finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Live: admin reply / status change pushes on `user:tickets` → merge it into
  // the matching row (or prepend) so history updates without a refresh.
  useEffect(() => {
    const unsub = wsClient.subscribe('user:tickets', (d) => {
      const t = d?.ticket;
      if (!t?._id) return;
      setItems((prev) => {
        const i = prev.findIndex((x) => x._id === t._id);
        if (i === -1) return [t, ...prev];
        const next = prev.slice();
        next[i] = { ...next[i], ...t };
        return next;
      });
    });
    return () => unsub && unsub();
  }, []);

  const submit = async () => {
    if (subject.trim().length < 3) { Alert.alert('Subject too short', 'Please enter at least 3 characters.'); return; }
    if (message.trim().length < 10) { Alert.alert('Message too short', 'Please enter at least 10 characters.'); return; }
    setSubmitting(true);
    try {
      await api.post('/user/feedback', {
        category,
        subject,
        message,
        rating: rating || null,
        context: { page: 'mobile:Feedback', appVersion: APP_VERSION },
      });
      Alert.alert('Thanks — feedback received', 'The product team reads every submission.');
      setSubject('');
      setMessage('');
      setRating(0);
      // Don't reset category — same user often files multiple of same kind.
      await load();
    } catch (err) {
      Alert.alert('Could not send feedback', errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const charsLeft = 4000 - message.length;
  const charsBad = charsLeft < 0;
  const activeHint = CATEGORIES.find((x) => x.value === category)?.hint;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      {/* ─── Header ─────────────────────────────────────────────────── */}
      <View>
        <Text style={styles.h1}>Leave Feedback</Text>
        <Text style={styles.sub}>
          Tell us what's working, what isn't, and what you'd love to see next. We read every submission.
        </Text>
      </View>

      {/* ─── Form ───────────────────────────────────────────────────── */}
      <View style={styles.card}>
        <View style={{ gap: 18 }}>
          {/* Category */}
          <View>
            <Text style={styles.label}>Category</Text>
            <View style={styles.chipGrid}>
              {CATEGORIES.map((cat) => {
                const on = category === cat.value;
                return (
                  <TouchableOpacity
                    key={cat.value}
                    activeOpacity={0.8}
                    onPress={() => setCategory(cat.value)}
                    style={[styles.chip, on && styles.chipOn]}
                  >
                    <Text style={[styles.chipTxt, on && styles.chipTxtOn]}>{cat.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {activeHint ? <Text style={styles.hint}>{activeHint}</Text> : null}
          </View>

          {/* Subject */}
          <View>
            <Text style={styles.label}>Subject</Text>
            <TextInput
              value={subject}
              onChangeText={setSubject}
              maxLength={200}
              placeholder="One-line summary"
              placeholderTextColor={c.textMuted}
              style={styles.input}
            />
          </View>

          {/* Message */}
          <View>
            <View style={styles.msgLabelRow}>
              <Text style={[styles.label, { marginBottom: 0 }]}>Message</Text>
              <Text style={[styles.counter, charsBad && { color: c.bear }]}>{charsLeft} chars</Text>
            </View>
            <TextInput
              value={message}
              onChangeText={setMessage}
              maxLength={4000}
              multiline
              placeholder="Steps to reproduce, screenshot links, what you expected vs. saw…"
              placeholderTextColor={c.textMuted}
              style={styles.textarea}
            />
          </View>

          {/* Rating */}
          <View>
            <Text style={styles.label}>Overall rating (optional)</Text>
            <StarPicker value={rating} onChange={setRating} styles={styles} c={c} />
          </View>

          {/* Submit */}
          <View>
            <Text style={styles.disclaimer}>
              We don't share your message externally. Submissions go to the product team.
            </Text>
            <Button
              title={submitting ? 'Sending…' : 'Send Feedback'}
              onPress={submit}
              loading={submitting}
              disabled={submitting || charsBad}
            />
          </View>
        </View>
      </View>

      {/* ─── History ────────────────────────────────────────────────── */}
      <View style={styles.card}>
        <View style={styles.histHead}>
          <Text style={styles.histTitle}>Your Submissions</Text>
          <Text style={styles.histSub}>Latest 50 · status updates by team</Text>
        </View>
        {loading ? (
          <Loader label="Loading…" />
        ) : !items.length ? (
          <Empty title="No submissions yet." sub="Your feedback will appear here once you send it." />
        ) : (
          <View>
            {items.map((it, idx) => (
              <SubmissionRow key={it._id} item={it} first={idx === 0} styles={styles} c={c} />
            ))}
          </View>
        )}
      </View>

      <View style={{ height: 24 }} />
    </ScrollView>
  );
}

const makeStyles = (c) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  content: { padding: 16, gap: 16 },

  // Header
  h1: { fontSize: 26, fontWeight: '900', color: c.textPrimary },
  sub: { fontSize: 13, color: c.textSecondary, marginTop: 8, lineHeight: 19 },

  // Shared card
  card: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.xl, padding: 16 },

  // Form fields
  label: { fontSize: 12, fontWeight: '700', color: c.textSecondary, letterSpacing: 0.3, marginBottom: 8 },
  input: { height: 48, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 16, color: c.textPrimary, backgroundColor: c.bg },
  textarea: { minHeight: 132, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, fontSize: 16, color: c.textPrimary, backgroundColor: c.bg, textAlignVertical: 'top', lineHeight: 22 },

  msgLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  counter: { fontSize: 11, color: c.textMuted, fontVariant: ['tabular-nums'] },

  // Category chips (2-col grid on mobile → mirrors web grid-cols-2)
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 8 },
  chip: { width: '48%', minHeight: 48, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg },
  chipOn: { borderColor: c.primary500, backgroundColor: c.primarySoft },
  chipTxt: { fontSize: 13, fontWeight: '600', color: c.textPrimary },
  chipTxtOn: { color: c.primary500 },
  hint: { fontSize: 11, color: c.textMuted, marginTop: 8 },

  // Star picker
  starRow: { flexDirection: 'row', alignItems: 'center' },
  starBtn: { paddingHorizontal: 3, paddingVertical: 2 },
  star: { fontSize: 28, lineHeight: 32 },
  clear: { marginLeft: 10, fontSize: 12, color: c.textMuted, fontWeight: '600' },

  disclaimer: { fontSize: 12, color: c.textMuted, lineHeight: 18, marginBottom: 12 },

  // History
  histHead: { paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: c.borderSubtle, marginBottom: 4 },
  histTitle: { fontSize: 15, fontWeight: '800', color: c.textPrimary },
  histSub: { fontSize: 11, color: c.textMuted, marginTop: 3 },

  subRow: { paddingVertical: 12 },
  subDivider: { borderTopWidth: 1, borderTopColor: c.borderSubtle },
  subTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  subMain: { flex: 1, minWidth: 0 },
  subSubject: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
  subMeta: { fontSize: 11, color: c.textMuted, marginTop: 3 },

  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  badgeTxt: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },

  reply: { marginTop: 8, borderLeftWidth: 2, paddingLeft: 10 },
  replyTxt: { fontSize: 12, color: c.textSecondary, lineHeight: 18 },
  replyTeam: { fontWeight: '700' },
});
