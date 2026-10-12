/**
 * upstox-login.js — the ALWAYS-WORKS fallback to get a fresh Upstox token via a
 * ONE-TIME browser login. Uses only Upstox's DOCUMENTED endpoints, so it works
 * even if the automated TOTP login (upstoxAuth) needs adjustment.
 *
 * Step 1 — print the login URL:
 *   docker compose exec backend node scripts/upstox-login.js
 * Open it in a browser, log in to Upstox. You get redirected to your
 * redirect_uri with  ?code=XXXX  in the address bar.
 *
 * Step 2 — exchange the code (paste the code OR the whole redirected URL):
 *   docker compose exec backend node scripts/upstox-login.js "XXXX"
 * It saves the token to disk; then apply it:
 *   docker compose restart backend
 */
require('dotenv').config();
const upstoxAuth = require('../src/services/upstoxAuth');

const KEY = process.env.UPSTOX_API_KEY;
const SECRET = process.env.UPSTOX_API_SECRET;
const REDIR = process.env.UPSTOX_REDIRECT_URI;

(async () => {
  if (!KEY || !SECRET || !REDIR) {
    console.error('❌ Set UPSTOX_API_KEY, UPSTOX_API_SECRET and UPSTOX_REDIRECT_URI in .env first.');
    process.exit(2);
  }
  const arg = process.argv[2];
  if (!arg) {
    const url = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code`
      + `&client_id=${encodeURIComponent(KEY)}&redirect_uri=${encodeURIComponent(REDIR)}`;
    console.log('\n1) Open this URL in a browser and log in to Upstox:\n');
    console.log('   ' + url + '\n');
    console.log('2) After login you land on your redirect URI with  ?code=...  in the address bar.');
    console.log('3) Run again with that code (or the whole redirected URL):\n');
    console.log('   docker compose exec backend node scripts/upstox-login.js "<code-or-redirect-url>"\n');
    process.exit(0);
  }
  const code = (String(arg).match(/[?&]code=([^&]+)/) || [null, arg])[1];
  try {
    const token = await upstoxAuth.exchangeCode(decodeURIComponent(code));
    upstoxAuth.saveToken(token);
    console.log('\n✅ Token obtained + saved to', upstoxAuth.TOKEN_FILE);
    console.log('   Apply it now:  docker compose restart backend');
    console.log('   Verify live:   docker compose exec backend node scripts/verify-indian-live.js');
    process.exit(0);
  } catch (e) {
    console.error('\n❌ Exchange failed:', e.message);
    console.error('   The code may be expired (they are single-use, ~short-lived) — redo Step 1 for a fresh code.');
    process.exit(1);
  }
})();
