import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';

import { cmsApi } from '@/api/cms.api';
import { errorMessage } from '@/api/client';
import { feedbackApi } from '@/api/feedback.api';
import { HelpdeskChatPanel } from '@/components/helpdesk/HelpdeskChatPanel';
import { TicketStatusChip } from '@/components/helpdesk/TicketStatusChip';
import { AppText, Button, Card, Input, Screen, Select, Tabs, toast } from '@/components/ui';
import { navigateToPath } from '@/navigation/linking';
import type { AppScreenProps, HelpdeskTab } from '@/navigation/types';
import { useTheme } from '@/theme';
import {
  TICKET_LIMITS,
  applyTicketPush,
  parseChatSocketEvent,
  validateTicket,
  validateTicketAttachment,
  type Ticket,
  type TicketCategoryOption,
} from '@/types/helpdesk';
import { fmtDateTime } from '@/utils/fundsFlows';
import {
  HELPDESK_TIMES,
  filterKb,
  helpdeskKb,
  helpdeskTabOf,
  isDirectVideo,
  ticketRef,
  toEmbedUrl,
  type HelpArticle,
} from '@/utils/helpdesk';
import { subscribeChat, subscribeTickets } from '@/websocket/channels';

/**
 * Helpdesk — client/src/pages/Helpdesk.jsx: Live Chat (the shared chat
 * panel, with an unread badge while another tab is open), Knowledge Base
 * (the built-in answers plus the admin's, searchable, each expanding to its
 * answer, video and "Go to …" link), My Tickets (every ticket the user has,
 * whatever its category — live via `user:tickets`, with the team's reply)
 * and New Ticket (a CHOSEN category from the server's list — never inferred
 * — subject, description, an optional image or PDF up to 3 MB).
 *
 * The open tab and the search live in the route params (`?tab=&q=`), as the
 * web keeps them in the URL, so a deep link lands on the same place.
 */

interface PickedAttachment { name: string; dataUrl: string; mimeType: string }

