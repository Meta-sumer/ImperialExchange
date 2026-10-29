/**
 * Render tests for the Profile screen: mounted in a real native stack with
 * the kit's overlay layer and confirm provider, the auth store and every
 * API module replaced by in-memory stand-ins, and the native pickers,
 * clipboard and file system mocked. Covers what a logic test cannot: which
 * tab is on screen, which call went out with what, and what the user is
 * told — EquityHub's Profile: the PAN card step, the Step 2 lock, the
 * password-only Security tab, "This device" in Active Sessions.
 *
 * No network, no device.
 */
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React, { act } from 'react';
import { Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));

jest.mock('@/store/auth', () => {
  const { create } = jest.requireActual('zustand');
  const useAuthStore = create((set: (p: Record<string, unknown>) => void) => ({
    user: null,
    status: 'authenticated',
    error: null,
    // A re-read that brings nothing back: what the page shows after a
    // change is what it did itself, not what /auth/me would have said.
    refreshUser: jest.fn(async () => {}),
    setUser: jest.fn((u: unknown) => set({ user: u })),
  }));
  return { useAuthStore };
});

jest.mock('@/api/auth.api', () => ({
  authApi: {
    resendVerification: jest.fn(),
    changePassword: jest.fn(),
    listDevices: jest.fn(),
    revokeDevice: jest.fn(),
  },
}));

jest.mock('@/api/user.api', () => ({ userApi: { updateProfile: jest.fn(), kycStatus: jest.fn() } }));

jest.mock('@/api/compliance.api', () => {
  const actual = jest.requireActual('@/api/compliance.api');
  return {
    ...actual,
    complianceApi: { kycDocuments: jest.fn(), uploadKycDocumentTimed: jest.fn() },
  };
});

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

jest.mock('expo-image-picker', () => ({
  getCameraPermissionsAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  UIImagePickerPreferredAssetRepresentationMode: { Automatic: 'automatic', Compatible: 'compatible', Current: 'current' },
}));

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

jest.mock('expo-file-system', () => {
  const contents: Record<string, string> = {};
  return {
    __contents: contents,
    File: jest.fn().mockImplementation((uri: string) => ({ uri, base64: async () => contents[uri] ?? '' })),
  };
});

/* eslint-disable import/first */
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

import { authApi } from '@/api/auth.api';
import { complianceApi } from '@/api/compliance.api';
import { userApi } from '@/api/user.api';
import { ConfirmProvider, PortalHost, toast } from '@/components/ui';
import { toastStore } from '@/components/ui/toast';
import type { ProfileTab, RootStackParamList } from '@/navigation/types';
import { ProfileScreen } from '@/screens/profile/ProfileScreen';
import { useAuthStore } from '@/store/auth';
import { ThemeProvider } from '@/theme';
import { toAuthUser } from '@/types/user';
/* eslint-enable import/first */

// react-test-renderer ships without types here; this is the slice used.
interface TestNode {
  type: unknown;
  props: Record<string, unknown>;
  parent: TestNode | null;
  findAll(pred: (n: TestNode) => boolean): TestNode[];
}
interface Renderer { root: TestNode; toJSON(): unknown; unmount(): void }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { create } = require('react-test-renderer') as { create: (el: React.ReactElement) => Renderer };

const textOf = (node: unknown): string => {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  const n = node as { children?: unknown };
  return textOf(n.children ?? null);
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
};

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const Stack = createNativeStackNavigator<RootStackParamList>();
const navRef = createNavigationContainerRef<RootStackParamList>();

let renderer: Renderer | null = null;
/** How many times the screen re-read the user as it opened. */
let refreshesOnMount = 0;

const mount = async (tab?: ProfileTab, opts: { strict?: boolean } = {}): Promise<Renderer> => {
  const tree = (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>
        <NavigationContainer ref={navRef}>
          <PortalHost>
            <ConfirmProvider>
              <Stack.Navigator screenOptions={{ headerShown: false, animation: 'none' }}>
                <Stack.Screen name="Profile" component={ProfileScreen} initialParams={tab ? { tab } : undefined} />
              </Stack.Navigator>
            </ConfirmProvider>
          </PortalHost>
        </NavigationContainer>
      </ThemeProvider>
    </SafeAreaProvider>
  );
  await act(async () => {
    // StrictMode replays every effect's cleanup + setup once, as Fast
    // Refresh does on each save during development.
    renderer = create(opts.strict ? <React.StrictMode>{tree}</React.StrictMode> : tree);
  });
  await settle();
  // The mount-time /auth/me re-read is counted and cleared, so a test's
  // "then re-reads the user" means its own action did.
  refreshesOnMount = refreshUser().mock.calls.length;
  refreshUser().mockClear();
  return renderer as unknown as Renderer;
};

const screenText = (r: Renderer): string => textOf(r.toJSON());

/** The nearest pressable around the text node that reads exactly `text`. */
const byText = (r: Renderer, text: string, nth = 0): TestNode | undefined => {
  let n: TestNode | null | undefined = r.root.findAll((x) => x.props.children === text)[nth];
  while (n && typeof n.props.onPress !== 'function') n = n.parent;
  return n ?? undefined;
};

const byLabel = (r: Renderer, label: string): TestNode | undefined =>
  r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];

const byTestId = (r: Renderer, id: string): TestNode | undefined =>
  r.root.findAll((n) => n.props.testID === id && typeof n.props.onPress === 'function')[0];

