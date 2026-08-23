const readLedgerMock = jest.fn();
jest.mock('../snapshot', () => ({
  readLedger: (...args: unknown[]) => readLedgerMock(...args),
  mapTransaction: jest.fn(),
}));

import { flowNodeDetail, flowSnapshot } from '../flow';

// FIX 2: `periodFor` is reached AFTER readLedger and builds a month key's date
// range with `key.split('-').map(Number)` — a key that isn't YYYY-MM/YYYY
// produces NaN -> Invalid Date -> an uncaught RangeError, i.e. a paid
// full-ledger read followed by a generic `internal` error. `key` must be
// validated (and rejected) BEFORE readLedger runs.
beforeEach(() => {
  readLedgerMock.mockReset();
  // Anything that gets past validation hits this sentinel rejection — proves
  // readLedger was reached without needing a full ledger fixture.
  readLedgerMock.mockRejectedValue(new Error('READLEDGER_CALLED'));
});

describe('flowSnapshot — key validation happens BEFORE readLedger', () => {
  it('rejects a malformed month key with invalid-argument and never reads the ledger', async () => {
    await expect(
      flowSnapshot.run({ auth: { uid: 'u1' }, data: { range: 'month', key: 'not-a-key' } } as never),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(readLedgerMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed year key with invalid-argument and never reads the ledger', async () => {
    await expect(
      flowSnapshot.run({ auth: { uid: 'u1' }, data: { range: 'year', key: '20-26' } } as never),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(readLedgerMock).not.toHaveBeenCalled();
  });

  it('rejects a month-shaped key given a year range, and vice versa (consistent with range)', async () => {
    await expect(
      flowSnapshot.run({ auth: { uid: 'u1' }, data: { range: 'year', key: '2026-06' } } as never),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(
      flowSnapshot.run({ auth: { uid: 'u1' }, data: { range: 'month', key: '2026' } } as never),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(readLedgerMock).not.toHaveBeenCalled();
  });

  it('a well-formed month key reaches readLedger unchanged', async () => {
    await expect(
      flowSnapshot.run({ auth: { uid: 'u1' }, data: { range: 'month', key: '2026-06' } } as never),
    ).rejects.toThrow('READLEDGER_CALLED');
    expect(readLedgerMock).toHaveBeenCalledWith('u1');
  });

  it('a well-formed year key reaches readLedger unchanged', async () => {
    await expect(
      flowSnapshot.run({ auth: { uid: 'u1' }, data: { range: 'year', key: '2026' } } as never),
    ).rejects.toThrow('READLEDGER_CALLED');
    expect(readLedgerMock).toHaveBeenCalledWith('u1');
  });

  it('no key at all (all-time) still reaches readLedger, unchanged', async () => {
    await expect(flowSnapshot.run({ auth: { uid: 'u1' }, data: {} } as never)).rejects.toThrow(
      'READLEDGER_CALLED',
    );
    expect(readLedgerMock).toHaveBeenCalledWith('u1');
  });
});

describe('flowNodeDetail — key validation happens BEFORE readLedger, same as nodeId', () => {
  it('rejects a malformed key with invalid-argument and never reads the ledger', async () => {
    await expect(
      flowNodeDetail.run({
        auth: { uid: 'u1' },
        data: { range: 'month', key: 'nope', nodeId: 'cat:food' },
      } as never),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(readLedgerMock).not.toHaveBeenCalled();
  });

  it('still rejects a missing nodeId before readLedger (existing behaviour, unchanged)', async () => {
    await expect(
      flowNodeDetail.run({ auth: { uid: 'u1' }, data: { range: 'all' } } as never),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(readLedgerMock).not.toHaveBeenCalled();
  });

  it('a well-formed key and nodeId reach readLedger unchanged', async () => {
    await expect(
      flowNodeDetail.run({
        auth: { uid: 'u1' },
        data: { range: 'month', key: '2026-06', nodeId: 'cat:food' },
      } as never),
    ).rejects.toThrow('READLEDGER_CALLED');
    expect(readLedgerMock).toHaveBeenCalledWith('u1');
  });
});
