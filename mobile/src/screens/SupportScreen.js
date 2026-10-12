import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Alert,
  Image, KeyboardAvoidingView, Platform, AppState, Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { useColors, radius } from '../theme';
import { Loader } from '../components/ui';
import { pickImageBase64 } from '../services/imagePicker';

/**
 * SupportScreen — native port of the web client's Helpdesk page
 * (client/src/pages/Helpdesk.jsx) WITH its live chat embedded
 * (client/src/pages/HelpdeskChat.jsx). Mirrors it tab-for-tab:
 *   • Live Chat       — realtime conversation with the assigned manager
 *                       (presence header · date-divided bubble thread ·
 *                        attachments · seen ticks · typing · composer).
 *   • Knowledge Base  — FAQ search + expandable KB cards (built-in defaults
 *                       merged with admin-managed /cms/knowledge-base articles).
 *   • My Tickets      — SUPPORT-category feedback rows with status badges
 *                       + admin replies (live via `user:tickets`).
 *   • New Ticket      — subject + message (with counter) + attach + submit.
 *
 * Same backend endpoints and the same WS channels (`user:chat`, `user:tickets`)
 * the web uses. Real data only; theme-reactive via useColors()/makeStyles(c).
 */

// Valid tabs (same order/keys as the web's TABS).
const TABS = ['chat', 'faq', 'tickets', 'new'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Web `<Link to>` targets → native route names (navigation.navigate).
const LINK_ROUTE = { '/wallet': 'Wallet', '/trade': 'Trade', '/profile': 'Profile', '/ib-room': 'Partner' };

// Built-in KB articles — ported verbatim from the web (merged with admin ones).
const KB_ARTICLES = [
  { q: 'How long do withdrawals take?', a: 'UPI: ≤ 2 hours. Bank transfer: 1 business day. Crypto: ~30 minutes once admin approves. High-value (>10 lakh) needs two-admin approval — adds 24h.', tag: 'Funds', link: '/wallet' },
  { q: 'Why is my position showing in CLOSING status?', a: 'You (or the worker) submitted a close order; engine is matching it. Auto-resolves in seconds. If it sticks for >30s, the engine likely failed — try the Close button again.', tag: 'Trading', link: '/trade' },
  { q: 'How is margin calculated?', a: 'margin = (quantity × price) ÷ leverage. Locked at order placement, released when the position closes. Settlement = margin + PnL − fee.', tag: 'Trading' },
  { q: 'What does Margin Call mean?', a: 'When equity / used margin × 100 ≤ 80% you get a Margin Call notification. At ≤ 50% (Stop Out level), the broker auto-liquidates your largest losing position until equity recovers.', tag: 'Risk', link: '/wallet' },
  { q: 'KYC rejected — what to do?', a: 'Re-upload clearer photos with all four corners visible, no glare, and matching name across documents. The rejection note tells you the specific issue.', tag: 'Account', link: '/profile' },
  { q: 'Why is BUY/SELL disabled in the order form?', a: 'Likely insufficient free margin, or the instrument is paused (check Mode badge). KYC must be APPROVED for live trading; demo accounts always work.', tag: 'Trading', link: '/trade' },
  { q: 'Where do I see my IB / referral commissions?', a: 'IB Room shows total earned + per-trade breakdown. Commissions credit to your wallet automatically when a referred user trades.', tag: 'Affiliate', link: '/ib-room' },
  { q: 'My chart shows "Loading…" forever', a: 'Backend likely lost DB connection or your session expired. Check Wallets — if it loads, refresh Trade. If both fail, log out and back in.', tag: 'Technical' },
];

// ── Formatting helpers (dependency-free — avoids Hermes Intl gaps) ─────────
function fmtClock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'PM' : 'AM';
  h %= 12; if (h === 0) h = 12;
  return `${h}:${m} ${ap}`;
}
function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${fmtClock(iso)}`;
}
// Centered day chip label — Today / Yesterday / "12 Jun" (mirrors the web).
function dateDividerLabel(iso) {
  const d = new Date(iso);
  const dd = new Date(d); dd.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yest = new Date(today); yest.setDate(yest.getDate() - 1);
  if (dd.getTime() === today.getTime()) return 'Today';
  if (dd.getTime() === yest.getTime()) return 'Yesterday';
  const withYear = d.getFullYear() !== today.getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${withYear ? ` ${d.getFullYear()}` : ''}`;
}
const toDataUrl = (img) => `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}`;
const extOf = (name) => { const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/); return m ? m[1] : ''; };

// Ticket status → soft-bg / fg pair (same colour language as the web's STATUS_STYLES).
function statusStyle(c, status) {
  switch (status) {
    case 'TRIAGED': return { bg: c.primarySoft, fg: c.primary500 };
    case 'IN_PROGRESS': return { bg: c.warnSoft, fg: c.warn };
    case 'RESOLVED': return { bg: c.bullSoft, fg: c.bull };
    case 'WONT_FIX': return { bg: c.bearSoft, fg: c.bear };
    case 'OPEN':
    default: return { bg: c.warnSoft, fg: c.warn };
  }
}

