#!/usr/bin/env node
/**
 * diagnose-email.js — why is no mail going out?
 *
 * emailService picks a transport at boot and then fails quietly: a rejected
 * send is logged and swallowed so a broken mailer can never break a signup or
 * an order. Good for uptime, bad for finding out that nothing has been
 * delivered for weeks. This asks Brevo directly and prints what it says.
 *
 *   docker compose exec backend node scripts/diagnose-email.js you@example.com
 *
 * The recipient is optional — without one it validates the key and sender and
 * stops short of actually sending.
 *
 * NEVER prints the API key. Only whether it is set, and its length.
 */
require('dotenv').config();

const BREVO = 'https://api.brevo.com/v3';
const ms = (n) => `${n.toFixed(0)} ms`;

const post = async (url, opts = {}, timeoutMs = 10000) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const started = process.hrtime.bigint();
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    const took = Number(process.hrtime.bigint() - started) / 1e6;
    const body = await res.text().catch(() => '');
    return { status: res.status, ok: res.ok, body, took };
  } finally { clearTimeout(t); }
};

// Copied from emailService.parseFrom so this reports the sender the service
// would ACTUALLY use — including its 'Frexever' default name — rather than a
// near-copy that could disagree about the very field being diagnosed.
const parseFrom = (raw) => {
  const s = String(raw || '').trim();
  const m = s.match(/^\s*"?([^"<]*)"?\s*<\s*([^>]+)\s*>\s*$/);
  if (m) return { name: (m[1] || '').trim() || 'Frexever', email: m[2].trim() };
  return { name: 'Frexever', email: s };
};

(async () => {
  const to = process.argv[2] || null;
  const key = process.env.BREVO_API_KEY;

  console.log('Transport');
  console.log('  BREVO_API_KEY         :', key ? `set (${key.length} chars)` : 'NOT set');
  console.log('  SMTP_HOST             :', process.env.SMTP_HOST || '(unset)');
  const mode = key ? 'brevo' : (process.env.SMTP_HOST ? 'smtp' : 'console');
  console.log('  resolved mode         :', mode);
  if (mode === 'console') {
    console.log('\n  Nothing is configured, so emailService is in CONSOLE mode — it prints');
    console.log('  messages to the log and sends nothing. That alone explains no delivery.');
    return;
  }
  if (mode !== 'brevo') {
    console.log('\n  SMTP mode — this script only diagnoses the Brevo API path.');
    return;
  }

  const parsed = parseFrom(process.env.EMAIL_FROM);
  const sender = {
    name: process.env.BREVO_SENDER_NAME || parsed.name,
    email: process.env.BREVO_SENDER_EMAIL || parsed.email,
  };
  console.log('  EMAIL_FROM            :', process.env.EMAIL_FROM || '(unset)');
  console.log('  sender it will use    :', JSON.stringify(sender));
  if (!sender.email) {
    console.log('  PROBLEM               : no sender email resolved — Brevo rejects every send.');
  }

  // ── 1. Is the key valid, and is this IP allowed to use it? ───────────
  // /v3/account is the cheapest authenticated call. It separates "bad key"
  // from "key fine, but Brevo is blocking this server's IP" — the latter is a
  // security setting people switch on and forget, and it fails EVERY request.
  console.log('\nKey check — GET /v3/account');
  let acct;
  try {
    acct = await post(`${BREVO}/account`, { headers: { 'api-key': key, accept: 'application/json' } });
  } catch (e) {
    console.log('  request failed        :', e.message);
    console.log('  => the server cannot reach api.brevo.com at all (egress/DNS/firewall).');
    return;
  }
  console.log('  HTTP', acct.status, 'in', ms(acct.took));

  if (acct.ok) {
    try {
      const j = JSON.parse(acct.body);
      console.log('  account               :', j.email || '(unknown)', j.companyName ? `· ${j.companyName}` : '');
      const credits = j.plan && j.plan.find((p) => p.credits != null);
      if (credits) console.log('  credits left          :', credits.credits, `(${credits.type || ''})`);
      if (credits && Number(credits.credits) <= 0) {
        console.log('  PROBLEM               : NO CREDITS. Brevo accepts the key and refuses to send.');
      }
    } catch (_) { /* shape varies by plan */ }
  } else {
    console.log('  body                  :', acct.body.slice(0, 400));
    const b = acct.body.toLowerCase();
    if (b.includes('ip') && (b.includes('whitelist') || b.includes('authorised') || b.includes('authorized'))) {
      console.log('\n  >>> THIS IS THE CAUSE. Brevo is blocking this server\'s IP address.');
      console.log('      Brevo has an "Authorised IPs" security setting. With it on, every');
      console.log('      API call from an unlisted IP is rejected — which is what happens');
      console.log('      after moving to a new server, because the new IP was never added.');
      console.log('      Fix: Brevo dashboard -> Security -> Authorised IPs -> add this');
      console.log('      server\'s public IPv4 (curl -4 ifconfig.me), or disable the setting.');
    } else if (acct.status === 401) {
      console.log('\n  >>> The key itself is rejected. Re-copy it from Brevo (watch for a');
      console.log('      truncated paste or surrounding quotes in .env).');
    }
    return;
  }

  // ── 2. Actually send one ─────────────────────────────────────────────
  if (!to) {
    console.log('\nKey and sender look usable. Pass a recipient to send a real test:');
    console.log('  docker compose exec backend node scripts/diagnose-email.js you@example.com');
    return;
  }

  console.log(`\nSend test — POST /v3/smtp/email -> ${to}`);
  const send = await post(`${BREVO}/smtp/email`, {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender,
      to: [{ email: to }],
      subject: 'Frexever email test',
      htmlContent: '<p>If you are reading this, the Brevo transport works.</p>',
      textContent: 'If you are reading this, the Brevo transport works.',
    }),
  });
  console.log('  HTTP', send.status, 'in', ms(send.took));
  console.log('  body                  :', send.body.slice(0, 400));

  if (send.ok) {
    console.log('\n  Accepted by Brevo. If it does not arrive, it is delivery rather than');
    console.log('  transport — check spam, and Brevo\'s Transactional -> Logs for a bounce.');
  } else {
    const b = send.body.toLowerCase();
    if (b.includes('sender') && (b.includes('not valid') || b.includes('not exist') || b.includes('verif'))) {
      console.log('\n  >>> The SENDER is not verified in Brevo. A from-address must be added and');
      console.log('      confirmed under Senders, Domains & Dedicated IPs -> Senders before');
      console.log('      Brevo will send as it. A free gmail.com address can be used, but only');
      console.log('      after clicking the confirmation link Brevo emails to it.');
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
