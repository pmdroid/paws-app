# Export rows

Linear parent for the paws-demo smoke. `epic.json` is the seed `scripts/demo-reset.ts` loads. Delegating this parent should merge three pull requests in order, ask one question, and run one Closeout fix loop.

The implement prompt uses the issue title, so each title carries the task. The description is the full spec.

## Export rows

Parent. Team label `paws`. Sub-issues run in the order below because each `blockedBy` edge is a Linear `blocks` relation.

## 1. export-rows

Small feature. `src/export.ts` exports `exportRows`, seeded to drop every row. `src/export.test.ts` expects:

```text
1,Ada
2,Grace
```

Archived rows are included. Do not edit the test. A pull request that still fails `bun test` is rejected, which is the fix loop.

## 2. export-header

Blocked by export-rows. Touches the same file, `src/export.ts`.

Add `exportWithHeader(rows)` that returns the line `id,name`, a newline, then `exportRows(rows)`. Add `src/export-header.test.ts`. Do not change `exportRows` or its test.

## 3. archived-rows

Blocked by export-header. Product decision. Before editing code, call `ask_team`:

- question: `Include archived rows?`
- options: `yes`, `no`

Wait for the answer. Then add `includeArchived()` and `rowsForExport(rows)` in `src/export.ts` from that answer, plus `src/archived.test.ts`. Do not choose a default, and do not change the earlier functions.
