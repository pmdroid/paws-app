# Paws agent guide

Paws is one Bun process on the developer's machine. It takes delegated Linear issues, places that work on a paired remote runner, verifies with Closeout, asks questions through Linear elicitations, and opens or merges pull requests with a GitHub App token.

The product is Paws. Do not rename it, and do not describe it as a factory.

The loop lives in `src/loop` and is wired from `src/index.ts`. A real run is `docs/smoke-test.md`. Check prerequisites with `bun run paws doctor`. If a function throws `NotImplementedError`, that seam is still open. Do not invent the feature while touching a neighboring module. The dashboard in `src/web` is owned separately.

## Run

```sh
bun install
bun run paws doctor  # prerequisites for a real Linear / GitHub / Closeout run
bun run paws          # 127.0.0.1:8787, data in ~/.paws
bun run check         # lint, fmt:check, typecheck, test
```

Individual scripts: `lint` (oxlint), `fmt` / `fmt:check` (oxfmt), `typecheck` (`tsc --noEmit`), `test` (`bun test`). CI (`.github/workflows/ci.yml`) runs those on Bun 1.4.2.

Tests must not call Linear, GitHub, ACP, or Closeout. Use the fakes exported from each module.

## Required autoreview

The working agent must use the `autoreview` skill to complete both Grok review and native Bugbot review through Cursor Agent before committing, pushing, opening or updating a PR, merging, or reporting a change complete. This includes documentation and repository instructions.

- Resolve `AUTOREVIEW` to the installed skill's bundled helper using its path instructions. Use `--engine grok` for Grok and Cursor Agent's `/review-bugbot` command for Bugbot. Ordinary `--engine cursor-agent` model review does not satisfy the Bugbot requirement.
- Review the complete final change, including untracked files. For branch work, compare against the intended target branch; for an existing PR, resolve its actual base. A stacked PR uses its parent branch. Confirm the base and fetch it successfully before reviewing. Use uncommitted-only review only when that is the entire change being delivered.
- When pending edits exist, also run `"$AUTOREVIEW" --mode local --engine grok` and `"$AUTOREVIEW" --mode local --preflight-only` before Bugbot so staged, unstaged, and untracked changes receive review and secret scanning alongside the committed branch changes.
- Run both reviews read-only. Reviewers report findings without editing files or starting extra reviews; native Bugbot may use its built-in review workflow. Ask for concrete bugs, regressions, security problems, and violations of the task or repository instructions.
- Verify findings against the code, fix actionable findings within the task, rerun affected checks, and rerun both reviews after any edit.
- Report both commands, reviewed scope, results, and disposition of findings in the final response or PR description. A failed, unavailable, incomplete, or substituted review is not a pass. Report the blocker and do not commit, push, merge, or claim completion until both reviews complete with no accepted actionable findings.

For branch or PR work, set `BASE_REF` to the successfully fetched target ref, then run:

```sh
"$AUTOREVIEW" --mode branch --base "$BASE_REF" --engine grok
"$AUTOREVIEW" --mode branch --base "$BASE_REF" --preflight-only &&
  cursor-agent --print --trust --mode ask --output-format json "/review-bugbot Review changes against $BASE_REF, including committed and uncommitted changes and new files. Report findings without editing files or running autofix."
```

## Layout

