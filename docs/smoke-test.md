# Local smoke test

This is the real-machine run of the loop. The automated stand-in is `test/loop.e2e.test.ts` (fake Linear, fake ACP agent, fake Closeout, fake GitHub). Nothing in that test calls the network.

Run this on the developer machine that already has Claude Code and Codex logins. Paws does not call `authenticate` and does not read credential files.

## 1. Install

```sh
bun install
```

Bun 1.4.2 or newer. `git` on `PATH`.

## 2. Linear app

Create an OAuth application in Linear with **actor = app** (not a user).

Scopes, exactly:

```text
read,write,app:assignable,app:mentionable
```

Enable the **Agent session events** webhook category. Set the webhook URL to the ngrok dev domain from the next step:

```text
https://<dev-domain>.ngrok-free.app/webhooks/linear
```

Copy the webhook signing secret into `LINEAR_WEBHOOK_SECRET`.

Put the client id and secret in the environment. A token can live in `LINEAR_ACCESS_TOKEN` (and `LINEAR_REFRESH_TOKEN` when the app issued one). On first start Paws copies that token to `~/.paws/secrets/linear-oauth.json` (mode `0600`) and refreshes it. Do not commit the file.

## 3. ngrok dev domain

Claim one free ngrok dev domain and an authtoken.

```sh
# example values — use the domain ngrok assigned
PAWS_PUBLIC_URL=https://<dev-domain>.ngrok-free.app
NGROK_AUTHTOKEN=<authtoken>
```

`bun run paws` starts `ngrok http --url=<PAWS_PUBLIC_URL> 8787` itself. Leave `PAWS_NO_TUNNEL` unset. The webhook URL above must be that same origin plus `/webhooks/linear`.

## 4. GitHub App

Create a GitHub App installed on **one** repository (the smoke repo, for example `pmdroid/paws-demo`).

Permissions:

| Permission    | Access         |
| ------------- | -------------- |
| Contents      | Read and write |
| Pull requests | Read and write |
| Checks        | Read and write |
| Metadata      | Read-only      |

Download the private key and store it under `~/.paws/secrets/` at mode `0600` or `0400`:

```sh
mkdir -p ~/.paws/secrets
mv ~/Downloads/<app>.pem ~/.paws/secrets/github-app.pem
chmod 600 ~/.paws/secrets/github-app.pem
```

```sh
GITHUB_APP_ID=<numeric app id>
GITHUB_APP_INSTALLATION_ID=<numeric installation id>
GITHUB_APP_PRIVATE_KEY_PATH=$HOME/.paws/secrets/github-app.pem
PAWS_GITHUB_REPOSITORY=<owner>/<repo>
```

The installation token must expire within an hour and cover that single repository. Paws mints a new token for each push and each merge.

## 5. Closeout

Install Closeout **0.1.0** and put the `closeout` binary on `PATH` (or set `CLOSEOUT_BIN` to its absolute path).

```sh
closeout --version
```

The line must contain `0.1.0`. The smoke repository's default branch should contain the Closeout policy the binary expects (`.agents/closeout.yaml`).

## 6. Claude and Codex logins

Both adapters must already be logged in on this machine. Paws only spawns them.

```sh
claude-agent-acp    # or set PAWS_CLAUDE_ACP to the executable
codex-acp           # or set PAWS_CODEX_ACP to the executable
```

Confirm each CLI can start with the existing login (Claude Code subscription or `~/.claude`, Codex login). Do not put API keys in the Paws environment. Paws strips `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`, and `SSH_AUTH_SOCK` out of the agent environment.

## 7. Check, then start

Copy `.env.example` to `.env` and fill the values above. Then:

```sh
bun run paws doctor
```

Every line must be `ok`. A `missing` line names the check (`git`, `bun`, `home`, `linear`, `linear-webhook`, `public-url`, `ngrok`, `claude`, `codex`, `closeout`, `repository`, `github-app`). The command exits `0` only when all of them pass. It does not print token or key material.

```sh
bun run paws
```

Expect:

```text
paws ready · http://127.0.0.1:8787 · tunnel https://<dev-domain>.ngrok-free.app
```

`GET http://127.0.0.1:8787/health` returns JSON. Paths other than the webhook routes are not served on the public URL.

## 8. Delegate one epic

In the GitHub repository from `PAWS_GITHUB_REPOSITORY`, use a parent issue with two sub-issues (the recorded demo in the Quick MVP plan uses three: export endpoint, a follow-up that touches the same file, and a product decision). For this smoke, two are enough:

1. **ENG-a** — a small change, and a Closeout command that fails once so the fix loop runs.
2. **ENG-b** — blocked by ENG-a (`blocks`), and the instructions tell the agent to call `ask_team` with options `yes` and `no` (for example "Include archived rows?").

Delegate the **parent** to the Paws app user.

Watch the Linear agent session:

1. Within 10 seconds: `Picked up 2 sub-issues; order: …`.
2. Thoughts, tool calls, and the final note show up as activities. A keepalive is posted before Linear's 30 minute stale window.
3. ENG-a fails Closeout once, the implementer commits a fix, Closeout accepts, a pull request opens (`Fixes ENG-a` on the first line, Closeout evidence in the body), and the GitHub App squash-merges it.
4. ENG-b stays queued until ENG-a is merged, then runs. `ask_team` parks the item in **awaiting input** and posts an elicitation with a `select` signal. Reply with one of the options, or with your own words.
5. The same session continues with that answer. If the process had to start a fresh session instead, the prompt begins with `Handoff from the previous session.`
6. ENG-b merges. The session gets `Epic complete.`

Stop from the Linear session cancels the live run. `agentAlive` for that run id drops when the agent process is gone.

Data stays in `~/.paws` (`paws.db`, `worktrees/`, `runs/<identifier>/` for the Closeout verdict). Shut down with Ctrl-C.
