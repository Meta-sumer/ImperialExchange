import { api } from '@/api/client';
import { rows, str } from '@/types/api';
import {
  KYC_ALLOWED_MIME,
  KYC_MAX_BYTES,
  toKycDocument,
  type KycDocType,
  type KycDocument,
} from '@/types/user';

/**
 * KYC documents (/compliance/kyc/documents) — Profile → KYC.
 *
 * NOT ported: /compliance/affiliate/*. Its only caller is
 * client/src/pages/Affiliate.jsx, which is never rendered — /affiliate,
 * /partner and /ib-room all render Partner (PORT-RULINGS).
 */

type Raw = Record<string, unknown>;

const payload = (body: unknown): unknown =>
  (body && typeof body === 'object' && 'success' in body ? (body as Raw).data : body);

export interface KycUpload {
  docType: KycDocType;
  filename: string;
  mimeType: string;
  /** The file's bytes as base64 — NOT a data URL; no `data:…;base64,` prefix. */
  dataBase64: string;
}

/** base64 length → decoded byte count, padding accounted for. */
export const base64ByteLength = (b64: string): number => {
  const s = b64.replace(/\s/g, '');
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
};

/**
 * Why an upload would be refused, or null — checked on the bytes just read,
 * before they are sent. The size check and its words are Profile.jsx's
 * (KYC_MAX_BYTES). The type check is the app's own: the web leaves a wrong
 * type to complianceController ("Unsupported mime type"); on a phone that
 * would be up to 13 MB of base64 over a mobile uplink to learn it, so it is
 * refused here first, against the server's own ALLOWED_MIME list.
 */
export const kycUploadError = (upload: Pick<KycUpload, 'mimeType' | 'dataBase64'>): string | null => {
  if (base64ByteLength(upload.dataBase64) > KYC_MAX_BYTES) return 'File too large (max 10MB)';
  if (!(KYC_ALLOWED_MIME as readonly string[]).includes(upload.mimeType)) {
    return 'Upload a JPG, PNG, WEBP or PDF';
  }
  return null;
};

/** Strip a `data:…;base64,` prefix if the picker handed one back. */
export const stripDataUrlPrefix = (s: string): string => s.replace(/^data:[^;,]+;base64,/, '');

export const complianceApi = {
  /** Newest first; the server's storage path is never included. */
  kycDocuments: async (): Promise<KycDocument[]> => {
    const { data } = await api.get('/compliance/kyc/documents');
    return rows<unknown>(payload(data)).map(toKycDocument);
  },

  /**
   * Upload one document — `PAN_CARD` (Step 1) or a Step 2 type. Moves a
   * NOT_SUBMITTED / REJECTED account to PENDING — refresh the user
   * afterwards, as Profile.jsx does. The server's refusals, in its words:
   * KYC_UNRECOGNISED_FORMAT (the bytes are no accepted format — it judges
   * the bytes, and stores them as what they really are), KYC_BAD_DOC_TYPE,
   * and KYC_ALREADY_VERIFIED (403: a verified account, upload not re-opened).
   */
  uploadKycDocument: async (upload: KycUpload): Promise<{ id: string; status: string }> => {
    const { data } = await api.post('/compliance/kyc/documents', {
      ...upload,
      dataBase64: stripDataUrlPrefix(upload.dataBase64),
    });
    const d = (payload(data) ?? {}) as Raw;
    return { id: str(d.id) || str(d._id), status: str(d.status) || 'PENDING' };
  },

  /**
   * uploadKycDocument with the request timeout chosen by the caller.
   *
   * Added for the Profile → KYC port. The app's default request timeout is
   * 20 s; the web's axios has none, and a 10 MB document travels as ~13.4 MB
   * of base64 — minutes on a phone's upstream. Same endpoint, same body.
   */
  uploadKycDocumentTimed: async (
    upload: KycUpload,
    timeoutMs: number,
  ): Promise<{ id: string; status: string }> => {
    const { data } = await api.post('/compliance/kyc/documents', {
      ...upload,
      dataBase64: stripDataUrlPrefix(upload.dataBase64),
    }, { timeout: timeoutMs });
    const d = (payload(data) ?? {}) as Raw;
    return { id: str(d.id) || str(d._id), status: str(d.status) || 'PENDING' };
  },
};