const press = async (node: TestNode | undefined): Promise<void> => {
  if (!node) throw new Error('node not found');
  await act(async () => { (node.props.onPress as () => void)(); });
  await settle();
};

const isDisabled = (node: TestNode | undefined): boolean => {
  if (!node) throw new Error('node not found');
  return !!(node.props.disabled ?? (node.props.accessibilityState as { disabled?: boolean } | undefined)?.disabled);
};

const input = (r: Renderer, pred: (p: Record<string, unknown>) => boolean): TestNode => {
  const n = r.root.findAll((x) => x.type === 'TextInput' && pred(x.props))[0];
  if (!n) throw new Error('input not found');
  return n;
};

const type = async (node: TestNode, value: string): Promise<void> => {
  await act(async () => { (node.props.onChangeText as (s: string) => void)(value); });
  await settle();
};

const toasts = (): string[] => toastStore.getState().toasts.map((t) => `${t.type}:${t.message}`);

const api = authApi as unknown as Record<string, jest.Mock>;
const users = userApi as unknown as Record<string, jest.Mock>;
const compliance = complianceApi as unknown as Record<string, jest.Mock>;
const files = (FileSystem as unknown as { __contents: Record<string, string> }).__contents;
const refreshUser = (): jest.Mock => (useAuthStore.getState() as unknown as { refreshUser: jest.Mock }).refreshUser;

const signIn = (raw: Record<string, unknown> = {}): void => {
  const user = toAuthUser({
    _id: 'u1',
    email: 'ada@example.com',
    role: 'USER',
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: '+919876543210',
    country: 'IN',
    userUid: 'USR100245',
    referralCode: 'ADA123',
    isEmailVerified: false,
    kycStatus: 'NOT_SUBMITTED',
    createdAt: '2025-03-14T10:00:00.000Z',
    referredBy: { firstName: 'Grace', lastName: 'Hopper', email: 'g@x.io', referralCode: 'GRACE1' },
    ...raw,
  });
  useAuthStore.setState({ user } as never);
};

/** A document row as complianceApi.kycDocuments adapts it. */
const kdoc = (raw: Record<string, unknown>): Record<string, unknown> => ({
  id: 'd1', docType: 'ID_FRONT', originalFilename: 'f.jpg', mimeType: 'image/jpeg', sizeBytes: 1000,
  status: 'PENDING', rejectionReason: null, createdAt: '2026-01-02T00:00:00Z', ...raw,
});
const PENDING_PAN = kdoc({ id: 'pan1', docType: 'PAN_CARD', originalFilename: 'pan.jpg' });

beforeEach(() => {
  jest.clearAllMocks();
  // Clears the auto-dismiss timers too, so none outlives the suite.
  toast.dismiss();
  for (const k of Object.keys(files)) delete files[k];
  compliance.kycDocuments?.mockResolvedValue([]);
  users.kycStatus?.mockResolvedValue({ status: 'NOT_SUBMITTED', rejectionReason: null, uploadUnlocked: false, canUpload: true });
  api.listDevices?.mockResolvedValue([]);
  // Not asked yet: a request will show the system dialog.
  (ImagePicker.getCameraPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false, canAskAgain: true });
  signIn();
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = null;
  toast.dismiss();
});

