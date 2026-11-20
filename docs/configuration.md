# Configuration reference

Paws reads three kinds of configuration:

- Settings, saved in the database and changed on the Settings pages of the dashboard. Invalid saved settings stop startup with a line number and what to change. A section in the saved dashboard settings that this Paws no longer knows, such as one a newer or older build wrote, does not stop startup: Paws ignores it, journals its name, and Workspace › Agents lists it with a **Remove** button that deletes it from the saved settings.
- Environment variables, usually from `PAWS_HOME/https.env`. At startup Paws reads `PAWS_DATABASE_URL`, `PAWS_PUBLIC_URL`, `LINEAR_TEAM`, `LINEAR_TEAM_ID`, `LINEAR_APP_USER_ID`, `LINEAR_WEBHOOKS` and `PAWS_GITHUB_REPOS`, the startup repositories as comma-separated `owner/repo` (`acme/api,acme/web`); an entry that is not `owner/repo` stops startup.
- The Closeout policy for each repository, `.agents/closeout.yaml` on `origin/main` or a [local Closeout policy](local-closeout.md). Its `retry` block sets the fix budgets.

Changes that need action on upgrade are in the [changelog](../CHANGELOG.md).

## `paws install`

`bun run paws install` sets up a control plane as a systemd user service. It asks for the checkout path (`~/.local/share/paws/app`), `PAWS_HOME` (`~/.paws`), `PAWS_HOST`, `PAWS_PORT`, `PAWS_PUBLIC_DASHBOARD`, `PAWS_PUBLIC_URL`, `PAWS_RUNNER_HOST`, `PAWS_RUNNER_PORT`, the Linear team and the GitHub repositories. It writes `PAWS_HOME/https.env` (mode 0600), with the Linear team as `LINEAR_TEAM` and the repositories as `PAWS_GITHUB_REPOS`, then `~/.config/systemd/user/paws.service` and its `paws.service.d/working-directory.conf` drop-in, then runs `systemctl --user daemon-reload`. It does not start the service.

