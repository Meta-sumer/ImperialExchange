import fs from 'fs';
import path from 'path';

import { SERVICE_TIMES_DEFAULTS } from '@/constants/serviceTimes';

/**
 * The turnaround times — EquityHub has no admin "Service Times" setting; its
 * pages print the words directly, and the app keeps them word for word.
 */

const ROOT = path.join(__dirname, '../../..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

it('support\'s first response is the Helpdesk\'s own words', () => {
  expect(read('client/src/pages/Helpdesk.jsx')).toContain(`Average first response: <span className="text-text-primary font-semibold">${SERVICE_TIMES_DEFAULTS.supportReply}</span>.`);
});

it('the deposit review and withdrawal processing are the Wallet\'s own words', () => {
  const wallet = read('client/src/pages/Wallet.jsx');
  expect(wallet).toContain(`Admin will verify your screenshot within ${SERVICE_TIMES_DEFAULTS.depositReview}.`);
  expect(wallet).toContain(`Withdrawals are processed manually within ${SERVICE_TIMES_DEFAULTS.withdrawalProcessing}`);
});

it('EquityHub serves no service-times setting, so the app reads none', () => {
  const routes = fs.readdirSync(path.join(ROOT, 'backend/src/routes')).map((f) => read(`backend/src/routes/${f}`)).join('\n');
  expect(routes).not.toContain('service-times');
  expect(fs.existsSync(path.join(__dirname, '../store/serviceTimes.ts'))).toBe(false);
});
