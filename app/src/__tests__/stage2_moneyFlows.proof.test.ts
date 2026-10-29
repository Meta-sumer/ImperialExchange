/**
 * The deposit proof — EquityHub's utils/imageCompress.js on a phone: a pick
 * of up to 10 MB, re-encoded at 1800 px on the long edge with the quality
 * stepping down until it is under ~900 KB, and refused in the web's words
 * when it cannot be read or is too big. The picker and the image manipulator
 * are native; both are replaced here by scripted stand-ins.
 */
import fs from 'fs';
import path from 'path';

const mockLaunch = jest.fn();
jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: (...a: unknown[]) => mockLaunch(...a) }));

/** base64 length the manipulator "produces" per call, in order. */
let mockSizes: number[] = [];
const mockResizes: Array<{ width?: number; height?: number }> = [];
const mockSaves: Array<Record<string, unknown>> = [];
let mockReleased = 0;
jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
  ImageManipulator: {
    manipulate: () => {
      const ctx = {
        resize: (s: { width?: number; height?: number }) => { mockResizes.push(s); return ctx; },
        renderAsync: async () => ({
          saveAsync: async (o: Record<string, unknown>) => {
            mockSaves.push(o);
            const n = mockSizes.shift() ?? 10;
            return { uri: `file:///out-${mockSaves.length}.jpg`, width: 1, height: 1, base64: 'A'.repeat(n) };
          },
          release: () => { mockReleased += 1; },
        }),
        release: () => { mockReleased += 1; },
      };
      return ctx;
    },
  },
}));

/* eslint-disable import/first */
import {
  PROOF_FALLBACK,
  PROOF_LADDER,
  PROOF_NOT_IMAGE,
  PROOF_TARGET,
  PROOF_TOO_LARGE,
  PROOF_UNREADABLE,
  isImageAsset,
  pickProofImage,
  proofTooLarge,
} from '@/services/proofImage';
import { PROOF_MAX_DATA_URL } from '@/utils/fundsFlows';
/* eslint-enable import/first */

const WEB = fs.readFileSync(path.join(__dirname, '../../../client/src/pages/Wallet.jsx'), 'utf8');
const COMPRESS = fs.readFileSync(path.join(__dirname, '../../../client/src/utils/imageCompress.js'), 'utf8');

beforeEach(() => {
  mockLaunch.mockReset();
  mockSizes = [];
  mockResizes.length = 0;
  mockSaves.length = 0;
  mockReleased = 0;
});

const asset = (o: Record<string, unknown> = {}) => ({
  canceled: false,
  assets: [{ uri: 'file:///shot.png', width: 1170, height: 2532, mimeType: 'image/png', type: 'image', ...o }],
});

describe('pickProofImage', () => {
  it('a cancelled pick is not an error', async () => {
    mockLaunch.mockResolvedValue({ canceled: true, assets: null });
    expect(await pickProofImage()).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('refuses a non-image in the web\'s words', async () => {
    mockLaunch.mockResolvedValue(asset({ mimeType: 'application/pdf', type: null }));
    expect(await pickProofImage()).toEqual({ ok: false, reason: 'not-image', message: PROOF_NOT_IMAGE });
    expect(WEB).toContain(`toast.error('${PROOF_NOT_IMAGE}')`);
    expect(isImageAsset({ mimeType: null, type: 'image' })).toBe(true);
    expect(isImageAsset({ mimeType: 'image/heic' })).toBe(true);
  });

  it('the ladder is imageCompress.js’s: 1800 px, quality 0.85 → 0.5', () => {
    expect(COMPRESS).toMatch(/opts\.maxDim \|\| 1800/);
    expect(COMPRESS).toMatch(/canvas\.toDataURL\('image\/jpeg', 0\.85\)/);
    expect(COMPRESS).toMatch(/for \(const q of \[0\.75, 0\.65, 0\.55, 0\.5\]\)/);
    expect(PROOF_LADDER).toEqual([0.85, 0.75, 0.65, 0.55, 0.5].map((compress) => ({ edge: 1800, compress })));
  });

  it('refuses a pick over 10 MB in the web’s words', async () => {
    mockLaunch.mockResolvedValue(asset({ fileSize: 12 * 1024 * 1024 }));
    expect(await pickProofImage()).toEqual({ ok: false, reason: 'too-large', message: 'File too large (12.0 MB). Maximum size: 10.0 MB' });
    expect(WEB).toContain('toast.error(`File too large (${fmtBytes(file.size)}). Maximum size: ${fmtBytes(MAX_UPLOAD_BYTES)}`)');
    expect(proofTooLarge(2048)).toBe('File too large (2 KB). Maximum size: 10.0 MB');
  });

  it('an unreadable image is reported in the web’s words, not thrown', async () => {
    expect(WEB).toContain(`toast.error('${PROOF_UNREADABLE}')`);
  });

  it('stops at the first rung that fits, scaling the long edge, as a JPEG data URL', async () => {
    const tooBig = PROOF_TARGET; // base64 alone this long + the prefix is over
    mockSizes = [tooBig, 1000];
    mockLaunch.mockResolvedValue(asset());
    const res = await pickProofImage();
    expect(res).toMatchObject({ ok: true, image: { mimeType: 'image/jpeg', uri: 'file:///out-2.jpg' } });
    if (!res.ok) throw new Error('expected ok');
    expect(res.image.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(res.image.dataUrl.length).toBeLessThanOrEqual(PROOF_TARGET);
    // Portrait: the height is the long edge.
    expect(mockResizes).toEqual([{ height: PROOF_LADDER[0]!.edge }, { height: PROOF_LADDER[1]!.edge }]);
    expect(mockSaves.map((s) => s.compress)).toEqual([PROOF_LADDER[0]!.compress, PROOF_LADDER[1]!.compress]);
    expect(mockSaves.every((s) => s.base64 === true && s.format === 'jpeg')).toBe(true);
    // Every native image and context mockReleased.
    expect(mockReleased).toBe(4);
  });

  it('does not upscale a small image', async () => {
    mockSizes = [500];
    mockLaunch.mockResolvedValue(asset({ width: 600, height: 400 }));
    expect((await pickProofImage()).ok).toBe(true);
    expect(mockResizes).toEqual([]);
  });

  it('like the web, keeps the last rung’s result once it is within the server’s cap', async () => {
    // Over the ~900 KB target on every rung, but under the server's 3 MB.
    mockSizes = PROOF_LADDER.map(() => PROOF_TARGET + 1);
    mockLaunch.mockResolvedValue(asset());
    const res = await pickProofImage();
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.image.dataUrl.length).toBeLessThanOrEqual(PROOF_MAX_DATA_URL);
    expect(mockSaves).toHaveLength(PROOF_LADDER.length);
  });

  it('gives up with the size message when nothing fits even the server’s cap', async () => {
    mockSizes = [...PROOF_LADDER, ...PROOF_FALLBACK].map(() => PROOF_MAX_DATA_URL + 1);
    mockLaunch.mockResolvedValue(asset());
    expect(await pickProofImage()).toEqual({ ok: false, reason: 'too-large', message: PROOF_TOO_LARGE });
    expect(mockSaves).toHaveLength(PROOF_LADDER.length + PROOF_FALLBACK.length);
  });

  it('a failure reading the image is reported, not thrown', async () => {
    mockLaunch.mockRejectedValue(new Error('boom'));
    expect(await pickProofImage()).toEqual({ ok: false, reason: 'failed', message: PROOF_UNREADABLE });
  });
});
