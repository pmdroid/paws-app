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

Each sub-issue's session is one story. Before the pull request, activities tell it and the title names the phase. After the pull request response, only the title and plan move. The face of each state is in [Linear agent sessions](linear-agent-sessions.md#the-face-table). Expect, for each sub-issue:

- Exactly two responses: the pull request response, then the final response "Merged #N into main at <sha>. ENG-n is Done." Nothing appears between them, not even evidence: evidence after the pull request is attached to the issue.
- After the merge the title reads `ENG-n: completed`, every plan step is completed, and the issue is Done. The session is complete, not stale.
- ENG-3, while it waits for ENG-2, has the title `ENG-3: waiting for ENG-2`, an in-progress **Wait for ENG-2** step, and an ephemeral "Still waiting for ENG-2." at most every 25 minutes.

## Stop

This run proves a stop ends in one response that says what is left on the branch. Delegate a fresh issue in the sandbox team, such as **Add a CSV footer**: "Append a total row to `exportRows` output." Wait for the agent's first commit, then stop it before the pull request opens.

1. Press stop on the Linear session. The session ends with one response, for example "Stopped. Branch paws/eng-n has 1 commit; no PR was opened. Re-delegate to continue." The title reads `ENG-n: stopped` and the remaining plan steps are canceled.
2. Re-delegate the issue and wait for the pull request response. Reply `/paws stop` in the session. The one response names the branch and its commits, and says `PR #N will be closed`, because a stop in the merge queue closes the pull request. Nothing follows it.
3. Delegate another issue and take it over from the dashboard. The session ends with "Taken over by <who>. Paws will not restart, verify or merge ENG-n." and the title reads `ENG-n: manual`.

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
3. After the item is back in the merge queue, add a line comment ("use a constant for the delimiter") and, within a minute, a conversation comment ("also mention it in the README").

Expect these results:

- The changes-requested review restarts the item once (restart reason `review`). The title reads "fixing review findings (1 of 3)". The agent renames the argument and asks in the session about the CSV question; that question is the one activity after the pull request response. Answer it.
- The two comments restart the item once more, with both comments in the handoff; the title reads "fixing review findings (2 of 3)". A Cloudflare Pages preview comment restarts nothing.
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

### Recorded runs