const pickFile = (asset: Record<string, unknown>): void => {
  (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({ canceled: false, assets: [asset] });
};

/* ══ Hero + Profile tab ════════════════════════════════════════════════ */

describe('Profile tab', () => {
  it('draws the hero, the chips, the referral card and the form from the user', async () => {
    const r = await mount();
    const text = screenText(r);
    for (const s of [
      'Ada Lovelace', 'ada@example.com', 'USR100245', 'Email unverified', 'KYC not started',
      'ADA123', 'Member since', 'Email address', 'Resend verification', 'Referral', 'Grace Hopper', 'GRACE1',
      'Personal information', 'All changes saved', 'Chosen at registration',
    ]) expect({ s, shown: text.includes(s) }).toEqual({ s, shown: true });
    // EquityHub's hero carries no 2FA chip.
    expect(text).not.toContain('2FA');
    for (const s of ['Profile', 'KYC Verification', 'Security', 'Active Sessions']) expect(text).toContain(s);
    expect(input(r, (p) => p.placeholder === 'First name').props.value).toBe('Ada');
    expect(input(r, (p) => p.placeholder === '+91 98xxxxxxxx').props.value).toBe('+919876543210');
    expect(r.root.findAll((n) => n.type === 'TextInput' && n.props.value === 'India')).toHaveLength(1);
  });

  it('copies the User ID and the referral code', async () => {
    const r = await mount();
    await press(byLabel(r, 'Copy your User ID'));
    expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith('USR100245');
    await press(byLabel(r, 'Copy referral code'));
    expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith('ADA123');
    expect(toasts()).toEqual(expect.arrayContaining(['success:User ID copied', 'success:Code copied']));
  });

  it('saves only when something changed, sends the web form, then re-reads the user', async () => {
    (userApi.updateProfile as jest.Mock).mockResolvedValue({});
    const r = await mount();
    expect(isDisabled(byText(r, 'Save changes'))).toBe(true);
    await type(input(r, (p) => p.placeholder === 'First name'), 'Augusta');
    expect(screenText(r)).toContain('Unsaved changes');
    expect(isDisabled(byText(r, 'Save changes'))).toBe(false);
    await press(byText(r, 'Save changes'));
    expect(userApi.updateProfile).toHaveBeenCalledWith({ firstName: 'Augusta', lastName: 'Lovelace', phone: '+919876543210' });
    expect(toasts()).toContain('success:Profile updated');
    expect(refreshUser()).toHaveBeenCalled();
  });

  it('shows the server refusal when a save fails', async () => {
    (userApi.updateProfile as jest.Mock).mockRejectedValue({ response: { data: { error: { message: 'Phone already in use' } } } });
    const r = await mount();
    await type(input(r, (p) => p.placeholder === '+91 98xxxxxxxx'), '+911111111111');
    await press(byText(r, 'Save changes'));
    expect(toasts()).toContain('error:Phone already in use');
  });

  it('resends the verification email and counts down 30 s', async () => {
    api.resendVerification?.mockResolvedValue({ alreadyVerified: false });
    const r = await mount();
    await press(byText(r, 'Resend verification'));
    expect(api.resendVerification).toHaveBeenCalledTimes(1);
    expect(toasts()).toContain('success:Verification email sent');
    expect(screenText(r)).toContain('Resend in 30s');
    expect(isDisabled(byText(r, 'Resend in 30s'))).toBe(true);
  });

  it('an address verified elsewhere refreshes the card instead of claiming an email went out', async () => {
    api.resendVerification?.mockResolvedValue({ alreadyVerified: true });
    const r = await mount();
    await press(byText(r, 'Resend verification'));
    expect(toasts()).toContain('success:Your email is already verified');
    expect(toasts()).not.toContain('success:Verification email sent');
    expect(refreshUser()).toHaveBeenCalled();
  });

  it('a verified email shows Verified, and a user nobody referred says so', async () => {
    signIn({ isEmailVerified: true, referredBy: null, referralCode: null, kycStatus: 'APPROVED' });
    const r = await mount();
    const text = screenText(r);
    for (const s of ['Verified', 'Email verified', 'KYC verified', 'Signed up directly']) expect(text).toContain(s);
    expect(text).not.toContain('Resend verification');
  });
});

/* ══ KYC ═══════════════════════════════════════════════════════════════ */

describe('KYC tab — the PAN card first', () => {
  it('opens from ?tab=kyc on Step 1 (Required) with Step 2 locked behind it', async () => {
    const r = await mount('kyc');
    const text = screenText(r);
    for (const s of [
      'NOT SUBMITTED', 'Verify your identity to unlock Live trading and withdrawals.',
      'PAN Card', 'Step 1 · Required. Upload a clear photo or scan of your PAN card.', 'Required',
      'Upload document', 'Step 2 · JPG, PNG, or PDF — max 10MB per file.',
      'Add your PAN card above first — it is required before other documents can be submitted.',
      'Upload your PAN card first', '0 documents on file', 'No documents uploaded yet',
    ]) expect({ s, shown: text.includes(s) }).toEqual({ s, shown: true });
    expect(isDisabled(byTestId(r, 'kyc-dropzone'))).toBe(true);
    expect(isDisabled(byLabel(r, 'Document type'))).toBe(true);
    expect(isDisabled(byTestId(r, 'kyc-pan-dropzone'))).toBe(false);
    expect(complianceApi.kycDocuments).toHaveBeenCalledTimes(1);
    expect(userApi.kycStatus).toHaveBeenCalledTimes(1);
    // Upload only — no field to type a PAN number into.
    expect(r.root.findAll((n) => n.type === 'TextInput')).toHaveLength(0);
  });

  it('uploads the PAN card as PAN_CARD, then re-reads the list and the user', async () => {
    compliance.uploadKycDocumentTimed?.mockResolvedValue({ id: 'pan1', status: 'PENDING' });
    pickFile({ uri: 'file:///cache/pan.pdf', name: 'pan.pdf', mimeType: 'application/pdf', size: 3000 });
    files['file:///cache/pan.pdf'] = 'JVBERi0xLjQK'.repeat(40);
    const r = await mount('kyc');
    await press(byTestId(r, 'kyc-pan-dropzone'));
    expect(screenText(r)).toContain('Upload a clear photo or scan of your PAN card.');
    await press(byText(r, 'Browse files'));
    expect(DocumentPicker.getDocumentAsync).toHaveBeenCalledWith(expect.objectContaining({
      type: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
      multiple: false,
    }));
    expect(complianceApi.uploadKycDocumentTimed).toHaveBeenCalledWith(
      { docType: 'PAN_CARD', filename: 'pan.pdf', mimeType: 'application/pdf', dataBase64: 'JVBERi0xLjQK'.repeat(40) },
      21_000,
    );
    expect(toasts()).toContain('success:PAN card uploaded');
    expect(complianceApi.kycDocuments).toHaveBeenCalledTimes(2);
    expect(refreshUser()).toHaveBeenCalled();
  });

  it('a pending PAN card on file unlocks Step 2, and can be replaced', async () => {
    compliance.kycDocuments?.mockResolvedValue([PENDING_PAN]);
    const r = await mount('kyc');
    let text = screenText(r);
    for (const s of ['PAN card on file', 'pan.jpg', 'We are reviewing your PAN card.', 'PENDING', 'Upload a different one']) {
      expect({ s, shown: text.includes(s) }).toEqual({ s, shown: true });
    }
    expect(text).not.toContain('Add your PAN card above first');
    expect(isDisabled(byTestId(r, 'kyc-dropzone'))).toBe(false);
    // No form over a card already on file…
    expect(byTestId(r, 'kyc-pan-dropzone')).toBeUndefined();
    // …until the user asks to replace it.
    await press(byText(r, 'Upload a different one'));
    expect(byTestId(r, 'kyc-pan-dropzone')).toBeDefined();
    text = screenText(r);
    expect(text).not.toContain('Upload a different one');
    await press(byText(r, 'Cancel'));
    expect(byTestId(r, 'kyc-pan-dropzone')).toBeUndefined();
  });

  it('a rejected PAN card shows the reason, asks for it again and keeps Step 2 locked', async () => {
    compliance.kycDocuments?.mockResolvedValue([kdoc({ id: 'pan1', docType: 'PAN_CARD', status: 'REJECTED', rejectionReason: 'Name not readable' })]);
    const r = await mount('kyc');
    const text = screenText(r);
    for (const s of ['Your PAN card was rejected. Please upload it again below.', 'Rejection reason: ', 'Name not readable', 'REJECTED']) {
      expect({ s, shown: text.includes(s) }).toEqual({ s, shown: true });
    }
    expect(byTestId(r, 'kyc-pan-dropzone')).toBeDefined();
    expect(isDisabled(byTestId(r, 'kyc-dropzone'))).toBe(true);
    expect(text).toContain('Add your PAN card above first');
  });

  it('an approved PAN card reads verified, with no upload form over it', async () => {
    compliance.kycDocuments?.mockResolvedValue([kdoc({ id: 'pan1', docType: 'PAN_CARD', status: 'APPROVED' })]);
    const r = await mount('kyc');
    expect(screenText(r)).toContain('Your PAN card is verified.');
    expect(byTestId(r, 'kyc-pan-dropzone')).toBeUndefined();
    expect(byText(r, 'Upload a different one')).toBeUndefined();
  });

  it('a list that did not load never locks Step 2', async () => {
    compliance.kycDocuments?.mockRejectedValue(new Error('offline'));
    const r = await mount('kyc');
    expect(screenText(r)).not.toContain('Add your PAN card above first');
    expect(isDisabled(byTestId(r, 'kyc-dropzone'))).toBe(false);
  });
});

describe('KYC tab — documents', () => {
  it('lists documents by their web labels, each with its own verdict and a rejected one its reason', async () => {
    compliance.kycDocuments?.mockResolvedValue([
      kdoc({ id: 'd1', docType: 'ADDRESS_PROOF', originalFilename: 'bill.pdf', status: 'PENDING' }),
      kdoc({ id: 'd2', docType: 'ID_FRONT', originalFilename: 'pass.jpg', status: 'REJECTED', rejectionReason: 'Blurry photo' }),
      PENDING_PAN,
    ]);
    signIn({ kycRejectionReason: 'Blurry photo' });
    const r = await mount('kyc');
    const text = screenText(r);
    expect(text).toContain('We are reviewing your documents. This usually takes 1-2 business days.');
    expect(text).toContain('3 documents on file');
    for (const s of ['Address proof', 'ID — Front', 'PAN Card', 'REJECTED', 'Reason: Blurry photo']) {
      expect({ s, shown: text.includes(s) }).toEqual({ s, shown: true });
    }
    expect(text).not.toContain('ADDRESS PROOF');
    expect(r.root.findAll((n) => n.props.testID === 'kyc-doc-row' && typeof n.type !== 'string')).toHaveLength(3);
  });

  it('an account that may not upload gets "Verification complete" and no upload form', async () => {
    signIn({ kycStatus: 'APPROVED' });
    users.kycStatus?.mockResolvedValue({ status: 'APPROVED', rejectionReason: null, uploadUnlocked: false, canUpload: false });
    const r = await mount('kyc');
    const text = screenText(r);
    expect(text).toContain('Verification complete');
    expect(text).toContain('No further documents are needed.');
    expect(text).toContain('Your identity is verified. You have full trading access.');
    expect(byTestId(r, 'kyc-dropzone')).toBeUndefined();
    expect(byTestId(r, 'kyc-pan-dropzone')).toBeUndefined();
  });

  it('an approved account an admin re-opened keeps the form (canUpload)', async () => {
    signIn({ kycStatus: 'APPROVED' });
    users.kycStatus?.mockResolvedValue({ status: 'APPROVED', rejectionReason: null, uploadUnlocked: true, canUpload: true });
    compliance.kycDocuments?.mockResolvedValue([kdoc({ id: 'pan1', docType: 'PAN_CARD', status: 'APPROVED' })]);
    const r = await mount('kyc');
    expect(screenText(r)).not.toContain('Verification complete');
    expect(byTestId(r, 'kyc-dropzone')).toBeDefined();
  });

  it('a failed status read leaves the form up rather than lock someone out', async () => {
    users.kycStatus?.mockRejectedValue(new Error('offline'));
    const r = await mount('kyc');
    expect(screenText(r)).not.toContain('Verification complete');
    expect(byTestId(r, 'kyc-pan-dropzone')).toBeDefined();
  });

  it('with the PAN card on file, uploads a Step 2 document as the chosen type', async () => {
    compliance.kycDocuments?.mockResolvedValue([PENDING_PAN]);
    compliance.uploadKycDocumentTimed?.mockResolvedValue({ id: 'd9', status: 'PENDING' });
    pickFile({ uri: 'file:///cache/bill.pdf', name: 'bill.pdf', mimeType: 'application/pdf', size: 3000 });
    files['file:///cache/bill.pdf'] = 'JVBERi0xLjQK'.repeat(40);
    const r = await mount('kyc');

    await press(byLabel(r, 'Document type'));
    await press(byText(r, 'Address proof (utility bill, bank statement)'));
    await press(byTestId(r, 'kyc-dropzone'));
    await press(byText(r, 'Browse files'));

    expect(complianceApi.uploadKycDocumentTimed).toHaveBeenCalledWith(
      { docType: 'ADDRESS_PROOF', filename: 'bill.pdf', mimeType: 'application/pdf', dataBase64: 'JVBERi0xLjQK'.repeat(40) },
      21_000,
    );
    expect(toasts()).toContain('success:Document uploaded');
  });

  it('refuses an oversized or wrong-type file before reading it', async () => {
    const r = await mount('kyc');
    pickFile({ uri: 'file:///cache/big.pdf', name: 'big.pdf', mimeType: 'application/pdf', size: 10 * 1024 * 1024 + 1 });
    await press(byTestId(r, 'kyc-pan-dropzone'));
    await press(byText(r, 'Browse files'));
    expect(toasts()).toContain('error:File too large (max 10MB)');

    pickFile({ uri: 'file:///cache/IMG_1.HEIC', name: 'IMG_1.HEIC', mimeType: 'image/heic', size: 2000 });
    await press(byTestId(r, 'kyc-pan-dropzone'));
    await press(byText(r, 'Browse files'));
    expect(toasts()).toContain('error:Upload a JPG, PNG, WEBP or PDF');

    expect(FileSystem.File).not.toHaveBeenCalled();
    expect(complianceApi.uploadKycDocumentTimed).not.toHaveBeenCalled();
  });

  it('photographs the PAN card: asks for the camera, and names the shot', async () => {
    compliance.uploadKycDocumentTimed?.mockResolvedValue({ id: 'd9', status: 'PENDING' });
    (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///cache/ImagePicker/SHOT.jpg', fileName: null, mimeType: 'image/jpeg', fileSize: 5000, width: 10, height: 10 }],
    });
    files['file:///cache/ImagePicker/SHOT.jpg'] = '/9j/4AAQ'.repeat(40);
    const r = await mount('kyc');
    await press(byTestId(r, 'kyc-pan-dropzone'));
    await press(byText(r, 'Take photo'));
    expect(ImagePicker.launchCameraAsync).toHaveBeenCalledWith(expect.objectContaining({ mediaTypes: ['images'] }));
    expect(complianceApi.uploadKycDocumentTimed).toHaveBeenCalledWith(
      expect.objectContaining({ docType: 'PAN_CARD', filename: 'SHOT.jpg', mimeType: 'image/jpeg' }),
      expect.any(Number),
    );
  });

  it('a refused camera permission says so and uploads nothing', async () => {
    (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
    const r = await mount('kyc');
    await press(byTestId(r, 'kyc-pan-dropzone'));
    await press(byText(r, 'Take photo'));
    expect(ImagePicker.launchCameraAsync).not.toHaveBeenCalled();
    expect(toasts()).toContain('error:Allow camera access to photograph your document.');
  });

  it("shows the server's refusal for bytes that are no accepted format", async () => {
    const message = 'That file is not a readable JPEG, PNG, WEBP, PDF — it may be corrupt or renamed from another format. Please upload the original image or PDF.';
    compliance.uploadKycDocumentTimed?.mockRejectedValue({ response: { data: { error: { code: 'KYC_UNRECOGNISED_FORMAT', message } } } });
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///x/pic.png', fileName: 'pic.png', mimeType: 'image/png', fileSize: 900 }],
    });
    files['file:///x/pic.png'] = 'AAAA'.repeat(50);
    const r = await mount('kyc');
    await press(byTestId(r, 'kyc-pan-dropzone'));
    await press(byText(r, 'Photo library'));
    expect(toasts()).toContain(`error:${message}`);
    // A failed PAN upload keeps the form.
    expect(byTestId(r, 'kyc-pan-dropzone')).toBeDefined();
  });

  it('an Android gallery HEIC comes back as JPEG bytes and is sent as the JPEG it is', async () => {
    const jpegB64 = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(300, 1)]).toString('base64');
    compliance.uploadKycDocumentTimed?.mockResolvedValue({ id: 'd9', status: 'PENDING' });
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///data/cache/ImagePicker/0d9e.jpeg', fileName: 'IMG_2041.heic', mimeType: 'image/heic', fileSize: 2_000_000 }],
    });
    files['file:///data/cache/ImagePicker/0d9e.jpeg'] = jpegB64;
    const r = await mount('kyc');
    await press(byTestId(r, 'kyc-pan-dropzone'));
    await press(byText(r, 'Photo library'));
    expect(toasts()).not.toContain('error:Upload a JPG, PNG, WEBP or PDF');
    expect(complianceApi.uploadKycDocumentTimed).toHaveBeenCalledWith(
      { docType: 'PAN_CARD', filename: 'IMG_2041.jpg', mimeType: 'image/jpeg', dataBase64: jpegB64 },
      expect.any(Number),
    );
  });

  it('a second tap on a source while the first pick is open does not open another picker', async () => {
    let finish: (v: unknown) => void = () => {};
    (DocumentPicker.getDocumentAsync as jest.Mock).mockReturnValue(new Promise((res) => { finish = res; }));
    const r = await mount('kyc');
    await press(byTestId(r, 'kyc-pan-dropzone'));
    const browse = byText(r, 'Browse files');
    if (!browse) throw new Error('Browse files not found');
    await act(async () => {
      (browse.props.onPress as () => void)();
      (browse.props.onPress as () => void)();
    });
    expect(DocumentPicker.getDocumentAsync).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ canceled: true, assets: null }); });
    await settle();
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({ canceled: true, assets: null });
    await press(byTestId(r, 'kyc-pan-dropzone'));
    await press(byText(r, 'Browse files'));
    expect(DocumentPicker.getDocumentAsync).toHaveBeenCalledTimes(2);
  });

  it('a camera refused for good points to Settings', async () => {
    (ImagePicker.getCameraPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false, canAskAgain: false });
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    const r = await mount('kyc');
    await press(byTestId(r, 'kyc-pan-dropzone'));
    await press(byText(r, 'Take photo'));
    expect(ImagePicker.requestCameraPermissionsAsync).not.toHaveBeenCalled();
    expect(screenText(r)).toContain('Camera access is turned off for this app.');
    await press(byText(r, 'Open Settings'));
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(complianceApi.uploadKycDocumentTimed).not.toHaveBeenCalled();
    openSettings.mockRestore();
  });
});

