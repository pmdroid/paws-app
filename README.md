# Paws

Agent workflows for engineering teams. Paws runs on your machine, picks up an issue you hand it, implements the change with your Claude Code, Grok, or Codex session over ACP, checks it with Closeout, and merges a pull request.

GitHub issues are the default tracker. Linear remains available. This repository is the local process. Planning and the issue list live in [pmdroid/paws-planning](https://github.com/pmdroid/paws-planning) (QM-01 through QM-13 are the quick MVP).

## Setup

Install [Bun](https://bun.sh) 1.4 or newer, then:

```sh
bun install
bun run paws setup    # sign in with GitHub, pick a repo; tracker defaults to github; implementer is claude, grok, or codex
bun run paws doctor
bun run paws
```

Add the `paws` label to an issue in the repository you picked. Paws polls that repository and starts the work. Sign-in, token storage, and the `gh` and App options are in [docs/github-login.md](docs/github-login.md). Triggers, epic order, and the comment protocol are in [docs/github-issues.md](docs/github-issues.md). The real-machine steps are in [docs/smoke-test.md](docs/smoke-test.md).

`setup` writes `~/.paws/config.toml`. It runs the GitHub device-flow sign-in, asks which repository to use, sets `[tracker] kind` to `github`, and asks for `agents.implementer` (`claude`, `grok`, or `codex`). The dashboard at `http://127.0.0.1:8787` has a **Sign in with GitHub** button that starts the same device flow. The default path uses no webhook, no public URL, and no GitHub App.

Without `--yes`, setup lists only installed, loginable implementers. On a machine without Claude Code, choose grok and run the printed `grok login`. `doctor` is all `ok` before `bun run paws` (a missing Claude install is a `note` when the implementer is grok). A `missing` line includes one fix. When Closeout is not on disk yet, that line is `bun run paws setup --closeout-path <binary>` (`pmdroid/closeout` has no release assets yet). If Grok advertises no auth method, doctor prints:

```text
missing grok: Run `grok login`
```

The process listens on `127.0.0.1:8787`, creates `~/.paws/` (SQLite database, secrets directory, worktrees, logs), and prints `paws ready` plus the dashboard URL. Tests use fakes and do not need external accounts.

| Path                  | What it is                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `~/.paws/paws.db`     | SQLite queue (WAL, `synchronous=FULL`)                                                              |
| `~/.paws/config.toml` | `github` auth and repo, `[tracker] kind`, caps, and `agents.implementer`                            |
| `~/.paws/secrets/`    | OAuth token file when Keychain or libsecret is unavailable, plus any Linear token or GitHub App key. Mode `0700` |
| `~/.paws/worktrees/`  | One git worktree per item                                                                           |
| `~/.paws/runs/`       | Transcripts and Closeout reports                                                                    |
| `~/.paws/logs/`       | Process logs                                                                                        |

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
bun run links         # local markdown links in README.md and docs/
bun run check         # all of the above
```

Module boundaries, how to extend them, and which issue owns which directory are in `AGENTS.md`.
