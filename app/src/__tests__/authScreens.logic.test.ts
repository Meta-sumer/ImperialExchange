/**
 * The signed-out screens' pure halves, pinned against EquityHub's web:
 * client/src/utils/validation.js, Login.jsx (email + password, nothing
 * else), Register.jsx's meter and payload, ForgotPassword.jsx's rules and
 * OTP boxes, AuthShell.jsx's chart, and Landing.jsx's copy and live
 * figures. EquityHub has no broker sign-in (no OAuthCallback page, no
 * /oauth/callback route) — nothing of it is ported.
 *
 * No React, no network.
 */
import fs from 'fs';
import path from 'path';

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  CANDLE_COUNT,
  GRID,
  advanceCandles,
  candleWidth,
  chartGeometry,
  gridLinesX,
  nextCandle,
  seedCandles,
  shiftsAt,
} from '@/screens/auth/logic/candles';
import { COUNTRY_OPTIONS } from '@/screens/auth/logic/countries';
import { serverMessage } from '@/screens/auth/logic/errors';
import {
  applyOtpBackspace,
  applyOtpText,
  emptyOtp,
  isOtpComplete,
  otpValue,
} from '@/screens/auth/logic/otp';
import { PASSWORD_RULES, passwordRulesPass, passwordStrength } from '@/screens/auth/logic/password';
import {
  PENDING_REF_KEY,
  clearPendingRef,
  loadPendingRef,
  normaliseRef,
  savePendingRef,
} from '@/screens/auth/logic/referral';
import {
  buildRegisterPayload,
  registerServerFieldMessage,
  registerSuccessMessage,
  sanitize,
  v,
  validateLogin,
  validateRegister,
  validateRegisterField,
  type RegisterForm,
} from '@/screens/auth/logic/validation';
import {
  BADGES,
  BENEFITS,
  BUILT,
  FEATURES,
  LIVE_MS,
  MARKETS,
  NAV,
  PLATFORM_POINTS,
  SECURITY,
  STEPS,
  STEP_STYLES,
  TERMINAL_POSITIONS,
  TESTIMONIALS,
  TICKER,
  WHY,
  marketChange,
  marketChanges,
  signedPct,
  tickerRows,
} from '@/screens/landing/landingData';
import type { Instrument } from '@/types/trading';

const ROOT = path.join(__dirname, '../../..');
const webSrc = (p: string): string => fs.readFileSync(path.join(ROOT, 'client/src', p), 'utf8').replace(/\r\n/g, '\n');
const appSrc = (p: string): string => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));

/** A deterministic RNG cycling through fixed values. */
const cycle = (...values: number[]) => {
  let i = 0;
  return () => {
    const x = values[i % values.length] ?? 0;
    i += 1;
    return x;
  };
};

