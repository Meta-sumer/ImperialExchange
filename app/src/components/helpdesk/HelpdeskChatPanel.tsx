import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Image,
  Modal as RNModal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { errorMessage } from '@/api/client';
import { CHAT_POLL_MS, TYPING_DISPLAY_MS, TYPING_THROTTLE_MS, helpdeskApi } from '@/api/helpdesk.api';
import { AppText, Button, toast } from '@/components/ui';
import { useTheme } from '@/theme';
import {
  chatSendErrorText,
  chatThreadItems,
  composeChatSend,
  hasInbound,
  hasMoreHistory,
  isImageAttachment,
  markOutboundSeen,
  mergeChatMessages,
  parseChatSocketEvent,
  stageChatFiles,
  type ChatAttachment,
  type ChatCounterpart,
  type ChatConversation,
  type ChatMessage,
  type ChatPendingFile,
  type ChatUploadConfig,
} from '@/types/helpdesk';
import { apiErrorCode } from '@/utils/fundsFlows';
import { subscribeChat } from '@/websocket/channels';

/**
 * Live chat with the trader's ASSIGNED support manager —
 * client/src/pages/HelpdeskChat.jsx's panel. No manager picker: the server
 * resolves the manager; until one exists the panel says so.
 *
 * Every new message — the optimistic send, the `user:chat` echo and the 5 s
 * polling fallback — goes through mergeChatMessages, so nothing shows twice.
 * The poll asks only for messages after the newest one held, and pauses
 * while the app is in the background or the screen is not focused. Older
 * history loads a page at a time ("Load older messages") without moving the
 * message under the reader's eye. Inbound messages are marked seen; the
 * manager's "seen" ticks the trader's messages ✓✓; typing and presence
 * update live.
 *
 * Attachments: the system document picker stands in for the web's file
 * input; each pick is checked against the role's limits before it is read,
 * then read into a data: URI. Tapping an image opens it full screen; any
 * other file is handed to the share sheet (the phone's "download").
 */

const NEAR_BOTTOM_PX = 120;

