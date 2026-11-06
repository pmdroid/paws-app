# Roll out multiple agent accounts

Paws can run one agent with several named accounts and try them in a configured order. How accounts, bindings, health, selection and continuation work is in [Enroll a remote Linux runner](runner-enrollment.md#agent-accounts-and-bindings). This page is the operator's path from a single-account installation to configured fallback, and what has and has not been proven.

The dashboard does not show named accounts or their order: on the Runners page each runner signs in to its agents once, and that is the setup in use. Named accounts are reached only through the accounts API and `config.toml` below. Leave fallback unconfigured until every gate below is met. An installation with no `[agents.*.accounts]` list runs each role with the runner's default sign-in, exactly as before accounts existed.

## Gates before configuring an order

1. **Paws and every runner that will hold a binding are current.** Named accounts need runner 0.1.61 or later (`AGENT_ACCOUNTS_RUNNER_VERSION` in `src/runner-protocol/versions.ts`). An older runner is never offered a named account and never runs one as its default sign-in.
2. **The agent is supported.** Use only an agent marked Supported in [the adapter matrix](#adapter-matrix). An agent with a reason in `runnerAccountAgentUnsupported` (`src/runner-protocol/accounts.ts`) is refused by Paws and by the runner, and `GET /api/runners/accounts` marks it unsupported.
3. **The accounts are authorized.** Use only provider accounts the workspace is allowed to use under the provider's terms. Paws never buys, shares or distributes credentials. Do not post credentials, tokens or sign-in codes in Linear, the dashboard or `config.toml`; only opaque account and binding ids leave the runner.
4. **Each binding is signed in and reported.** In `GET /api/runners/accounts` every binding you intend to use shows `eligible`, not `auth-required` or `unavailable`.
5. **The preview picks what you expect.** `GET /api/runners/accounts/preview?role=…` names the first account and runner new work would get, and why accounts ahead of it were passed over.
6. **The real-account acceptance run is recorded** for that agent (see [Real-account acceptance](#real-account-acceptance)). Until then, a configured order is a trial on a test workspace, not a rollout.

## Register accounts and bindings

1. As an admin, add an account with `POST /api/runners/accounts`: the agent and a label. The label is for people; Paws refers to the account by its ULID.
2. Link the account to each runner that should hold it. Linking one account to two runners makes two bindings that share one quota, one cooldown and one `concurrency` limit. Paws refuses a second binding of the same account on the same runner.
3. The runner's owner signs in each binding with `POST /api/runners/<runnerId>/accounts/<agent>/login?binding=<bindingId>`. The provider's own interactive sign-in runs inside that binding's private home. Paws never reads the credential and never infers which provider account it is.
4. Optionally set `concurrency` to cap how many executions the account runs at once across all its bindings.

## Configure the order

Edit `config.toml` as in [Account order](runner-enrollment.md#account-order). Start with one role on one project:

```toml
[agents.projects."owner/repo".accounts]
implementer = ["01J...A", "01J...B"]
```

An order never changes the agent, model or effort, and a second account of the reviewer's agent is not an independent reviewer: review only moves to another model through the explicit `reviewer_fallback` profile. Widen to `[agents.defaults.accounts]` after the project has run through at least one fallback and one wait.

## Diagnose

| Question                                    | Where to look                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Why does new work get this account?         | The preview                                                                                                  |
| Why did a run use B instead of A?           | `runner_execution_usage.account_fallback`, shown in the runner's **Execution history**                       |
| Which account ran a command?                | `runner_command_account` (kept after an account is disabled or removed)                                      |
| Why is a binding not eligible?              | Its readiness: `auth-required`, `cooling-down` with its next check, `waiting` or `unavailable`               |
| Why is a run waiting?                       | The run's placement wait names each rejected account and runner, and the earliest next check                 |
| Which accounts did a run already leave?     | `run_fallback_attempt` for the run and call                                                                  |
| Why did admission skip an account in order? | The journal's admission record: the policy revision, the accounts admitted and each skipped account's reason |

A binding that needs sign-in has no next check: sign in again from Runners. **Resume now** on a usage-limit pause makes the agent's account cooldowns due; one real attempt then checks each account.

## Upgrade and roll back

Upgrading applies the account migrations once. Each runner and agent pair that already existed becomes a default sign-in binding (`legacy_<agent>_<runnerId>`) of the workspace's default sign-in account (`legacy_<agent>_<workspaceId>`), with quota scope `unknown`. The runner's own quota and cooldown rows and the execution history are kept as they were.

To turn fallback off, remove the `accounts` lists from `config.toml`. Every role returns to the default sign-in at its next admission; running work keeps the account its command carries until its turn ends. Disable an account rather than removing it if you may want it back: a disabled account keeps its bindings and can still sign in.

To roll Paws back to a release without accounts, first remove the `accounts` lists, wait for running work on named accounts to finish, then install the older release. The older release applies none of its migrations again and does not touch the account tables: accounts, bindings, `runner_command_account` and health rows stay, and the schema refuses deleting them. Reinstalling the newer release finds every account, binding and recorded command account where it was. On a runner, a rollback below 0.1.61 leaves the binding homes under `/var/lib/paws-agent/.paws-accounts` in place and unused; the older runner refuses any command that names an account.

## Adapter matrix

Isolation means the runner gives a binding its own `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and XDG folders, signs in through a staged folder, and never passes `XAI_API_KEY` to a named command.

| Agent      | Named accounts | Synthetic tests                                 | Real two-account run                   |
| ---------- | -------------- | ----------------------------------------------- | -------------------------------------- |
| `claude`   | Supported      | Isolation, sign-in, selection, health, fallback | Blocked: no approved accounts recorded |
| `codex`    | Supported      | Isolation, sign-in, selection, health           | Blocked: no approved accounts recorded |
| `grok`     | Supported      | Isolation, sign-in (`XAI_API_KEY` withheld)     | Blocked: no approved accounts recorded |
| `opencode` | Supported      | Isolation, staged XDG data sign-in              | Blocked: no approved accounts recorded |

"Synthetic" means the real Paws schema, admission, placement, health and runner home code with simulated provider results. No synthetic test calls a provider, and none is evidence that a provider's CLI keeps two accounts apart. `test/account-fallback-matrix.test.ts` fails when an agent the runner accepts has no row here, or when a row's support disagrees with `runnerAccountAgentUnsupported`.

## Fault matrix

Each fault is covered by a deterministic test that drives SQLite and the placement and failover code with a simulated provider.

| Fault                                                          | Test                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Two accounts on one runner, one account on two runners         | `test/account-runner-selection.test.ts`, `test/account-fallback-matrix.test.ts`  |
| A unavailable, B succeeds; all unavailable waits; recheck once | `test/account-fallback-matrix.test.ts`, `test/agent-account-health.test.ts`      |
| Same-account duplicate binding cannot evade the cooldown       | `test/account-fallback-matrix.test.ts`                                           |
| Shared cooldown across one account's runners                   | `test/agent-account-health.test.ts`                                              |
| Stale readiness: unreported binding, offline runner            | `test/account-fallback-matrix.test.ts`                                           |
| Auth repair touches only its binding                           | `test/account-fallback-matrix.test.ts`, `test/runner-account-sign-in.test.ts`    |
| Revoked runner, removed or disabled account, late success      | `test/account-fallback-matrix.test.ts`, `test/agent-account-health.test.ts`      |
| Concurrent reservations take exactly one slot                  | `test/account-runner-selection.test.ts`                                          |
| Stale generation result, cancelled teardown keep the slot      | `test/account-runner-selection.test.ts`                                          |
| Restart keeps attempted bindings and spent budget              | `src/runner-backend/failover.test.ts` (persisted fallback attempts)              |
| Waiting for every account spends no usage-limit budget         | `src/runner-backend/failover.test.ts`                                            |
| Policy edits during a wait apply to the next attempt           | `src/runner-backend/failover.test.ts`, `test/account-policy-dispatch.test.ts`    |
| Reviewer independence: no same-agent account as fallback       | `src/runner-backend/failover.test.ts`, `test/runner-handover-resume.test.ts`     |
| Helper jobs admit the order and hold slots until their result  | `test/account-policy-dispatch.test.ts`, `test/account-runner-selection.test.ts`  |
| Session never restores into another account                    | `test/agent-sessions.test.ts` (`other_account`)                                  |
| Credentials and sessions stay in their binding home            | `test/runner-account-isolation.test.ts`, `src/runner-execution/accounts.test.ts` |
| Wrong-account command, result or heartbeat is refused          | `test/account-fallback-matrix.test.ts`, `src/runner-protocol/accounts.test.ts`   |
| Provider messages and secrets are not stored                   | `test/account-fallback-matrix.test.ts`                                           |
| Legacy upgrade and rollback keep identity and history          | `test/account-fallback-matrix.test.ts`, `src/db/agent-accounts.test.ts`          |

Human holds, questions and the pull request feedback quiet window decide whether an agent turn starts at all. Account selection happens inside a turn that already started, so it cannot release a hold or shorten a quiet window. A session still waiting on its question keeps it (`test/runner-handover-resume.test.ts`), and feedback batching keeps its window (`test/follow-up-ci.test.ts`).

## Real-account acceptance

Real-account acceptance is a separate, approved run. Before it, the workspace owner names an approved test workspace, two authorized accounts of one agent, and any spend limit. Quota is simulated with **Resume now** and the health rows at the supported seam (a usage-limit result or `recordAccountObservation`), not by exhausting paid accounts.

Record, for each agent:

1. The Paws commit, runner version and the agent CLI's version.
2. A → B: account A is marked exhausted, new work places on B, the turn succeeds on B, and the execution history shows `A: agent account quota cooldown`.
3. All unavailable: A and B are both exhausted, the run waits with a next check and no failed attempt, then resumes on the first account to recover.
4. The two bindings' homes on the runner hold separate credentials, and neither command's environment named the other's home.

Until that record exists for an agent, its row in the adapter matrix stays "Blocked" and its fallback stays unconfigured outside a test workspace.
