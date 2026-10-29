import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { complianceApi, kycUploadError } from '@/api/compliance.api';
import { userApi } from '@/api/user.api';
import { AppText, BottomSheet, Select, toast, useConfirm } from '@/components/ui';
import { useTheme } from '@/theme';
import {
  KYC_DOC_TYPES,
  PAN_CARD,
  effectiveKycStatus,
  kycDocDisplayStatus,
  kycDocLabel,
  userKycRejectionReason,
  type AuthUser,
  type KycDocType,
  type KycDocument,
} from '@/types/user';
import {
  KYC_PAN_FIRST,
  docStatusTone,
  docsSubtitle,
  kycFileError,
  kycNameForMime,
  kycStatusMeta,
  kycUploadTimeoutMs,
  kycUploadedToast,
  panBadge,
  panFormShown,
  panGate,
  panStatusLine,
  shortDate,
  sniffKycMime,
  underscoreToSpace,
} from '@/utils/profile';

import {
  CAMERA_BLOCKED,
  CAMERA_BLOCKED_TITLE,
  pickKycFile,
  readBase64,
  type KycPick,
  type KycSource,
} from './kycPicker';
import { ProfileIcon, type ProfileIconName } from './ProfileIcons';
import { IconTile, SectionCard, StatusBadge, toneColors } from './ProfilePrimitives';

const SOURCES: ReadonlyArray<{ key: KycSource; label: string; icon: ProfileIconName }> = [
  { key: 'camera', label: 'Take photo', icon: 'camera' },
  { key: 'library', label: 'Photo library', icon: 'image' },
  { key: 'files', label: 'Browse files', icon: 'folder' },
];

type Step2Type = (typeof KYC_DOC_TYPES)[number]['value'];

/**
 * Profile.jsx KycTab — the status banner; then, while this account may
 * still upload, Step 1 (the PAN card, required) and Step 2 (the other
 * documents, locked until a PAN card that is not rejected is on file) — or
 * "Verification complete" once it may not; then the documents on file.
 *
 * Whether it may upload is GET /user/kyc/status `canUpload` (a verified
 * account, unless an admin re-opened upload). Like the web, the form stays
 * up while that read is out or if it fails, and Step 2 locks only once the
 * document list has actually loaded — a failed read never locks anyone out.
 *
 * The web's drag-and-drop zones are tap targets here that open the three
 * sources a phone's file input offers; the upload starts as soon as a file
 * is chosen, as it does on the web's `onChange`.
 */
