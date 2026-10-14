# Paws

Agent workflows for engineering teams. Paws runs on your machine, picks up an issue you hand it, implements the change with your Claude Code, Grok, or Codex session over ACP, checks it with Closeout, and merges a pull request.

Linear is the issue tracker. GitHub hosts the repositories and pull requests. This repository is the local process. Planning and the issue list live in [pmdroid/paws-planning](https://github.com/pmdroid/paws-planning) (QM-01 through QM-13 are the quick MVP).

## Setup

Install [Bun](https://bun.sh) 1.4 or newer, then:

```sh
bun install
bun run paws setup    # connect Linear, sign in with GitHub, and pick a repo
bun run paws doctor
bun run paws
```

Add the `paws` label to a Linear issue or delegate it to the configured Linear user. Paws polls Linear and starts the work. Linear credentials, triggers, and questions are in [docs/linear-modes.md](docs/linear-modes.md). GitHub sign-in, token storage, and the `gh` and App options are in [docs/github-login.md](docs/github-login.md). The real-machine steps are in [docs/smoke-test.md](docs/smoke-test.md).

`setup` writes `~/.paws/config.toml`. It connects your Linear personal API key and team, signs in to GitHub, asks which repository to use, and asks for `agents.implementer` (`claude`, `grok`, or `codex`). Existing GitHub authentication settings are preserved. The dashboard at `http://127.0.0.1:8787` has a **Sign in with GitHub** button. Comment mode polls without a public URL; Linear agent-session mode is also available.

Without `--yes`, setup lists only installed, loginable implementers. On a machine without Claude Code, choose grok and run the printed `grok login`. `doctor` is all `ok` before `bun run paws` (a missing Claude install is a `note` when the implementer is grok). A `missing` line includes one fix. Closeout runs in process: `doctor` checks that `.agents/closeout.yaml` on `origin/main` loads, and a malformed policy prints one fix line. If Grok advertises no auth method, doctor prints:

```text
missing grok: Run `grok login`
```

The process listens on `127.0.0.1:8787`, creates `~/.paws/` (SQLite database, secrets directory, worktrees, logs), and prints `paws ready` plus the dashboard URL. Tests use fakes and do not need external accounts.

| Path                  | What it is                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `~/.paws/paws.db`     | SQLite queue (WAL, `synchronous=FULL`)                                                                           |
| `~/.paws/config.toml` | Linear credentials and team, GitHub auth and repo, caps, and `agents.implementer`                                |
| `~/.paws/secrets/`    | OAuth token file when Keychain or libsecret is unavailable, plus any Linear token or GitHub App key. Mode `0700` |
| `~/.paws/worktrees/`  | One git worktree per item                                                                                        |
| `~/.paws/runs/`       | Transcripts and Closeout reports                                                                                 |
| `~/.paws/logs/`       | Process logs                                                                                                     |

Paws can leave selected folders out of its worktrees. Add literal repository-relative folder paths to `~/.paws/config.toml`:

```toml
[checkout.projects."owner/repo"]
exclude = ["large-assets", "packages/archived"]
```

Paws applies these exclusions before checking out files, including in detached Closeout verification worktrees. The same per-repository settings travel in signed commands to paired runners and apply to their agent worktrees, trusted verification workspaces, and task source snapshots. Excluded files remain tracked in Git. The developer's checkout stays unchanged. Updated settings take effect when Paws next prepares an item worktree; an empty list restores a full checkout. Git preserves edited files when their folder becomes excluded.

`GET /health` returns JSON. `GET /status` serves the status dashboard (run `bun run build:status` first; otherwise the route tells you how). `GET /api/status` returns the live snapshot from the local database (`source: "live"`). `?engine=demo` or `PAWS_STATUS_DEMO=1` still serves the sample stub. Webhook routes stay off unless `config.toml` or `LINEAR_WEBHOOKS` turns them on. When they are on, `POST /webhooks/linear` checks the HMAC signature and timestamp, then commits the delivery before it acknowledges.

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
bun test
bun run build:status  # static dashboard → src/web/dist
bun run links         # local markdown links in README.md and docs/
bun run check         # all of the above
```

Module boundaries, how to extend them, and which issue owns which directory are in `AGENTS.md`.
