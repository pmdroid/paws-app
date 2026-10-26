# Paws agent guide

Paws is one Bun process on the developer's machine. It takes delegated Linear issues, places that work on a paired remote runner, verifies with Closeout, asks questions through Linear elicitations, and opens or merges pull requests with a GitHub App token.

The product is Paws. Do not rename it, and do not describe it as a factory.

The loop lives in `src/loop` and is wired from `src/index.ts`. A real run is `docs/smoke-test.md`. Check prerequisites with `bun run paws doctor`. Do not invent the feature while touching a neighboring module. The dashboard in `src/web` is owned separately.

## Run

```sh
bun install
bun run paws doctor  # prerequisites for a real Linear / GitHub / Closeout run
bun run paws          # 127.0.0.1:8787, data in ~/.paws
bun run check         # lint, fmt:check, typecheck, test
```

Individual scripts: `lint` (oxlint), `fmt` / `fmt:check` (oxfmt), `typecheck` (`tsc --noEmit`), `test` (`bun test --parallel=4 --timeout=20000`). CI (`.github/workflows/ci.yml`) runs those on Bun 1.4.2, with tests four files at a time (`bun test --parallel=4`); Closeout's `test` check does the same.

Tests must not call Linear, GitHub, ACP, or Closeout. Use the fakes exported from each module.

## Layout

