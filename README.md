# Paws

Agent workflows for engineering teams. Paws runs on your machine, picks up an issue you hand it, places the work on a paired Linux runner, checks it with Closeout, and merges a pull request.

Linear is the issue tracker. GitHub hosts the repositories and pull requests. This repository is the local process.

## Setup

Configure the server's HTTPS origin, certificate, Linear OAuth app credentials, and GitHub App credentials as described in [Workspace access](docs/workspace-access.md). Install Bun 1.4 or newer, then start Paws:

```sh
bun install
bun run build:status
bun run paws
```

Open the configured HTTPS address. A Linear workspace admin signs in and authorizes Paws in the same workspace. Paws saves the app authorization, creates the workspace with that person as its first admin, and opens Integrations. Connect GitHub, choose repositories and their Linear teams, then [enroll a runner](docs/runner-enrollment.md) and sign in to its agents through Runners.

Paws runs work only for a configured Linear workspace. `bun run paws doctor` reports `linear-workspace` as missing until `PAWS_PUBLIC_DASHBOARD=1` is set and a workspace admin has signed in.

### Upgrading

Read [CHANGELOG.md](CHANGELOG.md) before upgrading; breaking changes come first in each entry. Every `config.toml` setting is in the [configuration reference](docs/configuration.md).

Paws requires a configured Linear workspace. An existing install that runs from environment variables alone, without `PAWS_PUBLIC_DASHBOARD=1`, keeps serving the dashboard after the upgrade but starts no work and logs how to configure a workspace. Set up [Workspace access](docs/workspace-access.md), restart Paws, sign in as a Linear workspace admin, then run `bun run paws doctor` and check that `linear-workspace` is ok.

Linear holds delegated work and questions. GitHub hosts repositories and pull requests. Paws checks the repository's Closeout policy before publication.

To start work, delegate an issue to the Paws app in Linear. Delegation is the approval. Delegate a parent issue to run its sub-issues in Linear `blocks` order, each in its own Linear session that opens once its blockers merge. A project is the Linear project the issue belongs to, and Paws has no project start of its own. To choose the repository for an issue, see [Repository selection](docs/repository-selection.md).

| Path                          | What it is                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `~/.paws/paws.db`             | SQLite queue (WAL, `synchronous=FULL`)                                                                           |
| `~/.paws/config.toml`         | Linear credentials and team, GitHub auth and repo, caps, and `agents.implementer`                                |
| `~/.paws/secrets/`            | OAuth token file when Keychain or libsecret is unavailable, plus any Linear token or GitHub App key. Mode `0700` |
| `~/.paws/worktrees/`          | One git worktree per item                                                                                        |
| `~/.paws/runs/`               | Transcripts and Closeout reports                                                                                 |
| `~/.paws/runner-transcripts/` | Paired runner transcripts, stored locally by default                                                             |
| `~/.paws/logs/`               | Process logs                                                                                                     |

Paws can leave selected folders out of its worktrees. Add literal repository-relative folder paths to `~/.paws/config.toml`:

```toml
[checkout.projects."owner/repo"]
exclude = ["large-assets", "packages/archived"]
```

Paws applies these exclusions before checking out files, including in detached Closeout verification worktrees. The same per-repository settings travel in signed commands to enrolled runners and apply to their agent worktrees, trusted verification workspaces, and task source snapshots. Excluded files remain tracked in Git. The developer's checkout stays unchanged. Updated settings take effect when Paws next prepares an item worktree; an empty list restores a full checkout. Git preserves edited files when their folder becomes excluded.

`GET /health` returns JSON with `ok`, `checks`, and `failedChecks`, using HTTP 200 when healthy and 503 when a check fails. Checks read the database, expired or missing running-job leases, dead jobs and outbox rows, and active runner heartbeats. A runner is stale after the one-minute offline window plus the five-minute lease grace; paused and revoked runners are excluded, and no active runners is reported as skipped. When webhook routes and a provider's signing secret are configured, its last verified Linear or accepted GitHub delivery must be no more than one hour old; no delivery yet fails that check. Disabled providers are reported as skipped. Health failures and recovery are written to the journal. The response is not cached. `GET /status` serves the status dashboard (run `bun run build:status` first; otherwise the route tells you how). `GET /api/status` returns the live snapshot from the local database (`source: "live"`). Webhook routes stay off unless `config.toml` or `LINEAR_WEBHOOKS` turns them on. When they are on, `POST /webhooks/linear` checks the HMAC signature and timestamp, then commits the delivery before it acknowledges.

## Deploys

A restart is safe while work is running; deploys need no idle wait. Runners keep working while Paws is down and retain their results until it returns. Paws reattaches to the same commands after startup, including in-flight Closeout reviews and answer tasks.

Paws never changes its own checkout or restarts itself. To deploy a new commit, update the checkout Paws runs from and restart the service:

```sh
cd ~/.local/share/paws/app
git fetch && git checkout <commit>
bun install --frozen-lockfile
bun run build:status
systemctl --user restart paws.service
```

## Status dashboard

Shared workspaces use [Linear sign-in and workspace access](docs/workspace-access.md) over HTTPS. Admins manage Paws roles and repository mappings in the dashboard.

To connect a Linux VM, follow [Enroll a remote Linux runner](docs/runner-enrollment.md) for package installation, configuration, agent login and enrollment.

The status page lives in [`src/web`](src/web/README.md). It is read-only: items, current runs, open questions, Closeout verdicts, and the merge queue. It does not import the rest of the engine.

The dashboard reads `/api/status` from the Paws process that serves it. Build it with `bun run build:status`, then start Paws with `bun run paws` and open `http://127.0.0.1:8787/status`. An empty database shows no items.

## Checks

```sh
bun run lint          # oxlint
bun run fmt           # oxfmt, writes
bun run fmt:check     # oxfmt, check only
bun run typecheck     # tsc --noEmit, plus the browser client
bun run test          # bun test --parallel=4 --timeout=20000
bun run build:status  # static dashboard → src/web/dist
bun run links         # docs links, orphaned docs and dead source paths
bun run knip          # unused files, dependencies and duplicate exports
bun run check         # all of the above
```

Module boundaries, how to extend them, and which issue owns which directory are in `AGENTS.md`.