export function KycTab({
  user,
  onUpdate,
  reloadSignal,
}: {
  user: AuthUser | null;
  onUpdate: () => Promise<void>;
  /** Bumped by the screen's pull-to-refresh. */
  reloadSignal: number;
}): React.JSX.Element {
  const t = useTheme();
  const confirm = useConfirm();
  const [docs, setDocs] = useState<KycDocument[]>([]);
  const [docsLoaded, setDocsLoaded] = useState(false);
  const [canUpload, setCanUpload] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [docType, setDocType] = useState<Step2Type>('ID_FRONT');
  /** The PAN card on file is pending and the user chose "Upload a different one". */
  const [replacing, setReplacing] = useState(false);
  /** Which upload the source sheet is open for, or null when it is closed. */
  const [chooser, setChooser] = useState<KycDocType | null>(null);
  // Set in the setup, not only cleared in the cleanup: StrictMode and Fast
  // Refresh replay cleanup + setup on a live component, and a flag only
  // ever cleared would drop every later result (an empty list, a dropzone
  // stuck on "Uploading…").
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // Loads overlap — the mount, pull to refresh, coming back from a picker
  // (Android backgrounds the app for it), the reload after an upload — and
  // answers can land out of order. Only an answer to a later request than
  // the one on screen is shown, so a list read before an upload cannot
  // replace the list read after it. The two reads are sequenced apart.
  const issued = useRef(0);
  const docsShown = useRef(0);
  const statusShown = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++issued.current;
    await Promise.all([
      complianceApi.kycDocuments().then((list) => {
        if (!alive.current || mine <= docsShown.current) return;
        docsShown.current = mine;
        setDocs(list);
        setDocsLoaded(true);
      }, () => { /* ignore — Profile.jsx */ }),
      userApi.kycStatus().then((s) => {
        if (!alive.current || mine <= statusShown.current) return;
        statusShown.current = mine;
        setCanUpload(s.canUpload);
      }, () => { /* leave the control visible rather than lock someone out on a blip */ }),
    ]);
  }, []);

  useEffect(() => { void refresh(); }, [refresh, reloadSignal]);

  // One pick-and-upload at a time. `uploading` only starts once a file is
  // chosen, so a second tap on a source (before the sheet has gone) would
  // otherwise open a second picker over the first.
  const busy = useRef(false);

  /** Resolves true when the document was accepted (Profile.jsx upload). */
  const upload = async (source: KycSource, type: KycDocType): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    setChooser(null);
    try {
      let picked: KycPick;
      try {
        picked = await pickKycFile(source, type);
      } catch (e) {
        toast.error(errorMessage(e));
        return false;
      }
      if (!picked.ok) {
        if (picked.reason === 'denied') toast.error(picked.message);
        if (picked.reason === 'blocked') {
          // The system will not ask again; only Settings can turn it back on.
          const go = await confirm({ title: CAMERA_BLOCKED_TITLE, message: CAMERA_BLOCKED, confirmText: 'Open Settings' });
          if (go) Linking.openSettings().catch(() => { toast.error(CAMERA_BLOCKED); });
        }
        return false;
      }
      const file = picked.file;

      // Size (then type) before a byte is read.
      const early = kycFileError(file);
      if (early) { toast.error(early); return false; }

      setUploading(true);
      try {
        const dataBase64 = await readBase64(file.uri);
        // A photo is whatever the picker encoded it as; the bytes say which.
        // A browsed file goes as the file it is — the server judges it.
        const sniffed = file.reencoded ? sniffKycMime(dataBase64) : null;
        const mimeType = sniffed ?? file.mimeType;
        const filename = sniffed ? kycNameForMime(file.name, sniffed) : file.name;
        // The picker may not have known the size; the decoded bytes decide.
        const late = kycUploadError({ mimeType, dataBase64 });
        if (late) { toast.error(late); return false; }
        await complianceApi.uploadKycDocumentTimed(
          { docType: type, filename, mimeType, dataBase64 },
          kycUploadTimeoutMs(dataBase64.length),
        );
        toast.success(kycUploadedToast(type));
        // PanCardStep clears its own form only on success.
        if (type === PAN_CARD && alive.current) setReplacing(false);
        void refresh();
        await onUpdate();
        return true;
      } catch (e) {
        toast.error(errorMessage(e));
        return false;
      } finally {
        if (alive.current) setUploading(false);
      }
    } finally {
      busy.current = false;
    }
  };

  const rawStatus = user?.kycStatus || 'NOT_SUBMITTED';
  const { panDoc, panStatus, otherUploadsLocked } = panGate(docs, rawStatus, docsLoaded);
  // Documents on file under a NOT_SUBMITTED account read as under review.
  const status = effectiveKycStatus(rawStatus, docs);
  const meta = kycStatusMeta(status);
  const c = toneColors(t, meta.tone);
  const warn = toneColors(t, 'warn');
  const rejection = userKycRejectionReason(user);
  const step2Busy = uploading || otherUploadsLocked;

  return (
    <View style={styles.stack}>
      {/* Status banner */}
      <View
        testID="kyc-banner"
        style={[styles.banner, { backgroundColor: c.bg, borderColor: c.border, borderRadius: t.radius.xxl }]}
      >
        <View style={[styles.bannerIcon, { backgroundColor: t.colors.surface, borderColor: t.colors.borderSubtle, borderRadius: t.radius.xl }]}>
          <ProfileIcon name="shieldCheck" size={24} color={c.fg} />
        </View>
        <View style={styles.flex}>
          <View style={styles.titleRow}>
            <AppText variant="title" weight="800">KYC Verification</AppText>
            <View
              style={[
                styles.statusChip,
                { backgroundColor: t.colors.surface, borderColor: t.alpha(c.fg, 0.2) },
              ]}
            >
              <AppText variant="micro" weight="800" color={c.fg} style={styles.upper}>
                {underscoreToSpace(status)}
              </AppText>
            </View>
          </View>
          <AppText variant="body" tone="secondary" style={styles.gap4}>{meta.desc}</AppText>
          {rejection ? (
            <View
              style={[
                styles.reason,
                { backgroundColor: t.colors.surface, borderColor: t.alpha(t.colors.bear, 0.3), borderRadius: t.radius.lg },
              ]}
            >
              <AppText variant="body" color={t.colors.bear}>
                <AppText variant="body" weight="700" color={t.colors.bear}>Rejection reason: </AppText>
                {rejection}
              </AppText>
            </View>
          ) : null}
        </View>
      </View>

      {/* Upload — hidden once verified: there is nothing left to submit. An
          admin can re-open it when something genuinely needs refreshing. */}
      {!canUpload ? (
        <SectionCard
          icon="shieldCheck"
          title="Verification complete"
          subtitle="No further documents are needed."
        >
          <AppText variant="body" tone="secondary">
            Your identity is verified. If something needs updating — an expired
            ID, a change of address — contact support and they will re-open
            document upload for you.
          </AppText>
        </SectionCard>
      ) : (
        <>
          <PanCardStep
            panDoc={panDoc}
            panStatus={panStatus}
            uploading={uploading}
            replacing={replacing}
            onReplacing={setReplacing}
            onPick={() => setChooser(PAN_CARD)}
          />

          <SectionCard
            icon="upload"
            title="Upload document"
            subtitle="Step 2 · JPG, PNG, or PDF — max 10MB per file."
          >
            {otherUploadsLocked ? (
              <View
                testID="kyc-pan-first"
                style={[styles.notice, { backgroundColor: warn.bg, borderColor: warn.border, borderRadius: t.radius.lg }]}
              >
                <View style={styles.noticeIcon}><ProfileIcon name="lock" size={16} color={warn.fg} /></View>
                <AppText variant="body" color={warn.fg} style={styles.flex}>{KYC_PAN_FIRST}</AppText>
              </View>
            ) : null}
            <Select<Step2Type>
              label="Document type"
              value={docType}
              options={KYC_DOC_TYPES.map((d) => ({ value: d.value, label: d.label }))}
              onChange={setDocType}
              disabled={otherUploadsLocked}
            />
            <Pressable
              testID="kyc-dropzone"
              accessibilityRole="button"
              accessibilityLabel="Choose a document to upload"
              accessibilityState={{ disabled: step2Busy, busy: uploading }}
              disabled={step2Busy}
              onPress={() => setChooser(docType)}
              style={({ pressed }) => [
                styles.drop,
                {
                  borderRadius: t.radius.xl,
                  borderColor: pressed ? t.colors.primary : t.colors.borderDark,
                  backgroundColor: pressed ? t.alpha(t.colors.primary, 0.05) : t.alpha(t.colors.bgHover, 0.3),
                  opacity: step2Busy ? 0.6 : 1,
                },
              ]}
            >
              <IconTile icon="upload" size={48} iconSize={24} />
              <AppText variant="body" weight="700" align="center" style={styles.gap12}>
                {uploading ? 'Uploading…' : otherUploadsLocked ? 'Upload your PAN card first' : 'Tap to take a photo or choose a file'}
              </AppText>
              <AppText variant="small" tone="muted" align="center" style={styles.gap4}>Max 10MB · JPG, PNG, PDF</AppText>
            </Pressable>
          </SectionCard>
        </>
      )}

      {/* Documents list. A user's own handful of uploads — rendered in the
          page's scroll like the web's divide-y list, not a nested list. */}
      <SectionCard icon="folder" title="Uploaded documents" subtitle={docsSubtitle(docs.length)} padded={false}>
        {docs.length === 0 ? (
          <View style={styles.empty}>
            <IconTile icon="folder" size={48} iconSize={24} tone="muted" />
            <AppText variant="body" tone="muted" style={styles.gap12}>No documents uploaded yet</AppText>
          </View>
        ) : (
          docs.map((d, i) => {
            const ds = kycDocDisplayStatus(d, rawStatus);
            return (
              <View
                key={d.id || String(i)}
                testID="kyc-doc-row"
                style={[styles.docRow, i > 0 ? { borderTopWidth: 1, borderTopColor: t.colors.borderSubtle } : null]}
              >
                <IconTile icon={d.docType === PAN_CARD ? 'idCard' : 'file'} />
                <View style={styles.flex}>
                  <AppText variant="body" weight="700" numberOfLines={1}>{kycDocLabel(d.docType)}</AppText>
                  <AppText variant="caption" tone="muted" numberOfLines={1}>
                    {`${d.originalFilename} · ${shortDate(d.createdAt)}`}
                  </AppText>
                  {ds === 'REJECTED' && d.rejectionReason ? (
                    <AppText variant="caption" color={t.colors.bear} numberOfLines={2}>
                      {`Reason: ${d.rejectionReason}`}
                    </AppText>
                  ) : null}
                </View>
                <StatusBadge label={ds} tone={docStatusTone(ds)} />
              </View>
            );
          })
        )}
      </SectionCard>

      <BottomSheet
        open={chooser != null}
        onClose={() => setChooser(null)}
        title={chooser === PAN_CARD ? 'PAN Card' : 'Upload document'}
      >
        <AppText variant="small" tone="muted" style={styles.sheetHint}>
          {chooser === PAN_CARD
            ? 'Upload a clear photo or scan of your PAN card.'
            : KYC_DOC_TYPES.find((d) => d.value === chooser)?.label}
        </AppText>
        {SOURCES.map((s) => (
          <Pressable
            key={s.key}
            accessibilityRole="button"
            onPress={() => { if (chooser) void upload(s.key, chooser); }}
            style={({ pressed }) => [
              styles.source,
              { borderRadius: t.radius.lg, backgroundColor: pressed ? t.colors.bgHover : 'transparent' },
            ]}
          >
            <IconTile icon={s.icon} />
            <AppText variant="bodyStrong">{s.label}</AppText>
          </Pressable>
        ))}
      </BottomSheet>
    </View>
  );
}

