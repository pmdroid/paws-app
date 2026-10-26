# Changelog

Changes that need action on upgrade come first in each entry. Terms are in [GLOSSARY.md](GLOSSARY.md); settings are in the [configuration reference](docs/configuration.md).

## 2026-10-26: One way back to the agent, one way to ask, one merge predicate

### Breaking

- **`[merge] main_moved = "ci"` is rejected.** Paws no longer starts with it, in `[merge]`, `[merge.projects.*]` or `[[merge.rules]]`. The setting merged a rebased head that Closeout never saw. Set the key to `"closeout"` or remove it; every rebased head now goes through Closeout before it can merge. `"overlap"` is rejected the same way.
- **`exhausted` and `awaiting_signoff` are no longer work-item states.** A migration moves `exhausted` rows to `failed`; nothing wrote `awaiting_signoff`. `GET /api/status` no longer returns either state. A spent budget is now an open question in `awaiting_input`.
- **`[merge] ci_fix_attempts` no longer sets a CI budget.** Red CI is a fix round and counts against the Closeout policy's `retry.fix_rounds_per_item`.
- **The rebase budget no longer refills when main advances.** Three returns in a row on a known main, six in any rolling hour; only a person's reply in the item's session refills it.

### Added

- `retry.attempts_per_check` and `retry.fix_rounds_per_item` in the Closeout policy, both defaulting to 3. `maxFailedAttemptsPerItem` stays as an alias for `attempts_per_check`.
- `restart(item, handoff)` and `ask(item, question)` in `src/loop`, the only ways to send an item back to the agent and to ask a person. Restart keeps the run and the Linear session and records a reason: `findings`, `ci`, `review`, `conflict`, `follow_up` or `answer`.
- The merge lane squashes only when `mergeable(S)` holds, with GitHub's expected-head guard set to S. A rebase in the lane produces a new head that goes back to `verifying`.
- A changes-requested review on the pull request restarts the item once per review id with the review and its threads. The agent fixes what it is confident about and asks in the session about the rest. A comment-only review posts its threads once.
- Human visual review is a pending-human check inside `verifying`, bound to the head, and carried over a rebase that leaves the patch unchanged.
- After the pull request response, a Linear session stays quiet: rebase, re-verification, CI and queue position move only the title and plan, and one final response says merged or closed. Blocked and queued items name what they wait for, and the keepalive names the current step every 25 minutes.
- A stop ends in one response naming the branch, its commits and the pull request state.