// ─── Top tab bar ───────────────────────────────────────────────────────────
function TabBar({ tab, setTab, chatUnread, kbCount, ticketCount, styles, c }) {
  const items = [
    { k: 'chat', label: 'Live Chat', count: chatUnread || null },
    { k: 'faq', label: 'Knowledge Base', count: kbCount },
    { k: 'tickets', label: 'My Tickets', count: ticketCount },
    { k: 'new', label: 'New Ticket', count: null },
  ];
  return (
    <View style={styles.tabBar}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabScroll}>
        {items.map((t) => {
          const on = tab === t.k;
          return (
            <TouchableOpacity key={t.k} activeOpacity={0.8} onPress={() => setTab(t.k)} style={styles.tabBtn}>
              <View style={styles.tabBtnInner}>
                <Text style={[styles.tabLabel, on && styles.tabLabelOn]}>{t.label}</Text>
                {t.count != null && (
                  <View style={[styles.tabCount, on ? styles.tabCountOn : styles.tabCountOff]}>
                    <Text style={[styles.tabCountTxt, { color: on ? c.primary500 : c.textMuted }]}>{t.count}</Text>
                  </View>
                )}
              </View>
              {on && <View style={styles.tabUnderline} />}
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

// ─── Knowledge Base ─────────────────────────────────────────────────────────
function KbCard({ article, navigation, styles, c }) {
  const [open, setOpen] = useState(false);
  const route = article.link ? LINK_ROUTE[article.link] : null;
  return (
    <TouchableOpacity activeOpacity={0.9} onPress={() => setOpen((o) => !o)} style={styles.kbCard}>
      <View style={styles.kbHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.kbTag}>{(article.tag || '').toUpperCase()}</Text>
          <Text style={[styles.kbQ, open && { color: c.primary500 }]}>{article.q}</Text>
        </View>
        <Ionicons name={open ? 'remove' : 'add'} size={20} color={c.textMuted} />
      </View>
      {open && (
        <View style={styles.kbBody}>
          <Text style={styles.kbA}>{article.a}</Text>
          {!!article.videoUrl && (
            <TouchableOpacity onPress={() => Linking.openURL(article.videoUrl).catch(() => {})}>
              <Text style={styles.kbLink}>▶ Watch video</Text>
            </TouchableOpacity>
          )}
          {!!route && (
            <TouchableOpacity onPress={() => navigation.navigate(route)}>
              <Text style={styles.kbLink}>Go to {article.tag} →</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

function FaqPanel({ search, setSearch, articles, navigation, setTab, styles, c }) {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.panelPad} keyboardShouldPersistTaps="handled">
      <TextInput
        value={search}
        onChangeText={setSearch}
        placeholder="Search articles… (e.g. margin, withdrawal, KYC)"
        placeholderTextColor={c.textMuted}
        style={styles.searchInput}
      />
      {!articles.length ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTxt}>No articles match "{search}"</Text>
          <TouchableOpacity onPress={() => setTab('new')} style={styles.smallPrimaryBtn}>
            <Text style={styles.smallPrimaryTxt}>Open a ticket</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={{ gap: 12 }}>
          {articles.map((a, i) => <KbCard key={a.q || i} article={a} navigation={navigation} styles={styles} c={c} />)}
        </View>
      )}
    </ScrollView>
  );
}

// ─── My Tickets ─────────────────────────────────────────────────────────────
function TicketsPanel({ tickets, loading, setTab, styles, c }) {
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.ticketsHead}>
        <Text style={styles.ticketsHeadTitle}>Your Tickets</Text>
        <TouchableOpacity onPress={() => setTab('new')} style={styles.smallPrimaryBtn}>
          <Text style={styles.smallPrimaryTxt}>+ New Ticket</Text>
        </TouchableOpacity>
      </View>
      {loading ? (
        <Loader label="Loading tickets…" />
      ) : !tickets.length ? (
        <View style={styles.ticketsEmpty}>
          <View style={styles.ticketsEmptyIcon}>
            <Ionicons name="ticket-outline" size={22} color={c.textMuted} />
          </View>
          <Text style={styles.emptyTxt}>No tickets yet</Text>
          <Text style={styles.emptySub}>Browse the knowledge base — most issues are answered there.</Text>
          <TouchableOpacity onPress={() => setTab('new')} style={[styles.smallPrimaryBtn, { marginTop: 14 }]}>
            <Text style={styles.smallPrimaryTxt}>Open Your First Ticket</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.panelPad}>
          <View style={styles.ticketList}>
            {tickets.map((t, i) => {
              const st = statusStyle(c, t.status);
              return (
                <View key={t._id} style={[styles.ticketRow, i > 0 && styles.ticketRowDivider]}>
                  <View style={styles.ticketTop}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.ticketSubject}>{t.subject}</Text>
                      <Text style={styles.ticketMeta}>#{String(t._id).slice(-6).toUpperCase()} · {fmtDate(t.createdAt)}</Text>
                      <Text style={styles.ticketMsg} numberOfLines={2}>{t.message}</Text>
                    </View>
                    <View style={[styles.statusBadge, { backgroundColor: st.bg }]}>
                      <Text style={[styles.statusTxt, { color: st.fg }]}>{String(t.status || 'OPEN').replace('_', ' ')}</Text>
                    </View>
                  </View>
                  {!!t.adminReply && (
                    <View style={styles.replyBox}>
                      <Text style={styles.replyLabel}>SUPPORT REPLY{t.repliedAt ? ` · ${fmtDate(t.repliedAt)}` : ''}</Text>
                      <Text style={styles.replyTxt}>{t.adminReply}</Text>
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

// ─── New Ticket ─────────────────────────────────────────────────────────────
function NewTicketPanel({ subject, setSubject, message, setMessage, attachment, setAttachment, submitting, onSubmit, setTab, styles, c }) {
  const pickAttachment = async () => { const img = await pickImageBase64(); if (img) setAttachment(img); };
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.panelPad} keyboardShouldPersistTaps="handled">
        <View style={styles.formCard}>
          <View style={styles.formTitleRow}>
            <View style={styles.formTitleBar} />
            <Text style={styles.formTitle}>Open a Support Ticket</Text>
          </View>
          <Text style={styles.formHint}>Describe your issue clearly — include account numbers, error messages, or screenshots if relevant.</Text>

          <Text style={styles.label}>Subject</Text>
          <TextInput
            value={subject}
            onChangeText={setSubject}
            maxLength={200}
            placeholder="e.g. Withdrawal stuck in PENDING"
            placeholderTextColor={c.textMuted}
            style={styles.input}
          />

          <Text style={[styles.label, { marginTop: 16 }]}>Describe your issue</Text>
          <TextInput
            value={message}
            onChangeText={setMessage}
            maxLength={4000}
            multiline
            placeholder="What happened? What did you expect? Steps to reproduce?"
            placeholderTextColor={c.textMuted}
            style={[styles.input, styles.textarea]}
          />
          <Text style={styles.counter}>{4000 - message.length} chars left</Text>

          <Text style={[styles.label, { marginTop: 12 }]}>Attach a file <Text style={styles.labelMuted}>(optional — image)</Text></Text>
          {attachment ? (
            <View style={styles.attachRow}>
              <Image source={{ uri: attachment.uri }} style={styles.attachThumb} resizeMode="cover" />
              <Text style={styles.attachName} numberOfLines={1}>{attachment.fileName}</Text>
              <TouchableOpacity onPress={() => setAttachment(null)}>
                <Text style={styles.attachRemove}>Remove</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity onPress={pickAttachment} style={styles.attachBtn}>
              <Ionicons name="attach" size={16} color={c.textSecondary} />
              <Text style={styles.attachBtnTxt}>Attach image</Text>
            </TouchableOpacity>
          )}

          <View style={styles.infoBox}>
            <Ionicons name="information-circle-outline" size={16} color={c.warn} style={{ marginTop: 1 }} />
            <Text style={styles.infoTxt}>
              Average first response: <Text style={{ color: c.textPrimary, fontWeight: '700' }}>2-4 hours</Text>. For urgent payment issues, ticket will be auto-prioritized.
            </Text>
          </View>

          <View style={styles.formActions}>
            <TouchableOpacity onPress={() => setTab('faq')} style={styles.ghostBtn}>
              <Text style={styles.ghostBtnTxt}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onSubmit} disabled={submitting} style={[styles.primaryBtn, submitting && { opacity: 0.6 }]}>
              <Text style={styles.primaryBtnTxt}>{submitting ? 'Submitting…' : 'Submit Ticket'}</Text>
            </TouchableOpacity>
          </View>
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── Live Chat thread pieces ────────────────────────────────────────────────
function DateDivider({ date, styles }) {
  return (
    <View style={styles.dividerWrap}>
      <Text style={styles.dividerTxt}>{dateDividerLabel(date)}</Text>
    </View>
  );
}

function Bubble({ m, mine, styles, c }) {
  return (
    <View style={[styles.bubbleRow, { justifyContent: mine ? 'flex-end' : 'flex-start' }]}>
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
        {(m.attachments || []).map((a, i) => (
          <View key={i} style={{ marginBottom: 6 }}>
            {a.mimeType?.startsWith('image/') ? (
              <Image source={{ uri: a.dataUrl }} style={styles.msgImg} resizeMode="cover" />
            ) : (
              <TouchableOpacity onPress={() => a.dataUrl && Linking.openURL(a.dataUrl).catch(() => {})}>
                <Text style={[styles.msgFile, { color: mine ? '#FFFFFF' : c.primary500 }]}>📎 {a.name || 'file'}</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}
        {!!m.text && <Text style={[styles.bubbleText, { color: mine ? '#FFFFFF' : c.textPrimary }]}>{m.text}</Text>}
        <View style={styles.bubbleMeta}>
          <Text style={[styles.bubbleTime, { color: mine ? 'rgba(255,255,255,0.75)' : c.textMuted }]}>{fmtClock(m.createdAt)}</Text>
          {mine && <Text style={[styles.bubbleTick, { color: m.seenAt ? '#FFFFFF' : 'rgba(255,255,255,0.75)' }]}>{m.seenAt ? '✓✓' : '✓'}</Text>}
        </View>
      </View>
    </View>
  );
}

// Flatten messages into bubbles interleaved with day dividers (mirrors the web).
function renderThread(messages, styles, c) {
  const out = [];
  let lastDay = null;
  for (const m of messages) {
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) { out.push(<DateDivider key={`day-${day}`} date={m.createdAt} styles={styles} />); lastDay = day; }
    out.push(<Bubble key={m._id} m={m} mine={m.senderRole === 'USER'} styles={styles} c={c} />);
  }
  return out;
}

// ─── Live Chat panel (embedded HelpdeskChat) ────────────────────────────────
function ChatPanel({ styles, c }) {
  const [conv, setConv] = useState(null);
  const [counterpart, setCounterpart] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [theyTyping, setTheyTyping] = useState(false);
  const [uploadCfg, setUploadCfg] = useState(null);
  const [pending, setPending] = useState([]);

  const scrollRef = useRef(null);
  const typingTimer = useRef(null);
  const lastTypingSent = useRef(0);
  const messagesRef = useRef([]);
  const metrics = useRef({ contentH: 0, layoutH: 0, offsetY: 0 });
  const autoScroll = useRef(true);      // scroll to bottom on next content grow
  const prependAdjust = useRef(null);   // { prevContentH, prevOffsetY } after loading older

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { api.get('/chat/upload-config').then((r) => setUploadCfg(r.data.data)).catch(() => {}); }, []);

  const isNearBottom = () => {
    const m = metrics.current;
    if (!m.contentH || !m.layoutH) return true;
    return m.contentH - m.offsetY - m.layoutH < 120;
  };
  const scrollToBottom = () => { autoScroll.current = true; requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true })); };

  const markSeen = useCallback((id) => { if (id) api.post(`/chat/conversations/${id}/seen`).catch(() => {}); }, []);

  // Single funnel for ALL new messages — optimistic send, WS echo and the
  // polling fallback all go through here. Dedupes by _id, keeps the thread
  // time-ordered, auto-scrolls when appropriate, and marks inbound seen.
  const mergeIncoming = useCallback((incoming, { forceScroll = false } = {}) => {
    const list = (Array.isArray(incoming) ? incoming : [incoming]).filter((m) => m && m._id);
    if (!list.length) return;
    const existing = new Set(messagesRef.current.map((m) => m._id));
    const adds = list.filter((m) => !existing.has(m._id));
    if (!adds.length) return;
    const shouldScroll = forceScroll || isNearBottom();
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m._id));
      const merged = [...prev, ...adds.filter((m) => !seen.has(m._id))];
      merged.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      return merged;
    });
    if (shouldScroll) scrollToBottom();
    if (adds.some((m) => m.senderRole !== 'USER') && conv?._id) markSeen(conv._id);
  }, [conv?._id, markSeen]);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/chat/conversation');
      setConv(data.data.conversation);
      setCounterpart(data.data.counterpart);
      const msgs = data.data.messages || [];
      setMessages(msgs);
      setHasMore(msgs.length >= 50);
      if (data.data.conversation?._id) markSeen(data.data.conversation._id);
      scrollToBottom();
    } catch (e) { Alert.alert('Chat', errorMessage(e)); }
    finally { setLoading(false); }
  }, [markSeen]);

  useEffect(() => { load(); }, [load]);

  // Load OLDER messages (pagination) — prepend, preserving scroll position.
  const loadOlder = useCallback(async () => {
    const cur = messagesRef.current;
    if (loadingMore || !hasMore || !conv?._id || !cur.length) return;
    setLoadingMore(true);
    prependAdjust.current = { prevContentH: metrics.current.contentH, prevOffsetY: metrics.current.offsetY };
    try {
      const { data } = await api.get(`/chat/conversations/${conv._id}/messages`, { params: { before: cur[0].createdAt, limit: 50 } });
      const older = data.data || [];
      if (older.length < 50) setHasMore(false);
      if (older.length) {
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m._id));
          const merged = [...older.filter((m) => !seen.has(m._id)), ...prev];
          merged.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
          return merged;
        });
      } else { prependAdjust.current = null; }
    } catch (e) { prependAdjust.current = null; Alert.alert('Chat', errorMessage(e)); }
    finally { setLoadingMore(false); }
  }, [conv?._id, hasMore, loadingMore]);

  // Realtime — subscribe to the user's chat channel (same events as the web).
  useEffect(() => {
    const unsub = wsClient.subscribe('user:chat', (d) => {
      if (!d) return;
      if (d.event === 'message') {
        mergeIncoming(d.message);
      } else if (d.event === 'typing') {
        if (d.by !== 'USER') {
          setTheyTyping(true);
          clearTimeout(typingTimer.current);
          typingTimer.current = setTimeout(() => setTheyTyping(false), 3000);
        }
      } else if (d.event === 'seen') {
        if (d.by !== 'USER') setMessages((prev) => prev.map((m) => (m.senderRole === 'USER' && !m.seenAt ? { ...m, seenAt: new Date().toISOString() } : m)));
      } else if (d.event === 'presence') {
        setCounterpart((cp) => (cp && String(cp.id) === String(d.userId) ? { ...cp, online: d.online } : cp));
      }
    });
    return () => { unsub && unsub(); clearTimeout(typingTimer.current); };
  }, [mergeIncoming]);

  // Polling fallback — guarantees delivery without a refresh if a socket echo
  // is missed. Fetches ONLY messages after the last we hold; pauses in background.
  useEffect(() => {
    if (!conv?._id) return undefined;
    const id = setInterval(async () => {
      if (AppState.currentState !== 'active') return;
      try {
        const last = messagesRef.current[messagesRef.current.length - 1];
        const params = last?.createdAt ? { after: last.createdAt } : { limit: 50 };
        const { data } = await api.get(`/chat/conversations/${conv._id}/messages`, { params });
        mergeIncoming(data.data || []);
      } catch (_) { /* transient — retry next tick */ }
    }, 5000);
    return () => clearInterval(id);
  }, [conv?._id, mergeIncoming]);

  const onType = (v) => {
    setText(v);
    const now = Date.now();
    if (conv?._id && counterpart && now - lastTypingSent.current > 1500) {
      lastTypingSent.current = now;
      api.post(`/chat/conversations/${conv._id}/typing`).catch(() => {});
    }
  };

  const send = async (attachments) => {
    const bodyText = text.trim();
    if (!bodyText && !(attachments && attachments.length)) return;
    setSending(true);
    try {
      const { data } = await api.post(`/chat/conversations/${conv._id}/messages`, { text: bodyText, attachments });
      setText('');
      mergeIncoming(data.data, { forceScroll: true });
    } catch (e) {
      const code = e.response?.data?.error?.code;
      Alert.alert('Chat', code === 'NO_MANAGER' ? 'No manager is assigned to you yet.' : errorMessage(e));
    } finally { setSending(false); }
  };

  // ── Attachment staging (native picker returns base64 already-read) ──
  const validateFile = (file) => {
    const cfg = uploadCfg;
    if (!cfg || cfg.enabled === false) return 'File uploads are currently disabled.';
    const ext = extOf(file.name);
    if ((cfg.blockedExtensions || []).includes(ext)) return `Executable / unsafe files (.${ext}) are not allowed.`;
    if ((cfg.allowedExtensions || []).length && !cfg.allowedExtensions.includes(ext)) return `.${ext || '?'} is not allowed. Allowed: ${cfg.allowedExtensions.join(', ')}.`;
    if (file.sizeBytes > (cfg.maxFileMB || 5) * 1024 * 1024) return `"${file.name}" exceeds the ${cfg.maxFileMB} MB per-file limit.`;
    return null;
  };

  const onAttach = async () => {
    const cfg = uploadCfg;
    if (!cfg || cfg.enabled === false) { Alert.alert('Attach', 'File uploads are currently disabled.'); return; }
    const img = await pickImageBase64();
    if (!img) return;
    const sizeBytes = Math.floor((img.base64?.length || 0) * 0.75);
    const maxFiles = cfg.maxFiles > 0 ? cfg.maxFiles : Infinity;
    if (pending.length >= maxFiles) { Alert.alert('Attach', `You can attach at most ${cfg.maxFiles} file(s) per message.`); return; }
    const err = validateFile({ name: img.fileName, sizeBytes });
    if (err) { Alert.alert('Attach', err); return; }
    const maxTotal = cfg.maxTotalMB > 0 ? cfg.maxTotalMB * 1024 * 1024 : Infinity;
    const running = pending.reduce((s, p) => s + (p.sizeBytes || 0), 0);
    if (running + sizeBytes > maxTotal) { Alert.alert('Attach', `Total attachments would exceed the ${cfg.maxTotalMB} MB limit.`); return; }
    setPending((prev) => [...prev, { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, name: img.fileName, mimeType: img.mimeType, dataUrl: toDataUrl(img), sizeBytes, uri: img.uri }]);
  };
  const removePending = (id) => setPending((prev) => prev.filter((p) => p.id !== id));

  const submit = () => {
    if (sending) return;
    const attachments = pending.map((p) => ({ name: p.name, mimeType: p.mimeType, dataUrl: p.dataUrl }));
    if (!text.trim() && !attachments.length) return;
    send(attachments);
    setPending([]);
  };

  // Keep the view pinned to the latest message on grow; preserve position on prepend.
  const onContentSizeChange = (w, h) => {
    metrics.current.contentH = h;
    if (prependAdjust.current) {
      const { prevContentH, prevOffsetY } = prependAdjust.current;
      prependAdjust.current = null;
      const y = h - prevContentH + prevOffsetY;
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ y, animated: false }));
      return;
    }
    if (autoScroll.current) requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
  };
  const onScroll = (e) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    metrics.current = { contentH: contentSize.height, layoutH: layoutMeasurement.height, offsetY: contentOffset.y };
    autoScroll.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 120;
  };

  if (loading) return <Loader label="Loading chat…" />;

  // No manager assigned yet — empty state (mirrors the web card).
  if (!counterpart) {
    return (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.panelPad}>
        <View style={styles.noMgrCard}>
          <View style={styles.noMgrIcon}>
            <Ionicons name="chatbubbles-outline" size={26} color={c.primary500} />
          </View>
          <Text style={styles.noMgrTitle}>A support manager will be assigned soon</Text>
          <Text style={styles.noMgrSub}>Once your account is assigned a manager, you can chat with them here in real time.</Text>
        </View>
      </ScrollView>
    );
  }

  const uploadsOn = uploadCfg?.enabled !== false;
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      {/* Manager header w/ presence */}
      <View style={styles.chatHeader}>
        <View>
          <View style={styles.avatar}>
            <Text style={styles.avatarTxt}>{(counterpart.name || 'M').slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={[styles.presenceDot, { backgroundColor: counterpart.online ? c.bull : c.textMuted }]} />
        </View>
        <View style={{ minWidth: 0, flex: 1 }}>
          <Text style={styles.chatName} numberOfLines={1}>{counterpart.name}</Text>
          <Text style={styles.chatStatus}>{counterpart.online ? 'Online' : 'Offline'} · Your support manager</Text>
        </View>
      </View>

      {/* Thread */}
      <ScrollView
        ref={scrollRef}
        style={styles.thread}
        contentContainerStyle={styles.threadContent}
        onScroll={onScroll}
        onContentSizeChange={onContentSizeChange}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
      >
        {hasMore && (
          <View style={{ alignItems: 'center', paddingBottom: 4 }}>
            <TouchableOpacity onPress={loadOlder} disabled={loadingMore} style={styles.loadOlderBtn}>
              <Text style={styles.loadOlderTxt}>{loadingMore ? 'Loading…' : 'Load older messages'}</Text>
            </TouchableOpacity>
          </View>
        )}
        {messages.length === 0 && <Text style={styles.threadHint}>Say hello to your support manager 👋</Text>}
        {renderThread(messages, styles, c)}
        {theyTyping && <Text style={styles.typingTxt}>{counterpart.name} is typing…</Text>}
      </ScrollView>

      {/* Composer */}
      <View style={styles.composer}>
        {pending.length > 0 && (
          <View style={styles.pendingRow}>
            {pending.map((p) => (
              <View key={p.id} style={styles.pendingChip}>
                <Image source={{ uri: p.uri }} style={styles.pendingThumb} resizeMode="cover" />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.pendingName} numberOfLines={1}>{p.name}</Text>
                  <Text style={styles.pendingSize}>{(p.sizeBytes / 1024 / 1024).toFixed(2)} MB</Text>
                </View>
                <TouchableOpacity onPress={() => removePending(p.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={styles.pendingRemove}>✕</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}
        <View style={styles.composerRow}>
          {uploadsOn && (
            <TouchableOpacity onPress={onAttach} style={styles.attachIconBtn}>
              <Ionicons name="attach" size={20} color={c.textMuted} />
            </TouchableOpacity>
          )}
          <TextInput
            value={text}
            onChangeText={onType}
            placeholder="Type a message…"
            placeholderTextColor={c.textMuted}
            multiline
            style={styles.composerInput}
          />
          <TouchableOpacity
            onPress={submit}
            disabled={sending || (!text.trim() && pending.length === 0)}
            style={[styles.sendBtn, (sending || (!text.trim() && pending.length === 0)) && { opacity: 0.5 }]}
          >
            <Text style={styles.sendTxt}>Send</Text>
          </TouchableOpacity>
        </View>
        {!!uploadCfg && (
          <Text style={styles.composerHint}>
            {uploadCfg.enabled === false
              ? 'File uploads are currently disabled by the administrator.'
              : `Allowed: ${(uploadCfg.allowedExtensions || []).slice(0, 8).join(', ') || 'any (non-executable)'} · Max ${uploadCfg.maxFileMB} MB per file`}
          </Text>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

// ─── Screen ─────────────────────────────────────────────────────────────────
export default function SupportScreen({ route, navigation }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);

  const initialTab = TABS.includes(route?.params?.tab) ? route.params.tab : 'faq';
  const [tab, setTab] = useState(initialTab);
  const [tickets, setTickets] = useState([]);
  const [loadingTickets, setLoadingTickets] = useState(true);
  const [search, setSearch] = useState('');
  const [chatUnread, setChatUnread] = useState(0);
  const [adminKb, setAdminKb] = useState([]);

  // New-ticket draft lives here so it survives tab switches (mirrors the web).
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [attachment, setAttachment] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Admin-managed KB articles (fetched once) — merged with built-in defaults.
  useEffect(() => {
    let on = true;
    api.get('/cms/knowledge-base')
      .then((r) => { if (on) setAdminKb(Array.isArray(r.data?.data?.articles) ? r.data.data.articles : []); })
      .catch(() => {});
    return () => { on = false; };
  }, []);

  const loadTickets = useCallback(async () => {
    try {
      const { data } = await api.get('/user/feedback');
      setTickets((data.data || []).filter((f) => f.category === 'SUPPORT'));
    } catch (_) { /* keep prior list on transient error */ }
    finally { setLoadingTickets(false); }
  }, []);
  useEffect(() => { loadTickets(); }, [loadTickets]);

  // Live: an admin reply / status change on `user:tickets` merges in.
  useEffect(() => {
    const unsub = wsClient.subscribe('user:tickets', (d) => {
      const t = d?.ticket;
      if (!t?._id) return;
      setTickets((prev) => {
        const i = prev.findIndex((x) => x._id === t._id);
        if (i === -1) return t.category === 'SUPPORT' ? [t, ...prev] : prev;
        const next = prev.slice();
        next[i] = { ...next[i], ...t };
        return next;
      });
    });
    return () => unsub && unsub();
  }, []);

  // Unread badge on the Live Chat tab (inbound while not on the chat tab).
  const tabRef = useRef(tab);
  useEffect(() => { tabRef.current = tab; }, [tab]);
  useEffect(() => { if (tab === 'chat') setChatUnread(0); }, [tab]);
  useEffect(() => {
    const unsub = wsClient.subscribe('user:chat', (d) => {
      if (d?.event === 'message' && d.message?.senderRole !== 'USER') {
        setChatUnread((n) => (tabRef.current === 'chat' ? 0 : n + 1));
      }
    });
    return () => unsub && unsub();
  }, []);

  const allKb = useMemo(() => [...KB_ARTICLES, ...adminKb], [adminKb]);
  const filteredKb = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allKb;
    return allKb.filter((a) => (a.q || '').toLowerCase().includes(q) || (a.a || '').toLowerCase().includes(q) || (a.tag || '').toLowerCase().includes(q));
  }, [search, allKb]);

  const submitTicket = async () => {
    if (subject.trim().length < 3) { Alert.alert('Subject', 'Subject too short'); return; }
    if (message.trim().length < 10) { Alert.alert('Message', 'Describe your issue (min 10 chars)'); return; }
    setSubmitting(true);
    try {
      await api.post('/user/feedback', {
        category: 'SUPPORT',
        subject,
        message,
        context: { page: '/helpdesk' },
        attachment: attachment ? toDataUrl(attachment) : undefined,
        attachmentName: attachment?.fileName,
      });
      Alert.alert('Ticket opened', "We'll respond shortly.");
      setSubject('');
      setMessage('');
      setAttachment(null);
      setTab('tickets');
      await loadTickets();
    } catch (e) {
      Alert.alert('Ticket', errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.intro}>
        <Text style={styles.h1}>Helpdesk</Text>
        <Text style={styles.sub}>Browse the knowledge base, or open a ticket — our team responds in under 24 hours.</Text>
      </View>

      <TabBar
        tab={tab}
        setTab={setTab}
        chatUnread={chatUnread}
        kbCount={allKb.length}
        ticketCount={tickets.length}
        styles={styles}
        c={c}
      />

      <View style={{ flex: 1 }}>
        {tab === 'chat' && <ChatPanel styles={styles} c={c} />}
        {tab === 'faq' && (
          <FaqPanel search={search} setSearch={setSearch} articles={filteredKb} navigation={navigation} setTab={setTab} styles={styles} c={c} />
        )}
        {tab === 'tickets' && (
          <TicketsPanel tickets={tickets} loading={loadingTickets} setTab={setTab} styles={styles} c={c} />
        )}
        {tab === 'new' && (
          <NewTicketPanel
            subject={subject} setSubject={setSubject}
            message={message} setMessage={setMessage}
            attachment={attachment} setAttachment={setAttachment}
            submitting={submitting} onSubmit={submitTicket}
            setTab={setTab} styles={styles} c={c}
          />
        )}
      </View>
    </View>
  );
}

const makeStyles = (c) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },

  // Intro
  intro: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  h1: { fontSize: 22, fontWeight: '900', color: c.textPrimary },
  sub: { fontSize: 12, color: c.textMuted, marginTop: 4 },

  // Tab bar
  tabBar: { borderBottomWidth: 1, borderBottomColor: c.borderSubtle, backgroundColor: c.bg },
  tabScroll: { paddingHorizontal: 8 },
  tabBtn: { paddingHorizontal: 8, paddingTop: 12 },
  tabBtnInner: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 12 },
  tabLabel: { fontSize: 13, fontWeight: '700', color: c.textMuted },
  tabLabelOn: { color: c.textPrimary },
  tabCount: { paddingHorizontal: 7, paddingVertical: 1, borderRadius: radius.pill, minWidth: 20, alignItems: 'center' },
  tabCountOn: { backgroundColor: c.primarySoft },
  tabCountOff: { backgroundColor: c.hover },
  tabCountTxt: { fontSize: 10, fontWeight: '800' },
  tabUnderline: { position: 'absolute', left: 8, right: 8, bottom: 0, height: 2, borderRadius: 2, backgroundColor: c.primary500 },

  // Shared panel padding
  panelPad: { padding: 16, gap: 12 },

  // FAQ
  searchInput: { height: 46, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 15, color: c.textPrimary, backgroundColor: c.card },
  kbCard: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: 14 },
  kbHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  kbTag: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6, color: c.primary500, marginBottom: 4 },
  kbQ: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
  kbBody: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.borderSubtle },
  kbA: { fontSize: 13, color: c.textSecondary, lineHeight: 20 },
  kbLink: { fontSize: 12, fontWeight: '700', color: c.primary500, marginTop: 8 },

  // Empty states
  emptyCard: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: 32, alignItems: 'center' },
  emptyTxt: { fontSize: 14, color: c.textSecondary, fontWeight: '600', textAlign: 'center' },
  emptySub: { fontSize: 12, color: c.textMuted, marginTop: 4, textAlign: 'center' },

  // Small buttons
  smallPrimaryBtn: { backgroundColor: c.primary500, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 9, marginTop: 8, alignSelf: 'center' },
  smallPrimaryTxt: { color: c.white, fontSize: 12, fontWeight: '800' },

  // My Tickets
  ticketsHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  ticketsHeadTitle: { fontSize: 15, fontWeight: '800', color: c.textPrimary },
  ticketsEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  ticketsEmptyIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: c.hover, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  ticketList: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, overflow: 'hidden' },
  ticketRow: { paddingHorizontal: 14, paddingVertical: 14 },
  ticketRowDivider: { borderTopWidth: 1, borderTopColor: c.borderSubtle },
  ticketTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  ticketSubject: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
  ticketMeta: { fontSize: 11, color: c.textMuted, marginTop: 3 },
  ticketMsg: { fontSize: 12, color: c.textSecondary, marginTop: 8, lineHeight: 18 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  statusTxt: { fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  replyBox: { marginTop: 12, paddingLeft: 12, paddingVertical: 8, paddingRight: 10, borderLeftWidth: 2, borderLeftColor: c.primary500, backgroundColor: c.primarySoft, borderTopRightRadius: radius.sm, borderBottomRightRadius: radius.sm },
  replyLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6, color: c.primary500 },
  replyTxt: { fontSize: 12, color: c.textSecondary, marginTop: 4, lineHeight: 18 },

  // New Ticket form
  formCard: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: 16 },
  formTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  formTitleBar: { width: 4, height: 18, borderRadius: 2, backgroundColor: c.primary500 },
  formTitle: { fontSize: 16, fontWeight: '800', color: c.textPrimary },
  formHint: { fontSize: 12, color: c.textMuted, marginTop: 8, lineHeight: 18 },
  label: { fontSize: 13, fontWeight: '700', color: c.textSecondary, marginTop: 14, marginBottom: 6 },
  labelMuted: { fontWeight: '400', color: c.textMuted },
  input: { minHeight: 46, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: c.textPrimary, backgroundColor: c.bg },
  textarea: { minHeight: 140, textAlignVertical: 'top' },
  counter: { fontSize: 10, color: c.textMuted, marginTop: 4, textAlign: 'right', fontVariant: ['tabular-nums'] },
  attachRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: c.bg },
  attachThumb: { width: 40, height: 40, borderRadius: 6, backgroundColor: c.hover },
  attachName: { flex: 1, minWidth: 0, fontSize: 12, color: c.textSecondary },
  attachRemove: { fontSize: 12, fontWeight: '700', color: c.bear },
  attachBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', borderWidth: 1, borderStyle: 'dashed', borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10 },
  attachBtnTxt: { fontSize: 12, fontWeight: '600', color: c.textSecondary },
  infoBox: { flexDirection: 'row', gap: 8, marginTop: 16, backgroundColor: c.warnSoft, borderWidth: 1, borderColor: c.warnSoft, borderRadius: radius.md, padding: 12 },
  infoTxt: { flex: 1, fontSize: 12, color: c.textSecondary, lineHeight: 18 },
  formActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 18 },
  ghostBtn: { paddingHorizontal: 16, paddingVertical: 11, borderRadius: radius.md, borderWidth: 1, borderColor: c.border },
  ghostBtnTxt: { fontSize: 14, fontWeight: '700', color: c.textSecondary },
  primaryBtn: { paddingHorizontal: 18, paddingVertical: 11, borderRadius: radius.md, backgroundColor: c.primary500 },
  primaryBtnTxt: { fontSize: 14, fontWeight: '800', color: c.white },

  // Live Chat — header
  chatHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.borderSubtle, backgroundColor: c.card },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: c.primary500, alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { color: c.white, fontWeight: '800', fontSize: 16 },
  presenceDot: { position: 'absolute', bottom: -1, right: -1, width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: c.card },
  chatName: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
  chatStatus: { fontSize: 11, color: c.textMuted, marginTop: 2 },

  // Live Chat — thread
  thread: { flex: 1, backgroundColor: c.bg },
  threadContent: { padding: 14, gap: 6 },
  threadHint: { textAlign: 'center', fontSize: 12, color: c.textMuted, paddingVertical: 24 },
  loadOlderBtn: { borderWidth: 1, borderColor: c.borderSubtle, backgroundColor: c.card, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 },
  loadOlderTxt: { fontSize: 11, fontWeight: '700', color: c.primary500 },
  typingTxt: { fontSize: 11, color: c.textMuted, paddingHorizontal: 6, paddingTop: 2 },
  dividerWrap: { alignItems: 'center', marginVertical: 4 },
  dividerTxt: { fontSize: 10, fontWeight: '700', color: c.textMuted, backgroundColor: c.card, borderWidth: 1, borderColor: c.borderSubtle, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3, overflow: 'hidden' },

  // Bubbles
  bubbleRow: { flexDirection: 'row' },
  bubble: { maxWidth: '82%', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  bubbleMine: { backgroundColor: c.primary500, borderBottomRightRadius: 4 },
  bubbleTheirs: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderBottomLeftRadius: 4 },
  bubbleText: { fontSize: 14, lineHeight: 20 },
  bubbleMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 3 },
  bubbleTime: { fontSize: 10 },
  bubbleTick: { fontSize: 10, fontWeight: '700' },
  msgImg: { width: 180, height: 140, borderRadius: 10, backgroundColor: c.hover },
  msgFile: { fontSize: 13, fontWeight: '600', textDecorationLine: 'underline' },

  // No-manager card
  noMgrCard: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.xl, padding: 32, alignItems: 'center' },
  noMgrIcon: { width: 56, height: 56, borderRadius: radius.xl, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' },
  noMgrTitle: { fontSize: 15, fontWeight: '800', color: c.textPrimary, marginTop: 14, textAlign: 'center' },
  noMgrSub: { fontSize: 13, color: c.textSecondary, marginTop: 6, textAlign: 'center', lineHeight: 19 },

  // Composer
  composer: { borderTopWidth: 1, borderTopColor: c.borderSubtle, backgroundColor: c.card },
  pendingRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 10, paddingTop: 10 },
  pendingChip: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 230, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg, borderRadius: radius.md, paddingHorizontal: 8, paddingVertical: 6 },
  pendingThumb: { width: 28, height: 28, borderRadius: 5, backgroundColor: c.hover },
  pendingName: { fontSize: 11, fontWeight: '700', color: c.textPrimary },
  pendingSize: { fontSize: 10, color: c.textMuted, marginTop: 1 },
  pendingRemove: { fontSize: 13, color: c.textMuted, fontWeight: '700' },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 10, paddingVertical: 10 },
  attachIconBtn: { padding: 6 },
  composerInput: { flex: 1, maxHeight: 110, minHeight: 40, borderWidth: 1, borderColor: c.border, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9, fontSize: 14, color: c.textPrimary, backgroundColor: c.bg },
  sendBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 18, backgroundColor: c.primary500 },
  sendTxt: { color: c.white, fontSize: 14, fontWeight: '800' },
  composerHint: { fontSize: 10, color: c.textMuted, paddingHorizontal: 14, paddingBottom: 8 },
});
