# Paws

Agent workflows for engineering teams. Paws runs on your machine, picks up an issue you hand it, places the work on a paired Linux runner, checks it with Closeout, and merges a pull request.

Linear is the issue tracker. GitHub hosts the repositories and pull requests. This repository is the local process. Planning and the issue list live in [pmdroid/paws-planning](https://github.com/pmdroid/paws-planning) (QM-01 through QM-13 are the quick MVP).

## Setup

Configure the server's HTTPS origin, certificate, Linear OAuth app credentials, and GitHub App credentials as described in [Workspace access](docs/workspace-access.md). Install Bun 1.4 or newer, then start Paws:

```sh
bun install
bun run build:status
bun run paws --no-tunnel
```

Open the configured HTTPS address. A Linear workspace admin signs in and authorizes Paws in the same workspace. Paws saves the app authorization, creates the owner's workspace, and opens Integrations. Connect GitHub, choose repositories and their Linear teams, then [pair a runner](docs/runner-pairing.md) and sign in to its agents through Runners.

Linear holds delegated work and questions. GitHub hosts repositories and pull requests. Paws checks the repository's Closeout policy before publication.

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

Paws applies these exclusions before checking out files, including in detached Closeout verification worktrees. The same per-repository settings travel in signed commands to paired runners and apply to their agent worktrees, trusted verification workspaces, and task source snapshots. Excluded files remain tracked in Git. The developer's checkout stays unchanged. Updated settings take effect when Paws next prepares an item worktree; an empty list restores a full checkout. Git preserves edited files when their folder becomes excluded.

`GET /health` returns JSON. `GET /status` serves the status dashboard (run `bun run build:status` first; otherwise the route tells you how). `GET /api/status` returns the live snapshot from the local database (`source: "live"`). `?engine=demo` or `PAWS_STATUS_DEMO=1` still serves the sample stub. Webhook routes stay off unless `config.toml` or `LINEAR_WEBHOOKS` turns them on. When they are on, `POST /webhooks/linear` checks the HMAC signature and timestamp, then commits the delivery before it acknowledges.

## Updates

When Paws runs from a git checkout, such as `~/.local/share/paws/app`, it compares its commit with `origin/main` every 10 minutes. When `main` is ahead it schedules an update: new work waits, running work finishes, and tasks waiting for an answer, for CI or in the merge queue do not hold it. Then Paws fast-forwards the checkout, runs `bun install --frozen-lockfile` and `bun run build:status`, and exits with code 75 so `systemd` (`Restart=on-failure`) starts the new code. A failed step returns to the old commit and the overview says why.

`bun run paws update` schedules an update by hand. The overview shows **Paws update waiting** with **Update now** and **Cancel** for owners and admins. To turn the automatic check off:

```toml
[update]
automatic = false
```

## Status dashboard

Shared workspaces use [Linear sign-in and workspace access](docs/workspace-access.md) over HTTPS. Owners manage Paws roles and repository mappings in the dashboard.

To connect a Linux VM, follow [Pair a remote Linux runner](docs/runner-pairing.md) for package installation, configuration, agent login and dashboard approval.

The QM-11 status page lives in [`src/web`](src/web/README.md). It is read-only: epics, items, current runs, open questions, Closeout verdicts, and the merge queue. It does not import the rest of the engine.

The Paws engine stays on the developer's machine. The dashboard has two shapes:

- **Local.** `bun run paws` serves `http://127.0.0.1:8787/status` and `GET /api/status` from the same process. The handler is mounted in `src/server` and implemented in `src/web`.
- **Vercel.** A static build of the dashboard only. With no engine configured it shows clearly labeled demo data. Set an engine origin (build-time, the Engine control, or `?engine=`) to poll a local or tunneled `GET /api/status`.

### Deploy

From the repo root, with the [Vercel CLI](https://vercel.com/docs/cli):

```sh
vercel deploy --prod
```

`vercel.json` installs with Bun, runs `bun run build:status`, and publishes `src/web/dist`. That build does not start the engine. The deployed site shows demo data until you point it at an engine:

```sh
PAWS_ENGINE_URL=https://<tunnel-host> vercel deploy --prod
```

Or open `https://<deployment>/?engine=https://<tunnel-host>` after deploy. The tunnel must expose `GET /api/status`. The stub sends `Access-Control-Allow-Origin: *` on that route only.

## Checks

```sh
bun run lint          # oxlint
bun run fmt           # oxfmt, writes
bun run fmt:check     # oxfmt, check only
bun run typecheck     # tsc --noEmit, plus the browser client
bun run test          # bun test --parallel=4 --timeout=20000
bun run build:status  # static dashboard → src/web/dist
bun run links         # local markdown links in README.md and docs/
bun run check         # all of the above
```

Module boundaries, how to extend them, and which issue owns which directory are in `AGENTS.md`.
