# Smoke test

Run Paws against a Linear epic with three sub-issues, GitHub pull requests in blocked-by order, one answered question, and one Closeout fix loop. Install Bun 1.4.2 or newer and Git. Pair a Linux runner, sign in to Claude Code, Grok, or Codex on that host for implementation and Codex for review, and connect GitHub App repository access. Pairing is in [Pair a remote Linux runner](runner-pairing.md). GitHub App sign-in is in [GitHub sign-in](github-login.md).

```sh
bun install
bun run build:status
bun run paws --no-tunnel
```

Configure [HTTPS workspace access](workspace-access.md), then open the dashboard. Sign in as a Linear workspace admin and authorize Paws. Connect GitHub in Integrations, select the demo repository, and map it to the sandbox Linear team. Configure a [local Closeout policy](local-closeout.md), or commit `.agents/closeout.yaml` on the repository's `origin/main`. The configured HTTPS origin serves the dashboard at `/status` and health at `/health`.

## Linear work

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

Delegate the parent issue to the Paws app.

Watch the issue comments (each one starts with `Paws:`):

1. `Picked up 3 sub-issues; order: ENG-2 → ENG-3 → ENG-4`.
2. ENG-2 fails Closeout once, the implementer commits a fix, Closeout accepts, a pull request opens (`Fixes ENG-2` on the first line, `Fix attempts: 1` in the body), and Paws squash-merges it.
3. ENG-3 opens and merges after ENG-2.
4. ENG-4 parks on a question comment. Reply in that thread with `yes` or `no`, or with your own words. The run continues with that answer.
5. ENG-4 merges.

### Linear agent sessions

Configure the Linear app callbacks described in [Workspace access](workspace-access.md). Enable **Agent session events** and set the webhook URL to the Paws HTTPS origin followed by `/webhooks/linear`. Set `LINEAR_WEBHOOKS=true` and the matching signing secret on the server.

Sign in on the website and authorize the app as a workspace admin. Delegate the sandbox issue and verify its first activity, questions, Closeout result and GitHub pull request.
