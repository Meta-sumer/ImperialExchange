import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import BrandLogo from '../components/BrandLogo';

/**
 * /download — the Android app.
 *
 * The APK and its manifest are published by ops outside the containers at
 * /downloads/ImperialExchange.apk and /downloads/latest.json (nginx serves
 * that folder, see nginx/imperialexchange.in.conf). The manifest is what
 * app/scripts/build-android-release.mjs writes next to the APK, so the
 * version, size and date here are always the published build's. The QR on
 * the landing page and the store badges all point at this route.
 */
const APK = '/downloads/ImperialExchange.apk';

export default function Download() {
  const [meta, setMeta] = useState(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    document.title = 'Download the app · Imperial Exchange';
    let on = true;
    fetch('/downloads/latest.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((m) => { if (on) setMeta(m); })
      .catch(() => { if (on) setMissing(true); });
    return () => { on = false; };
  }, []);

  const mb = meta?.sizeBytes ? (meta.sizeBytes / 1048576).toFixed(1) : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-dark px-6 py-12">
      <div className="w-full max-w-md card p-8 text-center space-y-5">
        <div className="flex justify-center"><BrandLogo size={110} /></div>
        <div>
          <h1 className="text-2xl font-extrabold text-text-primary">Imperial Exchange for Android</h1>
          <p className="mt-2 text-sm text-text-secondary">
            Trade NSE, BSE and MCX on the go — live prices, your wallet, deposits and history, all in your pocket.
          </p>
        </div>

        {missing ? (
          <div className="rounded-xl border border-border-dark p-4 text-sm text-text-secondary">
            The Android build is being published. Check back shortly.
          </div>
        ) : (
          <>
            <a
              href={APK}
              className="keep-white block w-full rounded-xl px-5 py-3.5 text-base font-bold shadow-elevated hover:opacity-90 transition-opacity"
              style={{ background: 'linear-gradient(90deg,#2563EB 0%,#10B981 100%)', color: '#fff' }}
            >
              Download APK{mb ? ` · ${mb} MB` : ''}
            </a>
            <div className="text-xs text-text-muted">
              {meta ? <>Version {meta.version} · updated {meta.updatedAt} · Android {meta.minAndroid || '7.0'}+</> : 'Fetching the latest build…'}
            </div>
          </>
        )}

        <ol className="text-left text-xs text-text-secondary space-y-1.5 rounded-xl bg-bg-hover/40 p-4">
          <li>1. Open the downloaded file on your phone.</li>
          <li>2. If asked, allow installs from your browser (Settings → Install unknown apps).</li>
          <li>3. Sign in with the same account you use on the website.</li>
        </ol>

        <p className="text-xs text-text-muted">iPhone version coming soon.</p>
        <Link to="/" className="inline-block text-xs text-text-muted hover:underline">Back to Imperial Exchange</Link>
      </div>
    </div>
  );
}
