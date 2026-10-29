/**
 * Transfer Funds — the rules checked against the WEB'S OWN SOURCE.
 *
 * Each block lifts a slice of EquityHub's client/src/pages/Wallet.jsx (TransferView and
 * TransferToUserPanel), runs it with `new Function`, and runs
 * utils/transferLogic on the same inputs. If either side changes, this
 * fails — a parity claim nobody re-checks stops being true quietly.
 *
 * Where the port deliberately differs, the test pins the difference instead
 * of hiding it (see the header of utils/transferLogic.ts for the why).
 */
import fs from 'fs';
import path from 'path';

import {
  BONUS_OPTION,
  DEMO_TRANSFER_NOTE,
  PEER_NOTE_MAX,
  PEER_NO_LIVE_NOTE,
  PEER_SEARCH_DEBOUNCE_MS,
  PEER_SEARCH_LIMIT,
  PEER_SEARCH_MIN_CHARS,
  TRANSFER_CURRENCIES,
  canReviewPeer,
  bonusWalletShortcut,
  checkSelfTransfer,
  demoAccounts,
  freeCurrency,
  freeLabel,
  initialPeerSource,
  initialSelfPair,
  isPracticeSource,
  isUserWallet,
  liveAccounts,
  loadableAvatar,
  peerAmountErrors,
  peerConfirmNote,
  peerCurrencies,
  peerFeeCaveat,
  peerFromOptions,
  peerLimitsHint,
  peerQuote,
  peerSentMessage,
  peerSettingsAfter,
  peerTransferPayload,
  recipientInitials,
  recipientSubline,
  reseedPeerSource,
  reseedSelfPair,
  sanitizeAmount,
  searchPhase,
  selfFromOptions,
  selfSubmitRefusal,
  selfToOptions,
  selfTransferPayload,
  showBonusShortcut,
  snapshotMissing,
  sourceFree,
  accountsGate,
} from '@/utils/transferLogic';
import { fmtMoney } from '@/utils/money';

const ROOT = path.join(__dirname, '../../..');
/** LF only, so a CRLF checkout slices the same as this one. */
const readLf = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const WALLET = readLf(path.join(ROOT, 'client/src/pages/Wallet.jsx'));
const VIEW = readLf(path.join(__dirname, '../screens/wallet/views/TransferView.tsx'));
const LOGIC = readLf(path.join(__dirname, '../utils/transferLogic.ts'));

/** The text from `start` up to (not including) `end`, or a loud failure. */
const between = (src: string, start: string, end: string, from = 0): string => {
  const a = src.indexOf(start, from);
  if (a < 0) throw new Error(`slice start moved: ${start}`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`slice end moved: ${end}`);
  return src.slice(a, b);
};
/** Between `start` and `end`, both excluded. */
const inner = (src: string, start: string, end: string, from = 0): string =>
  between(src, start, end, from).slice(start.length);
/** `start` through the end of `end`. */
const through = (src: string, start: string, end: string, from = 0): string =>
  between(src, start, end, from) + end;

// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const lift = <T,>(params: string[], body: string): ((...args: unknown[]) => T) =>
  new Function(...params, body) as (...args: unknown[]) => T;

const SELF_AT = WALLET.indexOf('function TransferView(');
const PEER_AT = WALLET.indexOf('function TransferToUserPanel(');
const AVATAR_AT = WALLET.indexOf('function RecipientAvatar(');
if (SELF_AT < 0 || PEER_AT < 0 || AVATAR_AT < 0) throw new Error('Wallet.jsx transfer components moved');

/* ── Fixtures: web-shaped (`_id`) and app-shaped (`id`) twins ─────────── */