| Path                                                     | Owns                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| `src/index.ts`                                           | Process composition, startup and shutdown                             |
| `src/onboarding-start.ts`, `src/onboarding-readiness.ts` | Onboarding startup and readiness wiring                               |
| `src/acp`                                                | ACP agents, permissions, worktrees, checkpoints and tool servers      |
| `src/agent-catalog`                                      | Agent and model catalog and registry                                  |
| `src/auth`                                               | GitHub App credentials and hosted workspace authentication            |
| `src/closeout`                                           | Verification gate, fix loop, reports and independent review           |
| `src/closeout-spec`                                      | Closeout policy schema, sessions, retries and evidence approval       |
| `src/config`                                             | Home paths, environment, config.toml, agent and merge settings        |
| `src/core`                                               | Domain types, states, pure transition() and execution policies        |
| `src/credentials`                                        | Secret file access and credential refresh                             |
| `src/db`                                                 | SQLite migrations, domain rows, jobs, outbox and transactional writes |
| `src/decisions`                                          | Workspace decisions and repository access choices                     |
| `src/deployment`                                         | Deployment configuration, TLS certificates and renewal                |
| `src/doctor`                                             | Local prerequisites, agent profiles and external access probes        |
| `src/evidence`                                           | Evidence storage, media, review marks and HTTP routes                 |
| `src/execution-controls`                                 | Pause, resume, stop and take-over controls                            |
| `src/github`                                             | GitHub App API, repository access, pull requests and Git operations   |
| `src/host`                                               | Sleep, wake and process supervision                                   |
| `src/install`                                            | Agent adapter installation, login and usage probes                    |
| `src/intake`                                             | Delegation intake, dependencies, ordering and repository readiness    |
| `src/linear`                                             | Tracker adapter, webhooks, polling, sessions and workspace access     |
| `src/loop`                                               | Agent turns, `restart()` and `ask()`, Closeout, publication, recovery |
| `src/member-vm`                                          | Member VM provisioning, persistence and HTTP routes                   |
| `src/merge`                                              | Merge lane: `mergeable(S)`, squash at head S, rebase returns, CI      |
| `src/onboarding`                                         | Onboarding routes and reconnection                                    |
| `src/process`                                            | Owned child processes and process anchors                             |
| `src/provisioning`                                       | Remote VM bootstrap, releases, mise and Tailscale setup               |
| `src/questions`                                          | Elicitations, answer authorization, lifecycle and visual review       |
| `src/runner-answers`                                     | Runner answer storage and delivery                                    |
| `src/runner-artifacts`                                   | Runner artifact storage                                               |
| `src/runner-backend`                                     | Remote execution backend, helper turns and failover                   |
| `src/runner-cli`                                         | Runner command line entry point and daemon startup                    |
| `src/runner-control`                                     | Runner control HTTP routes and enrollment                             |
| `src/runner-coordinator`                                 | Runner authority initialization and service composition               |
| `src/runner-daemon`                                      | Runner connection, durable state and work dispatch                    |
| `src/runner-execution`                                   | Execution broker, jobs, processes, skills, spool and supervisor       |
| `src/runner-health`                                      | Runner health commands and observations                               |
| `src/runner-health-runtime`                              | Runtime health probes on the runner                                   |
| `src/runner-helpers`                                     | Runner helper commands and their lifecycle                            |
| `src/runner-identity`                                    | Runner certificates, identity authority and listener                  |
| `src/runner-inputs`                                      | Runner input storage                                                  |
| `src/runner-journal`                                     | Runner journal storage and delivery                                   |
| `src/runner-login`                                       | Runner login command coordination                                     |
| `src/runner-login-worker`                                | Login execution on the runner                                         |
| `src/runner-mise`                                        | Runner tool installation and mise locking                             |
| `src/runner-models`                                      | Runner model discovery and commands                                   |
| `src/runner-placement`                                   | Runner eligibility, quotas and placement                              |
| `src/runner-protocol`                                    | Shared runner command, event and transport contracts                  |
| `src/runner-repositories`                                | Repository checkout and preparation on the runner                     |
| `src/runner-repository-access`                           | Runner repository credential access                                   |
| `src/runner-results`                                     | Runner command results and lifecycle                                  |
| `src/runner-runtime`                                     | Runner agent and runtime installation                                 |
| `src/runner-transcript-config`                           | Runner transcript configuration                                       |
| `src/runner-transcripts`                                 | Transcript persistence, object storage and HTTP access                |
| `src/runner-work`                                        | Runner work command coordination and HTTP routes                      |
| `src/runner-worker`                                      | Agent turn execution and conversation compaction                      |
| `src/runtimes`                                           | Runtime definitions and parsing                                       |
| `src/scheduler`                                          | Job scheduling and admission                                          |
| `src/server`                                             | HTTP server, route composition and GitHub connection flows            |
| `src/settings`                                           | Settings API for agents, merge policy, hooks and skills               |
| `src/skills`                                             | Skill discovery, sources, bundles, hooks and updates                  |
| `src/slack`                                              | Slack OAuth, identity, authorization and webhooks                     |
| `src/web`                                                | Status dashboard client, server contract and build                    |
| `src/workspace`                                          | Workspace membership, integrations, assignments and policies          |
| `src/worktree-checkout`                                  | Worktree checkout and folder exclusion policies                       |

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

Domain rows are `work_item`, `run`, and `inbox_event`. Sibling items share `work_item.delegation_id`. `work_item.state` uses the unions in `src/core/states.ts`, and `transition()` is the work-item edge table.

Work-item states are `planning`, `queued`, `running`, `paused`, `awaiting_input`, `recovering`, `verifying`, `failed`, `merge_queue`, `manual`, `completed`, `merged` and `cancelled`. There is no `exhausted` or `awaiting_signoff`: a spent budget is a question in `awaiting_input`, and `failed` means execution stopped with nothing to ask. Session title and plan derive from the state, the restart reason and whether the pull request exists; do not add a second state machine for them. Title and plan derive from `transition()`, and `canReportProgress` in `src/loop` is the only activity gate: after the pull request response it passes only the final response and `ask()` elicitations (see `docs/linear-agent-sessions.md`).

Send an item back to the agent only with `restart()` and ask a person only with `ask()`, both from `src/loop`. Do not apply `ejected` or `closeout_rejected`, or open a question, from anywhere else. The merge lane squashes only when `mergeable(S)` holds, with expected head S; every rebased head goes back through Closeout. `[merge] main_moved` accepts only `"closeout"`, and `"ci"` is rejected at config load. Terms are in `GLOSSARY.md`.