/* ══ Security ══════════════════════════════════════════════════════════ */

describe('Security tab', () => {
  it('is the password change alone — no two-factor card', async () => {
    const r = await mount('security');
    const text = screenText(r);
    expect(text).toContain('Change your account password.');
    expect(text).not.toMatch(/2FA|Two-Factor|authenticator/i);
  });

  it('changes the password only once every rule passes and the two match', async () => {
    (authApi.changePassword as jest.Mock).mockResolvedValue('Password changed successfully.');
    const r = await mount('security');
    const submit = (): TestNode | undefined => byText(r, 'Update password');
    expect(isDisabled(submit())).toBe(true);

    await type(input(r, (p) => p.placeholder === 'Current password'), 'Old#Pass1');
    await type(input(r, (p) => p.placeholder === 'New password'), 'New#Pass2');
    await type(input(r, (p) => p.placeholder === 'Re-enter new password'), 'New#Pass');
    expect(screenText(r)).toContain('Passwords do not match');
    expect(isDisabled(submit())).toBe(true);

    await type(input(r, (p) => p.placeholder === 'Re-enter new password'), 'New#Pass2');
    expect(screenText(r)).not.toContain('Passwords do not match');
    expect(isDisabled(submit())).toBe(false);
    await press(submit());
    expect(authApi.changePassword).toHaveBeenCalledWith('Old#Pass1', 'New#Pass2');
    expect(toasts()).toContain('success:Password changed. Other devices have been signed out.');
    expect(input(r, (p) => p.placeholder === 'Current password').props.value).toBe('');
  });

  it('the keyboard submit runs the web checks and their toasts', async () => {
    const r = await mount('security');
    const confirm = input(r, (p) => p.placeholder === 'Re-enter new password');
    await act(async () => { (confirm.props.onSubmitEditing as () => void)(); });
    expect(toasts()).toContain('error:Enter your current password');
    await type(input(r, (p) => p.placeholder === 'Current password'), 'x');
    await type(input(r, (p) => p.placeholder === 'New password'), 'weak');
    await act(async () => { (input(r, (p) => p.placeholder === 'Re-enter new password').props.onSubmitEditing as () => void)(); });
    expect(toasts()).toContain('error:New password does not meet all requirements');
    expect(authApi.changePassword).not.toHaveBeenCalled();
  });
});