Run it again to change a value: each prompt shows the current value in the env file as its default, and other env lines stay as they are. Type `-` to clear an optional value and remove its line. `paws install` does not change settings; set the runner VM size in Settings ([Member VM size](#member-vm-size)). It needs bun 1.4.4 on `PATH` (`mise use -g bun@1.4.4`).

`bun run paws install secrets` asks for nothing. It prints the public URL from `PAWS_PUBLIC_URL` and the setup link, the same text as `paws setup-link`; before Paws has started once it says to start Paws and run `paws setup-link`. GitHub, Linear, [Slack](slack.md) and the runner VM keys are then set up in the browser ([workspace access](workspace-access.md)). Secrets already in `PAWS_HOME/secrets` or the environment keep working.

For a scripted install, pass `--non-interactive` with flags such as `--paws-port 443`, or `--answers answers.toml` with the same keys in snake case (`paws_port = 443`, `github_repos = ["owner/repo"]`). Flags override the file, and a value left out keeps its current or default value.

A public dashboard also needs `PAWS_TLS_KEY_PATH` and `PAWS_TLS_CERT_PATH`. When `PAWS_PUBLIC_URL` is a tailnet name (`*.ts.net`), the installer offers to run `tailscale cert <host>` into `PAWS_HOME/tls/` (key 0600). That needs the tailscale CLI, HTTPS certificates turned on for the tailnet, and `sudo tailscale set --operator=$USER`; if it fails, the installer prints the commands to run and asks for paths instead. For any other URL it asks for existing key and certificate paths. The pair uses the certificate checks from `paws public-tls validate` against the public URL hostname. The runner listener on `PAWS_RUNNER_PORT` uses the same certificate unless `PAWS_RUNNER_TLS_KEY_PATH` and `PAWS_RUNNER_TLS_CERT_PATH` give it its own; `PAWS_RUNNER_HOST` is only its bind address, and `PAWS_RUNNER_URL` sets the origin runners connect to ([A separate runner address and certificate](runner-enrollment.md#a-separate-runner-address-and-certificate)). A wrong host, an expired certificate or a key readable by others is explained and asked again. A certificate from `tailscale cert` is renewed weekly by `~/.config/systemd/user/paws-tls-renew.timer`, which then reloads Paws (SIGHUP, exit 75 and restart). The installer finishes with the tailnet policy rule for the dashboard and runner ports ([Create VM](create-vm.md)). Scripted installs take `tailscale_cert`, `tls_key_path` and `tls_cert_path`. Supplied certificate paths default to skipping `tailscale cert`. Switching to existing certificates or disabling the public dashboard disables and removes the renewal timer.

`PAWS_PUBLIC_TLS=proxy` is for a public dashboard behind a proxy that terminates HTTPS. Paws then serves plain HTTP, takes no `PAWS_TLS_KEY_PATH` or `PAWS_TLS_CERT_PATH`, runs runner control only with `PAWS_RUNNER_URL`, `PAWS_RUNNER_TLS_KEY_PATH` and `PAWS_RUNNER_TLS_CERT_PATH`, and reads the client address for the sign-in limits from the last `X-Forwarded-For` entry. Any other value fails startup. See [Behind a proxy](workspace-access.md#behind-a-proxy).

## Settings

Settings are saved in the database and changed on the Settings pages. The tables below name each saved section and its keys.

| Section         | Keys                                                                                                                                                                                                                                                 | Notes                                                                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[time_limits]` | `implementation_minutes`, `fixes_minutes`, `closeout_minutes`                                                                                                                                                                                        | See [below](#time_limits).                                                                                                                                                                      |
| `[agents]`      | `implementer`                                                                                                                                                                                                                                        | `implementer` is `claude`, `grok` or `codex`. Models and effort are set in Settings, under Agents. Whether an agent keeps running on extra usage is a runner setting, under Settings › Runners. |
| `[merge]`       | `order`, `main_moved`, `lanes`, `no_project`, `parallel`, `ci_fix_attempts`, `comment_quiet_seconds`, `comment_max_wait_seconds`, `review_wait_max_seconds`, `auto_approve_high_risk`, `overlap_hold`, `conflict_prone_after`, `conflict_prone_days` | See [below](#merge).                                                                                                                                                                            |
| `[queue]`       | `start_timeout_hours`, `max_running_per_owner`                                                                                                                                                                                                       | See [below](#queue).                                                                                                                                                                            |

Time limits count active work only. Waiting does not spend them: queued items, runner capacity waits, questions, pauses, usage limits, retry backoff, Closeout waiting on CI or a runner, and the merge queue all count zero. Time-limit messages report each stage's time separately from waiting.

### `[time_limits]`

```toml
[time_limits]
implementation_minutes = 180
fixes_minutes = 0
closeout_minutes = 0
```

Each stage has its own limit, and `0` means the stage's time is not counted. The stage of an agent turn comes from the restart that started it:

- **Implementation**: the first turn, a follow-up and an answer to a question.
- **Fixes**: turns for CI, review comments, Closeout findings and merge conflicts. Fix rounds are already limited by count (`ci_fix_attempts`), so by default their time is not counted.
- **Closeout**: Closeout's checks of a head.

The limits are global: every item uses the same `[time_limits]`. A missing `implementation_minutes` is `PAWS_MAX_AWAKE_MS` (milliseconds), or 3 hours when that is unset, and missing fixes or Closeout limits count nothing. Limits are fixed when an item is delegated and when a person asks for more time. Workspace › Queue and limits › Time limits reads and writes this table.

### `[github_access]`

Workspace administrators manage GitHub access in Settings.

- `agent_read` (default `true`): `false` gives no agent turn a read-only GitHub token, from the next turn on; see [the agent's token](runner-enrollment.md#the-agents-read-only-github-token).
- `mirrors` (default `true`): set `false` to use GitHub API reads instead of local repository mirrors. Restart Paws after changing it. Existing worktrees are converted to independent checkouts with their commits and uncommitted work preserved; keep the old mirror available until the conversion finishes.

### Linear comment agents

Workspace administrators can choose which external Linear agents' issue comments reach Paws through Settings. Save their Linear app user IDs. The change applies to the next comment without restarting Paws.

### `[brief]`

`[brief] template` replaces the built-in agent brief for every repository; Settings › Brief reads and writes it.

When a stage reaches its limit, Paws stops the agent or the Closeout run and asks in the Linear session, naming the stage ("Implementation reached its 3 h limit"): Continue or Stop, plus Merge once Closeout accepted a head. Continue after a stopped Closeout run checks the same head again. Accepted work in the merge queue or re-verification is not stopped. A task without a Linear session pauses when Closeout accepted a head, and fails otherwise.

Continue, or a typed answer to the time-limit question, starts over only the stage that reached its limit, and Paws says so in the session. A reply in the Linear session starts every stage over. Paws' own restarts (CI repair, review comments, conflicts, Closeout findings, recovery) do not reset any stage.

### Local Closeout policy roots

Workspace administrators can set a [local Closeout policy](local-closeout.md) folder for each `owner/repo` through Settings > Closeout. Use an absolute path to an existing folder on the Paws host. Saves apply without a restart.

### `[merge]`

```toml
[merge]
order = "queue"
lanes = ["project", "person"]
no_project = "own"
auto_approve_high_risk = false

[merge.projects."<Linear project id>"]
lane = "repository"
```

Every item uses the `[merge]` choices. Paws still loads an `order` or `main_moved` under `[merge.projects.*]` and every `[[merge.rules]]` table, ignores them, and journals one line at startup; the next Workspace › Merging save drops them.

- **`order`**: how pull requests in one repository merge. `queue` (default) merges one at a time through the merge lane. `ci-green` merges each one on its own green CI. `github-queue` hands the merge to GitHub's merge queue.
- **`main_moved`**: what the merge lane does when `main` moved before the merge. Set it in `[merge]` or in Workspace › Merging as "When main moved before the merge".
  - `"ci"` (default, and what a missing key means): rebase onto `main`, and the new head merges once its CI is green. Closeout does not run again; the new head carries Closeout's acceptance of the head it was rebased from.
  - `"overlap"`: when main's new commits touch none of the pull request's files, grouped by the repository's `packages` roots, merge without a rebase. When they do, or when GitHub requires branches to be up to date before merging, rebase and wait for CI as with `"ci"`.
  - `"green"`: a pull request behind main merges once its own CI is green. Paws doesn't rebase it and doesn't compare main's new commits with its files. When GitHub requires branches to be up to date before merging, the branch is updated first, as with `"overlap"`. Main's new commits aren't tested together with the change before it merges; GitHub still refuses a pull request that conflicts. In Workspace › Merging it is "Merge on green CI without updating the branch onto main".
  - `"closeout"`: rebase and run Closeout again on the new head before it can merge.

  A changed Closeout policy sends a carried head back through Closeout under every value.

  With `main_moved = "ci"` and mirrors are off in [GitHub access](#github_access), GitHub rebases the pull request instead (`updatePullRequestBranch` with `REBASE`, guarded by the head the lane read), under the same `patch-id` check. A conflict GitHub reports goes back to the agent like a rebase conflict; any other refusal falls back to the runner rebase above, and the journal says why. Other values keep the runner rebase.

- **`lanes`**: which items wait for each other in a repository's merge queue under `order = "queue"`. Lanes always split by repository; `"project"` splits them by Linear project and `"person"` by the item's owner. The default `["project", "person"]` gives each person their own lane in each project; `[]` puts every item in the repository in one lane. The old `lane` key is still read: `"project"` means `["project", "person"]` and `"repository"` means `["person"]`; a save writes `lanes`. A `lane = "repository"` under `[merge.projects.*]` turns the project split off for that project; labels play no part. An item keeps the lane it joined with while it holds its place. Queue messages name the project: "Second in the acme/monorepo queue for Billing". Lanes in one repository merge one after another. Later lanes follow `main_moved` when an earlier merge changes `main`.
- **`no_project`**: where an item without a Linear project waits. `"own"` (default) gives it a lane of its own, so it never waits behind another item's merge; an overlap hold on shared files still applies. `"lane"` puts it in the lane without a project, split by person when `lanes` has `"person"`.
- **`parallel`**: how many pull requests of one lane may merge at once, from 1 (default) to 5. The head of the lane goes as before. A task behind it in the lane's first `parallel` ready tasks merges alongside it only when its pull request is green on its own head and its latest candidate changes none of the files of the tasks ahead of it; one that shares a file waits as before. A batch member is not rebased onto the others: under `main_moved = "green"` or `"overlap"` it merges as it is. When two or more pull requests of a lane merged within 10 minutes of each other and main's CI then fails, the lane merges one at a time until main is green again, and the journal names the batch's pull requests.

- **`auto_approve_high_risk`**: off by default. Workspace › Merging offers "Let high-risk changes through when both reviews are clean". When on, a high-risk head needs no manual approval only if Closeout accepted that exact head under the current policy, both `security-review` and `independent-review` passed without P2-or-worse findings, including findings in pre-existing code, and no rule probe failed. Missing or unreadable evidence asks a person. Changes to `.paws/high-risk-paths`, any loaded Closeout policy input, `AGENTS.md`, `CLAUDE.md`, `.agents/**` or `.claude/**` always need a person. Review severities are stored with their exact Closeout attempt; the shared findings list cannot turn a P2 review into a clean review. Automatic approval is never stored and does not carry to a new or rebased head; both named reviews must run on that head. Manual approvals keep their existing carry-over behavior.

- **`comment_quiet_seconds`**: how long Paws waits after the latest pull request comment or changes-requested review before it sends what it collected to the agent in one fix round. Default 60, from 0 to 3600. Workspace › Merging › Pull request comments sets it as "Quiet time". A change applies to the next comment, without a restart.
- **`comment_max_wait_seconds`**: the longest Paws keeps collecting while comments keep arriving, counted from the first one. Default 300, from 0 to 3600, and never below the quiet time. Workspace › Merging calls it "Longest wait".
- **`review_wait_max_seconds`**: the longest pull request comments and changes-requested reviews wait for review apps that are still checking the head, counted from the head's push (its first check suite's creation). While GitHub's checks can't be read, the wait holds until this long after the feedback arrived. Default 900, from 0 to 3600. Past it, Paws restarts with what has arrived.
- **`ci_fix_attempts`**: legacy. Still read and shown in Workspace › Merging › Pull request checks as "CI fix attempts", but it no longer sets a separate CI budget. Red CI on the pull request is a fix round and counts against the policy's `retry.fix_rounds_per_item`.
- **`[merge.repositories."owner/repo"] packages`**: package roots such as `apps/*`. With `main_moved = "overlap"`, a change anywhere under the same root on main counts as an overlap.
- **`[merge.repositories."owner/repo"] review_apps`**: GitHub App slugs such as `acme-review` whose check runs comments wait for. Bots whose comments Paws has recorded on the repository's pull requests count as review apps without being listed.
- **`[merge.repositories."owner/repo"] ignore_comment_bots`**: bot logins such as `codecov[bot]` whose pull request comments only report status, so they never restart the item. Replaces the default list (Cloudflare Pages, Linear, Codecov, Netlify, Vercel, changesets) for that repository; `[]` ignores no bot.
- **`[merge.repositories."owner/repo"] ignore_comment_markers`**: literal strings; a pull request comment whose body contains one never restarts the item. Use it for a bot such as `github-actions[bot]` that posts status comments and real failures under the same login. At most 100 markers of at most 200 characters, none empty or repeated. Edits and deletions of a comment never restart the item either, so an updated sticky comment needs no marker of its own.

  ```toml
  [merge.repositories."acme/monorepo"]
  ignore_comment_markers = ["<!-- add-pr-comment:todo-count -->", "<!-- deploy-security-proof -->"]
  ```

  Workspace › Merging › Ignored PR comments edits both lists for each repository, one entry per line: **Bot accounts** (`ignore_comment_bots`) and **Comment markers** (`ignore_comment_markers`). An invalid entry is shown next to its field and nothing is saved. A saved change applies to the next comment, without a restart.

- **`[merge.repositories."owner/repo"] suggested_findings`**: what Paws does with review findings below the review's `failOn` in code the pull request changed. `"off"` only lists them under the pull request's Open findings. `"next_turn"` (default) also hands them to the agent as suggestions in the next restart the item gets for any other reason. `"own_turn"` also starts one restart for them right after acceptance, once per item. A change applies to the next publication or restart, without a restart of Paws. [Suggested findings](improvement-review.md) has the details.
- **`[merge.repositories."owner/repo"] parallel_files`**: exact paths of conflict-prone files Paws does not hold work for in that repository, such as `["src/index.ts"]`. A conflict-prone file is one that sent work back for merge-queue conflicts at least `conflict_prone_after` times in the last `conflict_prone_days` days; while a running or merge-queue item changes it, a queued item that changes it too waits. Workspace › Merging › Conflict-prone files sets it with each file's **Hold work that changes this file** toggle; the file stays listed as Not held. Applies to the next scheduling pass.
- **`[merge.repositories."owner/repo"] conflict_checks`**: Closeout check ids such as `["lint", "typecheck"]` that a restart which only resolves a merge conflict runs. It applies when the merge lane or GitHub's merge queue sent an accepted, not high-risk pull request back to rebase with nothing else to fix (no CI failure, review comment, Closeout finding, Linear comment or suggestion), `main_moved` is not `"closeout"` and every listed id ran on the accepted commit. The agent's `get_closeout` lists only those checks as pending. The other command checks keep their pass from the accepted commit only when CI is green on the fixed commit, the turn's checks passed on that commit under the same Closeout policy and the fix changes no file the accepted commit did not; otherwise every check runs. Setup steps, rules, evidence and both reviews run as before, and a high-risk pull request with a carried check is never approved automatically. Leave it empty to run every check.
- **`[merge] overlap_hold`**: on (`true`) by default. `false` turns off the hold on conflict-prone files in every repository: no queued item waits for other work that changes the same conflict-prone file, and an item already waiting for one starts on the next scheduling pass. Paws writes the key only when it is `false`. Applies to the next scheduling pass, without a restart.
- **`[merge] conflict_prone_after`**: how many merge-queue conflicts within the window make a file conflict-prone, a whole number from 1 to 20. Default `2`.
- **`[merge] conflict_prone_days`**: the window in days, a whole number from 1 to 30. Default `7`. Paws writes each key only when it differs from its default; both apply to the next scheduling pass and to the Conflict-prone files list.

Paws merges after verification, required CI, reviews and branch protection permit it. Follow the dashboard's merge queue for the current reason work is waiting.

### `[findings]`

Settings › Findings reads and writes the grouping time: `GET` returns `groupingTime`, and an admin's `PUT` with `{"groupingTime": "HH:MM"}` (24-hour, UTC) saves it to the database; any other value gets 400. Daily review-finding grouping runs at that UTC time, `06:00` by default, and a save moves the next run without a restart. Unchanged findings skip the helper and the Linear title read. Each workspace can spend at most one helper turn per UTC day, including **Run now** from the Findings page. Failed or interrupted attempts consume that day's allowance. An admin can turn grouping off for a workspace with the switch at the top of the Findings page; while it is off, the daily job skips that workspace and **Run now** is refused.

Grouping uses a paired runner owned by an active workspace owner or admin who can authorize the reporting session, signed in to the configured implementer. When an earlier admin has no runner, the job uses an admin who does. A runner whose owner cannot see that session is not selected. It runs read-only without a repository checkout. The job only reads open issue titles. A member must choose **File as one issue**, **Add to** the suggested issue, or **Dismiss group** with a reason. Filing creates an undelegated Triage issue with the `review finding` label. Open groups are replaced on the next changed snapshot; groups already acted on remain in history.

### `[queue]`

- **`start_timeout_hours`**: how long an item may wait for a runner slot before Paws fails it. Default 24, from 1 to 720.
- **`max_running_per_owner`**: how many items one owner may run at once. Missing means no cap; at most 1000.

Workspace › Queue and limits › Queue sets both.

## Project skill roots

Workspace administrators can set a [local skills](local-skills.md) folder for each repository in Settings. Use an absolute path to an existing folder on the Paws host. Saves apply to the next implementation turn without a restart.

## Member VM size

Set the CPU count, memory, disk size, image and pool for newly created VMs in Settings. Existing VMs keep their size. An omitted setting uses the exe.dev default.

## Closeout `retry`

```yaml
retry:
  attempts_per_check: 3
  fix_rounds_per_item: 3
  narrow_after_lines: 800
```

- **`attempts_per_check`**: failed attempts one Closeout check gets, on the agent side and the Paws side. Default 3. A check that reaches it is exhausted and Paws asks the team. `maxFailedAttemptsPerItem` is a legacy alias.
- **`fix_rounds_per_item`**: fix rounds per item, counted since the latest reply from a person in the item's session. Default 3. Closeout findings, red CI and changes-requested reviews all count. When they are spent, Paws asks the team.
- **`narrow_after_lines`**: the size, in changed lines against the base, past which Paws narrows a candidate back to its issue. Default 800; `0` turns the size check off. When Closeout rejects a candidate that is past it, or that doubled since the previous review round and has at least 200 changed lines, the next fix round becomes a narrowing restart: the agent is told to cut the change back to the issue, with the files and commits added since the last smaller head. Paws narrows once per reply from a person; the narrowing restart counts as a fix round.

Rebase returns are not configurable: three in a row on a known main commit or a conflicting push, and six in any rolling hour, then Paws asks. Only a person's reply in the session refills a budget. [Verification questions](closeout.md#resolve-a-verification-question) describe both.

### Agent presets and Linear labels

A preset names an implementer and a reviewer, stored alongside the global agent defaults:

```toml
[agents.presets.Opus.implementer]
agent = "claude"
model = "opus"
effort = "high"

[agents.presets.Opus.reviewer]
agent = "codex"
model = "codex"
```

Each role uses the same agent, model and optional effort validation as other profiles,
and a preset's reviewer must differ from its implementer in agent or model; a preset
that fails is refused with its name.
Any profile can add `fast = true` to turn on the agent's fast mode (Claude Code and Codex).
It is off when absent. A model without fast mode runs at normal speed and Paws journals
`fast mode unavailable for <agent> <model>`.
Names contain 1–40 letters, digits, spaces, dots, underscores or hyphens.
Matching ignores case and surrounding spaces; duplicate names under that comparison
are refused. Quote TOML names containing spaces or dots.

The Linear label groups are **Implementer** and **Reviewer**. A label in either
group naming a preset applies the whole preset, both roles. Unknown names, and two
labels naming different presets (`conflicting_presets`), return label problems and
keep the defaults. Reviewer fallback is still omitted when it uses the resolved
reviewer's agent.

Paws reads the labels from Linear each time it creates a new implement run, so
a change takes effect on the next run and never moves a running turn. If Linear
can't be read, the run keeps the previous run's labels, or none on a first run.
A run doesn't start on a label problem: the item asks in Linear, naming the
label, the reason and the available presets. **Use the default** runs that role
with its default profile for this item only; **I fixed the label** reads the
labels again. The agent session names a label's effect, for example
`Implementer: Opus (label)`.

An item about to wait for a runner has its labels read first when presets exist,
so it waits for, or starts on, a runner with the labelled agent.

The existing admin-protected `/api/workspace/agents` endpoint reads and writes
a `presets` object keyed by name alongside `defaults`.

Agent profiles are global: every repository uses the same implementer and
reviewer.
