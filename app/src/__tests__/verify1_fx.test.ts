/**
 * hooks/useUsdInr on EquityHub — an INR passthrough.
 *
 * EquityHub is INR-only: the web's useFxRate.js is gone (commit "Client:
 * INR-only display"), and the backend's /fx/usdinr is kept only for older
 * clients and answers rate 1. So the hook is a constant 1, makes no request,
 * and every caller that still multiplies by it gets the rupee figure it
 * started with.
 */
import fs from 'fs';
import path from 'path';

import { FX_TTL_MS, INR_RATE, _resetUsdInr, loadUsdInr, useFxStore, useUsdInr } from '@/hooks/useUsdInr';
import { toFxRate } from '@/types/wallet';

const mockUsdInr = jest.fn();
jest.mock('@/api/wallet.api', () => ({ walletApi: { usdInr: () => mockUsdInr() } }));

const ROOT = path.join(__dirname, '../../..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8');

beforeEach(() => {
  _resetUsdInr();
  mockUsdInr.mockReset();
});

describe('EquityHub has no FX', () => {
  it('the web client no longer ships a rate hook', () => {
    expect(fs.existsSync(path.join(ROOT, 'client/src/hooks/useFxRate.js'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'client/src/utils/currency.js'))).toBe(false);
  });

  it('the backend answers rate 1 for older clients and lists only INR', () => {
    const fx = read('backend/src/routes/fx.js');
    expect(fx).toMatch(/rate:\s*1,\s*source:\s*'inr-ledger'/);
    expect(read('backend/src/config/constants.js')).toMatch(/BASE_CURRENCY:\s*'INR'/);
  });

  it('the legacy endpoint adapter reads that answer as a usable rate of 1', () => {
    expect(toFxRate({ rate: 1, source: 'inr-ledger', ts: 5 })).toEqual({ rate: 1, source: 'inr-ledger', ts: 5 });
    expect(toFxRate({ rate: 83, source: 'fallback' }).rate).toBeNull();
  });
});

describe('useUsdInr is a constant passthrough', () => {
  it('is 1, always, with no request', async () => {
    expect(INR_RATE).toBe(1);
    expect(useUsdInr()).toBe(1);
    expect(await loadUsdInr()).toBe(1);
    expect(await loadUsdInr(true)).toBe(1);
    expect(mockUsdInr).not.toHaveBeenCalled();
  });

  it('keeps the old store shape for importers', () => {
    expect(useFxStore.getState().rate).toBe(1);
    expect(FX_TTL_MS).toBeGreaterThan(0);
  });
});
