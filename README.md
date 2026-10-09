# Paws

Agent workflows for engineering teams. A delegated Linear issue is picked up on the developer's machine, implemented by their own Claude Code session over ACP, checked by Closeout, and merged as a pull request.

This repository is the local process. Planning and the issue list live in [pmdroid/paws-planning](https://github.com/pmdroid/paws-planning) (QM-01 through QM-13 are the quick MVP).

## Setup

Install [Bun](https://bun.sh) 1.4 or newer, then:

```sh
bun install
bun run paws
```

The process listens on `127.0.0.1:8787`, creates `~/.paws/` (SQLite database, secrets directory, worktrees, logs), and prints `paws ready`. No external accounts are required for this foundation. Copy `.env.example` to `.env` when you have Linear and GitHub App credentials.

| Path                  | What it is                                   |
| --------------------- | -------------------------------------------- |
| `~/.paws/paws.db`     | SQLite queue (WAL, `synchronous=FULL`)       |
| `~/.paws/config.toml` | Team, repo, and caps (parser not wired yet)  |
| `~/.paws/secrets/`    | Linear token and GitHub App key, mode `0700` |
| `~/.paws/worktrees/`  | One git worktree per item                    |
| `~/.paws/runs/`       | Transcripts and Closeout reports             |
| `~/.paws/logs/`       | Process logs                                 |

`GET /health` returns JSON. `GET /status` is a static stub. `POST /webhooks/linear` checks the HMAC signature and timestamp, then commits the delivery before it acknowledges. GitHub webhooks still fail closed.

## Checks

```sh
bun run lint        # oxlint
bun run fmt         # oxfmt, writes
bun run fmt:check   # oxfmt, check only
bun run typecheck   # tsc --noEmit
bun test
bun run check       # all of the above
```

Module boundaries, how to extend them, and which issue owns which directory are in `AGENTS.md`.
