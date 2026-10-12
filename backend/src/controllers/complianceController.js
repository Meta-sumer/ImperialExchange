const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { WhitelistedAddress, KycDocument } = require('../models/Compliance');
const User = require('../models/User');
const affiliateService = require('../services/affiliateService');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const { KYC_STATUS } = require('../config/constants');

// =============== KYC Document Upload ===============

const UPLOAD_DIR = process.env.KYC_UPLOAD_DIR || path.join(__dirname, '../../uploads/kyc');
// Lazily create the upload dir on first use rather than at module load — a
// read-only volume or permission issue would otherwise crash the entire
// process at startup before MongoDB is even reached.
let _uploadDirReady = false;
const _ensureUploadDir = async (dir = UPLOAD_DIR) => {
  if (_uploadDirReady && dir === UPLOAD_DIR) return;
  try {
    await fsp.mkdir(dir, { recursive: true });
    if (dir === UPLOAD_DIR) _uploadDirReady = true;
  } catch (e) {
    throw new AppError(`KYC upload directory not writable: ${e.message}`, 500);
  }
};

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * What the bytes actually are, regardless of what the client claimed or
 * what the file was named. A document is identity evidence — accepting it
 * on the client's say-so meant a file that was not really an image uploaded
 * happily and only failed later, when someone tried to look at it.
 *
 * Returns a mime type, or null when the bytes match nothing we accept.
 */
function sniffMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
    && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) {
    return 'image/png';
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 4) === '%PDF') return 'application/pdf';
  return null;
}

/**
 * Upload a KYC document. Expects a base64-encoded payload in JSON body
 * to avoid pulling in multer just for this. For large files in production,
 * switch to multer + S3 multipart upload.
 *
 * Body: { docType: 'ID_FRONT' | 'ID_BACK' | 'SELFIE' | 'ADDRESS_PROOF', filename, mimeType, dataBase64 }
 */
const uploadKycDocument = asyncHandler(async (req, res) => {
  const { docType, filename, mimeType, dataBase64 } = req.body;
  if (!docType || !filename || !mimeType || !dataBase64) {
    throw new AppError('docType, filename, mimeType, and dataBase64 are required', 400);
  }
  if (!ALLOWED_MIME.includes(mimeType)) {
    throw new AppError(`Unsupported mime type. Allowed: ${ALLOWED_MIME.join(', ')}`, 400);
  }
  const buf = Buffer.from(dataBase64, 'base64');
  if (buf.length > MAX_SIZE) throw new AppError('File too large (max 10MB)', 400);
  if (buf.length < 100) throw new AppError('File too small / corrupt', 400);

  // What the file REALLY is. The claimed mimeType and the extension are both
  // just strings the client chose, so a renamed or mislabelled file used to
  // be stored and only fail when someone opened it. Refuse it up front.
  const realMime = sniffMime(buf);
  if (!realMime) {
    throw new AppError(
      `That file is not a readable ${ALLOWED_MIME.map((m) => m.split('/')[1].toUpperCase()).join(', ')} — it may be corrupt or renamed from another format. Please upload the original image or PDF.`,
      400,
      'KYC_UNRECOGNISED_FORMAT'
    );
  }

  // A verified user has nothing left to prove. Closing this on the server
  // (not just hiding the button) is what makes it a rule rather than a
  // suggestion — the endpoint is reachable directly.
  const owner = await User.findById(req.userId).select('kycStatus kycUploadUnlocked');
  if (owner && owner.kycStatus === KYC_STATUS.APPROVED && !owner.kycUploadUnlocked) {
    throw new AppError(
      'Your KYC is already verified, so no further documents are needed. Contact support if something needs updating.',
      403,
      'KYC_ALREADY_VERIFIED'
    );
  }

  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  // Derive the extension from what the bytes ARE, so the file on disk is
  // always named for its real format even if the upload was mislabelled.
  const EXT_FOR = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };
  const ext = EXT_FOR[realMime] || '.bin';
  const userDir = path.join(UPLOAD_DIR, String(req.userId));
  // Async IO so a slow disk doesn't stall the event loop for the whole
  // process while one user uploads.
  await _ensureUploadDir(UPLOAD_DIR);
  await _ensureUploadDir(userDir);
  const storagePath = path.join(userDir, `${docType}_${Date.now()}${ext}`);
  await fsp.writeFile(storagePath, buf);

  const doc = await KycDocument.create({
    userId: req.userId,
    docType,
    originalFilename: filename,
    storagePath,
    mimeType: realMime,
    sizeBytes: buf.length,
    sha256,
    status: 'PENDING',
  });

  // Reflect submission immediately: the first uploaded document moves the user
  // into PENDING (under review). Re-uploads after a REJECTED / NOT_SUBMITTED /
  // PENDING state also stay PENDING. We never downgrade an already-APPROVED user.
  if (owner && owner.kycStatus !== KYC_STATUS.APPROVED && owner.kycStatus !== KYC_STATUS.PENDING) {
    owner.kycStatus = KYC_STATUS.PENDING;
    await owner.save();
  }

  sendSuccess(res, { id: doc._id, docType, sha256, status: doc.status }, 201);
});

