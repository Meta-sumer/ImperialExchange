/**
 * Downscale + re-encode an image file to a data URL that is small enough to
 * store inline.
 *
 * Payment screenshots are kept as base64 data URLs ON the Deposit / Withdrawal
 * document itself, and the admin list endpoints return those documents whole —
 * 200 rows at a time. So the stored size is not a per-user cost, it is
 * multiplied by every row on every admin page load, and a raw 10 MB photo
 * (≈ 13.4 MB once base64-encoded) would also sit right against MongoDB's 16 MB
 * per-document ceiling.
 *
 * Rather than making people crop and re-save a screenshot before it is accepted,
 * we take the big file and shrink it here: a phone screenshot at 1800px on its
 * long edge is far more readable than the 500 KB original limit allowed, and
 * lands around 200-600 KB.
 *
 * @param {File} file
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]  target size of the encoded data URL
 * @param {number} [opts.maxDim]    longest edge, in pixels
 * @returns {Promise<{ dataUrl: string, mimeType: string, originalBytes: number, bytes: number }>}
 */
export async function compressImage(file, opts = {}) {
  const maxBytes = opts.maxBytes || 900 * 1024;
  const maxDim = opts.maxDim || 1800;

  const originalBytes = file.size;
  const dataUrl = await readAsDataUrl(file);

  // Already comfortably small and in a format the admin panel renders — keep
  // the original bytes rather than re-encoding (which would only lose quality).
  if (dataUrl.length <= maxBytes) {
    return { dataUrl, mimeType: file.type || 'image/jpeg', originalBytes, bytes: dataUrl.length };
  }

  const img = await loadImage(dataUrl);
  let { width, height } = img;
  if (Math.max(width, height) > maxDim) {
    const scale = maxDim / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // Screenshots are usually opaque; a white ground stops transparent PNG areas
  // turning black when re-encoded as JPEG.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  // Step the quality down until it fits. Stops at 0.5 — below that the text in
  // a payment screenshot starts to smear, and an admin has to read it.
  let out = canvas.toDataURL('image/jpeg', 0.85);
  for (const q of [0.75, 0.65, 0.55, 0.5]) {
    if (out.length <= maxBytes) break;
    out = canvas.toDataURL('image/jpeg', q);
  }

  return { dataUrl: out, mimeType: 'image/jpeg', originalBytes, bytes: out.length };
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read that file'));
    r.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file is not a readable image'));
    img.src = src;
  });
}

/** Human-readable byte size, for upload hints and error messages. */
export const fmtBytes = (n) => {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
};

/** Largest file a user may pick. Anything under this is compressed to fit. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export default compressImage;