describe('validators — validation.js, message for message', () => {
  it('email', () => {
    expect(v.email('')).toBe('Email is required');
    expect(v.email('   ')).toBe('Email is required');
    expect(v.email(`${'a'.repeat(250)}@x.com`)).toBe('Email is too long');
    expect(v.email('trader@local')).toBe('Enter a valid email address');
    expect(v.email('trader@tradingplatform.local')).toBeNull();
  });

  it('password, lenient (login) and strict (register)', () => {
    expect(v.password('')).toBe('Password is required');
    expect(v.password('short')).toBe('At least 8 characters');
    expect(v.password('x'.repeat(129))).toBe('Password is too long');
    expect(v.password('alllowercase')).toBeNull();
    expect(v.password('alllowercase', { strict: true })).toBe('Mix letters, numbers, and a symbol');
    expect(v.password('lower123', { strict: true })).toBe('Mix letters, numbers, and a symbol');
    expect(v.password('Lower123', { strict: true })).toBeNull();
    expect(v.password('lower12!', { strict: true })).toBeNull();
  });

  it('names: letters in any script, hyphens and apostrophes; last name optional', () => {
    expect(v.firstName('')).toBe('First name is required');
    expect(v.firstName('John123')).toBe('Letters, hyphens, and apostrophes only');
    expect(v.firstName("O'Brien-Smith")).toBeNull();
    expect(v.firstName('Zoë')).toBeNull();
    expect(v.firstName('Анна')).toBeNull();
    // Parity, not a choice: \p{L} excludes combining marks, so the web also
    // refuses a Devanagari name written with vowel signs.
    expect(v.firstName('राहुल')).toBe('Letters, hyphens, and apostrophes only');
    expect(v.firstName('-John')).toBe('Letters, hyphens, and apostrophes only');
    expect(v.lastName('')).toBeNull();
    expect(v.lastName('Sm1th')).toBe('Letters, hyphens, and apostrophes only');
  });

  it('phone optional, 7–15 digits with an optional +', () => {
    expect(v.phone('')).toBeNull();
    expect(v.phone('+919876543210')).toBeNull();
    expect(v.phone('123456')).toBe('Enter 7–15 digits (optional + prefix)');
    expect(v.phone('1234567890123456')).toBe('Enter 7–15 digits (optional + prefix)');
  });

  it('country must be an ISO-2 code', () => {
    expect(v.country('')).toBe('Pick a country');
    expect(v.country('india')).toBe('Invalid country code');
    expect(v.country('IN')).toBeNull();
  });

  it('referral code optional, 6–16 alphanumerics', () => {
    expect(v.referralCode('')).toBeNull();
    expect(v.referralCode('abc12345')).toBeNull();
    expect(v.referralCode('ABC12')).toBe('Letters and digits only (6–16 chars)');
  });

  it('no second-factor validators: no EquityHub page asks for a code', () => {
    // validation.js still carries totp / backupCode, but nothing calls them.
    const pages = ['pages/Login.jsx', 'pages/Register.jsx', 'pages/ForgotPassword.jsx', 'pages/Profile.jsx'].map(webSrc).join('\n');
    expect(pages).not.toMatch(/v\.totp|v\.backupCode|sanitize\.totp|sanitize\.backupCode/);
    expect(v).not.toHaveProperty('totp');
    expect(sanitize).not.toHaveProperty('backupCode');
  });

  it('passwordConfirm', () => {
    expect(v.passwordConfirm('', 'x')).toBe('Confirm your password');
    expect(v.passwordConfirm('y', 'x')).toBe('Passwords do not match');
    expect(v.passwordConfirm('x', 'x')).toBeNull();
  });
});

describe('sanitisers — the value on screen is the value sent', () => {
  it('email: no whitespace, lower-case', () => {
    expect(sanitize.email(' Trader @Example.COM ')).toBe('trader@example.com');
  });

  it('phone: digits and one LEADING +', () => {
    expect(sanitize.phone('+91 98765-43210')).toBe('+919876543210');
    expect(sanitize.phone('91+98+76')).toBe('919876');
    expect(sanitize.phone('++91')).toBe('+91');
    expect(sanitize.phone('1234567890123456789')).toBe('123456789012345');
  });

  it('name: strips digits and symbols, keeps letters of any script', () => {
    expect(sanitize.name('Jo3hn!')).toBe('John');
    expect(sanitize.name("D'Souza-Nair")).toBe("D'Souza-Nair");
    expect(sanitize.name('Zoë')).toBe('Zoë');
    expect(sanitize.name('x'.repeat(60))).toHaveLength(50);
  });

  it('referral: upper-case alphanumerics, 16 max', () => {
    expect(sanitize.referralCode('ab-c 12_345')).toBe('ABC12345');
    expect(sanitize.referralCode('a'.repeat(20))).toHaveLength(16);
  });

});

