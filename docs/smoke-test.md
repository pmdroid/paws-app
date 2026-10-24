# Smoke test

Run Paws against a Linear epic with three sub-issues, GitHub pull requests in blocked-by order, one answered question, and one Closeout fix loop. Install Bun 1.4.2 or newer and Git. Pair a Linux runner, sign in to Claude Code, Grok, or Codex on that host for implementation and Codex for review, and connect GitHub App repository access. Pairing is in [Pair a remote Linux runner](runner-pairing.md). GitHub App sign-in is in [GitHub sign-in](github-login.md).

```sh
bun install
bun run build:status
bun run paws --no-tunnel
```

Paws needs a configured Linear workspace. Configure [HTTPS workspace access](workspace-access.md), with `PAWS_PUBLIC_DASHBOARD=1`, then open the dashboard. Sign in as a Linear workspace admin and authorize Paws. Connect GitHub in Integrations, select the demo repository, and map it to the sandbox Linear team. Configure a [local Closeout policy](local-closeout.md), or commit `.agents/closeout.yaml` on the repository's `origin/main`. The configured HTTPS origin serves the dashboard at `/status` and health at `/health`.

Check the prerequisites before delegating:

```sh
bun run paws doctor
```

`linear-workspace` must be ok and name the workspace you signed in to. Without a workspace, Paws logs how to configure one and starts no work.

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

Delegate the parent issue to the Paws app. Delegation is the approval; there is no project to start in Paws.

Each sub-issue runs in its own Linear agent session and its own run. Paws opens a sub-issue's session once the issues that block it have merged. Watch the sessions:

1. The parent's session ends with one response that names each sub-issue. ENG-2 says `started`, ENG-3 says it waits for ENG-2, and ENG-4 says it waits for ENG-3. A message in the parent's session gets a reply that points to the sub-issue sessions. Stopping the parent's session stops them all.
2. In ENG-2's session, ENG-2 fails Closeout once, the implementer commits a fix, Closeout accepts, a pull request opens (`Fixes ENG-2` on the first line, `Fix attempts: 1` in the body), and Paws squash-merges it.
3. ENG-3's session opens after ENG-2 merges, and its pull request merges.
4. ENG-4's session opens after ENG-3 merges. ENG-4 parks on a question in its session. Answer `yes` or `no`, or reply in your own words. The run continues with that answer.
5. ENG-4 merges.

### Linear agent sessions

Configure the Linear app callbacks described in [Workspace access](workspace-access.md). Enable **Agent session events** and set the webhook URL to the Paws HTTPS origin followed by `/webhooks/linear`. Set `LINEAR_WEBHOOKS=true` and the matching signing secret on the server.

Sign in on the website and authorize the app as a workspace admin. Delegate the sandbox issue and verify its first activity, questions, Closeout result and GitHub pull request.

## Runtimes

This run proves a runner installs a repository's runtimes and puts them on `PATH`. How a repository declares them is in [Declare a repository's runtimes](runtimes.md).

1. Install the runner from the newest GitHub release, as in [Pair a remote Linux runner](runner-pairing.md), or upgrade an existing one to it. Pair it and start the daemon.
2. Push `examples/runtimes-demo` from this repository to an empty GitHub repository as its `main`:

   ```sh
   cp -R examples/runtimes-demo /tmp/runtimes-demo
   cd /tmp/runtimes-demo
   git init -b main && git add -A && git commit -m "Runtimes demo"
   gh repo create OWNER/runtimes-demo --private --source . --push
   ```

3. In Integrations, select the new repository and map it to the sandbox Linear team.
4. Create an issue such as **Record runtime versions**: "Add `VERSIONS.md` with the output of `node --version` and `python --version`." Delegate it to the Paws app.

Expect these results:

- The issue's session posts a line that names `node@22` and `python@3.12` and how long the install took.
- Closeout runs `node-version` and `python-version`. Each prints its version and passes only for Node 22 and Python 3.12.
- The pull request opens and Paws merges it.
- On the dashboard, the runner's card under **Runners** lists node 22 and python 3.12 as **Installed**.

Delegate a second issue to the same runner. The install line should take about a second, because the runner reuses both versions.

### Recorded run

On 2026-10-24, on a runner with `paws-runner` 0.1.37 and its shipped mise 2026.10.18:

| Step                                                                 | Result                                          |
| -------------------------------------------------------------------- | ----------------------------------------------- |
| Paws's own task for this page, from `mise.toml` with `bun = "1.4.2"` | Bun 1.4.2 from mise on the agent's `PATH`       |
| Runner bin folder on the agent's `PATH`                              | Absent                                          |
| Runner runtime report for the card                                   | `bun 1.4.2 installed`                           |
| Runner install of `node@22` and `python@3.12`                        | Installed 22.23.4 and 3.12.15 in 5.6 s          |
| Second install of the same versions                                  | Reused, 0.05 s                                  |
| Demo `node-version` and `python-version` checks with those runtimes  | Both pass, printing v22.23.4 and Python 3.12.15 |
| The same checks with only the system `PATH`                          | Both fail                                       |

The delegated `runtimes-demo` task and its card showing node 22 and python 3.12 are not recorded yet.
