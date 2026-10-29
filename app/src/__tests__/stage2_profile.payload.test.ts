/**
 * What the Profile screen sends, and where — checked against the SERVER'S
 * source.
 *
 * Every body below goes out through the real API module over a recording
 * axios adapter (no request leaves the process), and is compared with the
 * names the backend handler actually reads. A near-miss key is not an error
 * on the wire; the server just never reads it. Only a test that reads both
 * sides catches that.
 */
import fs from 'fs';
import path from 'path';

import type { InternalAxiosRequestConfig } from 'axios';

import { authApi } from '@/api/auth.api';
import { api } from '@/api/client';
import { complianceApi } from '@/api/compliance.api';
import { userApi } from '@/api/user.api';
import { clearTokens, setTokens } from '@/services/tokenStore';
import { toAuthUser } from '@/types/user';
import { kycUploadTimeoutMs, profileFormFrom } from '@/utils/profile';

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});

const ROOT = path.join(__dirname, '../../..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const backend = (p: string): string => read(path.join('backend/src', p));

const AUTH = backend('controllers/authController.js');
const USER = backend('controllers/userController.js');
const COMPLIANCE = backend('controllers/complianceController.js');

/** The keys a controller destructures from `req.body`, in the handler named. */
const bodyKeys = (src: string, handler: string): string[] => {
  const at = src.indexOf(`const ${handler} = asyncHandler`);
  if (at < 0) throw new Error(`handler moved: ${handler}`);
  const m = /const \{([^}]+)\} = req\.body/.exec(src.slice(at, at + 4000));
  if (!m?.[1]) throw new Error(`no body destructure in ${handler}`);
  return m[1]
    .split(',')
    .map((k) => k.trim().split(/[\s=:]/)[0] ?? '')
    .filter(Boolean);
};