describe('Login — EquityHub Login.jsx', () => {
  const LOGIN = webSrc('pages/Login.jsx');
  const base = { email: 'a@b.co', password: 'password1' };

  it('validates email and password, and nothing else', () => {
    expect(LOGIN).toContain('email:    v.email(email),');
    expect(LOGIN).toContain('password: v.password(password),');
    expect(validateLogin(base)).toEqual({});
  });

  it('signs in with email and password only — no code, no broker buttons, no demo hint', () => {
    expect(LOGIN).toContain('await login(email.trim().toLowerCase(), password);');
    expect(LOGIN).not.toMatch(/twoFactor|2FA|BrokerLoginButtons|broker_error|Demo:/);
    expect(webSrc('store/auth.js')).not.toContain('hydrateFromTokens');
    expect(fs.existsSync(path.join(ROOT, 'client/src/pages/OAuthCallback.jsx'))).toBe(false);
    const screen = appSrc('screens/auth/LoginScreen.tsx');
    expect(screen).not.toMatch(/twoFactor|show2FA|BrokerLogin|OAuthCallback|brokerError|Demo:/);
    expect(LOGIN).toContain('placeholder="you@example.com"');
    expect(screen).toContain('placeholder="you@example.com"');
  });

  it('shows the stacked EquityHub lockup on every auth page (BrandMark)', () => {
    // The web draws one 6:5 badge at 120 / 100 px; the app keeps its stacked lockup at 136 / 112.
    expect(webSrc('components/BrandMark.jsx')).toContain('<BrandLogo size={size === \'lg\' ? 120 : 100}');
    const shell = appSrc('screens/auth/AuthShell.tsx');
    expect(shell).toContain('<BrandLogo variant="stacked" height={size === \'lg\' ? 136 : 112}');
    for (const page of ['Login', 'Register', 'ForgotPassword', 'ResetPassword']) {
      expect(webSrc(`pages/${page}.jsx`)).toContain('<BrandMark />');
      expect(appSrc(`screens/auth/${page}Screen.tsx`)).toContain('<BrandMark />');
    }
    expect(webSrc('pages/VerifyEmail.jsx')).toContain('<BrandMark wordmark={false} />');
    expect(appSrc('screens/auth/VerifyEmailScreen.tsx')).toContain('<BrandMark wordmark={false} />');
  });

  it('reports every failing field at once', () => {
    expect(validateLogin({ ...base, email: '', password: '' })).toEqual({
      email: 'Email is required',
      password: 'Password is required',
    });
  });
});

describe('Register', () => {
  const good: RegisterForm = {
    email: ' Trader@Example.com ',
    password: 'Secret123',
    firstName: ' Asha ',
    lastName: '',
    phone: '',
    country: 'in',
    referralCode: 'abc12345',
  };

  it('validates with the STRICT password rule', () => {
    expect(validateRegisterField('password', 'secretpass')).toBe('Mix letters, numbers, and a symbol');
    expect(validateRegister({ ...good, country: 'IN' })).toEqual({});
    expect(validateRegister({ ...good, country: '', firstName: '' })).toEqual({
      country: 'Pick a country',
      firstName: 'First name is required',
    });
  });

  it('builds the payload the web sends: trimmed, cased, empty optionals as ""', () => {
    expect(buildRegisterPayload(good)).toEqual({
      email: 'trader@example.com',
      password: 'Secret123',
      firstName: 'Asha',
      lastName: '',
      phone: '',
      country: 'IN',
      referralCode: 'ABC12345',
    });
    expect(buildRegisterPayload({ ...good, referralCode: '' }).referralCode).toBe('');
  });

  it('says whether the referral went with the sign-up', () => {
    expect(registerSuccessMessage('ABC12345')).toBe('Account created · referral ABC12345 applied');
    expect(registerSuccessMessage('')).toBe('Account created! A demo account has been added.');
    const reg = webSrc('pages/Register.jsx');
    // The web still says "$10,000" here (the INR switch has not reached its copy yet); the app's message carries no figure.
    expect(reg).toContain("toast.success('Account created! A demo account with $10,000 has been added.');");
    expect(reg).toContain('toast.success(`Account created · referral ${payload.referralCode} applied`);');
  });

  it('puts a server refusal under its field, in the web’s words', () => {
    expect(registerServerFieldMessage('email', 'x')).toBe('This email is already registered');
    expect(registerServerFieldMessage('phone', 'x')).toBe('This phone is already registered with another account');
    expect(registerServerFieldMessage('referralCode', 'Referral code not found')).toBe('Referral code not found');
  });

  it('offers the web’s country list, India first', () => {
    expect(COUNTRY_OPTIONS).toHaveLength(41);
    expect(COUNTRY_OPTIONS[0]).toEqual({ code: 'IN', name: 'India' });
    expect(COUNTRY_OPTIONS.every((c) => v.country(c.code) === null)).toBe(true);
    expect(new Set(COUNTRY_OPTIONS.map((c) => c.code)).size).toBe(COUNTRY_OPTIONS.length);
  });
});

