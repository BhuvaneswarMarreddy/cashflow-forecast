import type { ParsedTransaction } from '@/lib/csv-import';
import type { PaymentAccount } from '@/types';

jest.mock('../rate-limit', () => ({
  checkRateLimit: jest.fn(),
  LIMITS: { importCsv: 30, applyDecision: 100, aiDecision: 50, parseReceipt: 60, aiChat: 100 },
}));
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(),
  Timestamp: { now: jest.fn(() => 'TS'), fromDate: jest.fn((d: Date) => d) },
}));

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import { buildRow, importCsv } from '../importCsv';
import { checkRateLimit } from '../rate-limit';

const parsed = (over: Partial<ParsedTransaction>): ParsedTransaction => ({
  id: 'p1',
  date: '2026-08-01T00:00:00.000Z',
  title: 'Coffee',
  amount: 5,
  type: 'expense',
  category: 'food',
  sourceCategory: 'Dining',
  paymentMethod: 'chase',
  description: 'Latte',
  merchant: 'Starbucks',
  csvAccount: 'Chase Checking',
  isValid: true,
  errors: [],
  ...over,
});

const account: PaymentAccount = {
  id: 'acc1',
  name: 'Chase Checking',
  type: 'bank_account',
  provider: 'chase',
  color: '#000000',
  isActive: true,
  openingBalance: 0,
};

// FIX 1: this is an Admin-SDK path — firestore.rules never runs, and the
// client-SDK equivalent enforces isValidString(title, 1, 200). A CSV cell has
// no length bound of its own besides the whole file's 8MB cap.
describe('buildRow — field-length clipping', () => {
  it('clips an oversized title/merchant/sourceCategory/description to 200 chars', () => {
    const huge = 'x'.repeat(900_000); // well within the 8MB file cap, as a single cell
    const row = buildRow(
      parsed({ title: huge, merchant: huge, sourceCategory: huge, description: huge }),
      account,
    );
    expect(row.title).toHaveLength(200);
    expect(row.merchant).toHaveLength(200);
    expect(row.sourceCategory).toHaveLength(200);
    expect(row.description).toHaveLength(200);
    expect(row.title).toBe(huge.slice(0, 200));
  });

  it('leaves a normal cell untouched', () => {
    const row = buildRow(parsed({}), account);
    expect(row.title).toBe('Coffee');
    expect(row.merchant).toBe('Starbucks');
    expect(row.sourceCategory).toBe('Dining');
    expect(row.description).toBe('Latte');
  });

  it('keeps absent optional fields absent — clipping is a no-op, not a stringify', () => {
    const row = buildRow(parsed({ merchant: undefined, sourceCategory: undefined, description: '' }), account);
    expect(row.merchant).toBeUndefined();
    expect(row.sourceCategory).toBeUndefined();
    expect(row.description).toBeUndefined(); // '' || undefined, existing behaviour
  });
});

// FIX 4: importCsv is a heavy op (parallel reads + a write batch); a retry
// storm is expensive even though imports are themselves idempotent.
describe('importCsv — rate limiting', () => {
  beforeEach(() => {
    (checkRateLimit as jest.Mock).mockReset();
  });

  it('rejects over the limit with resource-exhausted, before touching Firestore', async () => {
    (checkRateLimit as jest.Mock).mockRejectedValue(
      new HttpsError('resource-exhausted', 'Daily limit reached.'),
    );
    const fakeDb = { collection: jest.fn() };
    (getFirestore as jest.Mock).mockReturnValue(fakeDb);

    await expect(
      importCsv.run({ auth: { uid: 'u1' }, data: { content: 'x' } } as never),
    ).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(fakeDb.collection).not.toHaveBeenCalled();
  });

  it('under the limit, checkRateLimit runs and the call proceeds past the gate', async () => {
    (checkRateLimit as jest.Mock).mockResolvedValue(undefined);
    const fakeDb = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          get: jest.fn(async () => {
            throw new Error('PROCEEDED_PAST_GATE');
          }),
        })),
      })),
    };
    (getFirestore as jest.Mock).mockReturnValue(fakeDb);

    await expect(
      importCsv.run({ auth: { uid: 'u1' }, data: { content: 'x' } } as never),
    ).rejects.toThrow('PROCEEDED_PAST_GATE');
    expect(checkRateLimit).toHaveBeenCalledWith('u1', 'importCsv', 30);
  });
});
