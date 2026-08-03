// Skeleton for the CSV loading step (Monarch-shaped exports). Kept as a stub
// during the spike so the go/no-go gate only measures SDK/tsconfig interop.
export interface LedgerRow {
  date: string; // ISO yyyy-mm-dd
  merchant: string;
  category: string;
  account: string;
  originalStatement: string;
  notes: string;
  amountCents: number; // integer cents — repo convention, never float dollars
  tags: string[];
}

export function loadFromCsv(_csvPath: string): LedgerRow[] {
  throw new Error('not implemented yet');
}
