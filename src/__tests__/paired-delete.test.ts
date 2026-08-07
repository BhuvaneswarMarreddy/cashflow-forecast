/**
 * #28 — paired-delete must be a THREE-outcome choice where cancel deletes NOTHING.
 * The old window.confirm had two buttons and deleted on both of them; Cancel
 * reads as abort everywhere else in the OS, so users lost rows.
 */
import { executePairedDelete } from '@/lib/paired-delete';

describe('executePairedDelete', () => {
  const run = async (choice: 'both' | 'one' | 'keep') => {
    const deleted: string[] = [];
    await executePairedDelete(choice, 'txnA', 'txnB', async (id) => {
      deleted.push(id);
    });
    return deleted;
  };

  test('"both" deletes the pair, other leg first', async () => {
    expect(await run('both')).toEqual(['txnB', 'txnA']);
  });

  test('"one" deletes only the chosen transaction', async () => {
    expect(await run('one')).toEqual(['txnA']);
  });

  test('"keep" deletes nothing — cancel is a true abort', async () => {
    expect(await run('keep')).toEqual([]);
  });

  test('no pair: plain single delete', async () => {
    const deleted: string[] = [];
    await executePairedDelete('one', 'txnA', null, async (id) => {
      deleted.push(id);
    });
    expect(deleted).toEqual(['txnA']);
  });

  test('a failed first delete stops the second — no half-applied "both"', async () => {
    const deleted: string[] = [];
    await expect(
      executePairedDelete('both', 'txnA', 'txnB', async (id) => {
        if (id === 'txnB') throw new Error('offline');
        deleted.push(id);
      })
    ).rejects.toThrow('offline');
    expect(deleted).toEqual([]);
  });
});