const WEB_ACCOUNTS = [
  { _id: 'a1', accountNumber: '100234', accountType: 'STANDARD', nickname: '' },
  { _id: 'a2', accountNumber: '100777', accountType: 'PRO', nickname: 'Swing' },
  { _id: 'd1', accountNumber: '900001', accountType: 'DEMO', nickname: 'Practice' },
  { _id: 'v1', accountNumber: '900002', accountType: 'VIRTUAL', nickname: null },
  { _id: 'a3', accountNumber: '100999', accountType: 'REAL', nickname: null },
];
const APP_ACCOUNTS = WEB_ACCOUNTS.map(({ _id, nickname, ...rest }) => ({ id: _id, nickname: nickname || null, ...rest }));
const webLive = WEB_ACCOUNTS.filter((a) => a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL');
const webDemo = WEB_ACCOUNTS.filter((a) => a.accountType === 'DEMO' || a.accountType === 'VIRTUAL');
const appLive = liveAccounts(APP_ACCOUNTS);
const appDemo = demoAccounts(APP_ACCOUNTS);

const BALANCES = [
  { accountId: 'a1', currency: 'INR', free: '10000' },
  { accountId: 'a2', currency: 'INR', free: '2050.5' },
  { accountId: 'a3', currency: 'INR', free: '0' },
];
const BONUS = { balance: '1000' };

/** Wallet.jsx's module-level Bonus option and practice predicate. */
const webBonusOpt = lift<{ _id: string; nickname: string; accountType: string }>(
  [], `${through(WALLET, 'const BONUS_TRANSFER_OPT = ', ';')} return BONUS_TRANSFER_OPT;`,
)();
const webIsPractice = lift<boolean>(['a'], `${through(WALLET, 'const isPracticeAccount = ', ';')} return isPracticeAccount(a);`);
const webFromOptions = [...webLive, webBonusOpt, ...webDemo];

/* ══ Accounts and options ═══════════════════════════════════════════════ */

describe('who can be on either side', () => {
  it('practice and live accounts split exactly as the web splits them', () => {
    for (const t of ['STANDARD', 'PRO', 'FREE', 'STANDARD_IC', 'REAL', 'DEMO', 'VIRTUAL', 'CUSTOM']) {
      expect({ t, demo: demoAccounts([{ accountType: t }]).length === 1 }).toEqual({ t, demo: webIsPractice({ accountType: t }) });
      expect({ t, live: liveAccounts([{ accountType: t }]).length === 1 }).toEqual({ t, live: !webIsPractice({ accountType: t }) });
    }
    expect(appLive.map((a) => a.id)).toEqual(webLive.map((a) => a._id));
    expect(appDemo.map((a) => a.id)).toEqual(webDemo.map((a) => a._id));
  });

  it('From lists the live accounts, the Main Wallet, then the demo accounts, with the web labels — no Main Wallet', () => {
    const labelExpr = inner(WALLET, '<option key={a._id} value={a._id}>', '</option>', SELF_AT).trim().replace(/^\{/, '').replace(/\}$/, '');
    const webLabel = lift<string>(['a'], `return (${labelExpr});`);
    const opts = selfFromOptions(appLive, appDemo);
    expect(opts.map((o) => o.value)).toEqual(webFromOptions.map((a) => a._id));
    expect(opts.map((o) => o.label)).toEqual(webFromOptions.map((a) => webLabel(a)));
    expect(BONUS_OPTION.label).toBe('Main Wallet · INR');
    // The confirm sentence: `fromAcc?.nickname || fromAcc?.accountNumber`.
    expect(opts.map((o) => o.name))
      .toEqual(webFromOptions.map((a) => (a as { nickname?: string | null }).nickname || (a as { accountNumber?: string }).accountNumber));
    expect(BONUS_OPTION.name).toBe(webBonusOpt.nickname);
    expect(opts.some((o) => o.value === 'subscription')).toBe(false);
    expect(WALLET.slice(SELF_AT, PEER_AT)).not.toContain("'subscription'");
  });

  it('To offers only the same side of the demo / live line, minus the source', () => {
    const at = WALLET.indexOf('const toOptions = useMemo(', SELF_AT);
    const toExpr = between(WALLET, '() => (fromPractice', ',\n', at).slice('() => '.length);
    const webTo = lift<{ _id: string }[]>(
      ['fromPractice', 'demoAccounts', 'liveAccounts', 'BONUS_TRANSFER_OPT', 'from'],
      `return ${toExpr};`,
    );
    for (const from of ['a1', 'a2', 'a3', 'bonus', 'd1', 'v1', '']) {
      const fromAcc = webFromOptions.find((a) => a._id === from);
      const w = webTo(webIsPractice(fromAcc), webDemo, webLive, webBonusOpt, from).map((a) => a._id);
      expect({ from, to: selfToOptions(appLive, appDemo, from).map((o) => o.value) }).toEqual({ from, to: w });
      expect(isPracticeSource(appDemo, from)).toBe(webIsPractice(fromAcc));
    }
    // A demo source never reaches the Bonus Wallet or a live account.
    expect(selfToOptions(appLive, appDemo, 'd1').map((o) => o.value)).toEqual(['v1']);
    expect(selfToOptions(appLive, appDemo, 'bonus').map((o) => o.value)).toEqual(['a1', 'a2', 'a3']);
    expect(WALLET.slice(SELF_AT, PEER_AT)).toContain(DEMO_TRANSFER_NOTE);
    expect(WALLET.slice(SELF_AT, PEER_AT)).toContain('<option value="">No eligible account</option>');
  });

  it('the server refuses the mixes the pickers leave out, and the retired Main Wallet', () => {
    const ctrl = readLf(path.join(ROOT, 'backend/src/controllers/walletController.js'));
    const h = between(ctrl, 'const internalTransfer = asyncHandler', '\nconst ');
    expect(between(h, 'if (isSubFrom || isSubTo) {', '}')).toContain("'MAIN_WALLET_RETIRED'");
    expect(between(h, 'if (isPractice(from) !== isPractice(to)) {', '}')).toContain("'PRACTICE_TRANSFER_NOT_ALLOWED'");
    // The Bonus Wallet takes transfers in again.
    expect(h).not.toContain('BONUS_WALLET_WITHDRAW_ONLY');
  });

  it('the peer source list is the live accounts only', () => {
    const labelExpr = inner(WALLET, '<option key={a._id} value={a._id}>', '</option>', PEER_AT).trim().replace(/^\{/, '').replace(/\}$/, '');
    const webLabel = lift<string>(['a'], `return (${labelExpr});`);
    expect(WALLET.slice(SELF_AT, PEER_AT)).toContain('<TransferToUserPanel accounts={liveAccounts}');
    expect(WALLET.slice(PEER_AT, AVATAR_AT)).toContain('{accounts.map((a) => (');
    expect(peerFromOptions(appLive).map((o) => o.value)).toEqual(webLive.map((a) => a._id));
    expect(peerFromOptions(appLive).map((o) => o.label)).toEqual(webLive.map((a) => webLabel(a)));
    expect(peerFromOptions(appLive).some((o) => o.value === 'bonus' || o.value === 'subscription')).toBe(false);
    expect(WALLET.slice(PEER_AT, AVATAR_AT)).toContain('<option value="">No live trading account</option>');
    expect(WALLET.slice(PEER_AT, AVATAR_AT)).toContain(PEER_NO_LIVE_NOTE);
  });

  it('only the FIRST account-list load holds the form back (the store re-fetches on every wallet event)', () => {
    expect(accountsGate({ everReady: false, count: 0, loading: true, error: null })).toBe('loading');
    expect(accountsGate({ everReady: false, count: 0, loading: false, error: 'Network Error' })).toBe('error');
    expect(accountsGate({ everReady: false, count: 0, loading: false, error: null })).toBe('ready');
    expect(accountsGate({ everReady: false, count: 2, loading: true, error: null })).toBe('ready');
    expect(accountsGate({ everReady: true, count: 0, loading: true, error: null })).toBe('ready');
    expect(accountsGate({ everReady: true, count: 0, loading: false, error: 'Network Error' })).toBe('ready');
  });

  it('INR only: a fixed "INR (₹)" on both panels, no currency picker', () => {
    expect(WALLET.slice(SELF_AT, PEER_AT)).toContain("const currency = 'INR';");
    expect(WALLET.slice(PEER_AT, AVATAR_AT)).toContain("const currency = 'INR';");
    expect(WALLET.slice(SELF_AT, AVATAR_AT)).not.toContain('setCurrency');
    expect([...TRANSFER_CURRENCIES]).toEqual(['INR']);
    expect([...peerCurrencies('a1')]).toEqual(['INR']);
    expect([...peerCurrencies('bonus')]).toEqual(['INR']);
    expect(VIEW).toContain('INR (₹)');
  });

  it('the Main Wallet is the one server sentinel; the retired Main Wallet is not', () => {
    expect(isUserWallet('bonus')).toBe(true);
    expect(isUserWallet('subscription')).toBe(false);
    expect(isUserWallet('a1')).toBe(false);
    expect(isUserWallet('')).toBe(false);
    expect(freeLabel('bonus')).toBe('Balance');
    expect(freeLabel('a1')).toBe('Free');
    expect(freeCurrency('bonus')).toBe('INR');
    expect(freeCurrency('a1')).toBe('INR');
    // The web's balance caption: `isBonusFrom ? 'Balance' : 'Free'`.
    expect(WALLET.slice(SELF_AT, PEER_AT)).toContain("{isBonusFrom ? 'Balance' : 'Free'}");
  });
});

/* ══ Seeding the pickers ════════════════════════════════════════════════ */

describe('picker seeding', () => {
  const webInitFrom = lift<string>(['liveAccounts', 'demoAccounts'], `return ${between(WALLET, 'useState(', ');', WALLET.indexOf('const [from, setFrom]', SELF_AT)).slice('useState('.length)};`);
  const webInitTo = lift<string>(['liveAccounts'], `return ${between(WALLET, 'useState(', ');', WALLET.indexOf('const [to, setTo]', SELF_AT)).slice('useState('.length)};`);
  const fillFrom = `${between(WALLET, 'if (!from && (liveAccounts[0]', ';\n', SELF_AT)};`;
  const fixTo = `${between(WALLET, 'if (!toOptions.some(', ';\n', SELF_AT)};`;
  const at = WALLET.indexOf('const toOptions = useMemo(', SELF_AT);
  const toExpr = between(WALLET, '() => (fromPractice', ',\n', at).slice('() => '.length);
  /** The web's two effects, in order, on a pair. */
  const webSettle = lift<{ from: string; to: string }>(
    ['liveAccounts', 'demoAccounts', 'BONUS_TRANSFER_OPT', 'isPracticeAccount', 'from0', 'to0'],
    `let from = from0, to = to0;
     const setFrom = (v) => { from = v; }; const setTo = (v) => { to = v; };
     ${fillFrom}
     const fromOptions = [...liveAccounts, BONUS_TRANSFER_OPT, ...demoAccounts];
     const fromPractice = isPracticeAccount(fromOptions.find((a) => a._id === from));
     const toOptions = ${toExpr};
     ${fixTo}
     return { from, to };`,
  );
  const settleWeb = (live: typeof webLive, demo: typeof webDemo, from: string, to: string): { from: string; to: string } =>
    webSettle(live, demo, webBonusOpt, webIsPractice, from, to);
  const app = (list: { _id: string }[]): { id: string; accountNumber: string; accountType: string; nickname: string | null }[] =>
    APP_ACCOUNTS.filter((a) => list.some((w) => w._id === a.id));

  it('seeds From / To as the web does at mount', () => {
    for (const [live, demo] of [[webLive, webDemo], [webLive.slice(0, 1), webDemo], [[], webDemo], [webLive, []], [[], []]] as const) {
      expect(initialSelfPair(app([...live]), app([...demo])))
        .toEqual({ from: webInitFrom(live, demo), to: webInitTo(live) });
    }
  });

  it('settles the pair as the web effects do: a source once accounts arrive, a destination still on offer', () => {
    const LISTS = [[webLive, webDemo], [webLive.slice(0, 1), webDemo], [[], webDemo], [webLive, []], [[], []]] as const;
    const PAIRS: [string, string][] = [
      ['', ''], ['a1', 'a2'], ['a1', 'bonus'], ['bonus', 'a1'], ['bonus', 'bonus'], ['a1', 'a1'],
      ['d1', 'v1'], ['d1', 'a1'], ['d1', 'bonus'], ['a1', 'd1'], ['bonus', 'v1'], ['', 'bonus'],
    ];
    let checked = 0;
    for (const [live, demo] of LISTS) {
      const listed = new Set(['bonus', ...live.map((a) => a._id), ...demo.map((a) => a._id)]);
      for (const [from, to] of PAIRS) {
        // The web only fills an EMPTY source; a vanished one is the app's own
        // difference (below).
        if (from && !listed.has(from)) continue;
        const w = settleWeb([...live], [...demo], from, to);
        const ours = reseedSelfPair(app([...live]), app([...demo]), { from, to }) ?? { from, to };
        expect({ live: live.length, demo: demo.length, from, to, ours }).toEqual({ live: live.length, demo: demo.length, from, to, ours: w });
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('DIFFERENCE: a source that leaves the list falls to the first live (else demo) account; the web keeps the stale id', () => {
    expect(settleWeb(webLive, webDemo, 'gone', 'a2')).toEqual({ from: 'gone', to: 'a2' });
    expect(reseedSelfPair(appLive, appDemo, { from: 'gone', to: 'a2' })).toEqual({ from: 'a1', to: 'a2' });
    expect(reseedSelfPair([], appDemo, { from: 'gone', to: 'bonus' })).toEqual({ from: 'd1', to: 'v1' });
    expect(reseedSelfPair([], [], { from: 'a1', to: 'a2' })).toEqual({ from: '', to: 'bonus' });
    // Nothing to change is null.
    expect(reseedSelfPair(appLive, appDemo, { from: 'a1', to: 'bonus' })).toBeNull();
    // An empty From is the web's own "nothing picked": Review stays off.
    expect(checkSelfTransfer({ from: '', to: 'bonus', amount: '5', free: null }).canReview).toBe(false);
  });

  it('"Transfer to Main Wallet" moves a Bonus or demo source to the first live account, as the web button does', () => {
    const body = inner(WALLET, 'onClick={() => {', '}}', WALLET.indexOf('Quick action', SELF_AT));
    const webShortcut = lift<{ from: string; to: string | null }>(
      ['liveAccounts', 'from', 'isBonusFrom', 'fromPractice'],
      `let f = from, t = null;
       const setFrom = (v) => { f = v; }; const setTo = (v) => { t = v; };
       ${body}
       return { from: f, to: t };`,
    );
    for (const from of ['a1', 'a2', 'bonus', 'd1', 'v1']) {
      const fromAcc = webFromOptions.find((a) => a._id === from);
      const { currency, ...pair } = bonusWalletShortcut(appLive, appDemo, from);
      expect(pair).toEqual(webShortcut(webLive, from, from === 'bonus', webIsPractice(fromAcc)));
      expect(currency).toBe('INR');
    }
    // Offered only while the destination is something else and a live account exists.
    expect(WALLET.slice(SELF_AT, PEER_AT)).toContain('{!isBonusTo && liveAccounts.length > 0 && (');
    expect(showBonusShortcut(appLive, 'a2')).toBe(true);
    expect(showBonusShortcut(appLive, 'bonus')).toBe(false);
    expect(showBonusShortcut([], 'v1')).toBe(false);
  });

  it('the peer panel starts on the first live account, else none', () => {
    const webFrom = lift<string>(['accounts'], `return ${between(WALLET, 'useState(', ');', WALLET.indexOf('const [fromAccountId,', PEER_AT)).slice('useState('.length)};`);
    for (const list of [webLive, webLive.slice(2), []]) {
      expect(initialPeerSource(app(list))).toEqual({ from: webFrom(list), currency: 'INR' });
    }
  });

  it('the peer source follows the list as the web effect does', () => {
    const webEffect = lift<string>(
      ['accounts', 'fromAccountId'],
      `let f = fromAccountId; const setFromAccountId = (v) => { f = v; };
       ${between(WALLET, 'if (!accounts.some((a) => a._id === fromAccountId))', ';\n', PEER_AT)};
       return f;`,
    );
    for (const list of [webLive, webLive.slice(1), []]) {
      for (const from of ['a1', 'a2', 'gone', '']) {
        const next = reseedPeerSource(app(list), { from, currency: 'INR' });
        expect({ n: list.length, from, to: next ? next.from : from }).toEqual({ n: list.length, from, to: webEffect(list, from) });
      }
    }
  });
});

/* ══ Between my accounts ════════════════════════════════════════════════ */

describe('between my accounts — balance, gates and the Review button', () => {
  const slice = through(WALLET, 'const isBonusFrom = from === ', 'const overBudget = Number(amount) > free;', SELF_AT);
  const disabledExpr = inner(WALLET, 'disabled={', '}\n', WALLET.indexOf('disabled={!from', SELF_AT));
  const webSelf = lift<{ free: number; overBudget: boolean; disabled: boolean }>(
    ['from', 'to', 'currency', 'amount', 'balances', 'bonusWallet', 'toOptions'],
    `${slice}\nreturn { free, overBudget, disabled: (${disabledExpr}) };`,
  );

  it('agrees with the web on every pairing and amount (wallet loaded)', () => {
    const sides = ['a1', 'a2', 'bonus', 'd1', ''];
    const amounts = ['', '0', '10', '1000', '1000.01', '2050.5', '2050.51', '10000', '15000'];
    let checked = 0;
    for (const from of sides) {
      for (const to of sides) {
        for (const amount of amounts) {
          const w = webSelf(from, to, 'INR', amount, BALANCES, BONUS, []);
          const free = sourceFree({ from, balances: BALANCES, bonus: BONUS });
          const c = checkSelfTransfer({ from, to, amount, free });
          const key = { from, to, amount };
          if (from) expect({ ...key, free: Number(free) }).toEqual({ ...key, free: w.free });
          expect({ ...key, over: c.overBudget, review: c.canReview, same: c.same })
            .toEqual({ ...key, over: from ? w.overBudget : c.overBudget, review: !w.disabled, same: !!from && from === to });
          checked += 1;
        }
      }
    }
    expect(checked).toBe(5 * 5 * 9);
  });

  it('keeps the server figure as a string for display', () => {
    expect(sourceFree({ from: 'a2', balances: BALANCES, bonus: BONUS })).toBe('2050.5');
    expect(sourceFree({ from: 'bonus', balances: BALANCES, bonus: BONUS })).toBe('1000');
    // No INR wallet on that account: nothing there, the web's `|| 0`.
    expect(sourceFree({ from: 'a9', balances: BALANCES, bonus: BONUS })).toBe('0');
  });

  it('a Main Wallet snapshot that failed (and none on screen) is what offers a retry', () => {
    expect(snapshotMissing({ from: 'bonus', bonus: null, failed: true })).toBe(true);
    expect(snapshotMissing({ from: 'bonus', bonus: null, failed: false })).toBe(false);
    expect(snapshotMissing({ from: 'bonus', bonus: BONUS, failed: true })).toBe(false);
    expect(snapshotMissing({ from: 'a1', bonus: null, failed: true })).toBe(false);
  });

  it('DIFFERENCE: an unknown balance blocks Review without claiming "Exceeds source account balance"', () => {
    const w = webSelf('bonus', 'a1', 'INR', '50', BALANCES, null, []);
    expect(w).toMatchObject({ free: 0, overBudget: true, disabled: true });
    const free = sourceFree({ from: 'bonus', balances: BALANCES, bonus: null });
    expect(free).toBeNull();
    expect(checkSelfTransfer({ from: 'bonus', to: 'a1', amount: '50', free }))
      .toMatchObject({ overBudget: false, canReview: false });
    expect(sourceFree({ from: 'a1', balances: null, bonus: BONUS })).toBeNull();
  });

  it('DIFFERENCE: a malformed amount never enables Review (the web enables it for NaN)', () => {
    const w = webSelf('a1', 'a2', 'INR', '1.2.3', BALANCES, BONUS, []);
    expect(w.disabled).toBe(false);
    expect(checkSelfTransfer({ from: 'a1', to: 'a2', amount: '1.2.3', free: '100' }).canReview).toBe(false);
    expect(sanitizeAmount('1.2.3')).toBe('1.23');
    expect(sanitizeAmount('1,5')).toBe('1.5');
    expect(sanitizeAmount('-12e3 ')).toBe('123');
    expect(sanitizeAmount('.')).toBe('.');
    expect(checkSelfTransfer({ from: 'a1', to: 'a2', amount: '.', free: '100' }).canReview).toBe(false);
  });

  it('the submit refusal is the web\'s', () => {
    const body = inner(WALLET, 'const submit = async () => {', 'setSubmitting(true);', SELF_AT);
    const webRefusal = lift<string | null>(
      ['from', 'to', 'amount'],
      `let said = null; const toast = { error: (m) => { said = m; } };
       (() => { ${body} })();
       return said;`,
    );
    const cases: [string, string, string][] = [
      ['', 'a2', '5'], ['a1', 'a1', '5'], ['a1', 'a2', ''], ['a1', 'bonus', '5'], ['bonus', 'a1', '5'], ['d1', 'v1', '5'], ['bonus', '', '5'],
    ];
    for (const [from, to, amount] of cases) {
      expect({ from, to, amount, r: selfSubmitRefusal({ from, to, amount }) })
        .toEqual({ from, to, amount, r: webRefusal(from, to, amount) });
    }
  });

  it('posts exactly the web body, in INR', () => {
    const webBody = lift<Record<string, unknown>>(
      ['from', 'to', 'currency', 'amount'],
      `return ${between(WALLET, "api.post('/wallet/transfers', ", ');', SELF_AT).slice("api.post('/wallet/transfers', ".length)};`,
    );
    expect(selfTransferPayload({ from: 'a1', to: 'bonus', amount: '1250.50' }))
      .toEqual(webBody('a1', 'bonus', 'INR', '1250.50'));
  });
});

/* ══ To another user ════════════════════════════════════════════════════ */

describe('to another user — fee, limits and Review', () => {
  const body = through(WALLET, 'const amt = Number(amount) || 0;', 'cfg.enabled !== false;', PEER_AT);
  const webPeer = lift<{ amt: number; feePct: number; feeAmt: number; total: number; overBudget: boolean; belowMin: boolean; aboveMax: boolean; min: number; max: number; canReview: boolean }>(
    ['amount', 'cfg', 'free', 'recipient', 'fromAccountId'],
    `${body}\nreturn { amt, feePct, feeAmt, total, overBudget, belowMin, aboveMax, min, max, canReview };`,
  );

  const CFGS = [
    { enabled: true, min: '0', max: '0', feePercent: '0' },
    { enabled: true, min: '100', max: '50000', feePercent: '1.5' },
    { enabled: true, min: '1', max: '0', feePercent: '0.25' },
    { enabled: true, min: '', max: '', feePercent: '' },
    { enabled: false, min: '100', max: '50000', feePercent: '2' },
  ];
  const AMOUNTS = ['', '0', '0.5', '1', '50', '100', '9999.99', '10000', '10150', '49999.99', '50000', '50000.01', '60000', 'abc'];
  const FREES = [0, 5000, 10150, 10149, 15000, 100000];

  it('the fee is ON TOP and every limit reads as on the web', () => {
    let checked = 0;
    for (const cfg of CFGS) {
      for (const amount of AMOUNTS) {
        for (const free of FREES) {
          for (const recipient of [null, { _id: 'u2' }]) {
            for (const from of ['a1', '']) {
              const w = webPeer(amount, cfg, free, recipient, from);
              const q = peerQuote(amount, cfg, String(free));
              const key = { cfg: `${cfg.min}/${cfg.max}/${cfg.feePercent}/${cfg.enabled}`, amount, free, r: !!recipient, from };
              expect({ ...key, amt: q.amount, pct: q.feePercent, fee: q.fee, total: q.total, over: q.overBudget, low: q.belowMin, high: q.aboveMax, min: q.min, max: q.max })
                .toEqual({ ...key, amt: w.amt, pct: w.feePct, fee: w.feeAmt, total: w.total, over: w.overBudget, low: w.belowMin, high: w.aboveMax, min: w.min, max: w.max });
              expect({ ...key, review: canReviewPeer({ from, hasRecipient: !!recipient, quote: q, enabled: cfg.enabled, free: String(free) }) })
                .toEqual({ ...key, review: w.canReview });
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBe(CFGS.length * AMOUNTS.length * FREES.length * 2 * 2);
  });

  it('agrees with the server on what is charged, and who can send and receive (userTransferService)', () => {
    const svc = readLf(path.join(ROOT, 'backend/src/services/userTransferService.js'));
    expect(svc).toContain('const fee = feePct.gt(0) ? amt.mul(feePct).div(100) : D(0);');
    expect(svc).toContain('const senderTotal = amt.plus(fee);');
    expect(svc).toContain('if (min.gt(0) && amt.lt(min))');
    expect(svc).toContain('if (max.gt(0) && amt.gt(max))');
    // From a LIVE trading account only (never the retired Main Wallet), into
    // the recipient's primary live trading account.
    expect(svc).toContain("'MAIN_WALLET_RETIRED'");
    expect(svc).toContain("'PRACTICE_TRANSFER_NOT_ALLOWED'");
    expect(svc).toContain("'RECIPIENT_NO_LIVE_ACCOUNT'");
    expect(peerQuote('10000', { min: '0', max: '0', feePercent: '1.5' }, '100000')).toMatchObject({ fee: 150, total: 10150 });
  });

  it('DIFFERENCE: an unknown source balance blocks Review without an "Exceeds" message', () => {
    const q = peerQuote('50', { min: '0', max: '0', feePercent: '0' }, null);
    expect(q.overBudget).toBe(false);
    expect(canReviewPeer({ hasRecipient: true, quote: q, enabled: true, free: null })).toBe(false);
  });

  it('the amount messages and the limits line are the web copy', () => {
    const q = peerQuote('60000', { min: '100', max: '50000', feePercent: '0' }, '10000');
    expect(peerAmountErrors(q, '10000')).toEqual(['Exceeds free balance (₹10,000.00)', 'Above maximum transfer amount']);
    expect(peerAmountErrors(peerQuote('50', { min: '100', max: '0', feePercent: '0' }, '10000'), '10000'))
      .toEqual(['Below minimum transfer amount']);
    const peer = WALLET.slice(PEER_AT, AVATAR_AT);
    expect(peer).toContain('Exceeds free balance ({fmtMoney(free)})');
    expect(peer).toContain('Below minimum transfer amount');
    expect(peer).toContain('Above maximum transfer amount');

    expect(peerLimitsHint({ min: '100', max: '500000', feePercent: '1.5' })).toBe('Min ₹100.00 · Max ₹5,00,000.00 · Fee 1.5%');
    expect(peerLimitsHint({ min: '0', max: '0', feePercent: '0.5' })).toBe('Fee 0.5%');
    expect(peerLimitsHint({ min: '100', max: '0', feePercent: '0' })).toBe('Min ₹100.00');
    expect(peerLimitsHint({ min: '0', max: '0', feePercent: '0' })).toBe('');
    expect(peer).toContain('Min <span className="font-mono">{fmtMoney(min)}</span>');
    expect(peer).toContain('Max <span className="font-mono">{fmtMoney(max)}</span>');
    expect(peer).toContain('Fee <span className="font-mono">{feePct}%</span>');
  });

  it('sends the amount as the web normalises it, in INR, and a blank note not at all', () => {
    const webPayload = lift<Record<string, unknown>>(
      ['fromAccountId', 'currency', 'amt', 'note', 'recipient'],
      `return ${between(WALLET, "api.post('/wallet/transfer-user', ", ');', PEER_AT).slice("api.post('/wallet/transfer-user', ".length)};`,
    );
    for (const c of [{ amount: '1050.50', note: ' Rent ' }, { amount: '10', note: '   ' }, { amount: '0.1', note: '' }]) {
      for (const from of ['a1', 'a2']) {
        const ours = peerTransferPayload({ from, amount: c.amount, note: c.note, recipientUserId: 'u2' });
        const theirs = JSON.parse(JSON.stringify(webPayload(from, 'INR', Number(c.amount) || 0, c.note, { _id: 'u2' })));
        expect(ours).toEqual(theirs);
      }
    }
  });

  it('DIFFERENCE: a failed limits read is not silently "no fee" — it is said, and a re-read keeps good limits', () => {
    const peer = WALLET.slice(PEER_AT, AVATAR_AT);
    expect(peer).toContain("const [cfg, setCfg] = useState({ enabled: true, min: '0', max: '0', feePercent: '0' });");
    expect(between(peer, "api.get('/wallet/transfer-user/settings')", '}, []);')).toContain('.catch(() => {});');

    expect(peerSettingsAfter('loading', true)).toBe('ready');
    expect(peerSettingsAfter('loading', false)).toBe('failed');
    expect(peerSettingsAfter('failed', true)).toBe('ready');
    expect(peerSettingsAfter('failed', false)).toBe('failed');
    expect(peerSettingsAfter('ready', false)).toBe('ready');

    expect(peerFeeCaveat('ready', 0)).toBeNull();
    expect(peerFeeCaveat('ready', 0.75)).toBe('estimate');
    expect(peerFeeCaveat('failed', 0)).toBe('unknown');
    expect(peerFeeCaveat('loading', 0)).toBe('unknown');
  });

  it('the confirm says where the money leaves and lands, as the web does', () => {
    expect(WALLET.slice(PEER_AT, AVATAR_AT))
      .toContain("Sent from {acct?.nickname || acct?.accountNumber}. {recipient?.name || 'The recipient'} receives it in their trading account.");
    expect(peerConfirmNote('Swing', 'Jane Doe')).toBe('Sent from Swing. Jane Doe receives it in their trading account.');
    expect(peerConfirmNote('100234', null)).toBe('Sent from 100234. The recipient receives it in their trading account.');
  });

  it('the success toast is the web template', () => {
    const webMsg = lift<string>(['amt', 'recipient', 'fmtMoney'], `return ${between(WALLET, 'toast.success(', ');', PEER_AT).slice('toast.success('.length)};`);
    expect(peerSentMessage('1050.50', 'Jane Doe')).toBe(webMsg(1050.5, { name: 'Jane Doe' }, fmtMoney));
    expect(peerSentMessage('1050.50', 'Jane Doe')).toBe('Sent ₹1,050.50 to Jane Doe');
  });
});

/* ══ Recipients ═════════════════════════════════════════════════════════ */

describe('recipient search and avatar', () => {
  it('searches by User ID, 8 at a time, 250 ms after typing stops, from 2 characters', () => {
    const peer = WALLET.slice(PEER_AT, AVATAR_AT);
    expect(peer).toContain("api.get('/wallet/recipients/search', { params: { q, limit: 8, by: 'uid' } })");
    expect(peer).toContain('}, 250);');
    expect(peer).toContain('if (q.length < 2) { setResults([]); return; }');
    expect(peer).toContain('maxLength={120}');
    expect([PEER_SEARCH_LIMIT, PEER_SEARCH_DEBOUNCE_MS, PEER_SEARCH_MIN_CHARS, PEER_NOTE_MAX]).toEqual([8, 250, 2, 120]);
  });

  it('initials are RecipientAvatar\'s', () => {
    const webInitials = lift<string>(['user'], `return ${between(WALLET, 'const initials = ', ';\n', AVATAR_AT).slice('const initials = '.length)};`);
    const users = [
      { name: 'Jane Doe' }, { name: 'jane  mary doe' }, { name: 'Cher' }, { name: '', email: 'x@y.co' },
      { name: '   ', email: null }, {}, { name: null, email: null }, { name: 'Ávila Ñúñez' },
    ];
    for (const u of users) expect({ u, i: recipientInitials(u) }).toEqual({ u, i: webInitials(u) });
    expect(recipientInitials(null)).toBe(webInitials(null));
  });

  it('the line under the name is the User ID, else the email', () => {
    expect(recipientSubline({ userUid: 'USR100245', email: 'j@d.co' })).toBe('USR100245');
    expect(recipientSubline({ userUid: null, email: 'j@d.co' })).toBe('j@d.co');
    expect(WALLET.slice(PEER_AT, AVATAR_AT)).toContain('{recipient.userUid || recipient.email}');
  });

  it('only an absolute or data: avatar is loaded; anything else is initials', () => {
    expect(loadableAvatar('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(loadableAvatar('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(loadableAvatar('/uploads/a.png')).toBeNull();
    expect(loadableAvatar(null)).toBeNull();
  });

  it('DIFFERENCE: "No users found." is reachable; a failed search says why', () => {
    const peer = WALLET.slice(PEER_AT, AVATAR_AT);
    expect(peer).toContain('{(searching || results.length > 0) && (');
    expect(peer).toContain('{!searching && results.length === 0 && query.trim().length >= 2 && (');

    expect(searchPhase({ query: 'U', searching: false, resultCount: 0, last: null })).toBe('idle');
    expect(searchPhase({ query: 'USR1', searching: true, resultCount: 0, last: null })).toBe('searching');
    expect(searchPhase({ query: 'USR1', searching: true, resultCount: 2, last: null })).toBe('results');
    expect(searchPhase({ query: 'USR1', searching: false, resultCount: 0, last: { query: 'USR1', error: null } })).toBe('empty');
    expect(searchPhase({ query: ' USR1 ', searching: false, resultCount: 0, last: { query: 'USR1', error: 'Network Error' } })).toBe('error');
    expect(searchPhase({ query: 'USR12', searching: false, resultCount: 0, last: { query: 'USR1', error: null } })).toBe('idle');
  });
});

/* ══ Copy ═══════════════════════════════════════════════════════════════ */

describe('copy is the web\'s, word for word', () => {
  const STRINGS = [
    'Transfer Funds',
    'Move funds instantly between your trading accounts and your Main Wallet.',
    'Send funds from one of your live trading accounts to another registered user — they receive it in their trading account.',
    'Between my accounts',
    'Send to another user',
    'Transfer to Main Wallet',
    'Main Wallet · INR',
    'Demo accounts can only transfer to other demo accounts.',
    'No eligible account',
    'No live trading account',
    'Transfers are sent from a live trading account.',
    'Open one →',
    'INR (₹)',
    'Exceeds source account balance',
    'Review Transfer →',
    'Confirm Transfer',
    'Transferring…',
    'Transfer completed',
    'Pick two different accounts and a positive amount',
    'Peer transfers are currently disabled',
    'User-to-user transfers have been turned off by the platform administrator. Try again later.',
    "Enter recipient's User ID (e.g. USR100245)",
    'Searching…',
    'No users found.',
    'Visible to recipient',
    'Note (optional)',
    'You send',
    'Total debit',
    'You pay',
    'Confirm & Send',
    'Sending…',
    'Change',
  ];

  it.each(STRINGS)('%s', (s) => {
    expect(WALLET.slice(SELF_AT, AVATAR_AT)).toContain(s);
    expect(`${VIEW}\n${LOGIC}`).toContain(s);
  });

  it('no MetaTrading currency switch is left, and no Main Wallet', () => {
    expect(`${VIEW}\n${LOGIC}`).not.toMatch(/only supports USD|must be in USD/);
    // The retired wallet (shown as "Old Main Wallet") is never offered.
    expect(`${VIEW}\n${LOGIC}`).not.toMatch(/Old Main Wallet|MAIN_WALLET_ID/);
  });
});
