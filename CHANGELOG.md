# Changelog

Changes that need action on upgrade come first in each entry. Terms are in [GLOSSARY.md](GLOSSARY.md); settings are in the [configuration reference](docs/configuration.md).

## 2026-11-09: Paws no longer resets a pre-drizzle database without asking

### Changed

- **Paws refuses to start on a `paws.db` built by the earlier migrations.** The error names the database and lists what a reset loses, and the refused start changes nothing on disk. To set the database aside and start on an empty one as before, set `PAWS_RESET_LEGACY_DATABASE=1`. See [Database reset](docs/database-reset.md).

## 2026-11-09: Paws and runners run on Bun 1.4.4

### Changed

- **A host that runs Paws needs Bun 1.4.4 on `PATH`** (`mise use -g bun@1.4.4`); `paws install` refuses any other version. Runner packages bring their own Bun, so upgrading a runner needs nothing extra. A runner release is verified by the installer in its own package, so upgrades work across this change; a release built for 1.4.2 is older and is refused as a downgrade, as before.

### Fixed

- A synchronous child process no longer loses its exit after a garbage collection, which left the process spinning beside a zombie child. This was a Bun 1.4.2 bug; Paws makes synchronous git calls on the control plane and in tests.

## 2026-11-07: Settings saves go to the database, and GitHub deliveries keep their payload

### Changed

- **The Settings page no longer writes `config.toml`.** A save goes to the database's `setting` table, so every Paws process sharing the database reads it on its next use. `config.toml` is the starting point while the table is empty. After the first save, edit agents, merging, queue, time limits, checkout and brief settings on the Settings page; Paws ignores those sections of `config.toml` from then on. See the [configuration reference](docs/configuration.md).
- A GitHub delivery's payload is kept with its delivery id and deleted with it after three days.

## 2026-11-07: drizzle-kit owns migrations, and the upgrade resets the database

### Changed

- **The upgrade resets the database.** At the first start, a `paws.db` built by the earlier migrations is renamed to `paws.db.pre-drizzle-<UTC time>` beside it, with its `-wal` and `-shm` files, never deleted, and Paws starts on a new database. One journal line names the renamed file. Nothing is copied over: sign in to the dashboard as a Linear workspace admin to make the workspace again, connect the GitHub App again in **Integrations**, and pair each runner again after moving its identity aside. Delegate in-progress issues again. Secrets, `config.toml` and the environment file stay. See [Database reset](docs/database-reset.md).
- drizzle-kit migrations in `src/db/drizzle/` create and change the schema, starting from `0000_baseline`, the exact SQL of the schema the earlier migrations built. A new migration is generated from the Drizzle schema with `drizzle-kit generate`; see [src/db/README.md](src/db/README.md).

## 2026-11-05: Runner-backed runs get the repository's runtimes again

### Fixed

- A runner-backed run reads `mise.toml`, `.mise.toml` and `.tool-versions` from the `origin/main` its bare mirror last fetched. Since runner-backed items stopped keeping a worktree, every item read `origin/main` through the mirror's shared `FETCH_HEAD`, and items read at the same time could see each other's half-written fetch and dispatch with no runtimes, so Closeout could not find Bun.
- When Paws cannot read the runtime files, it retries the read twice, then posts one line naming the cause in Linear and journals one line for the run. The runner journals the runtimes each run asked for. See [runtimes](docs/runtimes.md).

## 2026-11-04: The Closeout stop hook runs with Bun

### Changed

- The Closeout stop hook is a TypeScript file run by the Bun that runs Paws or the runner (`/opt/paws-runner/bin/bun` on a runner, with runner 0.1.67), so a host no longer needs `python3` for it. Workspace hooks still need `python3`.

## 2026-11-04: No control-plane worktrees for runner-backed items

### Changed

- With runner execution, Paws keeps only the bare mirror of each repository. A runner's candidate is imported under `refs/paws/candidates/<item>` in the mirror, with the same checks as before, and Closeout, the merge lane and publication read that ref. `~/.paws/worktrees/` stays empty for runner-backed items, and the worktree sweep removes the ones an earlier release left once no work for the item runs in this process.

## 2026-11-04: The merge lane rebases on a runner

### Changed

- **Upgrade runners to 0.1.63** to move merge-lane rebases off the Paws host. With an older runner, or none online, the lane rebases on the Paws host as before.
- When `main` moved, the merge lane asks a runner to rebase the branch and push it, then checks the pushed head before it uses it: it must descend from `main` and carry the same patch (`git patch-id --stable`). A refused head, a failure or no answer within 10 minutes falls back to the rebase on the Paws host once, with a journal line. A conflict on the runner goes back to the agent as before.

## 2026-11-03: The status snapshot API is removed

### Removed

- **`GET /api/status` is gone.** So are its `slices` query, `GET /api/status/items/<id>` and the item's check log route; each answers 404. A script that read them reads the page resource it needs instead: `/api/overview`, `/api/issues`, `/api/issues/<id>` (and its `/attempts/<n>/checks/<check id>/log`), `/api/questions`, `/api/merge-queue` or `/api/evidence`. Old `/status` page links still redirect to `/dashboard`.

### Changed

- The per-minute response-size journal line is now `dashboard payload minute=… largest_bytes=… path=… responses=…`. Search for `dashboard payload` instead of `status payload`.

## 2026-11-01: The command reviewer gets the issue brief and earlier findings

### Changed

- **Upgrade runners to 0.1.55** for this. An older runner still runs the review, without the instructions.
- Closeout's review command now gets review instructions: the issue brief, a rule that behaviour the issue asks for is not a defect and that a declined finding is not raised again unless the new code changes it, and the earlier rounds' findings. They stay under 8 KiB, and the latest round's findings are kept first. Claude gets them with `--append-system-prompt`. Codex gets them as the `codex exec review` prompt, which names the base and head in place of `--base`.

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
