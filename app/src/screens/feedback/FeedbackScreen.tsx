import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { feedbackApi } from '@/api/feedback.api';
import { TicketStatusChip } from '@/components/helpdesk/TicketStatusChip';
import { AppText, Button, Card, Input, Screen, toast } from '@/components/ui';
import { useTheme } from '@/theme';
import {
  TICKET_CATEGORIES,
  TICKET_LIMITS,
  applyTicketPush,
  ticketMeta,
  validateTicket,
  type Ticket,
  type TicketCategory,
} from '@/types/helpdesk';
import { fmtDateTime } from '@/utils/fundsFlows';
import { subscribeTickets } from '@/websocket/channels';

/**
 * Leave Feedback — client/src/pages/Feedback.jsx: the form (category tiles
 * with their hint, subject, message with a live character count, an
 * optional 1–5 star rating) and "Your Submissions" — the last 50 with
 * status chips and the team's reply, merged live from `user:tickets`.
 *
 * The category stays as it was after a send — the same person often files
 * several of one kind — and the history is re-read so the new entry shows.
 * On a phone the two columns stack, form first.
 */

const RATING_TITLES = ['', 'Very poor', 'Poor', 'Average', 'Good', 'Excellent'];

export function FeedbackScreen(): React.JSX.Element {
  const t = useTheme();
  const [items, setItems] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);

  const [category, setCategory] = useState<TicketCategory>('FEATURE');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [rating, setRating] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    try {
      const list = await feedbackApi.list();
      if (alive.current) setItems(list);
    } catch { /* keep the previous list on a transient error */ } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // An admin reply / status change arrives on `user:tickets`.
  useEffect(() => subscribeTickets((d) => setItems((prev) => applyTicketPush(prev, d))), []);

  const submit = async (): Promise<void> => {
    if (submitting) return;
    const refusal = validateTicket({ subject, message }, 'feedback');
    if (refusal) { toast.error(refusal); return; }
    setSubmitting(true);
    try {
      await feedbackApi.submit({ category, subject, message, rating: rating || null, page: '/feedback' });
      toast.success('Thanks — feedback received');
      setSubject('');
      setMessage('');
      setRating(0);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      if (alive.current) setSubmitting(false);
    }
  };

  const charsLeft = TICKET_LIMITS.messageMax - message.length;
  const charsBad = charsLeft < 0;
  const hint = TICKET_CATEGORIES.find((c) => c.value === category)?.hint ?? '';

  return (
    <Screen onRefresh={load} testID="feedback-screen">
      <View style={styles.page}>
        <View>
          <AppText variant="display">Leave Feedback</AppText>
          <AppText variant="body" tone="secondary" style={styles.sub}>
            Tell us what's working, what isn't, and what you'd love to see next. We read every submission.
          </AppText>
        </View>

        {/* ── Form ─────────────────────────────────────────────── */}
        <Card style={styles.form}>
          <View>
            <AppText variant="label" style={styles.label}>Category</AppText>
            <View style={styles.tiles}>
              {TICKET_CATEGORIES.map((c) => {
                const on = category === c.value;
                return (
                  <Pressable
                    key={c.value}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    accessibilityHint={c.hint}
                    onPress={() => setCategory(c.value)}
                    style={({ pressed }) => [styles.tile, {
                      borderColor: on ? t.colors.primary : t.colors.borderDark,
                      backgroundColor: on ? t.alpha(t.colors.primary, 0.1) : pressed ? t.colors.bgHover : 'transparent',
                    }]}
                  >
                    <AppText variant="bodyStrong" weight="500">{c.label}</AppText>
                  </Pressable>
                );
              })}
            </View>
            <AppText variant="caption" tone="muted" style={styles.hint}>{hint}</AppText>
          </View>

          <Input
            label="Subject"
            value={subject}
            onChangeText={setSubject}
            maxLength={TICKET_LIMITS.subjectMax}
            placeholder="One-line summary"
          />

          <View>
            <View style={styles.messageHead}>
              <AppText variant="label">Message</AppText>
              <AppText variant="micro" mono color={charsBad ? t.colors.bear : t.colors.textMuted}>{`${charsLeft} chars`}</AppText>
            </View>
            <Input
              value={message}
              onChangeText={setMessage}
              maxLength={TICKET_LIMITS.messageMax}
              placeholder="Steps to reproduce, screenshot links, what you expected vs. saw…"
              multiline
              numberOfLines={7}
              inputStyle={styles.textarea}
              accessibilityLabel="Message"
            />
          </View>

          <View>
            <AppText variant="label" style={styles.label}>Overall rating (optional)</AppText>
            <StarPicker value={rating} onChange={setRating} />
          </View>

          <View style={styles.footer}>
            <AppText variant="small" tone="muted" style={styles.flex}>
              We don't share your message externally. Submissions go to the product team.
            </AppText>
            <Button
              title={submitting ? 'Sending…' : 'Send Feedback'}
              onPress={() => { void submit(); }}
              disabled={submitting || charsBad}
            />
          </View>
        </Card>

        {/* ── History ──────────────────────────────────────────── */}
        <Card padded={false}>
          <View style={[styles.historyHead, { borderBottomColor: t.colors.borderDark }]}>
            <AppText variant="title" weight="600">Your Submissions</AppText>
            <AppText variant="caption" tone="muted">Latest 50 · status updates by team</AppText>
          </View>
          {loading ? (
            <AppText variant="body" tone="secondary" align="center" style={styles.state}>Loading…</AppText>
          ) : !items.length ? (
            <AppText variant="body" tone="secondary" align="center" style={styles.state}>No submissions yet.</AppText>
          ) : (
            items.map((it, i) => (
              <View
                key={it.id}
                style={[styles.row, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.borderSubtle } : null]}
              >
                <View style={styles.rowTop}>
                  <View style={styles.flex}>
                    <AppText variant="bodyStrong" weight="500" numberOfLines={1}>{it.subject}</AppText>
                    <AppText variant="caption" tone="muted">{`${fmtDateTime(it.createdAt)} · ${ticketMeta(it)}`}</AppText>
                  </View>
                  <TicketStatusChip status={it.status} />
                </View>
                {it.adminReply ? (
                  <View style={[styles.reply, { borderLeftColor: t.alpha(t.colors.primary, 0.4) }]}>
                    <AppText variant="caption" tone="secondary">
                      <AppText variant="caption" weight="600" color={t.colors.primaryText}>Team: </AppText>
                      {it.adminReply}
                    </AppText>
                  </View>
                ) : null}
              </View>
            ))
          )}
        </Card>
      </View>
    </Screen>
  );
}

