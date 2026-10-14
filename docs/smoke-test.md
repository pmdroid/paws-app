# Smoke test

Run Paws against a Linear epic with three sub-issues, GitHub pull requests in blocked-by order, one answered question, and one Closeout fix loop. Install Bun 1.4.2 or newer and Git. Pair a Linux runner, sign in to Claude Code, Grok, or Codex on that host for implementation and Codex for review, and connect GitHub App repository access. Pairing is in [Pair a remote Linux runner](runner-pairing.md). GitHub App sign-in is in [GitHub sign-in](github-login.md).

```sh
bun install
bun run paws setup --checkout /path/to/paws-demo --repo owner/paws-demo
bun run paws doctor
bun run paws
```

Setup connects Linear and your GitHub repository. See [GitHub sign-in](github-login.md) for OAuth, App, and gh authentication. Configure a [local Closeout policy](local-closeout.md), or commit `.agents/closeout.yaml` on the repository's `origin/main`, before running doctor. Every required doctor check must be `ok`; a `missing` line includes a fix. The process listens on `127.0.0.1:8787`, with the dashboard at `/status` and health at `/health`.

## Linear comments

[Comment mode](linear-modes.md) is the default. Run `bun run paws setup` from this repository. Setup asks for a Linear personal API key and the team, writes `[tracker] kind = "linear"` and `[linear] mode = "comments"`, and keeps GitHub for pull requests. Comment mode uses no webhook URL and no public URL.

Reset the demo epic from a checkout of this repository:

```sh
./examples/paws-demo/scripts/push-template.sh --yes
LINEAR_API_KEY=lin_api_... bun scripts/demo-reset.ts --yes
```

`LINEAR_ACCESS_TOKEN` is accepted when `LINEAR_API_KEY` is unset. Optional: `PAWS_DEMO_TEAM` (Linear team key, default `ENG`) and `PAWS_DEMO_REPO`.

The parent is **Export rows**. The three sub-issues merge in `blocks` order:

1. **ENG-2** — fix `exportRows`. Closeout fails once, the fix loop repairs it, then the pull request squash-merges.
2. **ENG-3** — add `exportWithHeader`. Stays queued until ENG-2 merges.
3. **ENG-4** — calls `ask_team` with "Include archived rows?" and options `yes` and `no`.

Label the parent `paws` (setup creates the label) or delegate it to the Linear user in `config.toml`.

Watch the issue comments (each one starts with `Paws:`):

1. `Picked up 3 sub-issues; order: ENG-2 → ENG-3 → ENG-4`.
2. ENG-2 fails Closeout once, the implementer commits a fix, Closeout accepts, a pull request opens (`Fixes ENG-2` on the first line, `Fix attempts: 1` in the body), and Paws squash-merges it.
3. ENG-3 opens and merges after ENG-2.
4. ENG-4 parks on a question comment. Reply in that thread with `yes` or `no`, or with your own words. The run continues with that answer.
5. ENG-4 merges. The thread gets `Epic complete.`

With gh authentication and the Claude implementer, doctor includes `git`, `bun`, `home`, `linear`, `linear-mode`, `linear-team`, `linear-label`, `gh-login`, `gh-push`, `claude-acp`, `codex-acp`, `claude`, `codex`, `closeout`, and `repository`. `linear-webhook`, `public-url`, `ngrok`, and `github-app` appear only when webhooks or GitHub App auth are turned on.

### Linear agent sessions

Create a Linear OAuth application named Paws. Register `http://localhost:3000/oauth/callback` as its redirect URI. Enable webhooks, select **Agent session events**, and set the webhook URL to `https://YOUR-NGROK-DOMAIN/webhooks/linear`.

Run:

```sh
bun run paws setup --tracker linear --linear-mode agent-session
```

Enter the application's client ID and client secret. Open the authorization link printed by setup and approve the installation as a workspace admin. Setup listens on loopback port 3000, verifies the returned state, exchanges the code, and stores the access token, refresh token, and expiry under `~/.paws/secrets/`. The callback listener closes when authorization completes.

Configure ngrok authentication, set `LINEAR_WEBHOOK_SECRET` to the application's webhook signing secret, and run these commands in the same shell:

```sh
export LINEAR_WEBHOOKS=true
export PAWS_PUBLIC_URL=https://YOUR-NGROK-DOMAIN
bun run paws doctor
bun run paws
```

Paws starts the ngrok tunnel for that domain. Delegate the parent issue to Paws in Linear to start an agent session.
