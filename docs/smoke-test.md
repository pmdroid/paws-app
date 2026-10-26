# Smoke test

Run Paws against a Linear epic with three sub-issues, GitHub pull requests in blocked-by order, one answered question, and one Closeout fix loop, then exercise the merge lane: a rebase after main moved, a changes-requested review and a forced conflict loop. Install Bun 1.4.2 or newer and Git. Enroll a Linux runner, sign in to Claude Code, Grok, or Codex on that host for implementation and Codex for review, and connect GitHub App repository access. Enrollment is in [Enroll a remote Linux runner](runner-enrollment.md). GitHub App setup is in [GitHub App](github-app.md).

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

## Merge lane

These runs prove that every merged head is one Closeout accepted, that a review reaches the agent without a Linear paste, and that a conflict loop ends in one question. Terms are in [GLOSSARY.md](../GLOSSARY.md); the flow is in [After acceptance](closeout.md#after-acceptance). Use the demo repository with `[merge] order = "queue"`, the default. Reset the demo first, and for each run create a fresh issue in the sandbox team and delegate it to the Paws app.

Hold an item in the merge queue while you act: in the demo repository's branch protection on `main`, require one approving review. Branch protection then keeps `mergeable(S)` false. Release the hold by approving the pull request when the step says so.

### Rebase after main moved

1. Delegate **Add a comment to `exportRows`**: "Add a one-line doc comment above `exportRows` in `src/export.ts`." Wait until the session posts the pull request response and the item is in `merge_queue`.
2. Push an unrelated commit to `main`, for example a line appended to `README.md`.
3. Release the hold.

Expect these results:

- The lane finds the head behind `main`, rebases it to a new head S', and the item returns to `verifying`. The session title reads "rebased onto main, re-verifying" and the plan gains a **Re-verify after rebase** step. No new activity appears after the pull request response.
- Closeout runs on S'; the run page shows a Closeout result for S' next to the one for the first head.
- The squash merge has S' as its head, and the session ends with the merged response.

### Changes-requested review

1. Delegate **Name the header row**: "`exportWithHeader` takes an optional `header` argument." Wait for the pull request and the merge queue, with the hold in place.
2. On GitHub, submit a review with **Request changes** and two line comments: one clear ("rename `header` to `headerRow`") and one unclear ("should this match the CSV spec?").
3. Submit a second review on the same pull request with **Comment** only and one line comment.

Expect these results:

- The changes-requested review restarts the item once (restart reason `review`). The title reads "fixing review findings (1 of 3)". The agent renames the argument and asks in the session about the CSV question; that question is the one activity after the pull request response. Answer it.
- The comment-only review posts its thread once in the session and restarts nothing.
- Redelivering the changes-requested webhook from the GitHub App's advanced settings restarts nothing.
- The new head goes through Closeout. Resolve the threads and approve; the pull request merges.

### Forced conflict loop

1. Delegate **Rename the export file**: "Rename `exportRows` to `exportTable` everywhere." Wait for the pull request and the merge queue, with the hold in place.
2. Push a commit to `main` that edits the same lines of `src/export.ts` differently, and release the hold. The lane's rebase conflicts, and the item restarts with reason `conflict` and the conflicting files.
3. Each time the agent pushes a resolved head and the item is back in `merge_queue`, push another conflicting commit to the same lines on `main`.

Expect these results:

- Each conflict is a rebase return. The title reads "resolving merge conflict", and the lane is released before the agent starts.
- On the fourth conflict, Paws does not restart the agent. It asks one question in the session that names the main commits and the conflicting files, and the item waits in `awaiting_input`. A newer `main` does not reset the count.
- Reply with guidance. The item restarts with reason `answer` and a fresh budget, resolves the conflict, goes through Closeout and merges.

### Record the run

For each run, keep the Linear session, the GitHub pull request and the Paws run page. Publish a screenshot of each session and of each run page's Closeout results on the PAS issue for the run, and link the merged pull requests.

### Linear agent sessions

Configure the Linear app callbacks described in [Workspace access](workspace-access.md). Enable **Agent session events** and set the webhook URL to the Paws HTTPS origin followed by `/webhooks/linear`. Set `LINEAR_WEBHOOKS=true` and the matching signing secret on the server.

Sign in on the website and authorize the app as a workspace admin. Delegate the sandbox issue and verify its first activity, questions, Closeout result and GitHub pull request.

### Plan outcome

This run proves a planning request becomes sub-issues that intake can run. Use an issue with no sub-issues in the sandbox team, labelled with the demo repository, such as **Plan CSV export**: "Plan this: split CSV export into sub-issues we can ship one at a time." Delegate it to the Paws app.

1. The session's title reads `ENG-n: planning sub-issues`. The plan turn runs read-only on the runner: it reads the repository and `.agents/closeout.yaml` and changes no files.
2. The session asks one question. It lists the proposed sub-issues in blocks order, each with a description and acceptance criteria that name Closeout checks and any screenshots they need. The buttons are **Create k sub-issues**, **Edit** and **Discard**.
3. Press **Edit**. Paws asks what to change. Reply with a change such as "Merge the last two sub-issues." A new plan turn runs, and the question comes back with the revised list.
4. Press **Create k sub-issues**. The session ends with one response that links each created identifier. In Linear, the sub-issues sit under the parent in the proposed order, carry the repository label, and are linked by `blocks` relations. None is delegated.
5. Delegate the first sub-issue. Intake runs it, and the next one waits for it to merge.

**Discard** instead of Create ends the session with "Discarded the proposal. Nothing was filed." Only someone who may answer Paws questions in the workspace can press the buttons.

## Runtimes

This run proves a runner installs a repository's runtimes and puts them on `PATH`. How a repository declares them is in [Declare a repository's runtimes](runtimes.md).

1. Install the runner from the newest GitHub release, as in [Enroll a remote Linux runner](runner-enrollment.md), or upgrade an existing one to it. Enroll it and start the daemon.
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