export function HelpdeskScreen({ navigation, route }: AppScreenProps<'Helpdesk'>): React.JSX.Element {
  const t = useTheme();
  const [tab, setTab] = useState<HelpdeskTab>(() => helpdeskTabOf(route.params?.tab));
  const [search, setSearch] = useState(() => route.params?.q ?? '');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [chatUnread, setChatUnread] = useState(0);
  const [adminKb, setAdminKb] = useState<HelpArticle[]>([]);

  // '' = not chosen yet (forces a selection).
  const [category, setCategory] = useState('');
  const [categories, setCategories] = useState<TicketCategoryOption[]>([]);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [attachment, setAttachment] = useState<PickedAttachment | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // A link that arrives while the screen is open switches the tab / search.
  const paramTab = route.params?.tab;
  const paramQ = route.params?.q;
  useEffect(() => { if (paramTab) setTab(helpdeskTabOf(paramTab)); }, [paramTab]);
  useEffect(() => { if (paramQ !== undefined) setSearch(paramQ); }, [paramQ]);

  // …and the state goes back into the params (the web's replace-state).
  useEffect(() => {
    const q = search.trim() || undefined;
    if (route.params?.tab !== tab || route.params?.q !== q) navigation.setParams({ tab, q });
  }, [tab, search]); // eslint-disable-line react-hooks/exhaustive-deps

  // The admin's articles (fetched once) — appended to the built-in answers.
  useEffect(() => {
    cmsApi.knowledgeBase()
      .then((rows) => {
        if (!alive.current) return;
        setAdminKb(rows.map((r) => ({ q: r.q, a: r.a, tag: r.tag, link: r.link, videoUrl: r.videoUrl })));
      })
      .catch(() => { /* keep the built-in answers only */ });
  }, []);

  // The categories come from the server (the model's list) — never a list of our own.
  useEffect(() => {
    feedbackApi.categories()
      .then((list) => { if (alive.current) setCategories(list); })
      .catch(() => { if (alive.current) setCategories([]); });
  }, []);

  const load = useCallback(async () => {
    try {
      // ALL of the user's tickets, whatever the category.
      const all = await feedbackApi.list();
      if (alive.current) setTickets(all);
    } catch { /* keep the prior list */ } finally {
      if (alive.current) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => subscribeTickets((d) => setTickets((prev) => applyTicketPush(prev, d))), []);

  // The Live Chat tab's unread badge: inbound messages while another tab is open.
  const tabRef = useRef(tab);
  tabRef.current = tab;
  useEffect(() => { if (tab === 'chat') setChatUnread(0); }, [tab]);
  useEffect(() => subscribeChat((raw) => {
    const d = parseChatSocketEvent(raw);
    if (d?.event === 'message' && d.message.senderRole !== 'USER') {
      setChatUnread((n) => (tabRef.current === 'chat' ? 0 : n + 1));
    }
  }), []);

  const kb = useMemo(() => helpdeskKb(adminKb), [adminKb]);
  const filteredKb = useMemo(() => filterKb(kb, search), [kb, search]);

  const pickAttachment = async (): Promise<void> => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['image/*', 'application/pdf'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      const a = res.canceled ? null : res.assets?.[0];
      if (!a) return;
      const mimeType = a.mimeType ?? '';
      const refusal = validateTicketAttachment({ name: a.name, size: typeof a.size === 'number' ? a.size : 0, mimeType });
      if (refusal) { toast.error(refusal); return; }
      const b64 = await new File(a.uri).base64();
      if (alive.current) setAttachment({ name: a.name || 'attachment', mimeType, dataUrl: `data:${mimeType};base64,${b64}` });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const submitTicket = async (): Promise<void> => {
    if (submitting) return;
    const refusal = validateTicket({ category, subject, message }, 'helpdesk');
    if (refusal || !category) { toast.error(refusal ?? 'Please select a category.'); return; }
    setSubmitting(true);
    try {
      await feedbackApi.submit({
        category,
        subject,
        message,
        page: '/helpdesk',
        attachment: attachment?.dataUrl ?? null,
        attachmentName: attachment?.name ?? null,
      });
      toast.success("Ticket opened — we'll respond shortly");
      setCategory('');
      setSubject('');
      setMessage('');
      setAttachment(null);
      setTab('tickets');
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      if (alive.current) setSubmitting(false);
    }
  };

  const tabs = [
    { key: 'chat' as const, label: 'Live Chat', badge: chatUnread || null },
    { key: 'faq' as const, label: 'Knowledge Base', badge: kb.length },
    { key: 'tickets' as const, label: 'My Tickets', badge: tickets.length },
    { key: 'new' as const, label: 'New Ticket', badge: null },
  ];

  return (
    <Screen onRefresh={tab === 'tickets' ? load : undefined} testID="helpdesk-screen">
      <View style={styles.page}>
        <View>
          <AppText variant="display">Helpdesk</AppText>
          <AppText variant="body" tone="secondary" style={styles.sub}>
            Browse the knowledge base, or open a ticket — our team responds in &lt; 24 hours.
          </AppText>
        </View>

        <Tabs tabs={tabs} value={tab} onChange={setTab} />

        {tab === 'chat' ? <HelpdeskChatPanel embedded /> : null}

        {tab === 'faq' ? (
          <View style={styles.stack}>
            <Input
              value={search}
              onChangeText={setSearch}
              placeholder="Search articles… (e.g. margin, withdrawal, KYC)"
              autoCorrect={false}
              accessibilityLabel="Search articles"
            />
            {!filteredKb.length ? (
              <Card style={styles.center}>
                <AppText variant="body" tone="secondary" align="center">{`No articles match "${search}"`}</AppText>
                <Button title="Open a ticket" size="sm" onPress={() => setTab('new')} style={styles.cta} />
              </Card>
            ) : (
              filteredKb.map((a, i) => <KbCard key={`${a.q}-${i}`} article={a} />)
            )}
          </View>
        ) : null}

        {tab === 'tickets' ? (
          <Card padded={false}>
            <View style={[styles.ticketsHead, { borderBottomColor: t.colors.borderDark }]}>
              <AppText variant="title" weight="600">Your Tickets</AppText>
              <Button title="+ New Ticket" size="sm" onPress={() => setTab('new')} />
            </View>
            {loading ? (
              <AppText variant="body" tone="secondary" align="center" style={styles.state}>Loading…</AppText>
            ) : !tickets.length ? (
              <View style={styles.emptyTickets}>
                <View style={[styles.ticketIcon, { backgroundColor: t.colors.bgHover, borderColor: t.colors.borderDark }]}>
                  <AppText style={styles.ticketGlyph}>🎫</AppText>
                </View>
                <AppText variant="body" tone="secondary" align="center">No tickets yet</AppText>
                <AppText variant="small" tone="muted" align="center" style={styles.sub}>
                  Browse the knowledge base — most issues are answered there.
                </AppText>
                <Button title="Open Your First Ticket" size="sm" onPress={() => setTab('new')} style={styles.cta} />
              </View>
            ) : (
              tickets.map((tk, i) => (
                <View
                  key={tk.id}
                  style={[styles.ticket, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.borderSubtle } : null]}
                >
                  <View style={styles.ticketTop}>
                    <View style={styles.flex}>
                      <AppText variant="bodyStrong">{tk.subject}</AppText>
                      <AppText variant="caption" tone="muted">{`${ticketRef(tk.id)} · ${fmtDateTime(tk.createdAt)}`}</AppText>
                      <AppText variant="small" tone="secondary" numberOfLines={2} style={styles.preview}>{tk.message}</AppText>
                    </View>
                    <TicketStatusChip status={tk.status} />
                  </View>
                  {tk.adminReply ? (
                    <View style={[styles.reply, { borderLeftColor: t.alpha(t.colors.primary, 0.4), backgroundColor: t.alpha(t.colors.primary, 0.05) }]}>
                      <AppText variant="micro" weight="600" color={t.colors.primaryText}>
                        {`SUPPORT REPLY${tk.repliedAt ? ` · ${fmtDateTime(tk.repliedAt)}` : ''}`}
                      </AppText>
                      <AppText variant="small" tone="secondary" style={styles.replyText}>{tk.adminReply}</AppText>
                    </View>
                  ) : null}
                </View>
              ))
            )}
          </Card>
        ) : null}

        {tab === 'new' ? (
          <Card style={styles.form}>
            <View style={styles.formHead}>
              <View style={[styles.bar, { backgroundColor: t.colors.primary }]} />
              <AppText variant="h3" weight="700">Open a Support Ticket</AppText>
            </View>
            <AppText variant="small" tone="muted">
              Describe your issue clearly — include account numbers, error messages, or screenshots if relevant.
            </AppText>

            <Select
              label="Category *"
              value={category || null}
              placeholder="Select Category"
              options={categories.map((c) => ({ value: c.value, label: c.label }))}
              onChange={(v) => setCategory(v)}
              title="Category"
            />

            <Input
              label="Subject"
              value={subject}
              onChangeText={setSubject}
              maxLength={TICKET_LIMITS.subjectMax}
              placeholder="e.g. Withdrawal stuck in PENDING"
            />

            <View>
              <Input
                label="Describe your issue"
                value={message}
                onChangeText={setMessage}
                maxLength={TICKET_LIMITS.messageMax}
                placeholder="What happened? What did you expect? Steps to reproduce?"
                multiline
                numberOfLines={8}
                inputStyle={styles.textarea}
              />
              <AppText variant="micro" tone="muted" mono align="right" style={styles.count}>
                {`${TICKET_LIMITS.messageMax - message.length} chars left`}
              </AppText>
            </View>

            <View>
              <AppText variant="label" style={styles.label}>
                {'Attach a file '}
                <AppText variant="small" tone="muted">(optional — image or PDF, ≤ 3 MB)</AppText>
              </AppText>
              {attachment ? (
                <View style={[styles.attached, { borderColor: t.colors.borderDark, backgroundColor: t.colors.bgCard }]}>
                  {/^data:image\//.test(attachment.dataUrl) ? (
                    <Image source={{ uri: attachment.dataUrl }} style={styles.thumb} accessibilityLabel="attachment preview" />
                  ) : (
                    <View style={[styles.thumb, styles.pdf, { backgroundColor: t.colors.bgHover }]}>
                      <AppText variant="micro" weight="700" tone="muted">PDF</AppText>
                    </View>
                  )}
                  <AppText variant="small" tone="secondary" numberOfLines={1} style={styles.flex}>{attachment.name}</AppText>
                  <Pressable accessibilityRole="button" hitSlop={6} onPress={() => setAttachment(null)}>
                    <AppText variant="small" tone="bear">Remove</AppText>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => { void pickAttachment(); }}
                  style={({ pressed }) => [styles.attach, {
                    borderColor: pressed ? t.colors.primary : t.colors.borderDark,
                  }]}
                >
                  <AppText variant="small" tone="secondary">📎  Attach image or PDF</AppText>
                </Pressable>
              )}
            </View>

            <View style={[styles.info, { backgroundColor: t.alpha(t.colors.info, 0.05), borderColor: t.alpha(t.colors.info, 0.3) }]}>
              <AppText variant="small" tone="secondary">
                {'Average first response: '}
                <AppText variant="small" weight="600">{HELPDESK_TIMES.supportReply}</AppText>
                {'. For urgent payment issues, ticket will be auto-prioritized.'}
              </AppText>
            </View>

            <View style={styles.actions}>
              <Button title="Cancel" variant="secondary" onPress={() => setTab('faq')} />
              <Button title={submitting ? 'Submitting…' : 'Submit Ticket'} onPress={() => { void submitTicket(); }} disabled={submitting} />
            </View>
          </Card>
        ) : null}
      </View>
    </Screen>
  );
}