/**
 * Profile.jsx PanCardStep — Step 1 of KYC: a photo or scan of the PAN card,
 * mandatory for an Indian trading account. Upload only; no PAN number is
 * typed anywhere. Shows the card on file and its review state; the upload
 * zone shows when nothing usable is on file (none yet, or rejected), or
 * when the user chose to replace one still pending.
 */
function PanCardStep({
  panDoc,
  panStatus,
  uploading,
  replacing,
  onReplacing,
  onPick,
}: {
  panDoc: KycDocument | null;
  panStatus: string | null;
  uploading: boolean;
  replacing: boolean;
  onReplacing: (v: boolean) => void;
  onPick: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const showForm = panFormShown(!!panDoc, panStatus, replacing);
  const badge = panBadge(panStatus);
  const line = panStatusLine(panStatus);

  return (
    <SectionCard
      testID="kyc-pan-step"
      icon="idCard"
      title="PAN Card"
      subtitle="Step 1 · Required. Upload a clear photo or scan of your PAN card."
      action={<StatusBadge label={badge.label} tone={badge.tone} />}
    >
      {panDoc ? (
        <View
          style={[
            styles.onFile,
            { borderColor: t.colors.borderSubtle, backgroundColor: t.alpha(t.colors.bgHover, 0.4), borderRadius: t.radius.lg },
          ]}
        >
          <View style={styles.onFileRow}>
            <View style={styles.flex}>
              <AppText variant="micro" weight="700" tone="muted" style={styles.upper}>PAN card on file</AppText>
              <AppText variant="caption" tone="muted" numberOfLines={1} style={styles.gap2}>
                {`${panDoc.originalFilename} · ${shortDate(panDoc.createdAt)}`}
              </AppText>
            </View>
            {panStatus === 'PENDING' && !replacing ? (
              <AppText
                variant="small"
                weight="600"
                color={t.colors.primaryText}
                accessibilityRole="button"
                onPress={() => onReplacing(true)}
                suppressHighlighting
              >
                Upload a different one
              </AppText>
            ) : null}
          </View>
          {line ? <AppText variant="small" tone="secondary" style={styles.gap8}>{line}</AppText> : null}
          {panStatus === 'REJECTED' && panDoc.rejectionReason ? (
            <View
              style={[
                styles.panReason,
                { backgroundColor: t.colors.surface, borderColor: t.alpha(t.colors.bear, 0.3), borderRadius: t.radius.lg },
              ]}
            >
              <AppText variant="body" color={t.colors.bear}>
                <AppText variant="body" weight="700" color={t.colors.bear}>Rejection reason: </AppText>
                {panDoc.rejectionReason}
              </AppText>
            </View>
          ) : null}
        </View>
      ) : null}

      {showForm ? (
        <>
          <Pressable
            testID="kyc-pan-dropzone"
            accessibilityRole="button"
            accessibilityLabel="Choose your PAN card to upload"
            accessibilityState={{ disabled: uploading, busy: uploading }}
            disabled={uploading}
            onPress={onPick}
            style={({ pressed }) => [
              styles.drop,
              {
                borderRadius: t.radius.xl,
                borderColor: pressed ? t.colors.primary : t.colors.borderDark,
                backgroundColor: pressed ? t.alpha(t.colors.primary, 0.05) : t.alpha(t.colors.bgHover, 0.3),
                opacity: uploading ? 0.6 : 1,
              },
            ]}
          >
            <IconTile icon="idCard" size={48} iconSize={24} />
            <AppText variant="body" weight="700" align="center" style={styles.gap12}>
              {uploading ? 'Uploading…' : 'Tap to photograph your PAN card or choose a file'}
            </AppText>
            <AppText variant="small" tone="muted" align="center" style={styles.gap4}>Max 10MB · JPG, PNG, PDF</AppText>
          </Pressable>

          {replacing && panStatus === 'PENDING' ? (
            <AppText
              variant="small"
              weight="600"
              tone="muted"
              accessibilityRole="button"
              onPress={() => onReplacing(false)}
              suppressHighlighting
            >
              Cancel
            </AppText>
          ) : null}
        </>
      ) : null}
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 20 },
  flex: { flex: 1, minWidth: 0 },
  banner: { flexDirection: 'row', alignItems: 'flex-start', gap: 16, borderWidth: 1, padding: 20 },
  bannerIcon: { width: 48, height: 48, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  statusChip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  upper: { textTransform: 'uppercase', letterSpacing: 0.6 },
  gap2: { marginTop: 2 },
  gap4: { marginTop: 4 },
  gap8: { marginTop: 8 },
  gap12: { marginTop: 12 },
  reason: { marginTop: 12, padding: 12, borderWidth: 1 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12, borderWidth: 1 },
  noticeIcon: { marginTop: 2 },
  onFile: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10 },
  onFileRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  panReason: { marginTop: 8, padding: 10, borderWidth: 1 },
  drop: {
    borderWidth: 2,
    borderStyle: 'dashed',
    paddingHorizontal: 16,
    paddingVertical: 32,
    alignItems: 'center',
  },
  empty: { paddingHorizontal: 20, paddingVertical: 40, alignItems: 'center' },
  docRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 12 },
  sheetHint: { marginBottom: 8 },
  source: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, paddingVertical: 10 },
});