describe('password strength — two meters, as on the web', () => {
  it('ForgotPassword: every rule must pass', () => {
    expect(PASSWORD_RULES.map((r) => r.label)).toEqual([
      'At least 8 characters',
      'One uppercase letter',
      'One lowercase letter',
      'One number',
      'One special character',
    ]);
    expect(passwordRulesPass('Secret123')).toBe(false);
    expect(passwordRulesPass('Secret12!')).toBe(true);
  });

  it('Register: the four-bar score and its caption', () => {
    expect(passwordStrength('')).toMatchObject({ score: 0, caption: 'Min 8 characters · mix letters, numbers, symbols' });
    expect(passwordStrength('abc')).toMatchObject({ score: 0, caption: 'Too short', tone: 'bear' });
    expect(passwordStrength('abcdefgh')).toMatchObject({ score: 1, caption: 'Weak', tone: 'orange500' });
    expect(passwordStrength('Abcdefgh')).toMatchObject({ score: 2, caption: 'Fair', tone: 'amber400' });
    expect(passwordStrength('Abcdefg1')).toMatchObject({ score: 3, caption: 'Strong', tone: 'lime500' });
    expect(passwordStrength('Abcdefgh123!')).toMatchObject({ score: 4, caption: 'Excellent', tone: 'bull', filled: 4 });
  });
});

describe('OTP boxes', () => {
  it('a typed digit fills the box and moves right', () => {
    const r = applyOtpText(emptyOtp(), 0, '4');
    expect(r.next).toEqual(['4', '', '', '', '', '']);
    expect(r.focus).toBe(1);
  });

  it('non-digits are ignored', () => {
    expect(applyOtpText(emptyOtp(), 2, 'a').next).toEqual(emptyOtp());
  });

  it('typing over a filled box replaces it, whichever side the caret was on', () => {
    const d = ['1', '2', '', '', '', ''];
    expect(applyOtpText(d, 1, '27').next[1]).toBe('7');
    expect(applyOtpText(d, 1, '72').next[1]).toBe('7');
    expect(applyOtpText(d, 1, '22').next[1]).toBe('2');
  });

  it('a paste or the OS code fill spreads from the first box', () => {
    const r = applyOtpText(['9', '', '', '', '', ''], 3, '12 34 56');
    expect(r.next).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(isOtpComplete(r.next)).toBe(true);
    expect(otpValue(r.next)).toBe('123456');
    expect(r.focus).toBe(5);

    const part = applyOtpText(emptyOtp(), 0, '123');
    expect(part.next).toEqual(['1', '2', '3', '', '', '']);
    expect(part.focus).toBe(3);
  });

  it('clearing a box empties it and stays', () => {
    const r = applyOtpText(['1', '2', '3', '', '', ''], 2, '');
    expect(r.next).toEqual(['1', '2', '', '', '', '']);
    expect(r.focus).toBe(2);
  });

  it('backspace on an empty box clears the previous one and steps back', () => {
    expect(applyOtpBackspace(['1', '2', '', '', '', ''], 2)).toEqual({ next: ['1', '', '', '', '', ''], focus: 1 });
    expect(applyOtpBackspace(['1', '2', '', '', '', ''], 1)).toBeNull(); // not empty: the text change handles it
    expect(applyOtpBackspace(emptyOtp(), 0)).toBeNull();
  });
});

