/**
 * upstox-refresh-now.js — trigger a full Upstox token auto-refresh RIGHT NOW and
 * report the outcome. Use this to TEST the TOTP auto-login after setting the
 * UPSTOX_* env vars. Verbose per-step logs are printed by upstoxAuth.
 *
 *   docker compose exec backend node scripts/upstox-refresh-now.js
 *
 * On success it persists the token to disk. The running backend also refreshes
 * on its own (daily + on any 401), so this is mainly a test/kick. To apply the
 * saved token immediately:  docker compose restart backend
 */
require('dotenv').config();
const upstoxAuth = require('../src/services/upstoxAuth');

(async () => {
  if (!upstoxAuth.isConfigured()) {
    console.error('❌ Not configured. Set these in .env: UPSTOX_API_KEY, UPSTOX_API_SECRET, UPSTOX_REDIRECT_URI, UPSTOX_TOTP_SECRET, UPSTOX_MOBILE, UPSTOX_PIN');
    process.exit(2);
  }
  const ok = await upstoxAuth.refreshToken();
  if (ok) {
    console.log('\n✅ SUCCESS — token refreshed + saved to', upstoxAuth.TOKEN_FILE);
    console.log('   Apply to the running app:  docker compose restart backend');
    console.log('   Verify live:               docker compose exec backend node scripts/verify-indian-live.js');
    process.exit(0);
  }
  console.error('\n❌ FAILED — see the step logs above. If the auto-login step is the blocker,');
  console.error('   use the guaranteed fallback:  docker compose exec backend node scripts/upstox-login.js');
  console.error('   (browser login once), and paste the step logs here so the endpoint can be fixed.');
  process.exit(1);
})();