/** updateProfile reads an allow-list, not a destructure. */
const allowList = (src: string, handler: string): string[] => {
  const at = src.indexOf(`const ${handler} = asyncHandler`);
  if (at < 0) throw new Error(`handler moved: ${handler}`);
  const m = /const allowed = \[([^\]]+)\]/.exec(src.slice(at, at + 1500));
  if (!m?.[1]) throw new Error(`no allow-list in ${handler}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1] as string);
};

/** A route line exists: `router.<method>('<path>', …, c.<handler>)`. */
const expectRoute = (file: string, method: string, routePath: string, handler: string): void => {
  const src = backend(`routes/${file}`);
  const re = new RegExp(`router\\.${method}\\('${routePath.replace(/[/:]/g, (c) => `\\${c}`)}'[^\\n]*c\\.${handler}\\)`);
  expect({ route: `${method.toUpperCase()} ${routePath}`, found: re.test(src) }).toEqual({ route: `${method.toUpperCase()} ${routePath}`, found: true });
};

const expectReadBy = (body: Record<string, unknown>, keys: string[]): void => {
  for (const k of Object.keys(body)) {
    expect({ key: k, readByServer: keys.includes(k) }).toEqual({ key: k, readByServer: true });
  }
};

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown>;
  timeout: number | undefined;
}

const calls: Call[] = [];
let reply: (c: Call) => unknown = () => ({ success: true, data: {} });

const last = (): Call => {
  const c = calls[calls.length - 1];
  if (!c) throw new Error('no request was made');
  return c;
};

beforeAll(() => {
  api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const call: Call = {
      method: String(config.method ?? 'get').toUpperCase(),
      url: config.url ?? '',
      body: (typeof config.data === 'string' ? JSON.parse(config.data) : config.data ?? {}) as Record<string, unknown>,
      timeout: config.timeout,
    };
    calls.push(call);
    return { data: reply(call), status: 200, statusText: 'OK', headers: {}, config };
  };
});

beforeEach(async () => {
  calls.length = 0;
  reply = () => ({ success: true, data: {} });
  await setTokens('AT', 'RT-this-device');
});

afterAll(async () => {
  await clearTokens();
});

describe('Profile → personal information', () => {
  it('PUTs /user/profile with exactly the web form — keys the server allow-lists', async () => {
    const user = toAuthUser({ _id: 'u1', email: 'a@b.c', role: 'USER', firstName: 'Ada', lastName: 'L', phone: '+91 98', country: 'IN' });
    reply = () => ({ success: true, data: { _id: 'u1', email: 'a@b.c', role: 'USER', firstName: 'Ada' } });
    await userApi.updateProfile({ ...profileFormFrom(user), firstName: 'Augusta' });
    expect(last()).toMatchObject({ method: 'PUT', url: '/user/profile' });
    expect(Object.keys(last().body).sort()).toEqual(['firstName', 'lastName', 'phone']);
    expect(last().body).toEqual({ firstName: 'Augusta', lastName: 'L', phone: '+91 98' });
    expectReadBy(last().body, allowList(USER, 'updateProfile'));
    expect(backend('routes/user.js')).toContain("router.put('/profile', c.updateProfile)");
  });

  it('asks for a verification email with no body', async () => {
    reply = () => ({ success: true, data: { ok: true } });
    expect(await authApi.resendVerification()).toEqual({ alreadyVerified: false });
    expect(last()).toMatchObject({ method: 'POST', url: '/auth/resend-verification' });
    expect(Object.keys(last().body)).toEqual([]);
    expectRoute('auth.js', 'post', '/resend-verification', 'resendVerifyEmail');
    reply = () => ({ success: true, data: { ok: true, alreadyVerified: true } });
    expect(await authApi.resendVerification()).toEqual({ alreadyVerified: true });
    expect(AUTH).toContain('return sendSuccess(res, { ok: true, alreadyVerified: true })');
  });
});

describe('Profile → KYC', () => {
  it('posts the document with the four keys uploadKycDocument reads, and a timeout sized to it', async () => {
    reply = () => ({ success: true, data: { id: 'd1', docType: 'ID_FRONT', status: 'PENDING' } });
    const dataBase64 = 'A'.repeat(200_000);
    const res = await complianceApi.uploadKycDocumentTimed(
      { docType: 'ID_FRONT', filename: 'passport.jpg', mimeType: 'image/jpeg', dataBase64: `data:image/jpeg;base64,${dataBase64}` },
      kycUploadTimeoutMs(dataBase64.length),
    );
    expect(res).toEqual({ id: 'd1', status: 'PENDING' });
    expect(last()).toMatchObject({ method: 'POST', url: '/compliance/kyc/documents', timeout: 24_000 });
    expect(Object.keys(last().body).sort()).toEqual(['dataBase64', 'docType', 'filename', 'mimeType']);
    // Raw base64, never a data URL — the server Buffer.from()s it as is.
    expect(last().body.dataBase64).toBe(dataBase64);
    expectReadBy(last().body, bodyKeys(COMPLIANCE, 'uploadKycDocument'));
    expect(backend('routes/compliance.js')).toContain("router.post('/kyc/documents', express.json({ limit: '15mb' }), c.uploadKycDocument)");
  });

  it('the PAN card goes the same way, as docType PAN_CARD — a file, no number', async () => {
    reply = () => ({ success: true, data: { id: 'p1', docType: 'PAN_CARD', status: 'PENDING' } });
    await complianceApi.uploadKycDocumentTimed(
      { docType: 'PAN_CARD', filename: 'pan.jpg', mimeType: 'image/jpeg', dataBase64: 'B'.repeat(400) },
      kycUploadTimeoutMs(400),
    );
    expect(last()).toMatchObject({ method: 'POST', url: '/compliance/kyc/documents' });
    expect(last().body).toEqual({ docType: 'PAN_CARD', filename: 'pan.jpg', mimeType: 'image/jpeg', dataBase64: 'B'.repeat(400) });
    expectReadBy(last().body, bodyKeys(COMPLIANCE, 'uploadKycDocument'));
    expect(backend('config/constants.js')).toContain("KYC_DOC_TYPES: ['ID_FRONT', 'ID_BACK', 'SELFIE', 'ADDRESS_PROOF', 'PAN_CARD', 'OTHER'],");
  });

  it('reads whether this account may still upload from GET /user/kyc/status', async () => {
    reply = () => ({ success: true, data: { status: 'APPROVED', rejectionReason: null, uploadUnlocked: false, canUpload: false } });
    expect(await userApi.kycStatus()).toEqual({ status: 'APPROVED', rejectionReason: null, uploadUnlocked: false, canUpload: false });
    expect(last()).toMatchObject({ method: 'GET', url: '/user/kyc/status' });
    expect(backend('routes/user.js')).toContain("router.get('/kyc/status', c.getKycStatus);");
  });

  it('the server body limit fits the largest document the app lets through', () => {
    // 10 MB of bytes is ~13.4 MB of base64 — under both 15 MB parsers.
    expect(Math.ceil((10 * 1024 * 1024 * 4) / 3)).toBeLessThan(15 * 1024 * 1024);
    expect(backend('server.js')).toContain("app.use(express.json({ limit: '15mb' }))");
  });

  it('lists documents from the same path', async () => {
    reply = () => ({ success: true, data: [{ _id: 'd1', docType: 'SELFIE', originalFilename: 's.jpg', status: 'APPROVED', createdAt: '2026-01-01' }] });
    const docs = await complianceApi.kycDocuments();
    expect(last()).toMatchObject({ method: 'GET', url: '/compliance/kyc/documents' });
    expect(docs[0]).toMatchObject({ id: 'd1', docType: 'SELFIE', originalFilename: 's.jpg', status: 'APPROVED' });
  });
});

describe('Profile → Security', () => {
  it('changes the password keeping THIS device signed in — the keys changePassword reads', async () => {
    reply = () => ({ success: true, data: { ok: true, message: 'Password changed successfully.' } });
    await authApi.changePassword('Old#Pass1', 'New#Pass2');
    expect(last()).toMatchObject({ method: 'POST', url: '/auth/change-password' });
    expect(last().body).toEqual({ currentPassword: 'Old#Pass1', newPassword: 'New#Pass2', keepRefreshToken: 'RT-this-device' });
    expectReadBy(last().body, bodyKeys(AUTH, 'changePassword'));
    expectRoute('auth.js', 'post', '/change-password', 'changePassword');
  });

  it('there is no two-factor endpoint to call — EquityHub has none', () => {
    expect(backend('routes/auth.js')).not.toContain('2fa');
    expect(Object.keys(authApi)).not.toEqual(expect.arrayContaining(['setup2fa']));
    expect(Object.keys(authApi).filter((k) => /2fa/i.test(k))).toEqual([]);
  });
});

describe('Profile → Active sessions', () => {
  it('lists sessions with this device marked, and revokes one by its session id', async () => {
    reply = () => ({
      success: true,
      data: [
        { id: '9b1c5c4e-sid-this', deviceInfo: 'okhttp/4.12', createdAt: '2026-01-01', lastSeenAt: '2026-02-01', current: true },
        { id: '1f2e3d4c-sid-other', deviceInfo: 'iPhone', createdAt: '2026-01-05', lastSeenAt: '2026-01-06', current: false },
      ],
    });
    const devices = await authApi.listDevices();
    expect(last()).toMatchObject({ method: 'GET', url: '/auth/devices' });
    expect(devices).toEqual([
      { id: '9b1c5c4e-sid-this', deviceInfo: 'okhttp/4.12', createdAt: '2026-01-01', lastSeenAt: '2026-02-01', current: true },
      { id: '1f2e3d4c-sid-other', deviceInfo: 'iPhone', createdAt: '2026-01-05', lastSeenAt: '2026-01-06', current: false },
    ]);

    await authApi.revokeDevice('1f2e3d4c-sid-other');
    expect(last()).toMatchObject({ method: 'DELETE', url: '/auth/devices/1f2e3d4c-sid-other' });
    // revokeDevice pulls the session whose sid is the id.
    expect(AUTH).toContain('{ $pull: { refreshTokens: { sid: id } } }');

    expectRoute('auth.js', 'get', '/devices', 'listDevices');
    expectRoute('auth.js', 'delete', '/devices/:id', 'revokeDevice');
  });
});