describe('the auth background chart', () => {
  it('walks as AuthShell.jsx genCandle does, floored at 20', () => {
    const c = nextCandle(100, cycle(0.48, 0.5, 0.5));
    expect(c).toEqual({ open: 100, close: 100, high: 101.5, low: 98.5 });
    expect(nextCandle(20, cycle(0, 0, 0)).close).toBe(20);
  });

  it('seeds 70 candles, each opening at the last close, and advances by dropping from the left', () => {
    const s = seedCandles(CANDLE_COUNT, cycle(0.1, 0.9, 0.3, 0.7));
    expect(s).toHaveLength(70);
    for (let i = 1; i < s.length; i += 1) expect(s[i]?.open).toBe(s[i - 1]?.close);
    const a = advanceCandles(s, 3, cycle(0.5));
    expect(a).toHaveLength(70);
    expect(a[0]).toBe(s[3]);
    expect(a[67]?.open).toBe(s[69]?.close);
  });

  it('candle width is width/46, never under 9', () => {
    expect(candleWidth(200)).toBe(9);
    expect(candleWidth(920)).toBe(20);
  });

  it('fits every candle into the middle 80% and draws only what can be seen', () => {
    const s = seedCandles(CANDLE_COUNT, cycle(0.2, 0.8, 0.6, 0.1));
    const g = chartGeometry(s, 414, 800, 6);
    expect(g.shapes.length).toBe(Math.ceil(414 / 9) + 6);
    for (const c of g.shapes) {
      expect(c.wickTop).toBeGreaterThanOrEqual(80 - 1e-9);
      expect(c.wickBottom).toBeLessThanOrEqual(720 + 1e-9);
      expect(c.bodyHeight).toBeGreaterThanOrEqual(1.5);
      expect(c.wickTop).toBeLessThanOrEqual(c.bodyTop);
    }
    expect(g.closeLine.split(' ')).toHaveLength(g.shapes.length);
    expect(chartGeometry([], 414, 800).shapes).toEqual([]);
  });

  it('grid lines sit on absolute multiples of the pitch, so they scroll without jumping', () => {
    for (const shifted of [0, 9, 47, 48, 100, 1000]) {
      for (const x of gridLinesX(shifted, 400)) expect((x + shifted) % GRID).toBe(0);
    }
  });

  it('counts whole candles scrolled past', () => {
    expect(shiftsAt(0, 9)).toBe(0);
    expect(shiftsAt(-8.9, 9)).toBe(0);
    expect(shiftsAt(-9, 9)).toBe(1);
    expect(shiftsAt(-100, 9)).toBe(11);
  });
});

describe('VerifyEmail — the server message only', () => {
  it("shows the server's message or its own — never a transport error's text", () => {
    const axiosLike = { response: { data: { error: { message: 'Token expired' } } }, message: 'Request failed with status code 400' };
    expect(serverMessage(new Error('Network Error'), 'Verification failed')).toBe('Verification failed');
    expect(serverMessage(axiosLike, 'Verification failed')).toBe('Token expired');
    expect(serverMessage(null, 'Verification failed')).toBe('Verification failed');
  });
});

/* ══ Landing — EquityHub's Indian-market page ══════════════════════════ */