/* ══ Sessions ══════════════════════════════════════════════════════════ */

describe('Active Sessions tab', () => {
  const THIS = { id: 'sid-this', deviceInfo: 'okhttp/4.12', createdAt: '2026-01-01T10:00:00Z', lastSeenAt: '2026-02-01T10:00:00Z', current: true };
  const OTHER = { id: 'sid-other', deviceInfo: 'iPhone 15 · Safari', createdAt: '2026-01-05T10:00:00Z', lastSeenAt: null, current: false };

  it('marks this device, offers Revoke only on the others, and revokes after the confirm', async () => {
    api.listDevices?.mockResolvedValue([THIS, OTHER]);
    api.revokeDevice?.mockResolvedValue(undefined);
    const r = await mount('devices');
    const text = screenText(r);
    expect(text).toContain('2 active sessions');
    expect(text).toContain('This device');
    expect(text).toContain('Current');
    expect(text).toContain(`Last active ${new Date(THIS.lastSeenAt).toLocaleString()} · Signed in ${new Date(THIS.createdAt).toLocaleDateString()}`);
    // The other's last activity falls back to its start.
    expect(text).toContain(`Last active ${new Date(OTHER.createdAt).toLocaleString()}`);
    expect(byLabel(r, 'Revoke okhttp/4.12')).toBeUndefined();

    await press(byLabel(r, 'Revoke iPhone 15 · Safari'));
    expect(screenText(r)).toContain('Revoke this session? You will be logged out from that device.');
    await press(byText(r, 'Cancel'));
    expect(api.revokeDevice).not.toHaveBeenCalled();

    await press(byLabel(r, 'Revoke iPhone 15 · Safari'));
    await press(byText(r, 'Confirm'));
    expect(api.revokeDevice).toHaveBeenCalledWith('sid-other');
    expect(toasts()).toContain('success:Session revoked');
    expect(api.listDevices).toHaveBeenCalledTimes(2);
  });

  it('a row without an id is not sent as "undefined"', async () => {
    api.listDevices?.mockResolvedValue([{ ...OTHER, id: null }]);
    const r = await mount('devices');
    await press(byLabel(r, 'Revoke iPhone 15 · Safari'));
    await press(byText(r, 'Confirm'));
    expect(api.revokeDevice).not.toHaveBeenCalled();
    expect(toasts()).toContain('error:Session not found');
  });

  it('says so when there are none', async () => {
    const r = await mount('devices');
    expect(screenText(r)).toContain('No active sessions');
    expect(screenText(r)).toContain('0 active sessions');
  });

  it('shows "Loading sessions…" until the list arrives', async () => {
    let resolve: (v: unknown) => void = () => {};
    api.listDevices?.mockReturnValue(new Promise((res) => { resolve = res; }));
    const r = await mount('devices');
    expect(screenText(r)).toContain('Loading sessions…');
    expect(screenText(r)).toContain('Loading…');
    await act(async () => { resolve([{ ...OTHER, deviceInfo: 'Pixel' }]); });
    await settle();
    expect(screenText(r)).toContain('1 active session');
  });

  it('a pull-to-refresh answer landing after the post-revoke reload does not bring the session back', async () => {
    const a = { ...OTHER, id: 'devA', deviceInfo: 'iPhone' };
    const b = { ...OTHER, id: 'devB', deviceInfo: 'Pixel' };
    api.listDevices?.mockResolvedValueOnce([a, b]);
    const r = await mount('devices');
    expect(screenText(r)).toContain('2 active sessions');

    let lateRefresh: (v: unknown) => void = () => {};
    api.listDevices?.mockReturnValueOnce(new Promise((res) => { lateRefresh = res; }));
    const pull = r.root.findAll((n) => typeof n.props.onRefresh === 'function' && 'refreshing' in n.props)[0];
    if (!pull) throw new Error('no RefreshControl');
    await act(async () => { (pull.props.onRefresh as () => void)(); });

    api.listDevices?.mockResolvedValue([b]);
    api.revokeDevice?.mockResolvedValue(undefined);
    await press(byLabel(r, 'Revoke iPhone'));
    await press(byText(r, 'Confirm'));
    expect(api.revokeDevice).toHaveBeenCalledWith('devA');
    expect(screenText(r)).toContain('1 active session');

    await act(async () => { lateRefresh([a, b]); });
    await settle();
    expect(screenText(r)).toContain('1 active session');
    expect(byLabel(r, 'Revoke iPhone')).toBeUndefined();
  });
});

