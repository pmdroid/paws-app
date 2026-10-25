# Smoke test

Run Paws against a Linear epic with three sub-issues, GitHub pull requests in blocked-by order, one answered question, and one Closeout fix loop. Install Bun 1.4.2 or newer and Git. Pair a Linux runner, sign in to Claude Code, Grok, or Codex on that host for implementation and Codex for review, and connect GitHub App repository access. Pairing is in [Pair a remote Linux runner](runner-pairing.md). GitHub App setup is in [GitHub App](github-app.md).

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

`linear-workspace` must be ok and name the workspace you signed in to. `github-app`, `github-app-installation` and `github-app-push` must be ok for the demo repository. Without a workspace, Paws logs how to configure one and starts no work.

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

## First delegation by a new Linear user

This run proves that a Linear user who has never used Paws can delegate an issue and see it merged, all in one Linear session. Run it on a disposable Paws instance, with a fresh `~/.paws`, so no membership, runner or GitHub link exists yet. The flow it checks is in [Workspace access](workspace-access.md#first-time-members) and [Linear agent sessions](linear-agent-sessions.md#a-first-delegation).

Prepare the instance as an admin first:

1. Start a disposable Paws with HTTPS workspace access and agent session webhooks, as above. Point it at a sandbox Linear workspace.
2. Sign in as a Linear workspace admin, connect GitHub in Integrations, and map a demo repository to the sandbox team. For Create VM, save an exe.dev token as in [Create a runner VM on exe.dev](create-vm.md).
3. Invite a fresh Linear user to the workspace as a member, not a guest, and add them to the sandbox team. They must never have signed in to this Paws.
4. Create a small issue in the sandbox team, such as "Add a `HELLO.md` that says hello."

Run it as the fresh user, in a private browser window. Take a screenshot of the Linear session after each numbered step, and of the onboarding page at steps 3 to 6.

1. **Delegate.** Delegate the issue to the Paws app. Within 10 seconds the session shows "Picked up this issue." Then it shows one **Sign in to Paws** action with the welcome text and the optional GitHub line. It shows no error.
2. **Wait and reply.** Reply "Use a short file." in the session. Paws posts nothing. Wait at least 15 minutes and confirm the session still shows a single sign-in action.
3. **Sign in.** Select the action and sign in with Linear. The browser lands on `/onboard/<link id>`. **Linear** and **Membership** are done, **Runner** is needed, and the page says how many steps remain. The session gets "You don't have a runner Paws can use yet…" once.
4. **Runner.** Select **Create VM** and watch the four VM steps finish, or select **Add a host** and run the printed command on a Linux host. The runner step then names your runner: "<runner> will run this task."
5. **Agent sign-in.** The **Claude and Codex** step is now needed. Select **Sign in on <runner>** and sign in to Claude and Codex on the Runners page. The step turns to **Connected**. The session posts nothing new here, because the hold already said once what was missing.
6. **GitHub credit.** On the onboarding page, check the consent box and select **Link GitHub**. GitHub returns you to the onboarding page, which shows "Commits will credit @login." The lead says "You're set up."
7. **Automatic start.** Without delegating again, the session shows "Starting <issue> on <runner>." The run follows the earlier reply, then Closeout runs and a pull request opens.
8. **Merged with credit.** Paws merges the pull request. Each commit has a `Co-authored-by` trailer with the fresh user's GitHub noreply address, and the pull request body credits their login.

Check the edges with a second issue delegated by the same fresh user, or by a second fresh user:

- Open the sign-in link while signed in to Linear as someone else. The page says "This link belongs to <name>." and the session does not change.
- Open `/auth/linear?assignment=x`. It answers 410.
- After onboarding finishes, open the `/onboard/<link id>` address in a private window. It answers 404.

After the merge, read `/health` on the instance. Under `linear.items`, the issue shows at most 30 requests for the last hour.

Record the run on the pull request that changes this flow. List the Paws commit, the Linear workspace, and whether the runner came from Create VM or Add a host. Attach one screenshot per session state: the first thought, the sign-in action, the no-runner thought, the start thought, and the merged pull request. Also attach the onboarding page before setup and after "You're set up."

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
