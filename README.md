# Paws

Agent workflows for engineering teams. A delegated Linear issue is picked up on the developer's machine, implemented by their own Claude Code session over ACP, checked by Closeout, and merged as a pull request.

This repository is the local process. Planning and the issue list live in [pmdroid/paws-planning](https://github.com/pmdroid/paws-planning) (QM-01 through QM-13 are the quick MVP).

## Setup

Install [Bun](https://bun.sh) 1.4 or newer, then:

```sh
bun install
bun run paws setup
bun run paws doctor
bun run paws
```

`setup` writes `~/.paws/config.toml` and the secret files it names. Comment mode and `gh` auth are the defaults: no webhook, no public URL, and no GitHub App. `doctor` is all `ok` before `bun run paws`. A `missing` line includes one fix. When Closeout is not on disk yet, that line is `bun run paws setup --closeout-path <binary>` (`pmdroid/closeout` has no release assets yet).

The process listens on `127.0.0.1:8787`, creates `~/.paws/` (SQLite database, secrets directory, worktrees, logs), and prints `paws ready` plus the dashboard URL. Tests use fakes and do not need external accounts. The real-machine steps are in `docs/smoke-test.md`.

| Path                  | What it is                                   |
| --------------------- | -------------------------------------------- |
| `~/.paws/paws.db`     | SQLite queue (WAL, `synchronous=FULL`)       |
| `~/.paws/config.toml` | Team, repo, mode, and caps from `paws setup` |
| `~/.paws/secrets/`    | Linear token and GitHub App key, mode `0700` |
| `~/.paws/worktrees/`  | One git worktree per item                    |
| `~/.paws/runs/`       | Transcripts and Closeout reports             |
| `~/.paws/logs/`       | Process logs                                 |

`GET /health` returns JSON. `GET /status` serves the status dashboard (run `bun run build:status` first; otherwise the route tells you how). `GET /api/status` returns the live snapshot from the local database (`source: "live"`). `?engine=demo` or `PAWS_STATUS_DEMO=1` still serves the sample stub. Webhook routes stay off unless `config.toml` or `LINEAR_WEBHOOKS` turns them on. When they are on, `POST /webhooks/linear` checks the HMAC signature and timestamp, then commits the delivery before it acknowledges.

## Status dashboard

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
bun run check         # all of the above
```

Module boundaries, how to extend them, and which issue owns which directory are in `AGENTS.md`.