/* ══ Tabs ══════════════════════════════════════════════════════════════ */

describe('tab rail', () => {
  const selectedTabs = (r: Renderer): TestNode[] => r.root.findAll((n) => n.props.accessibilityRole === 'tab'
    && typeof n.props.onPress === 'function'
    && !!(n.props.accessibilityState as { selected?: boolean } | undefined)?.selected);

  it('switches tab, writes ?tab= (dropped for Profile), and follows a link to another tab', async () => {
    const r = await mount();
    await press(byText(r, 'Security'));
    expect(screenText(r)).toContain('Change your account password.');
    expect(navRef.getCurrentRoute()?.params).toEqual({ tab: 'security' });

    await press(byText(r, 'Profile'));
    expect(screenText(r)).toContain('Personal information');
    expect((navRef.getCurrentRoute()?.params as { tab?: string } | undefined)?.tab).toBeUndefined();

    await act(async () => { navRef.navigate('Profile', { tab: 'devices' }); });
    await settle();
    expect(screenText(r)).toContain('Active sessions');
  });

  it('the rail is the web page rail: four tabs, exactly the open one selected', async () => {
    const r = await mount('kyc');
    const tabs = r.root.findAll((n) => n.props.accessibilityRole === 'tab' && typeof n.props.onPress === 'function');
    expect(tabs).toHaveLength(4);
    expect(selectedTabs(r)).toHaveLength(1);
    await press(byText(r, 'Active Sessions'));
    expect(selectedTabs(r)).toHaveLength(1);
    expect(navRef.getCurrentRoute()?.params).toEqual({ tab: 'devices' });
  });
});

