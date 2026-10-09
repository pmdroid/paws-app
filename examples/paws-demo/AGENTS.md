# paws-demo

Smoke repository for Paws. Acceptance rules live in `.agents/closeout.yaml` on `origin/main`. Do not copy those rules into this file.

When a task needs a product decision with a fixed set of choices, call `ask_team` and wait for the answer.

`src/export.test.ts` is seeded to fail until `exportRows` is fixed. Do not weaken that test.
