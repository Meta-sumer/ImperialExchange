/**
 * API + WebSocket base URLs.
 *
 * DEFAULT = the LIVE production backend (trading.metawebdevelopment.cloud).
 * This works from ANY network — mobile data or Wi-Fi — and uses your real
 * accounts. This is what you want for normal use on a phone.
 *
 * For LOCAL dev against a backend running on your PC instead, comment the two
 * production lines below and uncomment the local ones — the phone must be on
 * the SAME Wi-Fi, and replace the IP with your PC's LAN IP (`ipconfig`).
 *   • Physical device (Expo Go): http://<YOUR-PC-LAN-IP>:5000/api
 *   • Android emulator:          http://10.0.2.2:5000/api
 */

// ── Production (live) — default ──
export const API_BASE_URL = 'https://trading.metawebdevelopment.cloud/api';
export const WS_BASE_URL = 'wss://trading.metawebdevelopment.cloud';

// ── Local dev (comment the two lines above, uncomment these) ──
// export const API_BASE_URL = 'http://10.175.67.103:5000/api';
// export const WS_BASE_URL = 'ws://10.175.67.103:5000';
