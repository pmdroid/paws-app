# Configuration reference

Paws has two kinds of configuration:

- [Environment variables](#environment-variables), read once at startup, usually from `PAWS_HOME/https.env`. Change one and restart Paws.
- [Settings](#settings), saved in the database and changed on the Settings pages of the dashboard by a workspace admin. Every Paws process that shares the database reads a save on its next use.

The Closeout policy of each repository, `.agents/closeout.yaml` on `origin/main` or a [local Closeout policy](local-closeout.md), sets the checks and the [fix budgets](#closeout-retry).

## Environment variables

| Variable                                      | What it sets                                                                                                                                                                     | Default                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `PAWS_HOME`                                   | The data folder: secrets, PGlite, TLS files and evidence.                                                                                                                        | `~/.paws`                              |
| `PAWS_HOST`                                   | The address the dashboard and API listen on.                                                                                                                                     | `127.0.0.1`                            |
| `PAWS_PORT`                                   | Their port, a whole number from 0 to 65535; anything else stops startup.                                                                                                         | `8787`                                 |
| `PAWS_PUBLIC_URL`                             | The public HTTPS origin people and webhooks reach Paws on, used in setup links, sign-in callbacks and links Paws posts.                                                          | None                                   |
| `PAWS_DATABASE_URL`                           | A Postgres server ([Database](postgres.md)).                                                                                                                                     | PGlite in `PAWS_HOME/pglite`           |
| `PAWS_ROLE`                                   | What this process does when several share a database: `all` and `worker` run background jobs, `web` serves requests without running jobs. Any other value stops startup.         | `all`                                  |
| `PAWS_GITHUB_REPOS`                           | Startup repositories, comma-separated `owner/repo` (`acme/api,acme/web`). An entry that is not `owner/repo` stops startup. Workspaces choose their repositories in Integrations. | None                                   |
| `PAWS_MAX_AWAKE_MS`                           | The Implementation [time limit](#time-limits) in milliseconds when none is saved.                                                                                                | 3 hours                                |
| `LINEAR_TEAM`                                 | The Linear team key Paws takes work from.                                                                                                                                        | None                                   |
| `LINEAR_TEAM_ID`                              | The same team by ID.                                                                                                                                                             | None                                   |
| `LINEAR_APP_USER_ID`                          | The Linear app user Paws acts as; issues delegated to it are Paws' work. `LINEAR_VIEWER_ID` is read when it is unset.                                                            | None                                   |
| `LINEAR_WEBHOOKS`                             | `1` or `true` takes Linear events from webhooks, `0` or `false` polls.                                                                                                           | Polling                                |
| `LINEAR_WEBHOOK_SECRET`                       | The Linear webhook signing secret.                                                                                                                                               | `PAWS_HOME/secrets/linear-webhook`     |
| `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`    | The Linear app OAuth client ([Workspace access](workspace-access.md)).                                                                                                           | `PAWS_HOME/secrets/linear-client.json` |
| `LINEAR_ORGANIZATION_ID`                      | The only Linear workspace this Paws accepts an installation from.                                                                                                                | Any                                    |
| `LINEAR_ACCESS_TOKEN`, `LINEAR_REFRESH_TOKEN` | A Linear token Paws stores once when the database has none.                                                                                                                      | None                                   |
| `GITHUB_APP_ID`                               | The GitHub App ID ([GitHub App](github-app.md)).                                                                                                                                 | `PAWS_HOME/secrets/github-app.json`    |
| `GITHUB_APP_INSTALLATION_ID`                  | The App installation. Integrations finds it when unset.                                                                                                                          | `PAWS_HOME/secrets/github-app.json`    |
| `GITHUB_APP_PRIVATE_KEY_PATH`                 | Path to the App private key, mode `0600`.                                                                                                                                        | `PAWS_HOME/secrets/github-app.pem`     |
| `GITHUB_WEBHOOK_SECRET`                       | The GitHub webhook secret.                                                                                                                                                       | `PAWS_HOME/secrets/github-webhook`     |

[Workspace access](workspace-access.md), [runner enrollment](runner-enrollment.md) and [Slack](slack.md) describe the variables for a public dashboard, the runner listener and Slack.

### `paws install`

`bun run paws install` sets up a control plane as a systemd user service. It asks for the checkout path (`~/.local/share/paws/app`), `PAWS_HOME` (`~/.paws`), `PAWS_HOST`, `PAWS_PORT`, `PAWS_PUBLIC_DASHBOARD`, `PAWS_PUBLIC_URL`, `PAWS_RUNNER_HOST`, `PAWS_RUNNER_PORT`, the Linear team and the GitHub repositories. It writes `PAWS_HOME/https.env` (mode 0600), with the Linear team as `LINEAR_TEAM` and the repositories as `PAWS_GITHUB_REPOS`, then `~/.config/systemd/user/paws.service` and its `paws.service.d/working-directory.conf` drop-in, then runs `systemctl --user daemon-reload`. It does not start the service.

Run it again to change a value: each prompt shows the current value in the env file as its default, and other env lines stay as they are. Type `-` to clear an optional value and remove its line. `paws install` does not change settings; set the runner VM size in Settings ([Member VM](#member-vm)). It needs bun 1.4.4 on `PATH` (`mise use -g bun@1.4.4`).

`bun run paws install secrets` asks for nothing. It prints the public URL from `PAWS_PUBLIC_URL` and the setup link, the same text as `paws setup-link`; before Paws has started once it says to start Paws and run `paws setup-link`. GitHub, Linear, [Slack](slack.md) and the runner VM keys are then set up in the browser ([workspace access](workspace-access.md)). Secrets already in `PAWS_HOME/secrets` or the environment keep working.

For a scripted install, pass `--non-interactive` with flags such as `--paws-port 443`, or `--answers answers.toml` with the same keys in snake case (`paws_port = 443`, `github_repos = ["owner/repo"]`). Flags override the file, and a value left out keeps its current or default value.

A public dashboard also needs `PAWS_TLS_KEY_PATH` and `PAWS_TLS_CERT_PATH`. When `PAWS_PUBLIC_URL` is a tailnet name (`*.ts.net`), the installer offers to run `tailscale cert <host>` into `PAWS_HOME/tls/` (key 0600). That needs the tailscale CLI, HTTPS certificates turned on for the tailnet, and `sudo tailscale set --operator=$USER`; if it fails, the installer prints the commands to run and asks for paths instead. For any other URL it asks for existing key and certificate paths. The pair uses the certificate checks from `paws public-tls validate` against the public URL hostname. The runner listener on `PAWS_RUNNER_PORT` uses the same certificate unless `PAWS_RUNNER_TLS_KEY_PATH` and `PAWS_RUNNER_TLS_CERT_PATH` give it its own; `PAWS_RUNNER_HOST` is only its bind address, and `PAWS_RUNNER_URL` sets the origin runners connect to ([A separate runner address and certificate](runner-enrollment.md#a-separate-runner-address-and-certificate)). A wrong host, an expired certificate or a key readable by others is explained and asked again. A certificate from `tailscale cert` is renewed weekly by `~/.config/systemd/user/paws-tls-renew.timer`, which then reloads Paws (SIGHUP, exit 75 and restart). The installer finishes with the tailnet policy rule for the dashboard and runner ports ([Create VM](create-vm.md)). Scripted installs take `tailscale_cert`, `tls_key_path` and `tls_cert_path`. Supplied certificate paths default to skipping `tailscale cert`. Switching to existing certificates or disabling the public dashboard disables and removes the renewal timer.

`PAWS_PUBLIC_TLS=proxy` is for a public dashboard behind a proxy that terminates HTTPS. Paws then serves plain HTTP, takes no `PAWS_TLS_KEY_PATH` or `PAWS_TLS_CERT_PATH`, runs runner control only with `PAWS_RUNNER_URL`, `PAWS_RUNNER_TLS_KEY_PATH` and `PAWS_RUNNER_TLS_CERT_PATH`, and reads the client address for the sign-in limits from the last `X-Forwarded-For` entry. Any other value fails startup. See [Behind a proxy](workspace-access.md#behind-a-proxy).

## Settings

Workspace admins change settings under **Workspace** in the dashboard. Invalid saved settings stop startup with what to change. A saved section this Paws does not know, such as one a newer or older build wrote, does not stop startup: Paws ignores it, journals its name, and Workspace › Agents lists it with a **Remove** button that deletes it.

A setting without a control on its page is described by what it does and marked "set through the Settings API": an admin's `PUT` to the page's `/api/settings/…` endpoint saves it.

### Merging

Workspace › Merging. Every item uses these choices. A save applies to items that start from then on unless a setting says otherwise.

- **Merge order**: how pull requests in one repository merge. **Merge queue: one pull request at a time, in order** (default) merges through Paws' merge lane. **Merge each pull request when its CI is green** merges each one on its own green CI. **Add to the GitHub merge queue** hands the merge to GitHub's merge queue.
- **When main moved before the merge**:
  - **Always update the branch and wait for CI** (default): rebase onto main, and the new head merges once its CI is green. Closeout does not run again; the new head carries Closeout's acceptance of the head it was rebased from. With **Use local mirrors** off in [GitHub access](#github-access), GitHub rebases the pull request instead, guarded by the head the lane read and the same `patch-id` check. A conflict GitHub reports goes back to the agent like a rebase conflict; any other refusal falls back to the runner rebase, and the journal says why.
  - **Update and re-test only when main changed the same files or package**: when main's new commits touch none of the pull request's files, grouped by the repository's package roots, merge without a rebase. When they do, or when GitHub requires branches to be up to date before merging, rebase and wait for CI.
  - **Merge on green CI without updating the branch onto main**: a pull request behind main merges once its own CI is green. Main's new commits aren't tested together with the change; GitHub still refuses a pull request that conflicts. When GitHub requires branches to be up to date, the branch is updated first.
  - **Always update the branch and run Closeout again**: rebase and run Closeout on the new head before it can merge.

  A changed Closeout policy sends a carried head back through Closeout under every choice.

- **Merge lanes** decide which items wait for each other under the merge queue order. Lanes always split by repository. **Give each lane its own** **Linear project** and **Person who delegated the issue** are both on by default, so each person has a lane in each project; with both off every item in a repository shares one lane. **Issues without a project**: **Each issue merges on its own** (default) gives such an item its own lane, so it never waits behind another item's merge; an overlap hold on shared files still applies. **One lane, like a project** puts them in one lane. An item keeps the lane it joined with while it holds its place, and queue messages name the project ("Second in the acme/monorepo queue for Billing"). Lanes in one repository merge one after another; later lanes follow **When main moved before the merge** when an earlier merge changes main.
- **Merges at once in a lane**: 1 (default), 3 or 5; the Settings API takes any whole number from 1 to 5. A task behind the head of the lane merges alongside it only when its pull request is green on its own head and changes none of the files of the tasks ahead of it. **Check main after a batch** is always on: when two or more pull requests of a lane merged within 10 minutes and main's CI then fails, the lane merges one at a time until main is green again.
- **Repositories and projects**: for each repository, **Package roots, one per line** (such as `apps/*`; a change anywhere under the same root counts as an overlap), **Review GitHub App slugs, one per line** (check runs that pull request comments wait for; bots whose comments Paws has recorded count without being listed) and **Suggested findings**. Suggested findings are review findings below the review's `failOn` in code the pull request changed: **Off** only lists them under the pull request's Open findings, **Include on the next turn** (default) hands them to the agent in the next restart the item gets for another reason. A Linear project ID can choose **Own project lane** or **Repository lane** instead of **Use workspace lane settings**. [Suggested findings](improvement-review.md) has the details.
- **Pull request comments**: **Quiet time (seconds)**, default 60, is how long Paws waits after the latest pull request comment or changes-requested review before it sends what it collected to the agent in one fix round. **Longest wait (seconds)**, default 300 and never below the quiet time, sends them anyway after this long from the first one. Both range from 0 to 3600 and apply to the next comment.
- How long pull request comments and changes-requested reviews wait for review apps still checking the head, counted from the head's push, is set through the Settings API (`commentWait.reviewWaitMaxSeconds` on `/api/settings/merging`): default 900 seconds, from 0 to 3600. Past it, Paws restarts with what has arrived. While GitHub's checks can't be read, the wait holds until this long after the feedback arrived.
- **Pull request checks** › **CI fix attempts**: shown from 0 to 10, default 3. It no longer sets a separate budget: red CI on the pull request is a fix round and counts against the policy's [`fix_rounds_per_item`](#closeout-retry).
- **When Paws finishes the Linear session**: **When the pull request opens** (default), **When CI is green**, or **When CI is green and the pull request has been quiet** for **Quiet for, minutes** (1 to 120, default 10). Paws keeps fixing review comments and CI either way.
- **High-risk approval**: with the risk gate on, a pull request that changes a high-risk path waits for an approval on its issue page. **Let high-risk changes through when both reviews are clean**, off by default, lets a high-risk head through only if Closeout accepted that exact head under the current policy, `security-review` and `independent-review` passed without P2-or-worse findings, including in pre-existing code, and no rule probe failed. Missing evidence asks a person. Changes to `.paws/high-risk-paths`, a Closeout policy input, `AGENTS.md`, `CLAUDE.md`, `.agents/**` or `.claude/**` always need a person. Automatic approval does not carry to a new or rebased head.
- **High-risk paths** › **Paws settings**: globs, one per line, that make a changed path high-risk in addition to the repository's `.paws/high-risk-paths`.
- **Checks after a conflict fix** › **Check ids**: Closeout check ids such as `lint` and `typecheck` that a restart which only resolves a merge conflict runs. It applies when an accepted, not high-risk pull request came back to rebase with nothing else to fix, **When main moved before the merge** is not Closeout, and every listed id ran on the accepted commit. The other checks keep their pass only when CI is green on the fixed commit and the fix changes no file the accepted commit did not; otherwise every check runs. Leave it empty to run every check.
- **Ignored PR comments**: per repository, **Bot accounts** (logins such as `codecov[bot]` whose comments never restart the item; replaces the default list of Cloudflare Pages, Linear, Codecov, Netlify, Vercel and changesets) and **Comment markers** (literal strings; a comment containing one never restarts the item; at most 100 markers of at most 200 characters, none empty or repeated). Edits and deletions of a comment never restart the item. A change applies to the next comment.
- **Conflict-prone files**: a file is conflict-prone after **Conflicts before a file holds work** (1 to 20, default 2) merge-queue conflicts within **Counted over the last (days)** (1 to 30, default 7). While a running or merge-queue item changes one, a queued item that changes it too waits. **Hold work that changes conflict-prone files**, on by default, turns this off for every repository; each listed file has its own **Hold work that changes this file** toggle. Changes apply to the next scheduling pass.

Paws merges after verification, required CI, reviews and branch protection permit it. Follow the dashboard's merge queue for the current reason work is waiting.

### Queue and limits

Workspace › Queue and limits. Saves apply to the next scheduling pass.

- **Fail an item that has not started after, in hours**: 1 to 720, default 24. Delegating the item again retries.
- **Most items one person or project runs at once**: 1 to 1000; empty (default) means no cap.

#### Time limits

**Implementation** (the first turn, a follow-up and an answer to a question), **Fix rounds** (CI, review comments, Closeout findings and merge conflicts) and **Closeout** (checks of a head) each take **Minutes**, 1 to 10080, or **Not counted**. Implementation defaults to `PAWS_MAX_AWAKE_MS`, 3 hours when that is unset; the other two default to not counted. Limits are fixed when an item is delegated and when a person asks for more time.

Time limits count active work only. Queued items, runner capacity waits, questions, pauses, usage limits, retry backoff, Closeout waiting on CI or a runner, and the merge queue count zero.

When a stage reaches its limit, Paws stops the agent or the Closeout run and asks in the Linear session, naming the stage ("Implementation reached its 3 h limit"): Continue or Stop, plus Merge once Closeout accepted a head. Continue after a stopped Closeout run checks the same head again. Accepted work in the merge queue or re-verification is not stopped. A task without a Linear session pauses when Closeout accepted a head, and fails otherwise. Continue starts over only the stage that reached its limit; a reply in the Linear session starts every stage over. Paws' own restarts do not reset any stage.

### Agents

Workspace › Agents. Agent profiles are global: every repository uses the same implementer and reviewer.

- **Global defaults**: **Implementer** and **Reviewer**, each with **Agent** (Claude Code, Codex, Grok or OpenCode), **Model** and **Effort** (**Agent default** when unset) and, for models that have it, **Fast mode**. The reviewer must differ from the implementer in agent or model. Whether an agent keeps running on extra usage is a runner setting, under Settings › Runners.
- **Label presets**: each has a **Name** (1–40 letters, digits, spaces, dots, underscores or hyphens; matching ignores case) and its own implementer and reviewer. A Linear label in the **Implementer** or **Reviewer** group naming a preset applies the whole preset. Paws reads labels each time it starts a new implement run, so a change applies from the issue's next run. An unknown name or two labels naming different presets stops the run with a question: **Use the default** or **I fixed the label**.
- **Also switch runs that are waiting**: waiting runs use the saved profiles at their next step. Agents working now finish with their current profiles.

### Closeout

Workspace › Repositories › **Closeout policy roots**: a **Repository** (`owner/repo`) and its **Policy root**, an absolute path to an existing folder on the Paws host holding a [local Closeout policy](local-closeout.md). Saves apply without a restart.

#### Closeout `retry`

The `retry` block in the repository's Closeout policy sets the fix budgets:

```yaml
retry:
  attempts_per_check: 3
  fix_rounds_per_item: 3
  narrow_after_lines: 800
```

- **`attempts_per_check`**: failed attempts one Closeout check gets, on the agent side and the Paws side. Default 3. A check that reaches it is exhausted and Paws asks the team. `maxFailedAttemptsPerItem` is a legacy alias.
- **`fix_rounds_per_item`**: fix rounds per item, counted since the latest reply from a person in the item's session. Default 3. Closeout findings, red CI and changes-requested reviews all count. When they are spent, Paws asks the team.
- **`narrow_after_lines`**: the size, in changed lines against the base, past which Paws narrows a candidate back to its issue. Default 800; `0` turns the size check off. When Closeout rejects a candidate that is past it, or that doubled since the previous review round and has at least 200 changed lines, the next fix round tells the agent to cut the change back to the issue. Paws narrows once per reply from a person; the narrowing restart counts as a fix round.

Rebase returns are not configurable: three in a row on a known main commit or a conflicting push, and six in any rolling hour, then Paws asks. Only a person's reply in the session refills a budget. [Verification questions](closeout.md#resolve-a-verification-question) describe both.

### Skills

Workspace › Agent instructions.

- **Agent brief** › **Template** replaces the built-in agent brief for every repository; clearing it uses the built-in default.
- **Skills** › **Add a skill** takes an npm package, a git URL (with **Git ref** and **Subfolder**) or **Or upload a folder**, for the **Agents** you check. Paws pins the exact version or commit.
- **Repository skill roots**: a **Repository** and its **Skill root**, an absolute path to an existing folder on the Paws host with [local skills](local-skills.md). Saves apply to the next implementation turn.

### GitHub access

Workspace › Repositories › **GitHub access**:

- **Agents may read the repository** (default on): off gives no agent turn a read-only GitHub token, from the next turn on; see [the agent's token](runner-enrollment.md#the-agents-read-only-github-token).
- **Use local mirrors** (default on): off uses GitHub API reads instead of local repository mirrors. Restart Paws after changing it. Existing worktrees become independent checkouts with their commits and uncommitted work kept; keep the old mirror until the conversion finishes.

### Findings

On the Findings page, an admin sets **Daily grouping time (UTC)**, `06:00` by default; a save moves the next run without a restart. **Group similar findings into suggested fixes once a day** turns grouping off for the workspace; while it is off, the daily job skips the workspace and **Run now** is refused.

Each workspace spends at most one helper turn per UTC day, including **Run now**; failed or interrupted attempts consume it. Unchanged findings skip the helper. Grouping uses a paired runner owned by an active workspace owner or admin who can authorize the reporting session and is signed in to the implementer, and runs read-only without a checkout. A member chooses **File as one issue**, **Add to** the suggested issue, or **Dismiss group** with a reason. Filing creates an undelegated Triage issue with the `review finding` label.

### Member VM

Workspace › Member VMs › **Member VM size**: **CPUs**, **Memory (GB)**, **Disk (GB)**, **Image** and **Default pool** for newly created VMs. An empty field uses the exe.dev default. Existing VMs keep their size.

### Linear comments

Workspace › Linear › **Comment agents** › **Agents**: Linear app user IDs, one per line, of external Linear agents whose issue comments reach Paws. A change applies to the next comment without a restart.

### Project memory

Workspace › Project memory. All three are off by default.

- **Save answers as decisions**: a person's answer to an agent's question on an issue in a Linear project is saved as a project decision ([project context](project-context.md)).
- **Summarize finished work**: when Paws opens a pull request, it saves a short summary of the change to the project's memory.
- **Dream**: once a day, when a project has enough new entries, a model merges its memory into a few topics. It uses an agent account and costs tokens.
