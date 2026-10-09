# Local smoke test

This is the real-machine run of the loop. The automated stand-in is `test/loop.e2e.test.ts` (comment mode, `gh` auth, the three-item `examples/paws-demo` epic, one comment answer, one Closeout fix, no webhook and no tunnel). Nothing in that test calls the network.

Run this on the machine that already has Claude Code and Codex logins. Paws does not call `authenticate` and does not read credential files.

## 1. Install

```sh
bun install
```

Bun 1.4.2 or newer. `git` and `gh` on `PATH`.

## 2. Setup

```sh
bun run paws setup
```

Setup asks for a Linear personal API key, the team, and the GitHub repo (`gh` must already be logged in with push access). It writes `~/.paws/config.toml` and puts the API key in `~/.paws/secrets/` at mode `0600`. The mode it writes is **comments**. GitHub auth is **gh**. No webhook URL and no GitHub App.

`pmdroid/closeout` has no release assets yet. Point setup at a Closeout binary you already have:

```sh
bun run paws setup --closeout-path /absolute/path/to/closeout
```

That copies it to `~/.paws/bin/closeout`. Claude and Codex must already be logged in (`claude auth login`, `codex login`). Setup prints those commands; it does not run them.

Optional later: `bun run paws setup` again with `--linear-mode agent-session` when a Linear OAuth app is configured. That is the only path that uses webhooks, a public URL, and ngrok. Leave it unset for the local run.

## 3. Doctor

```sh
bun run paws doctor
```

Every line must be `ok`, and the command exits `0`. A `missing` line names the check and prints one `fix:` line. The default checks are `git`, `bun`, `home`, `linear`, `linear-mode`, `linear-team`, `linear-label`, `gh-login`, `gh-push`, `claude-acp`, `codex-acp`, `claude`, `codex`, `closeout`, and `repository`.

`linear-webhook`, `public-url`, `ngrok`, and `github-app` are not in that list. They appear only when webhooks or GitHub App auth are turned on. Doctor does not print token or key material.

## 4. Start

```sh
bun run paws
```

Expect:

```text
paws ready · http://127.0.0.1:8787
dashboard http://127.0.0.1:8787/status
```

The process listens only on `127.0.0.1`. `GET /health` returns JSON. `GET /api/status` is the live snapshot (`source: "live"`). There is no tunnel line.

## 5. Delegate the demo epic

Push `examples/paws-demo` and reset Linear with `bun scripts/demo-reset.ts --yes` (see that directory's README). The parent is **Export rows**. The three sub-issues merge in `blocks` order:

1. **ENG-2** — fix `exportRows`. Closeout fails once, the fix loop repairs it, then the pull request squash-merges.
2. **ENG-3** — add `exportWithHeader`. Stays queued until ENG-2 merges.
3. **ENG-4** — calls `ask_team` with "Include archived rows?" and options `yes` and `no`.

Label the parent `paws` (setup creates the label) or delegate it to the Linear user in `config.toml`.

Watch the issue comments (each one starts with `Paws:`):

1. `Picked up 3 sub-issues; order: ENG-2 → ENG-3 → ENG-4`.
2. ENG-2 fails Closeout once, the implementer commits a fix, Closeout accepts, a pull request opens (`Fixes ENG-2` on the first line, `Fix attempts: 1` in the body), and `gh` squash-merges it.
3. ENG-3 opens and merges after ENG-2.
4. ENG-4 parks on a question comment. Reply in that thread with `yes` or `no`, or with your own words. The run continues with that answer.
5. ENG-4 merges. The thread gets `Epic complete.`

Stop with a comment whose line is `/paws stop`. That cancels the live run.

Data stays in `~/.paws` (`paws.db`, `worktrees/`, `runs/<identifier>/` for the Closeout verdict). Shut down with Ctrl-C.

Docker is optional. `bun run paws --docker` runs the adapters in the sandbox. One-time container login is `bun run paws login claude --docker` and `bun run paws login codex --docker`. The default run stays on the host.