const listKycDocuments = asyncHandler(async (req, res) => {
  const docs = await KycDocument.find({ userId: req.userId })
    .select('-storagePath') // never expose internal paths to user
    .sort({ createdAt: -1 })
    .lean();
  sendSuccess(res, docs);
});

// Admin: stream a KYC file for review
const streamKycFile = asyncHandler(async (req, res) => {
  const doc = await KycDocument.findById(req.params.id);
  if (!doc) throw new AppError('Document not found', 404);

  // Every failure here used to collapse into one 404 ("File missing on disk"),
  // or — when stat passed but the READ did not — into a bare 500 with the reason
  // only in the server log. Those are different faults with different fixes, and
  // an admin looking at a 500 in the browser had no way to tell them apart.
  //
  // The distinction that matters: stat() only needs execute permission on the
  // parent DIRECTORY, while reading needs permission on the FILE. A file copied
  // from another host with different ownership therefore stats fine and then
  // fails to open — which is exactly how "some documents open, some 500" looks.
  if (!doc.storagePath) {
    throw new AppError('Document has no stored file path (upload never completed)', 404, 'KYC_NO_PATH');
  }
  let stat;
  try {
    stat = await fsp.stat(doc.storagePath);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error(`[compliance] KYC file not on disk: ${doc.storagePath} (doc ${doc._id})`);
      throw new AppError('File missing on disk', 404, 'KYC_FILE_MISSING');
    }
    console.error(`[compliance] KYC stat failed (${e.code}) for ${doc.storagePath}: ${e.message}`);
    throw new AppError(`Cannot read document (${e.code || 'stat failed'})`, 500, 'KYC_STAT_FAILED');
  }
  if (stat.isDirectory()) {
    throw new AppError('Stored path is a directory, not a file', 500, 'KYC_PATH_IS_DIR');
  }
  // Check readability BEFORE any header goes out — once the response has begun
  // streaming we can only destroy the socket, which reaches the browser as an
  // opaque network error rather than a message anyone can act on.
  try {
    await fsp.access(doc.storagePath, fs.constants.R_OK);
  } catch (e) {
    console.error(`[compliance] KYC file not readable (${e.code}) — check ownership/permissions on ${doc.storagePath}`);
    throw new AppError('Document exists but is not readable by the server (file permissions)', 500, 'KYC_FILE_UNREADABLE');
  }

  // Content-Disposition, RFC 6266 style.
  //
  // Node's setHeader throws ERR_INVALID_CHAR for ANY character outside
  // Latin-1, and that throw reached the browser as a plain 500 on a file
  // that was perfectly readable. macOS screenshots are the common case —
  // their names carry U+202F before AM/PM — so the very documents users
  // upload most often were the ones that would not open, and renaming the
  // same image to ASCII "fixed" it.
  //
  // `filename` therefore carries an ASCII-only fallback (also stripped of
  // CR/LF and quotes, so an upload name cannot inject headers), and
  // `filename*` carries the real name percent-encoded, which browsers prefer.
  const rawName = String(doc.originalFilename || 'document').slice(0, 200);
  const asciiName = (rawName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_').trim()) || 'document';
  const encodedName = encodeURIComponent(rawName)
    .replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

  res.setHeader('Content-Type', doc.mimeType);
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${asciiName}"; filename*=UTF-8''${encodedName}`
  );

  const stream = fs.createReadStream(doc.storagePath);
  stream.on('error', (err) => {
    // Headers may already be sent; either way we can't recover gracefully —
    // destroy the connection so the client knows the body is bad rather
    // than hanging on a stalled socket.
    console.error(`[compliance] KYC stream error (${err.code}) on ${doc.storagePath}: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'Stream read failed' });
    } else {
      res.destroy(err);
    }
  });
  stream.pipe(res);
});

// =============== Withdrawal Whitelist ===============

const listWhitelist = asyncHandler(async (req, res) => {
  const items = await WhitelistedAddress.find({ userId: req.userId, isActive: true }).lean();
  sendSuccess(res, items);
});

const addWhitelistEntry = asyncHandler(async (req, res) => {
  const { label, method, currency, address, network, bankDetails } = req.body;
  if (!label || !method || !currency) throw new AppError('label, method, currency required', 400);
  if (method === 'CRYPTO' && !address) throw new AppError('Crypto address required', 400);
  if (method === 'BANK' && !bankDetails) throw new AppError('Bank details required', 400);

  // Length caps so a pathological payload doesn't bloat the doc.
  if (String(label).length > 64) throw new AppError('label too long (max 64 chars)', 400);
  if (address && String(address).length > 256) {
    throw new AppError('address too long (max 256 chars)', 400);
  }

  // Per-network format validation (mirrors withdrawal-time check) so we
  // never whitelist a TRC20 address against an ERC20 network.
  if (method === 'CRYPTO') {
    const NET_VALIDATORS = {
      ERC20: /^0x[a-fA-F0-9]{40}$/,
      BEP20: /^0x[a-fA-F0-9]{40}$/,
      TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
      BTC:   /^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,87}$/,
    };
    const net = String(network || '').toUpperCase();
    const re = NET_VALIDATORS[net];
    if (!re) throw new AppError(`Unsupported network: ${net || '(empty)'}`, 400);
    if (!re.test(String(address).trim())) {
      throw new AppError(`Invalid ${net} address format`, 400);
    }
  }

  // Dedupe: don't create a second active row for the same (userId, method,
  // currency, address) — saves admin confusion and silent duplicate payouts.
  const dedupeFilter = {
    userId: req.userId,
    method,
    currency,
    isActive: true,
  };
  if (method === 'CRYPTO') dedupeFilter.address = address;
  const existing = await WhitelistedAddress.findOne(dedupeFilter);
  if (existing) {
    throw new AppError('This destination is already whitelisted', 409, 'DUPLICATE_WHITELIST');
  }

  // Per doc §12.3: new addresses require email confirmation + 24h cooldown.
  // For MVP we auto-confirm but enforce the 24h cooldown.
  const now = new Date();
  const entry = await WhitelistedAddress.create({
    userId: req.userId,
    label,
    method,
    currency,
    address: address || '',
    network,
    bankDetails,
    confirmedAt: now,
    activeFrom: new Date(now.getTime() + 24 * 60 * 60 * 1000), // 24h cooldown
  });
  sendSuccess(res, entry, 201);
});

const removeWhitelistEntry = asyncHandler(async (req, res) => {
  const entry = await WhitelistedAddress.findOne({ _id: req.params.id, userId: req.userId });
  if (!entry) throw new AppError('Whitelist entry not found', 404);
  entry.isActive = false;
  await entry.save();
  sendSuccess(res, { ok: true });
});

// =============== Affiliate Dashboard ===============

const affiliateSummary = asyncHandler(async (req, res) => {
  const summary = await affiliateService.getReferrerSummary(req.userId);
  const user = await User.findById(req.userId).select('referralCode').lean();
  sendSuccess(res, { ...summary, referralCode: user.referralCode });
});

const affiliateCommissions = asyncHandler(async (req, res) => {
  const { Commission } = require('../models/Compliance');
  const commissions = await Commission.find({ referrerId: req.userId }).sort({ createdAt: -1 }).limit(200).lean();
  sendSuccess(res, commissions);
});

module.exports = {
  uploadKycDocument,
  listKycDocuments,
  streamKycFile,
  listWhitelist,
  addWhitelistEntry,
  removeWhitelistEntry,
  affiliateSummary,
  affiliateCommissions,
};