describe('Landing — Landing.jsx copy, verbatim', () => {
  const LANDING = webSrc('pages/Landing.jsx');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const liftConst = <T,>(name: string, end = '\n];\n'): T => {
    const start = LANDING.indexOf(`const ${name} = [`);
    if (start < 0) throw new Error(`moved: ${name}`);
    const stop = LANDING.indexOf(end, start);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    return new Function(`return ${LANDING.slice(start + `const ${name} = `.length, stop + 2)};`)() as T;
  };

  it('the static ticker is the Indian showcase (NIFTY, BANKNIFTY, SENSEX, RELIANCE…)', () => {
    expect(TICKER).toEqual(liftConst('TICKER'));
    expect(TICKER.map((r) => r.s)).toEqual(['NIFTY 50', 'BANK NIFTY', 'SENSEX', 'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN', 'TATAMOTORS']);
    expect(LANDING).toContain('const id = setInterval(load, 10000);');
    expect(LIVE_MS).toBe(10_000);
  });

  it.each([
    ['FEATURES', FEATURES],
    ['BADGES', BADGES],
    ['BUILT', BUILT],
    ['TESTIMONIALS', TESTIMONIALS],
  ] as const)('%s is the web list', (name, list) => {
    expect(list).toEqual(liftConst(name));
  });

  // WHY and STEPS keep the app's Indian wording where the web still carries
  // global leftovers ('$0 Free to Start', '500+ Options', 'Trade 500+ markets'):
  // same shape and count, titles compared loosely.
  it.each([
    ['WHY', WHY],
    ['STEPS', STEPS],
  ] as const)('%s has the web list’s shape', (name, list) => {
    const web = liftConst<readonly Record<string, unknown>[]>(name);
    expect(list).toHaveLength(web.length);
    expect(Object.keys(list[0]!).sort()).toEqual(Object.keys(web[0]!).sort());
  });

  it('carries the Indian-market wording — Indian Market Access, Live Market Data', () => {
    expect(WHY.map((w) => w.title)).toEqual(expect.arrayContaining(['Indian Market Access', 'Live Market Data', 'Always-On Platform']));
    expect(BADGES.map((b) => b.tag)).toContain('Indian markets');
    expect(TESTIMONIALS.map((t) => t.role)).toContain('Equity Investor');
  });

  it('the step, benefit and security styling is the web one', () => {
    const steps = LANDING.slice(LANDING.indexOf('const STEP_STYLES = ['), LANDING.indexOf('\n  ];\n', LANDING.indexOf('const STEP_STYLES = [')));
    for (const st of STEP_STYLES) {
      expect(steps).toContain(`icon: '${st.icon}'`);
      expect(steps).toContain(`linear-gradient(135deg,${st.g[0]},${st.g[1]})`);
      expect(steps).toContain(`sh: '${st.sh}'`);
      expect(steps).toContain(`accent: '${st.accent}'`);
    }
    for (const b of BENEFITS) {
      expect(LANDING).toContain(`title: '${b.title}',`);
      expect(LANDING).toContain(`body: '${b.body}'`);
      expect(LANDING).toContain(`tint: '${b.tint}'`);
    }
    // The web's first tile is still "Cold Storage" (a crypto leftover); the app says "Secure Payments".
    for (const s of SECURITY.slice(1)) {
      expect(LANDING).toContain(`title: '${s.title}',`);
      expect(LANDING).toContain(`sub: '${s.sub}'`);
    }
    for (const p of PLATFORM_POINTS) expect(LANDING).toContain(`'${p}'`);
    // The web's mockup rows carry symbol, side, colour and change; the app adds the size column.
    for (const r of TERMINAL_POSITIONS) expect(LANDING).toContain(`['${r[0]}', '${r[1]}', '${r[2]}', '${r[3]}']`);
    const header = webSrc('components/LandingHeader.jsx');
    for (const [label, id] of NAV) expect(header).toContain(`['${label}', '/#${id}']`);
  });

  it('every headline and line of copy on the page is in the app, and the brand is Imperial Exchange throughout', () => {
    const screen = [appSrc('screens/landing/LandingScreen.tsx'), appSrc('screens/landing/landingData.ts')].join('\n');
    for (const s of [
      '● Secure &amp; safe · NSE &amp; BSE markets · Low fees on trades',
      'Your gateway to NSE and BSE stocks and indices at ultra-low commissions.',
      'NIFTY 50',
      'NSE benchmark index',
      '+₹12,840.00',
      '10 × RELIANCE · market',
      'Why Choose Imperial Exchange?',
      'Everything a Trader Needs',
      'Built for Every Trader',
      'Professional Trading ',
      'Imperial Exchange Terminal',
      'Your Assets.',
      'How It Works',
      'Loved by thousands of traders',
      'Why Traders Love Imperial Exchange',
      'Join thousands of traders who trust Imperial Exchange every day.',
      'Ready To Start Your Trading Journey?',
      'Trade. Invest. Grow. Imperial Exchange.',
      'Start trading free →',
      'Explore Platform →',
    ]) {
      expect({ s, web: LANDING.includes(s) }).toEqual({ s, web: true });
      expect({ s, app: screen.includes(s) }).toEqual({ s, app: true });
    }
    // The web's gradient words, drawn letter by letter here.
    for (const w of ['Invest.', 'Indian Markets', 'Always Secure', 'Platform']) {
      expect(LANDING).toContain(`>${w}</span>`);
      expect(screen).toContain(`text="${w}"`);
    }
    expect(screen).not.toMatch(/Advance AI Trader|BTC|Crypto|Forex|Always Open|Every Market/);
  });
});

