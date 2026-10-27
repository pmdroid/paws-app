# Changelog

Changes that need action on upgrade come first in each entry. Terms are in [GLOSSARY.md](GLOSSARY.md); settings are in the [configuration reference](docs/configuration.md).

## 2026-10-27: Closeout's live review runs the agent's review command on the runner

### Changed

- **Upgrade runners to 0.1.47.** The independent review now needs it. On an older runner the review is blocked with "needs runner 0.1.47 or later".
- The live Closeout review runs the reviewer profile's own review command on the item's runner, in the run's checkout at the candidate commit, with the runner's login. Codex runs `codex exec review --base <base>` and Claude runs `/code-review <base>..<head>`. Paws no longer sends a rendered prompt: the review skill, the diff, the brief and the finding format stay out of it. The policy digest is unchanged.
- The reviewer profile needs a Claude or Codex model. `scope: diff` on a review item no longer narrows the review.

## 2026-10-27: "When main moved before the merge" has its three choices again

### Changed

- **`[merge] main_moved` accepts `"ci"`, `"overlap"` and `"closeout"` again, and a missing key means `"ci"`.** `config.toml` with `"ci"` or `"overlap"` starts Paws again, and Settings › Merging saves all three choices. Items that already started keep the value they resolved when they started.
  - `"ci"`: after a rebase, the new head merges once its CI is green. Closeout does not run again; the new head carries the acceptance of the head the lane rebased.
  - `"overlap"`: when main's new commits touch none of the pull request's files or package roots, the pull request merges without a rebase. When they do, or GitHub requires branches to be up to date, the branch is updated and waits for CI.
  - `"closeout"`: every rebased head goes back through Closeout, as on 2026-10-26.
- The merge lane still squashes only when `mergeable(S)` holds, with GitHub's expected-head guard set to S. A changed Closeout policy sends a carried head back through Closeout.

## 2026-10-26: One way back to the agent, one way to ask, one merge predicate

### Breaking

- **`[merge] main_moved = "ci"` is rejected.** Paws no longer starts with it, in `[merge]`, `[merge.projects.*]` or `[[merge.rules]]`. The setting merged a rebased head that Closeout never saw. Set the key to `"closeout"` or remove it; every rebased head now goes through Closeout before it can merge. `"overlap"` is rejected the same way. Reverted on 2026-10-27.
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
