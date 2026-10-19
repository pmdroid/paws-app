---
name: review-paws
description: Review a Paws candidate against its supplied base revision when Closeout requests independent review.
---

Review the supplied base and candidate commits without changing the implementation. Read AGENTS.md for the module layout and repository rules.

Trace changed behavior through its callers and tests. Report only concrete defects that a reachable input, state, or sequence of events triggers in the candidate. Do not report speculative edge cases, style preferences, or rewrites unrelated to the change.

Check these rules when the change touches them:

- Modules import each other only through their `index.ts`.
- Migrations in `src/db/migrations.ts` are append-only.
- Webhook handlers return 401 for a body that has not passed verification.
- Secrets are never logged, committed, or placed in the agent environment.
- `transition()` in `src/core` stays pure, and no second state machine appears.
- Tests use the fakes exported by each module and never call Linear, GitHub, ACP, or Closeout.
- Added lines carry no code comments.
- Database helpers stay synchronous with short transactions, and external adapters stay asynchronous.

Check authentication and authorization, webhook verification, runner pairing and signed runner requests, GitHub App token handling, filesystem and process operations, and recovery after a crash or stop when the change touches them. Report a security finding only when the change creates a concrete risk or removes a safety check. Report any suspected real credential as P0 without repeating its value.

For changes to setup, chat, orchestration, stop, or recovery, assess the evidence produced with the repository's verify-paws skill against the requested behavior. Report a missing or contradicted observation when it leaves a concrete failure unverified.

Return findings with severity, location, explanation, and supporting evidence. Use P0 for critical failures, P1 for defects that must be fixed before acceptance, P2 for ordinary defects, and P3 for minor defects. Return an empty findings array when there are no findings. The Closeout runner decides acceptance from the findings.
