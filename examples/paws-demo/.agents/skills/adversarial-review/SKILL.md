---
name: adversarial-review
description: Review a paws-demo candidate before a pull request. Report findings; do not decide acceptance.
---

# Adversarial review

Read the diff from the base commit to the candidate. Report findings with severity `P0`, `P1`, `P2`, or `P3`, a location, an explanation, and evidence. Do not assign an overall pass or fail.

- A failing `bun test` or a weakened assertion in `src/export.test.ts` is `P0`.
- A product choice made without `ask_team` when the issue requires it is `P1`.
- An edit outside the issue's files is `P2`.

An empty finding list means the change is fine.
