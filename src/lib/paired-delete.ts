/**
 * #28 — the paired-delete decision, separated from the UI so the three
 * outcomes are testable. 'keep' MUST delete nothing: Cancel is an abort,
 * not a smaller delete. For 'both', the other leg goes first so a failure
 * leaves the pair intact rather than half-deleted.
 */
export type PairedDeleteChoice = 'both' | 'one' | 'keep';

export async function executePairedDelete(
  choice: PairedDeleteChoice,
  id: string,
  otherId: string | null,
  deleteFn: (id: string) => Promise<void>
): Promise<void> {
  if (choice === 'keep') return;
  if (choice === 'both' && otherId) await deleteFn(otherId);
  await deleteFn(id);
}