| Date       | Kind                   | Head       | Scenarios                                                        | Result             | Evidence                                                                                                                                                                                                                                                                                                |
| ---------- | ---------------------- | ---------- | ---------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-26 | Rehearsal over fakes   | `50977106` | Rebase after main moved, changes-requested review, conflict loop | 55 pass, 0 fail    | [Report](https://uploads.linear.app/b887619d-5cb4-463d-9824-983433dbc4b3/c2456404-f6fc-4904-b90f-089c31fa06b5/2f2a6f0b-57f8-4618-9f64-fe5d22d1e5bb), [JUnit](https://uploads.linear.app/b887619d-5cb4-463d-9824-983433dbc4b3/9d95d275-6015-4268-b721-3666e4d5d272/8d150f99-78c6-44f9-9bda-f78cc0e8f22f) |
| —          | Live (Linear + GitHub) | —          | Rebase after main moved, changes-requested review, conflict loop | Tracked in PAS-744 | —                                                                                                                                                                                                                                                                                                       |

The rehearsal drives Paws' merge lane, review handler and loop over the module fakes, because the runner that wrote these docs had no Linear workspace, GitHub App or agent logins. It is not a live run. It reproduces the expected results above, but not Linear's rendering or GitHub's behaviour. Rerun it with:

```sh
bun test src/merge/advance-merge.test.ts src/merge/step.test.ts src/merge/budget.test.ts \
  src/loop/pull-reviews.test.ts test/linear-session-progress.test.ts test/loop.e2e.test.ts \
  -t "main moved|behind main|rebase|review|conflict|quiet through"
```

The live run of these three scenarios against Linear and GitHub is tracked in PAS-744. Add a row for each live run, with links to the sessions, pull requests and published evidence.

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

## First delegation by a new Linear user

This run proves a Linear member who has never used Paws can delegate an issue, set up in one session, and get the pull request merged with their credit. What each message and page step says is in [Linear agent sessions](linear-agent-sessions.md#a-first-delegation) and [Workspace access](workspace-access.md#a-first-delegation).

Run it on a disposable Paws instance, set up as at the top of this page, with its own `~/.paws`. Map the demo repository to the sandbox team. In Linear, invite a fresh user to the workspace as a member (not a guest) and add them to the sandbox team. They must never have signed in to this Paws instance, own no runner, and have no GitHub credit link. Use a separate browser profile for them, signed in to Linear only. To exercise **Create VM**, configure exe.dev as in [Create a VM](create-vm.md); otherwise use **Add a host** with a Linux host as in [Enroll a remote Linux runner](runner-enrollment.md).

1. **Delegate.** As the new user, create **Add a CSV header comment**: "Add a one-line comment at the top of `src/export.ts`." Delegate it to the Paws app. The session shows "Picked up this issue.", then one sign-in action addressed to the new user that starts "Welcome to Paws." and ends with the optional GitHub line. Wait ten minutes: no second action appears.
2. **Reply while waiting.** Reply "Keep it under 80 characters." in the session. Nothing is posted.
3. **Wrong person.** Copy the action's link. In another browser profile, open it and sign in as the workspace admin. The page says "This link belongs to <new user>." and nothing changes in the session. The admin is not signed in to the dashboard by it.
4. **Sign in.** Press **Sign in to Paws** and complete Linear sign-in. The browser lands on `/onboard/<link id>`: "Welcome, <name>", Linear and Membership done, Runner needed, Claude and Codex after the runner, GitHub credit optional. The session gets one thought: "You don't have a runner Paws can use yet. …"
5. **Optional GitHub credit.** On the onboarding page, before the runner is ready, check the consent box and press **Link GitHub**. GitHub returns to the onboarding page, which reads "Commits will credit @<login>." Paws reads the link when the run starts, so a link made after the start credits only later runs.
6. **Create VM or Add a host.** Press **Create VM** and watch its four steps finish, or press **Add a host**, run the command on the host, and wait for it to enroll. The Runner step reads "<runner> will run this task." and Claude and Codex becomes **Needed**.
7. **Agent sign-in.** Press **Sign in on <runner>** and sign in to Claude and Codex on the Runners page. Then turn the runner on if it is paused.
8. **Automatic start.** Without any further click, the session gets "Starting ENG-n on <runner>." and the ordinary running face. The agent's handoff includes the reply from step 2. The page lead reads "You're set up. Paws runs ENG-n on <runner>."
9. **Merged with credit.** Closeout accepts, the pull request opens, and Paws squash-merges it. The session ends with "Merged #N into main at <sha>. ENG-n is Done." Each commit carries the new user's `Co-authored-by` trailer and the pull request body credits their GitHub login.

Then check the edges on fresh issues delegated by another new user:

- Do not sign in for a day. The session ends with "This sign-in link expired. Delegate the issue again to retry.", and the link answers 404.
- Open an old `/auth/linear?assignment=…` link. It answers 410.
- Open the `/onboard/<link id>` address eleven times in a minute. The eleventh answers 429 with `Retry-After`, and Linear shows nothing new.

Keep each session, the onboarding page at each step, the pull request and the run page. Publish a screenshot of each session state (sign-in action, no runner, starting, merged) and of each onboarding page step on the PAS issue for the run, and link the merged pull request. For the whole run, `/health` should count no more than 30 Linear requests under the issue.

### Recorded first delegations

| Date       | Kind                   | Head       | Result           | Evidence                              |
| ---------- | ---------------------- | ---------- | ---------------- | ------------------------------------- |
| 2026-10-26 | Rehearsal over fakes   | `1348ecd5` | 127 pass, 0 fail | Onboarding page screenshots on the PR |
| —          | Live (Linear + GitHub) | —          | Not run yet      | —                                     |

The rehearsal runs the first-delegation flow over the module fakes: the sign-in hold and its one action, kept replies, the link rules, the onboarding page steps, the runner-setup hold and its resume, the repository denials, and the 30-request budget. It renders each onboarding page state, but not Linear's session UI, so it is not a live run. Rerun it with:

```sh
bun test test/workspace-assignments.test.ts test/workspace-access.test.ts \
  test/browser-onboarding.test.ts test/onboarding-readiness.test.ts test/onboarding-runner-step.test.ts \
  test/integrated-onboarding-attribution.test.ts test/runner-setup-hold.test.ts \
  test/runner-setup-hold-queue.test.ts test/github-repository-access.test.ts \
  test/first-delegation-budget.test.ts
```

Add a row for each live run, with links to the session, the pull request and the published screenshots.

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