const newPendingId = (): string => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function HelpdeskChatPanel({ embedded = false }: { embedded?: boolean }): React.JSX.Element {
  const t = useTheme();
  const focused = useIsFocused();
  const { height: winH } = useWindowDimensions();

  const [conv, setConv] = useState<ChatConversation | null>(null);
  const [counterpart, setCounterpart] = useState<ChatCounterpart | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [theyTyping, setTheyTyping] = useState(false);
  const [uploadCfg, setUploadCfg] = useState<ChatUploadConfig | null>(null);
  const [pending, setPending] = useState<ChatPendingFile[]>([]);
  const [viewer, setViewer] = useState<ChatAttachment | null>(null);

  const scrollRef = useRef<ScrollView>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const convId = conv?.id ?? null;
  const convIdRef = useRef<string | null>(null);
  convIdRef.current = convId;
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSent = useRef(0);
  const nearBottom = useRef(true);
  const stickToBottom = useRef(false);
  // "Load older" keeps the same message in view: remember the content height
  // before the prepend and shift by the difference once it lands.
  const prependFrom = useRef<{ height: number; y: number } | null>(null);
  const contentH = useRef(0);
  const scrollY = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, []);

  const setThread = (next: ChatMessage[]): void => {
    messagesRef.current = next;
    setMessages(next);
  };

  const markSeen = useCallback((id: string | null) => {
    if (id) helpdeskApi.markSeen(id).catch(() => undefined);
  }, []);

  /** The single funnel for every new message. */
  const mergeIncoming = useCallback((incoming: ChatMessage | ChatMessage[], opts: { forceScroll?: boolean } = {}) => {
    const { messages: merged, added } = mergeChatMessages(messagesRef.current, incoming);
    if (!added.length) return;
    if (opts.forceScroll || nearBottom.current) stickToBottom.current = true;
    setThread(merged);
    if (hasInbound(added)) markSeen(convIdRef.current);
  }, [markSeen]);

  // Upload limits for this role — they drive validation and the hint line.
  useEffect(() => {
    helpdeskApi.uploadConfig().then((c) => { if (alive.current) setUploadCfg(c); }).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    try {
      const thread = await helpdeskApi.conversation();
      if (!alive.current) return;
      setConv(thread.conversation);
      setCounterpart(thread.counterpart);
      setThread(thread.messages);
      setHasMore(hasMoreHistory(thread.messages));
      stickToBottom.current = true;
      if (thread.conversation?.id) markSeen(thread.conversation.id);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [markSeen]);

  useEffect(() => { void load(); }, [load]);

  const loadOlder = async (): Promise<void> => {
    const cur = messagesRef.current;
    const oldest = cur[0];
    if (loadingMore || !hasMore || !convId || !oldest) return;
    setLoadingMore(true);
    try {
      const older = await helpdeskApi.messagesBefore(convId, oldest);
      if (!alive.current) return;
      if (!hasMoreHistory(older)) setHasMore(false);
      if (older.length) {
        prependFrom.current = { height: contentH.current, y: scrollY.current };
        setThread(mergeChatMessages(messagesRef.current, older).messages);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      if (alive.current) setLoadingMore(false);
    }
  };

  // Realtime — the trader's chat channel.
  useEffect(() => subscribeChat((raw) => {
    const d = parseChatSocketEvent(raw);
    if (!d) return;
    if (d.event === 'message') {
      mergeIncoming(d.message);
    } else if (d.event === 'typing') {
      if (d.by !== 'USER') {
        setTheyTyping(true);
        if (typingTimer.current) clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => { if (alive.current) setTheyTyping(false); }, TYPING_DISPLAY_MS);
      }
    } else if (d.event === 'seen') {
      if (d.by !== 'USER') setThread(markOutboundSeen(messagesRef.current, new Date().toISOString()));
    } else if (d.event === 'presence') {
      setCounterpart((c) => (c && String(c.id) === String(d.userId) ? { ...c, online: d.online } : c));
    }
  }), [mergeIncoming]);

  // Polling fallback: only what arrived after the newest message held;
  // paused in the background and while another screen is in front.
  useEffect(() => {
    if (!convId || !focused) return undefined;
    const id = setInterval(() => {
      if (AppState.currentState !== 'active') return;
      const cur = messagesRef.current;
      helpdeskApi.messagesAfter(convId, cur[cur.length - 1] ?? null)
        .then((msgs) => { if (alive.current) mergeIncoming(msgs); })
        .catch(() => undefined);
    }, CHAT_POLL_MS);
    return () => clearInterval(id);
  }, [convId, focused, mergeIncoming]);

  const onType = (v: string): void => {
    setText(v);
    const now = Date.now();
    if (convId && counterpart && now - lastTypingSent.current > TYPING_THROTTLE_MS) {
      lastTypingSent.current = now;
      helpdeskApi.typing(convId).catch(() => undefined);
    }
  };

  const pickFiles = async (): Promise<void> => {
    if (!uploadCfg || !uploadCfg.enabled) { toast.error('File uploads are currently disabled.'); return; }
    let res: DocumentPicker.DocumentPickerResult;
    try {
      res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    } catch (e) {
      toast.error(errorMessage(e));
      return;
    }
    if (res.canceled || !res.assets?.length) return;
    const picked = res.assets.map((a) => ({
      name: a.name || 'file',
      size: typeof a.size === 'number' ? a.size : 0,
      mimeType: a.mimeType ?? 'application/octet-stream',
      uri: a.uri,
    }));
    const staged = pending.map((p) => ({ name: p.name, size: p.sizeBytes, mimeType: p.mimeType }));
    const { accepted, errors } = stageChatFiles(picked, staged, uploadCfg);
    for (const e of errors) toast.error(e);
    for (const f of accepted) {
      const id = newPendingId();
      setPending((prev) => [...prev, { id, name: f.name, mimeType: f.mimeType, dataUrl: '', sizeBytes: f.size, progress: 0 }]);
      new File(f.uri).base64()
        .then((b64) => {
          if (!alive.current) return;
          const dataUrl = `data:${f.mimeType};base64,${b64}`;
          setPending((prev) => prev.map((x) => (x.id === id ? { ...x, dataUrl, progress: 100 } : x)));
        })
        .catch(() => {
          if (!alive.current) return;
          toast.error(`Failed to read "${f.name}"`);
          setPending((prev) => prev.filter((x) => x.id !== id));
        });
    }
  };

  const submit = async (): Promise<void> => {
    if (sending || !convId) return;
    const composed = composeChatSend(text, pending);
    if (!composed) return;
    if ('error' in composed) { toast.error(composed.error); return; }
    setSending(true);
    const staged = pending;
    setPending([]);
    try {
      const msg = await helpdeskApi.send(convId, composed.body);
      if (!alive.current) return;
      setText('');
      mergeIncoming(msg, { forceScroll: true });
    } catch (e) {
      // Keep what the trader wrote and attached, so a retry needs no re-pick.
      if (alive.current) setPending(staged);
      toast.error(chatSendErrorText(apiErrorCode(e) ?? undefined, errorMessage(e)));
    } finally {
      if (alive.current) setSending(false);
    }
  };

  const openAttachment = async (a: ChatAttachment): Promise<void> => {
    if (isImageAttachment(a)) { setViewer(a); return; }
    try {
      const base64 = a.dataUrl.replace(/^data:[^;]*;base64,/, '');
      const file = new File(Paths.cache, (a.name || 'file').replace(/[\\/:*?"<>|]+/g, '_'));
      file.create({ overwrite: true });
      file.write(base64, { encoding: 'base64' });
      if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');
      await Sharing.shareAsync(file.uri, { mimeType: a.mimeType || undefined, dialogTitle: a.name });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    scrollY.current = contentOffset.y;
    nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < NEAR_BOTTOM_PX;
  };

  const onContentSizeChange = (_w: number, h: number): void => {
    contentH.current = h;
    const from = prependFrom.current;
    if (from) {
      prependFrom.current = null;
      scrollRef.current?.scrollTo({ y: Math.max(0, h - from.height + from.y), animated: false });
      return;
    }
    if (stickToBottom.current) {
      stickToBottom.current = false;
      scrollRef.current?.scrollToEnd({ animated: false });
    }
  };

  if (loading) {
    return <AppText variant="body" tone="muted" align="center" style={styles.loading}>Loading chat…</AppText>;
  }

  if (!counterpart) {
    return (
      <View style={[styles.none, { backgroundColor: t.colors.surface, borderColor: t.colors.borderDark }]}>
        <View style={[styles.noneIcon, { backgroundColor: t.alpha(t.colors.primary, 0.1) }]}>
          <AppText style={styles.noneGlyph} color={t.colors.primaryText}>💬</AppText>
        </View>
        <AppText variant="title" align="center" style={styles.noneTitle}>A support manager will be assigned soon</AppText>
        <AppText variant="body" tone="secondary" align="center">
          Once your account is assigned a manager, you can chat with them here in real time.
        </AppText>
      </View>
    );
  }

  const items = chatThreadItems(messages);
  const panelHeight = Math.round(winH * (embedded ? 0.68 : 0.7));
  const hintLine = uploadCfg
    ? (!uploadCfg.enabled
      ? 'File uploads are currently disabled by the administrator.'
      : `Allowed: ${uploadCfg.allowedExtensions.slice(0, 8).join(', ') || 'any (non-executable)'} · Max ${uploadCfg.maxFileMB} MB per file`)
    : null;

  return (
    <View
      testID="helpdesk-chat"
      style={[styles.panel, { height: panelHeight, backgroundColor: t.colors.surface, borderColor: t.colors.borderDark }]}
    >
      {/* Manager */}
      <View style={[styles.head, { borderBottomColor: t.colors.borderSubtle, backgroundColor: t.colors.bgCard }]}>
        <View>
          <View style={[styles.avatar, { backgroundColor: '#2563EB' }]}>
            <AppText variant="bodyStrong" weight="700" color="#FFFFFF">{(counterpart.name || 'M').slice(0, 1).toUpperCase()}</AppText>
          </View>
          <View
            style={[styles.presence, {
              backgroundColor: counterpart.online ? t.colors.bull : t.colors.textMuted,
              borderColor: t.colors.surface,
            }]}
          />
        </View>
        <View style={styles.flex}>
          <AppText variant="bodyStrong" weight="700" numberOfLines={1}>{counterpart.name}</AppText>
          <AppText variant="caption" tone="muted">{`${counterpart.online ? 'Online' : 'Offline'} · Your support manager`}</AppText>
        </View>
      </View>

      {/* Thread */}
      <ScrollView
        ref={scrollRef}
        style={[styles.thread, { backgroundColor: t.colors.bgDark ?? t.colors.bgHover }]}
        contentContainerStyle={styles.threadContent}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={onContentSizeChange}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        {hasMore ? (
          <View style={styles.olderWrap}>
            <Pressable
              accessibilityRole="button"
              disabled={loadingMore}
              onPress={() => { void loadOlder(); }}
              style={[styles.older, { borderColor: t.colors.borderSubtle, backgroundColor: t.colors.bgCard, opacity: loadingMore ? 0.5 : 1 }]}
            >
              <AppText variant="caption" weight="600" color={t.colors.primaryText}>
                {loadingMore ? 'Loading…' : 'Load older messages'}
              </AppText>
            </Pressable>
          </View>
        ) : null}
        {messages.length === 0 ? (
          <AppText variant="small" tone="muted" align="center" style={styles.hello}>Say hello to your support manager 👋</AppText>
        ) : null}
        {items.map((it) => (it.kind === 'day' ? (
          <View key={it.key} style={styles.dayWrap}>
            <View style={[styles.day, { backgroundColor: t.colors.bgCard, borderColor: t.colors.borderSubtle }]}>
              <AppText variant="micro" weight="600" tone="muted">{it.label}</AppText>
            </View>
          </View>
        ) : (
          <Bubble key={it.key} m={it.message} mine={it.mine} onOpen={(a) => { void openAttachment(a); }} />
        )))}
        {theyTyping ? <AppText variant="caption" tone="muted" style={styles.typing}>{`${counterpart.name} is typing…`}</AppText> : null}
      </ScrollView>

      {/* Composer */}
      <View style={[styles.composer, { borderTopColor: t.colors.borderSubtle, backgroundColor: t.colors.surface }]}>
        {pending.length ? (
          <View style={styles.pendingRow}>
            {pending.map((p) => (
              <View key={p.id} style={[styles.pending, { borderColor: t.colors.borderDark, backgroundColor: t.colors.bgCard }]}>
                <AppText style={styles.clip}>📎</AppText>
                <View style={styles.flex}>
                  <AppText variant="caption" weight="600" numberOfLines={1}>{p.name}</AppText>
                  <AppText variant="micro" tone="muted">
                    {`${(p.sizeBytes / 1024 / 1024).toFixed(2)} MB${p.progress < 100 ? ` · ${p.progress}%` : ''}`}
                  </AppText>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${p.name}`}
                  hitSlop={8}
                  onPress={() => setPending((prev) => prev.filter((x) => x.id !== p.id))}
                >
                  <AppText variant="small" tone="muted">✕</AppText>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
        <View style={styles.inputRow}>
          {uploadCfg?.enabled !== false ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={uploadCfg ? `Attach · max ${uploadCfg.maxFileMB} MB/file` : 'Attach'}
              hitSlop={6}
              onPress={() => { void pickFiles(); }}
              style={({ pressed }) => [styles.attach, pressed ? { backgroundColor: t.colors.bgHover } : null]}
            >
              <AppText style={styles.clipBtn} tone="muted">📎</AppText>
            </Pressable>
          ) : null}
          <TextInput
            value={text}
            onChangeText={onType}
            placeholder="Type a message…"
            placeholderTextColor={t.colors.textMuted}
            multiline
            style={[styles.input, { borderColor: t.colors.borderDark, color: t.colors.textPrimary, backgroundColor: t.colors.surface }]}
            accessibilityLabel="Message"
          />
          <Button
            title="Send"
            size="sm"
            onPress={() => { void submit(); }}
            disabled={sending || (!text.trim() && pending.length === 0)}
          />
        </View>
        {hintLine ? <AppText variant="micro" tone="muted" style={styles.hint}>{hintLine}</AppText> : null}
      </View>

      <RNModal visible={!!viewer} transparent animationType="fade" onRequestClose={() => setViewer(null)}>
        <Pressable style={styles.viewer} onPress={() => setViewer(null)} accessibilityLabel="Close image">
          {viewer ? <Image source={{ uri: viewer.dataUrl }} resizeMode="contain" style={styles.viewerImg} accessibilityLabel={viewer.name} /> : null}
        </Pressable>
      </RNModal>
    </View>
  );
}

function Bubble({ m, mine, onOpen }: { m: ChatMessage; mine: boolean; onOpen: (a: ChatAttachment) => void }): React.JSX.Element {
  const t = useTheme();
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <View style={[styles.bubbleRow, { justifyContent: mine ? 'flex-end' : 'flex-start' }]}>
      <View
        style={[styles.bubble, mine
          ? { backgroundColor: t.colors.primary, borderBottomRightRadius: 4 }
          : { backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.borderDark, borderBottomLeftRadius: 4 }]}
      >
        {m.attachments.map((a, i) => (
          <Pressable key={`${m.id}-a${i}`} accessibilityRole="button" onPress={() => onOpen(a)} style={styles.attachment}>
            {isImageAttachment(a) ? (
              <Image source={{ uri: a.dataUrl }} accessibilityLabel={a.name} resizeMode="cover" style={styles.attImg} />
            ) : (
              <AppText variant="body" color={mine ? 'rgba(255,255,255,0.9)' : t.colors.primaryText} style={styles.fileLink}>
                {`📎 ${a.name || 'file'}`}
              </AppText>
            )}
          </Pressable>
        ))}
        {m.text ? <AppText variant="body" color={mine ? '#FFFFFF' : t.colors.textPrimary}>{m.text}</AppText> : null}
        <AppText variant="micro" align="right" color={mine ? 'rgba(255,255,255,0.7)' : t.colors.textMuted} style={styles.meta}>
          {`${time}${mine ? (m.seenAt ? '  ✓✓' : '  ✓') : ''}`}
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  loading: { paddingVertical: 40 },
  none: { borderWidth: 1, borderRadius: 16, padding: 32, alignItems: 'center', gap: 4 },
  noneIcon: { width: 56, height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  noneGlyph: { fontSize: 24, lineHeight: 30 },
  noneTitle: { marginTop: 12 },
  panel: { borderWidth: 1, borderRadius: 16, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  presence: { position: 'absolute', right: -1, bottom: -1, width: 12, height: 12, borderRadius: 6, borderWidth: 2 },
  thread: { flex: 1 },
  threadContent: { padding: 16, gap: 8 },
  olderWrap: { alignItems: 'center', paddingBottom: 4 },
  older: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
  hello: { paddingVertical: 32 },
  dayWrap: { alignItems: 'center', marginVertical: 4 },
  day: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2 },
  typing: { paddingHorizontal: 8 },
  bubbleRow: { flexDirection: 'row' },
  bubble: { maxWidth: '78%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  attachment: { marginBottom: 6 },
  attImg: { width: 180, height: 180, borderRadius: 8 },
  fileLink: { textDecorationLine: 'underline' },
  meta: { marginTop: 2 },
  composer: { borderTopWidth: 1 },
  pendingRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 10, paddingTop: 10 },
  pending: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 230, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  clip: { fontSize: 16 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10 },
  attach: { padding: 8, borderRadius: 8 },
  clipBtn: { fontSize: 18 },
  input: { flex: 1, maxHeight: 112, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
  hint: { paddingHorizontal: 12, paddingBottom: 8 },
  viewer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  viewerImg: { width: '100%', height: '80%' },
});