/* ══ Review fixes ══════════════════════════════════════════════════════ */

describe('review fixes', () => {
  const valueOf = (r: Renderer, placeholder: string): unknown => input(r, (p) => p.placeholder === placeholder).props.value;

  it('re-reads the user as the screen opens', async () => {
    await mount();
    expect(refreshesOnMount).toBe(1);
  });

  it('a refreshed profile reaches the untouched fields; a field being edited keeps the edit', async () => {
    const r = await mount();
    await act(async () => { signIn({ phone: '+910000000001' }); });
    await settle();
    expect(valueOf(r, '+91 98xxxxxxxx')).toBe('+910000000001');
    expect(screenText(r)).toContain('All changes saved');

    await type(input(r, (p) => p.placeholder === 'First name'), 'Augusta');
    await act(async () => { signIn({ firstName: 'Ada', phone: '+910000000002' }); });
    await settle();
    expect(valueOf(r, 'First name')).toBe('Augusta');
    expect(valueOf(r, '+91 98xxxxxxxx')).toBe('+910000000002');

    (userApi.updateProfile as jest.Mock).mockResolvedValue({});
    await press(byText(r, 'Save changes'));
    expect(userApi.updateProfile).toHaveBeenCalledWith({ firstName: 'Augusta', lastName: 'Lovelace', phone: '+910000000002' });
  });

  it('a referrer the store holds only as an id reads "Anonymous referrer", as on the web', async () => {
    signIn({ referredBy: '65f0c0ffee0000000000abcd' });
    const r = await mount();
    const text = screenText(r);
    expect(text).toContain('Anonymous referrer');
    expect(text).not.toContain('Signed up directly');
  });

  it('the KYC list read before an upload, landing late, does not hide the uploaded document', async () => {
    let lateFirst: (v: unknown) => void = () => {};
    compliance.kycDocuments
      ?.mockReturnValueOnce(new Promise((res) => { lateFirst = res; }))
      .mockResolvedValue([PENDING_PAN]);
    compliance.uploadKycDocumentTimed?.mockResolvedValue({ id: 'pan1', status: 'PENDING' });
    pickFile({ uri: 'file:///cache/pan.pdf', name: 'pan.pdf', mimeType: 'application/pdf', size: 3000 });
    files['file:///cache/pan.pdf'] = 'JVBERi0xLjQK'.repeat(40);
    const r = await mount('kyc');
    await press(byTestId(r, 'kyc-pan-dropzone'));
    await press(byText(r, 'Browse files'));
    expect(screenText(r)).toContain('1 document on file');

    await act(async () => { lateFirst([]); });
    await settle();
    expect(screenText(r)).toContain('1 document on file');
    expect(screenText(r)).toContain('pan.jpg');
  });

  it('a saved profile reads "All changes saved", from the saved document, keeping the populated referrer', async () => {
    (userApi.updateProfile as jest.Mock).mockImplementation(async (f: Record<string, string>) => toAuthUser({
      _id: 'u1', email: 'ada@example.com', role: 'USER', ...f, referredBy: '65f0c0ffee0000000000abcd',
    }));
    const r = await mount();
    await type(input(r, (p) => p.placeholder === 'First name'), 'Augusta');
    await press(byText(r, 'Save changes'));

    expect(toasts()).toContain('success:Profile updated');
    const text = screenText(r);
    expect(text).toContain('All changes saved');
    expect(text).not.toContain('Unsaved changes');
    expect(isDisabled(byText(r, 'Save changes'))).toBe(true);
    expect(text).toContain('Augusta Lovelace');
    expect(text).toContain('Grace Hopper');
    expect(text).not.toContain('Anonymous referrer');
  });

  it('a save the server refuses changes nothing held', async () => {
    const held = (): Record<string, unknown> =>
      ((useAuthStore.getState() as unknown as { user: { raw: Record<string, unknown> } }).user).raw;
    (userApi.updateProfile as jest.Mock).mockRejectedValue({ response: { data: { error: { message: 'Duplicate value for phone' } } } });
    const r = await mount();
    await type(input(r, (p) => p.placeholder === 'First name'), 'Augusta');
    await press(byText(r, 'Save changes'));
    expect(toasts()).toContain('error:Duplicate value for phone');
    expect(held().firstName).toBe('Ada');
    expect(screenText(r)).toContain('Unsaved changes');
  });

  it('an address the server says is already verified reads Verified', async () => {
    api.resendVerification?.mockResolvedValue({ alreadyVerified: true });
    const r = await mount();
    await press(byText(r, 'Resend verification'));
    const text = screenText(r);
    expect(text).toContain('Email verified');
    expect(text).not.toContain('Resend verification');
  });
});