/** One knowledge-base article; tap to open the answer. */
function KbCard({ article }: { article: HelpArticle }): React.JSX.Element {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <Card onPress={() => setOpen((o) => !o)} accessibilityLabel={article.q}>
      <View style={styles.kbTop}>
        <View style={styles.flex}>
          <AppText variant="micro" weight="700" color={t.colors.primaryText} style={styles.kbTag}>{article.tag.toUpperCase()}</AppText>
          <AppText variant="bodyStrong">{article.q}</AppText>
        </View>
        <AppText style={[styles.plus, { transform: [{ rotate: open ? '45deg' : '0deg' }] }]} tone="muted">+</AppText>
      </View>
      {open ? (
        <View style={[styles.kbBody, { borderTopColor: t.colors.borderSubtle }]}>
          <AppText variant="small" tone="secondary">{article.a}</AppText>
          {article.videoUrl ? <KbVideo url={article.videoUrl} /> : null}
          {article.link ? (
            <Pressable accessibilityRole="link" hitSlop={6} onPress={() => navigateToPath(article.link ?? '/')} style={styles.goto}>
              <AppText variant="small" color={t.colors.primaryText}>{`Go to ${article.tag} →`}</AppText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

/** A YouTube / Vimeo player inline; a direct file or anything else opens in the browser. */
function KbVideo({ url }: { url: string }): React.JSX.Element {
  const t = useTheme();
  const embed = toEmbedUrl(url);
  if (embed) {
    return (
      <View style={[styles.video, { borderColor: t.colors.borderSubtle }]}>
        <WebView source={{ uri: embed }} allowsFullscreenVideo mediaPlaybackRequiresUserAction style={styles.flex} />
      </View>
    );
  }
  return (
    <Pressable accessibilityRole="link" hitSlop={6} onPress={() => { Linking.openURL(url).catch(() => undefined); }} style={styles.goto}>
      <AppText variant="small" color={t.colors.primaryText}>{isDirectVideo(url) ? '▶ Play video' : '▶ Watch video'}</AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { gap: 20 },
  sub: { marginTop: 6 },
  flex: { flex: 1, minWidth: 0 },
  stack: { gap: 12 },
  center: { alignItems: 'center', paddingVertical: 32 },
  cta: { marginTop: 16 },
  ticketsHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1,
  },
  state: { padding: 40 },
  emptyTickets: { alignItems: 'center', padding: 40 },
  ticketIcon: { width: 48, height: 48, borderRadius: 24, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  ticketGlyph: { fontSize: 20, lineHeight: 26 },
  ticket: { paddingHorizontal: 20, paddingVertical: 16 },
  ticketTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  preview: { marginTop: 8 },
  reply: { marginTop: 12, borderLeftWidth: 2, paddingLeft: 12, paddingVertical: 8, borderTopRightRadius: 6, borderBottomRightRadius: 6 },
  replyText: { marginTop: 4 },
  form: { gap: 20 },
  formHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bar: { width: 4, height: 20, borderRadius: 2 },
  textarea: { minHeight: 170, textAlignVertical: 'top' },
  count: { marginTop: 4 },
  label: { marginBottom: 8 },
  attached: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  thumb: { width: 40, height: 40, borderRadius: 4 },
  pdf: { alignItems: 'center', justifyContent: 'center' },
  attach: { alignSelf: 'flex-start', borderWidth: 1, borderStyle: 'dashed', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  info: { borderWidth: 1, borderRadius: 8, padding: 12 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  kbTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  kbTag: { letterSpacing: 1, marginBottom: 6 },
  plus: { fontSize: 22, lineHeight: 24 },
  kbBody: { marginTop: 12, paddingTop: 12, borderTopWidth: 1 },
  goto: { marginTop: 8, alignSelf: 'flex-start' },
  video: { marginTop: 12, aspectRatio: 16 / 9, width: '100%', borderRadius: 8, borderWidth: 1, overflow: 'hidden' },
});