/** Five stars; tapping the active star again clears it. */
function StarPicker({ value, onChange }: { value: number; onChange: (n: number) => void }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={styles.stars}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Pressable
          key={n}
          accessibilityRole="button"
          accessibilityLabel={`Rate ${n} star${n > 1 ? 's' : ''}`}
          accessibilityHint={RATING_TITLES[n]}
          accessibilityState={{ selected: n <= value }}
          hitSlop={4}
          onPress={() => onChange(value === n ? 0 : n)}
        >
          <AppText style={styles.star} color={n <= value ? t.colors.primary : t.colors.textMuted}>
            {n <= value ? '★' : '☆'}
          </AppText>
        </Pressable>
      ))}
      {value > 0 ? (
        <Pressable accessibilityRole="button" onPress={() => onChange(0)} hitSlop={6} style={styles.clear}>
          <AppText variant="caption" tone="muted">Clear</AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { gap: 24 },
  sub: { marginTop: 8 },
  form: { gap: 20 },
  label: { marginBottom: 8 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { width: '48%', padding: 12, borderRadius: 6, borderWidth: 1 },
  hint: { marginTop: 6 },
  messageHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  textarea: { minHeight: 150, textAlignVertical: 'top' },
  footer: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12, paddingTop: 8 },
  flex: { flex: 1, minWidth: 0 },
  historyHead: { paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1, gap: 2 },
  state: { padding: 32 },
  row: { paddingHorizontal: 20, paddingVertical: 12 },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  reply: { marginTop: 8, borderLeftWidth: 2, paddingLeft: 12 },
  stars: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  star: { fontSize: 26, lineHeight: 30 },
  clear: { marginLeft: 8 },
});