describe('survives an effect replay (StrictMode / Fast Refresh)', () => {
  it('KYC still lands its documents', async () => {
    compliance.kycDocuments?.mockResolvedValue([kdoc({ id: 'd1', docType: 'SELFIE', originalFilename: 'me.jpg' })]);
    const r = await mount('kyc', { strict: true });
    expect(screenText(r)).toContain('1 document on file');
    expect(screenText(r)).toContain('me.jpg');
  });

  it('Active Sessions still lands its list', async () => {
    api.listDevices?.mockResolvedValue([{ id: 'dev1', deviceInfo: 'Pixel 8', createdAt: null, lastSeenAt: null, current: false }]);
    const r = await mount('devices', { strict: true });
    expect(screenText(r)).not.toContain('Loading sessions…');
    expect(screenText(r)).toContain('Pixel 8');
    expect(screenText(r)).toContain('1 active session');
  });

  it('an upload still clears its "Uploading…" state', async () => {
    compliance.uploadKycDocumentTimed?.mockResolvedValue({ id: 'd9', status: 'PENDING' });
    pickFile({ uri: 'file:///cache/pan.pdf', name: 'pan.pdf', mimeType: 'application/pdf', size: 3000 });
    files['file:///cache/pan.pdf'] = 'JVBERi0xLjQK'.repeat(40);
    const r = await mount('kyc', { strict: true });
    await press(byTestId(r, 'kyc-pan-dropzone'));
    await press(byText(r, 'Browse files'));
    expect(toasts()).toContain('success:PAN card uploaded');
    expect(screenText(r)).not.toContain('Uploading…');
  });
});
