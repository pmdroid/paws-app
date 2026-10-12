# Verification and implementation map

Each implementation change should carry local proof of the behavior it adds. The proof ties the tested source revision to its commands, observations, and review results.

## Run the local checks

From a checkout of the implementation branch:

```sh
bun install
bun run check
```

`check` runs lint, formatting validation, TypeScript checking, and tests. Module fakes keep the automated tests independent of Linear, GitHub, ACP providers, and Closeout services.

For a configured local installation:

```sh
bun run paws doctor
bun run paws
```

The [local smoke test](https://github.com/pmdroid/paws-app/blob/07d8458de8f9e1579eaee626396d4573baf1a4da/docs/smoke-test.md) provides the setup and expected issue conversation. Use the [project verification skill](https://github.com/pmdroid/paws-app/tree/07d8458de8f9e1579eaee626396d4573baf1a4da/.agents/skills/verify-paws) for disposable instances, scripted agents, fake trackers, real SQLite, worktrees, and local merge proof.

## Prove the feature where it runs

| Feature               | Useful evidence                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| Workspace access      | Browser sign-in, membership changes, role checks, CSRF rejection, and cross-workspace rejection.         |
| Pairing and mTLS      | A real HTTPS pairing exchange, certificate authentication, renewal, revocation, and rejected identities. |
| Host installation     | Package validation, selected-release identity, interruption at installer checkpoints, and recovery.      |
| Agent login bootstrap | The actual selected launcher, process UID and home, provider version, and login-status output.           |
| Repository delivery   | The assigned base SHA, prepared bundle, candidate SHA, ancestry check, and push destination.             |
| Results and questions | Repeated delivery, persistence after reopening SQLite, answer ordering, and payload limits.              |
| Runner health         | Real mTLS submission, persisted health, replay behavior, and oversized-stream cancellation.              |
| Dashboard             | Actual API data, role-specific controls, working links, and desktop and mobile browser observations.     |

Record a failing baseline and a passing treatment when fixing a regression. Keep raw reports, the tested revision, and the final source hash. Distinguish scripted provider behavior from an observation made against a real provider CLI or authenticated service.

## Implementation map

| Responsibility                       | Owning module                               | Source or contract                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime composition                  | `src/index.ts`                              | [Local workflow](https://github.com/pmdroid/paws-app/blob/07d8458de8f9e1579eaee626396d4573baf1a4da/src/index.ts)                                                   |
| State transitions                    | `src/core`                                  | [Core](https://github.com/pmdroid/paws-app/tree/07d8458de8f9e1579eaee626396d4573baf1a4da/src/core)                                                                 |
| Database and durable delivery        | `src/db`                                    | [Database](https://github.com/pmdroid/paws-app/tree/07d8458de8f9e1579eaee626396d4573baf1a4da/src/db)                                                               |
| Linear intake and activity           | `src/linear`, `src/intake`, `src/loop`      | [Linear adapter](https://github.com/pmdroid/paws-app/tree/07d8458de8f9e1579eaee626396d4573baf1a4da/src/linear)                                                     |
| Workspace access                     | `src/workspace`                             | [PR 238](https://github.com/pmdroid/paws-app/pull/238)                                                                                                             |
| Browser dashboard                    | `src/web`                                   | [PR 243](https://github.com/pmdroid/paws-app/pull/243)                                                                                                             |
| Signed runner commands               | `src/runner-protocol`                       | [PR 207](https://github.com/pmdroid/paws-app/pull/207)                                                                                                             |
| Certificates and pairing             | `src/runner-identity`, `src/runner-control` | [PR 236](https://github.com/pmdroid/paws-app/pull/236)                                                                                                             |
| Runner work and results              | `src/runner-work`, `src/runner-results`     | [PR 235](https://github.com/pmdroid/paws-app/pull/235), [PR 247](https://github.com/pmdroid/paws-app/pull/247)                                                     |
| Runner daemon                        | `src/runner-daemon`                         | [PR 231](https://github.com/pmdroid/paws-app/pull/231)                                                                                                             |
| Linux execution exchange             | `src/runner-execution`                      | [PR 248](https://github.com/pmdroid/paws-app/pull/248)                                                                                                             |
| Repository snapshots and publication | `src/runner-repositories`                   | [PR 227](https://github.com/pmdroid/paws-app/pull/227)                                                                                                             |
| Installation and provider launchers  | `deploy/linux`                              | [PR 244](https://github.com/pmdroid/paws-app/pull/244), [PR 245](https://github.com/pmdroid/paws-app/pull/245)                                                     |
| Runner health                        | `src/runner-health`                         | [PR 249](https://github.com/pmdroid/paws-app/pull/249)                                                                                                             |
| Agent execution                      | `src/acp`                                   | [ACP](https://github.com/pmdroid/paws-app/tree/07d8458de8f9e1579eaee626396d4573baf1a4da/src/acp)                                                                   |
| Verification                         | `src/closeout`, `src/runner-check-inputs`   | [Closeout](https://github.com/pmdroid/paws-app/tree/07d8458de8f9e1579eaee626396d4573baf1a4da/src/closeout), [PR 239](https://github.com/pmdroid/paws-app/pull/239) |
| Pull requests and merge              | `src/github`, `src/loop`                    | [GitHub adapter](https://github.com/pmdroid/paws-app/tree/07d8458de8f9e1579eaee626396d4573baf1a4da/src/github)                                                     |

## Review and CI proof

A review report names the exact changed files and comparison base. Verify actionable findings against the code, fix them, and rerun the affected proof. Keep failed or incomplete review attempts with their actual disposition.

The pull request should connect the implemented behavior to its local verification commands and artifacts. CI results must refer to the same published commit. The [project tracker](https://github.com/pmdroid/paws-planning/issues) records milestone acceptance and remaining decisions.
