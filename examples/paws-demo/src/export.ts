export type Row = {
  id: string;
  name: string;
  archived: boolean;
};

/**
 * CSV body of `id,name` lines. Seeded to drop every row so Closeout's first
 * run fails and the fix loop has a red test. Archived rows belong in this
 * output; filtering them is a later decision.
 */
export function exportRows(rows: readonly Row[]): string {
  void rows;
  return "";
}
