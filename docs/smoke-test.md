# Local smoke test

This is the real-machine run of the loop. The automated stand-in is `test/loop.e2e.test.ts` (comment mode, `gh` auth, the three-item `examples/paws-demo` epic, one comment answer, one Closeout fix, no webhook and no tunnel). Nothing in that test calls the network.

Run this on the developer machine that has a Codex login for review, and an implementer login for Claude Code, Grok, or Codex. Paws does not read credential files. For Grok it calls `authenticate` with the advertised method id only (`cached_token`, or `xai.api_key` when `agents.grok.allow_api_key` is true and `XAI_API_KEY` is set). It does not read `~/.grok/auth.json` or the key value.

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

That copies it to `~/.paws/bin/closeout`. Codex stays the reviewer (`codex login`). The implementer is whichever of Claude Code, Grok, or Codex setup offers. Setup prints the login command; it does not run it.

On a machine without Claude Code, the prompt lists grok (the pinned `@xai-official/grok` on `node_modules/.bin`, unless `agents.grok.path` points at another `grok`):

```text
Choose the implementer Paws will run. Only installed, loginable agents are listed.
  1) grok: Run `grok login`
  2) codex: Run `codex login`
```

Type `grok` or `1`. Paws writes `agents.implementer = "grok"` and prints:

```text
Run `grok login`
```

`grok login` opens a browser and caches the session at `~/.grok/auth.json`. Paws never reads that file. Headless and Docker logins use device auth into the agent-home volume:

```sh
grok login --device-auth
```

Mount the agent home so that file persists, then run `grok login --device-auth` inside the container. The next `grok agent stdio` advertises `cached_token`.

`XAI_API_KEY` is an alternative only when `agents.grok.allow_api_key` is true. Leave that false unless you mean to pass the key into the Grok process. Paws still does not print the key. Paws strips `XAI_API_KEY` (unless `allow_api_key` is true), `GITHUB_TOKEN`, `GH_TOKEN`, `SSH_AUTH_SOCK`, and cloud keys out of the agent environment.

Grok is spawned as `grok --no-auto-update agent stdio --no-leader` with the worktree as its cwd. Paws does not pass `--always-approve` or `--yolo`. Tool permission stays on the `session/request_permission` guard.

`--yes` skips the menu and keeps Claude as the implementer. Pass `--implementer grok` to select Grok without the prompt.

Optional later: `bun run paws setup` again with `--linear-mode agent-session` when a Linear OAuth app is configured. That is the only path that uses webhooks, a public URL, and ngrok. Leave it unset for the local run.

## 3. Doctor

```sh
bun run paws doctor
```

Every required line must be `ok`, and the command exits `0`. A `missing` line names the check and prints one `fix:` line. The default checks, when the implementer is Claude, are `git`, `bun`, `home`, `linear`, `linear-mode`, `linear-team`, `linear-label`, `gh-login`, `gh-push`, `claude-acp`, `codex-acp`, `claude`, `codex`, `closeout`, and `repository`. When `agents.implementer` is `grok`, a missing Claude install is a `note` and does not fail the command. If Grok advertises no auth method, doctor prints one actionable line:

```text
missing grok: Run `grok login`
```

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

Docker is optional. `bun run paws --docker` runs the adapters in the sandbox. One-time container login is `bun run paws login claude --docker` and `bun run paws login codex --docker`. For Grok, run `grok login --device-auth` inside the container with the agent-home volume mounted so `cached_token` survives. The default run stays on the host.