| Path            | Owns                                                     | Depends on                          |
| --------------- | -------------------------------------------------------- | ----------------------------------- |
| `src/index.ts`  | Composition root. Opens the database, migrates, listens. | public indexes only                 |
| `src/config`    | `~/.paws` paths, env schema, `config.toml` seam          | `core` (for `NotImplementedError`)  |
| `src/core`      | Domain types, states, `transition()`                     | nothing in `src`                    |
| `src/db`        | `bun:sqlite` connection, migrations, `job` and `outbox`  | `core`                              |
| `src/linear`    | `TrackerAdapter`, webhook route, fake                    | `core`                              |
| `src/intake`    | Delegated issues and `blocks` order                      | `core`, `db`, `linear`              |
| `src/acp`       | ACP executor, worktrees, fake agent                      | `core`                              |
| `src/closeout`  | `CloseoutGate`, fake                                     | nothing in `src`                    |
| `src/github`    | GitHub App token, pull requests, serial merge, fake      | nothing in `src`                    |
| `src/questions` | Elicitation text, question rows, `QuestionChannel`       | `core`                              |
| `src/loop`      | Orchestrator: intake, ACP, Closeout, PR, merge           | the modules it composes             |
| `src/doctor`    | `bun run paws doctor` prerequisite checks                | `config`                            |
| `src/host`      | Sleep, wake, and `agentAlive`                            | `core`, `db`                        |
| `src/server`    | `Bun.serve` on `127.0.0.1:8787`, `/health`, route table  | `config`, `linear`, `github`, `web` |
| `src/web`       | Static status dashboard (`/status`, `GET /api/status`)   | nothing in `src`                    |

Import another module only through its `index.ts`. `test/boundaries.test.ts` fails the build otherwise. A new npm dependency is fine; a deep import is not.

`src/core` does not open SQLite and does not talk to Linear. `transition()` is pure. The single writer that commits a transition, outbox rows, and jobs in one `BEGIN IMMEDIATE` transaction comes later; call `transition()` and do not add a second state machine.

SQLite, when opened, uses WAL, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`, and `temp_store=MEMORY`. Migrations in `src/db/migrations.ts` are append-only. Add `002_…` for new tables. Do not edit `001_jobs_outbox`.

External adapters are async. Database helpers are sync because `bun:sqlite` is sync. Keep transactions short.

Webhook handlers fail closed (HTTP 401) until the real HMAC check exists. Do not return 200 for an unverified body.

## Conventions

- TypeScript strict. Public types leave through the module `index.ts`.
- Prefer `import type` for types (`verbatimModuleSyntax`).
- Fakes live next to the interface they implement and are exported from that module. They record calls in memory.
- Identifiers in the design are ULIDs. The foundation does not mint them yet.
- Secrets stay in `~/.paws/secrets` (directory mode `0700`). Never log them, never put them in the agent environment, and never commit them.
- The status page is static files under `src/web` so it can ship on its own. The process serves them on localhost at `/status` and `GET /api/status`.

## Parallel work

Stay inside the directory your issue owns. Shared files are `src/index.ts` (wire a constructed adapter) and `src/server/serve.ts` (one route branch). Add a module rather than widening an existing one when the work is a new concern (`src/intake`, `src/host`).

| Issue                                  | Directory                                  | Leaves alone                |
| -------------------------------------- | ------------------------------------------ | --------------------------- |
| QM-03 webhooks, dedupe, first activity | `src/linear`                               | ACP, Closeout, GitHub merge |
| QM-04 intake and `blocks` order        | new `src/intake`                           | `src/linear/webhook.ts`     |
| QM-05 worktree, ACP, permission guard  | `src/acp`                                  | Closeout, GitHub            |
| QM-06 Closeout gate and fix loop       | `src/closeout`                             | the ACP client              |
| QM-07 `ask_team` elicitation           | `src/questions`                            | webhook verification        |
| QM-08 GitHub App, PR, serial merge     | `src/github`                               | the state-machine table     |
| QM-09 recovery, stop, caps             | `src/core/transition.ts`, `src/db/jobs.ts` | adapter internals           |
| QM-11 status page                      | `src/web`                                  | the workflow                |
| QM-12 sleep and wake                   | new `src/host`                             | merge logic                 |

QM-09 is the owner of the edge table and the job claim. Other issues call `transition()`, `enqueueJob()`, and `enqueueOutbox()` without editing those files. `claimNextJob` and `dispatchOutbox` throw on purpose.

Domain rows (`epic`, `work_item`, `run`, `inbox_event`) are not created yet. The issue that first writes them adds the next migration and uses the unions in `src/core/states.ts` for any `state` column.