describe('Landing — the live figures', () => {
  const LANDING = webSrc('pages/Landing.jsx');
  const row = (x: Partial<Instrument> & { symbol?: string }): Instrument =>
    ({ symbol: 'X', category: 'STOCK', lastPrice: '100', change24h: 1, pricePrecision: 2, ...x }) as Instrument;

  // The web's MARKETS (name, desc, static %) and its MARKET_CATEGORY map, lifted.
  // The web averages one instrument category per card; the app's `match`
  // mirrors that: STOCK → spot stocks, INDEX → spot indices, COMMODITY → MCX.
  const webMarkets = (() => {
    const slice = (name: string, close: string): string => {
      const start = LANDING.indexOf(`const ${name} = `);
      if (start < 0) throw new Error(`moved: ${name}`);
      const stop = LANDING.indexOf(close, start);
      return LANDING.slice(start, stop + close.length);
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const { MARKETS: cards, MARKET_CATEGORY: cat } = new Function(`${slice('MARKETS', '\n];')}\n${slice('MARKET_CATEGORY', '\n};')}\nreturn { MARKETS, MARKET_CATEGORY };`)() as {
      MARKETS: Array<{ name: string; desc: string; c: number }>; MARKET_CATEGORY: Record<string, string>;
    };
    const segOf = (x: Instrument): string => String(x.segment || '').toUpperCase();
    const catOf = (x: Instrument): string => String(x.category || '').toUpperCase();
    const spot = (x: Instrument): boolean => segOf(x) !== 'FUT' && segOf(x) !== 'OPT';
    const byCat: Record<string, (x: Instrument) => boolean> = {
      STOCK: (x) => catOf(x) === 'STOCK' && spot(x),
      INDEX: (x) => catOf(x) === 'INDEX' && spot(x),
      COMMODITY: (x) => String(x.exchange || '').toUpperCase() === 'MCX' || catOf(x) === 'COMMODITY',
    };
    return cards.map((m) => ({ ...m, match: byCat[cat[m.name] ?? ''] ?? (() => false) }));
  })();

  it('the six Indian market cards, in order, with their static fallback', () => {
    expect(MARKETS.map(({ name, desc, c }) => ({ name, desc, c }))).toEqual(webMarkets.map(({ name, desc, c }) => ({ name, desc, c })));
    expect(MARKETS.map((m) => m.name)).toEqual(['Stocks', 'Indices', 'Commodities', 'Large Caps', 'Banking', 'IT & Tech']);
  });

  const feed: Instrument[] = [
    row({ symbol: 'RELIANCE', category: 'STOCK', segment: 'EQ', exchange: 'NSE', change24h: 1.2 }),
    row({ symbol: 'TCS', category: 'STOCK', exchange: 'BSE', change24h: -0.4 }),
    row({ symbol: 'RELIANCE-FUT', category: 'STOCK', segment: 'FUT', exchange: 'NFO', change24h: 2 }),
    row({ symbol: 'RELIANCE-OPT', category: 'STOCK', segment: 'OPT', exchange: 'NFO', change24h: 9 }),
    row({ symbol: 'NIFTY', category: 'INDEX', exchange: 'NSE', change24h: 0.5 }),
    row({ symbol: 'BANKNIFTY', category: 'INDEX', exchange: 'NSE', change24h: null }),
    row({ symbol: 'CRUDEOIL', category: 'COMMODITY', exchange: 'MCX', change24h: -1 }),
    row({ symbol: 'GOLDM', category: 'FUTURE' as Instrument['category'], exchange: 'mcx', change24h: 0.6 }),
  ];

  it("each card's match picks what the web's picks", () => {
    for (const m of MARKETS) {
      const w = webMarkets.find((x) => x.name === m.name);
      for (const x of feed) expect({ card: m.name, sym: x.symbol, hit: m.match(x) }).toEqual({ card: m.name, sym: x.symbol, hit: !!w?.match(x as Instrument) });
    }
  });

  it('averages the live 24h change per card; a row without a baseline is skipped, not a zero', () => {
    const chg = marketChanges(feed);
    expect(chg.Stocks).toBeCloseTo(0.4);
    expect(chg.Indices).toBeCloseTo(0.5);
    expect(chg['Large Caps']).toBeCloseTo(0.4);
    expect(chg.Commodities).toBeCloseTo(-0.2);
    // A card with no live rows keeps its static fallback.
    expect(marketChange({ name: 'Stocks', c: 0.62 }, {})).toBe(0.62);
    expect(marketChange({ name: 'Stocks', c: 0.62 }, chg)).toBeCloseTo(0.4);
    expect(signedPct(0.4)).toBe('+0.40%');
    expect(signedPct(-0.2)).toBe('-0.20%');
  });

  it('the ticker: priced rows only, the first 14, at the instrument precision (capped at 5)', () => {
    const many = Array.from({ length: 20 }, (_, i) => row({ symbol: `S${i}`, lastPrice: String(1000 + i), change24h: i % 2 ? -0.5 : null }));
    const rows = tickerRows([row({ symbol: 'ZERO', lastPrice: '0' }), ...many]);
    expect(rows).toHaveLength(14);
    expect(rows[0]).toEqual({ s: 'S0', p: '1,000.00', c: 0 });
    expect(rows[1]).toEqual({ s: 'S1', p: '1,001.00', c: -0.5 });
    expect(tickerRows([row({ symbol: 'P', lastPrice: '1.234567', pricePrecision: 8 })])[0]?.p).toBe('1.23457');
    // Indian grouping, as the web's fmtNum (en-IN).
    expect(tickerRows([row({ symbol: 'G', lastPrice: '121850' })])[0]?.p).toBe('1,21,850.00');
  });
});

describe('pending referral — Register.jsx localStorage, in AsyncStorage', () => {
  beforeEach(async () => { await AsyncStorage.clear(); });

  it('normalises the link’s code', () => {
    expect(normaliseRef('  abc12345 ')).toBe('ABC12345');
    expect(normaliseRef(undefined)).toBe('');
  });

  it('remembers a code under the web’s key until sign-up clears it', async () => {
    expect(await loadPendingRef()).toBe('');
    await savePendingRef('ABC12345');
    expect(await AsyncStorage.getItem(PENDING_REF_KEY)).toBe('ABC12345');
    expect(await loadPendingRef()).toBe('ABC12345');
    await clearPendingRef();
    expect(await loadPendingRef()).toBe('');
  });

  it('never stores an empty code', async () => {
    await savePendingRef('');
    expect(await AsyncStorage.getItem(PENDING_REF_KEY)).toBeNull();
  });
});
