import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { MAX_UPLOAD_BYTES, PROOF_COMPRESS_TARGET, PROOF_MAX_DATA_URL, fmtBytes } from '@/utils/fundsFlows';

/**
 * A payment screenshot, ready to post as proof of a deposit —
 * client/src/utils/imageCompress.js.
 *
 * The web accepts a pick of up to 10 MB and downscales it before sending:
 * longest edge 1800 px, re-encoded as JPEG at falling quality (0.85 → 0.5)
 * until the data URL is under ~900 KB. The server's own backstop is 3 MB of
 * encoded data URL (walletController SCREENSHOT_MAX_BYTES) — the proof lives
 * inline on the deposit document, so the stored size is paid on every admin
 * page load. Here the same ladder runs with expo-image-manipulator, with two
 * smaller rungs after it so a pathological image still fits the server's cap.
 */
export interface ProofImage {
  /** `data:image/jpeg;base64,…` — what the server stores. */
  dataUrl: string;
  mimeType: string;
  /** A local file for the preview. */
  uri: string;
}

export type ProofPick =
  | { ok: true; image: ProofImage }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'not-image' | 'too-large' | 'failed'; message: string };

/** The web's refusals (Wallet.jsx handleFileChange), word for word. */
export const PROOF_NOT_IMAGE = 'Please upload an image file (PNG/JPG)';
export const proofTooLarge = (bytes: number): string =>
  `File too large (${fmtBytes(bytes)}). Maximum size: ${fmtBytes(MAX_UPLOAD_BYTES)}`;
export const PROOF_UNREADABLE = 'Could not read that image. Try a PNG or JPG.';
/** Nothing on the ladder fitted the server's cap — said the web's way. */
export const PROOF_TOO_LARGE = proofTooLarge(MAX_UPLOAD_BYTES);

/** Long edge in pixels, JPEG quality — imageCompress.js, tried in order. */
export const PROOF_LADDER: readonly { edge: number; compress: number }[] = [
  { edge: 1800, compress: 0.85 },
  { edge: 1800, compress: 0.75 },
  { edge: 1800, compress: 0.65 },
  { edge: 1800, compress: 0.55 },
  { edge: 1800, compress: 0.5 },
];

/** Past the web's ladder: smaller, so an image still fits the server's cap. */
export const PROOF_FALLBACK: readonly { edge: number; compress: number }[] = [
  { edge: 1280, compress: 0.5 },
  { edge: 1024, compress: 0.5 },
];

/** The web's target for the encoded data URL. */
export const PROOF_TARGET = PROOF_COMPRESS_TARGET;

/** Whether a picked asset is an image the web would accept (`image/*`). */
export const isImageAsset = (asset: { mimeType?: string | null; type?: string | null }): boolean => {
  if (asset.mimeType) return asset.mimeType.startsWith('image/');
  // Some Android providers leave mimeType empty; the picker was asked for images only.
  return !asset.type || asset.type === 'image';
};

/**
 * One rung of the ladder, always from the ORIGINAL (re-encoding a JPEG that
 * was already squeezed compounds the artefacts). The native image and
 * context are released as soon as the file is written.
 */
const encodeStep = async (
  uri: string,
  resize: { width?: number; height?: number } | null,
  compress: number,
): Promise<{ uri: string; base64?: string }> => {
  const ctx = ImageManipulator.manipulate(uri);
  try {
    if (resize) ctx.resize(resize);
    const ref = await ctx.renderAsync();
    try {
      return await ref.saveAsync({ compress, format: SaveFormat.JPEG, base64: true });
    } finally {
      ref.release();
    }
  } finally {
    ctx.release();
  }
};

export const pickProofImage = async (): Promise<ProofPick> => {
  try {
    // The system photo picker needs no permission prompt on Android 13+ or iOS 14+.
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      quality: 1,
    });
    const asset = result.canceled ? null : result.assets?.[0];
    if (!asset) return { ok: false, reason: 'cancelled' };
    if (!isImageAsset(asset)) return { ok: false, reason: 'not-image', message: PROOF_NOT_IMAGE };
    if (typeof asset.fileSize === 'number' && asset.fileSize > MAX_UPLOAD_BYTES) {
      return { ok: false, reason: 'too-large', message: proofTooLarge(asset.fileSize) };
    }

    const portrait = asset.height >= asset.width;
    const longEdge = Math.max(asset.width, asset.height);

    let lastFit: ProofImage | null = null;
    for (const step of [...PROOF_LADDER, ...PROOF_FALLBACK]) {
      // eslint-disable-next-line no-await-in-loop
      const out = await encodeStep(asset.uri, longEdge > step.edge ? (portrait ? { height: step.edge } : { width: step.edge }) : null, step.compress);
      if (!out.base64) continue;
      const dataUrl = `data:image/jpeg;base64,${out.base64}`;
      const image = { dataUrl, mimeType: 'image/jpeg', uri: out.uri };
      if (dataUrl.length <= PROOF_TARGET) return { ok: true, image };
      // The web stops at quality 0.5 and sends what it has; the server takes
      // up to its own cap.
      if (dataUrl.length <= PROOF_MAX_DATA_URL && !lastFit) lastFit = image;
      if (step === PROOF_LADDER[PROOF_LADDER.length - 1] && lastFit) return { ok: true, image: lastFit };
    }
    return lastFit
      ? { ok: true, image: lastFit }
      : { ok: false, reason: 'too-large', message: PROOF_TOO_LARGE };
  } catch {
    return { ok: false, reason: 'failed', message: PROOF_UNREADABLE };
  }
};
