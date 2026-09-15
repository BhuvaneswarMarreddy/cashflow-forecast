/**
 * #183 PLAID-SCHWAB-001 — web Plaid Link is safe for Charles Schwab (and every bank).
 *
 * The lies and losses these pin:
 * - picking an already-connected bank in Link created a SECOND Item: a second login to
 *   the same accounts and one of the 10 lifetime Trial slots gone for good;
 * - sharing zero accounts (Schwab starts every account unchecked) ended in silence, and
 *   an empty list reads as "no money";
 * - Repair re-exchanged its public token as if it were a new bank.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const calls: Array<{ name: string; data: unknown }> = [];
const responses: Record<string, (data: unknown) => Promise<{ data: unknown }>> = {};

jest.mock('@/lib/firebase', () => ({ app: {} }));
jest.mock('firebase/functions', () => ({
  getFunctions: () => ({}),
  httpsCallable: (_fns: unknown, name: string) => (data: unknown) => {
    calls.push({ name, data });
    return responses[name](data);
  },
}));

import { connectBankWithPlaid, describeConnect, findLinkedInstitution, type LinkedInstitution } from '@/lib/sync-client';

type CreateOpts = Parameters<NonNullable<Window['Plaid']>['create']>[0];
let link: CreateOpts;
let exited = false;

const SCHWAB: LinkedInstitution = { itemId: 'item-schwab', institution: 'Charles Schwab', institutionId: 'ins_11' };

beforeEach(() => {
  calls.length = 0;
  exited = false;
  responses.plaid_link_token = async () => ({ data: { linkToken: 'link-sandbox', linked: [SCHWAB] } });
  responses.plaid_exchange = async () => ({ data: { institution: 'Bank of America', itemId: 'item-boa' } });
  window.Plaid = {
    create: (opts) => {
      link = opts;
      return { open: () => {}, destroy: () => {}, exit: () => { exited = true; opts.onExit(null); } };
    },
  };
});

/** Starts the flow and waits until Link is "open". Wrapped: awaiting a returned promise would wait for Link to finish. */
async function start(itemId?: string) {
  const pending = connectBankWithPlaid(itemId);
  await new Promise((r) => setTimeout(r, 0));
  return { pending };
}

describe('one Item per institution, in Link (#183)', () => {
  it('picking an already-connected bank closes Link before sign-in and offers Repair; nothing is exchanged', async () => {
    const { pending } = await start();
    link.onEvent!('SELECT_INSTITUTION', { institution_id: 'ins_11', institution_name: 'Charles Schwab' });
    expect(exited).toBe(true);
    await expect(pending).resolves.toEqual({ status: 'already-linked', institution: 'Charles Schwab', itemId: 'item-schwab' });
    expect(calls.map((c) => c.name)).toEqual(['plaid_link_token']);
  });

  it('a different bank is left alone', async () => {
    const { pending } = await start();
    link.onEvent!('SELECT_INSTITUTION', { institution_id: 'ins_3', institution_name: 'Bank of America' });
    expect(exited).toBe(false);
    link.onExit(null);
    await expect(pending).resolves.toBeNull();
  });

  it('the server refusal (ALREADY_EXISTS) also lands as Repair, not an error', async () => {
    responses.plaid_exchange = async () => { throw Object.assign(new Error('already'), { code: 'functions/already-exists', details: { itemId: 'item-schwab' } }); };
    const { pending } = await start();
    link.onSuccess('public-x', { institution: { name: 'Charles Schwab', institution_id: 'ins_11' }, accounts: [{}] });
    await expect(pending).resolves.toEqual({ status: 'already-linked', institution: 'Charles Schwab', itemId: 'item-schwab' });
  });
});

describe('what the exchange sends and returns (#183)', () => {
  it('sends institution_id with the public token and counts the shared accounts', async () => {
    const { pending } = await start();
    link.onSuccess('public-y', { institution: { name: 'Bank of America', institution_id: 'ins_3' }, accounts: [{}, {}] });
    await expect(pending).resolves.toEqual({ status: 'linked', institution: 'Bank of America', itemId: 'item-boa', accountsShared: 2 });
    expect(calls[1]).toEqual({ name: 'plaid_exchange', data: { publicToken: 'public-y', institution: 'Bank of America', institutionId: 'ins_3' } });
  });

  it('Repair (update mode) never exchanges, and the duplicate guard does not fire on its own bank', async () => {
    const { pending } = await start('item-schwab');
    expect(calls[0]).toEqual({ name: 'plaid_link_token', data: { itemId: 'item-schwab' } });
    link.onEvent!('SELECT_INSTITUTION', { institution_id: 'ins_11', institution_name: 'Charles Schwab' });
    expect(exited).toBe(false);
    link.onSuccess('public-update', { institution: { name: 'Charles Schwab', institution_id: 'ins_11' }, accounts: [{}, {}] });
    await expect(pending).resolves.toEqual({ status: 'repaired', institution: 'Charles Schwab', itemId: 'item-schwab', accountsShared: 2 });
    expect(calls.map((c) => c.name)).toEqual(['plaid_link_token']);
  });
});

describe('what the owner is told (#183)', () => {
  it('zero shared accounts says so and offers Repair; it never refreshes into an empty list', () => {
    expect(describeConnect({ status: 'linked', institution: 'Charles Schwab', itemId: 'item-schwab', accountsShared: 0 })).toEqual({
      message: 'No accounts were shared. Open the connection again and tick the accounts you want.',
      repairItemId: 'item-schwab',
      refresh: false,
    });
  });

  it('a duplicate names the bank, offers Repair, and still pulls data for a connection that never synced', () => {
    const d = describeConnect({ status: 'already-linked', institution: 'Charles Schwab', itemId: 'item-schwab' });
    expect(d.message).toBe('Charles Schwab is already connected — pulling its data. Repair the connection to change which accounts are shared.');
    expect(d).toMatchObject({ repairItemId: 'item-schwab', refresh: true });
  });

  it('a real connection pulls data', () => {
    expect(describeConnect({ status: 'linked', institution: 'Charles Schwab', itemId: 'i', accountsShared: 2 }))
      .toEqual({ message: 'Charles Schwab connected — pulling your data…', repairItemId: null, refresh: true });
  });

  it('the Schwab line is on Accounts before Link opens, and Repair is wired to update mode', () => {
    const accounts = readFileSync(join(process.cwd(), 'src/app/accounts/page.tsx'), 'utf8');
    expect(accounts).toContain('At Schwab, tick each account you want. They start unchecked.');
    expect(accounts).toContain('onClick={() => handleConnectBank(repairItemId)}');
    expect(accounts).toContain('const outcome = describeConnect(result);');
  });
});

describe('findLinkedInstitution mirrors the server rule (plaid_ingest.existing_item_for)', () => {
  const legacy: LinkedInstitution = { itemId: 'item-chase', institution: 'Chase', institutionId: '' };
  it('matches by id; by name only for an Item stored before ids were', () => {
    expect(findLinkedInstitution([SCHWAB, legacy], 'ins_11', 'Renamed')).toBe(SCHWAB);
    expect(findLinkedInstitution([SCHWAB, legacy], 'ins_56', 'chase')).toBe(legacy);
    expect(findLinkedInstitution([SCHWAB, legacy], 'ins_99', 'Charles Schwab')).toBeNull();
    expect(findLinkedInstitution([SCHWAB, legacy], null, null)).toBeNull();
  });
});
