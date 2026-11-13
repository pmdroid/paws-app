# Configuration reference

Paws reads its settings from three places:

- The **Settings** pages in the dashboard, for agents, merging, the queue, time limits and agent instructions ([Settings pages](#settings-pages)). They save to the database's `setting` table, so a save reaches every other Paws process sharing the database within 5 seconds.
- `~/.paws/config.toml`, for the settings no Settings page holds ([`config.toml`](#configtoml)). Setup writes it; you can edit it by hand while Paws is stopped. An unknown section or key, or a value Paws no longer accepts, stops Paws at startup with the line number and what to change.
- The Closeout policy for each repository, `.agents/closeout.yaml` on `origin/main` or a [local Closeout policy](local-closeout.md). Its `retry` block sets the fix budgets.

Changes that need action on upgrade are in the [changelog](../CHANGELOG.md).

## `paws install`

`bun run paws install` sets up a control plane as a systemd user service. It asks for the checkout path (`~/.local/share/paws/app`), `PAWS_HOME` (`~/.paws`), `PAWS_HOST`, `PAWS_PORT`, `PAWS_PUBLIC_DASHBOARD`, `PAWS_PUBLIC_URL`, `PAWS_RUNNER_HOST`, `PAWS_RUNNER_PORT`, the Linear team and the GitHub repositories. It writes `PAWS_HOME/https.env` (mode 0600), the `[linear] team` and `[github] repo`/`repos` keys of `config.toml`, `~/.config/systemd/user/paws.service` and its `paws.service.d/working-directory.conf` drop-in, then runs `systemctl --user daemon-reload`. It does not start the service.

Run it again to change a value: each prompt shows the current value as its default, and other env lines and `config.toml` keys stay as they are. Type `-` to clear an optional value. It needs bun 1.4.4 on `PATH` (`mise use -g bun@1.4.4`).

`bun run paws install secrets` asks for the GitHub App, the Linear OAuth client, the Linear and GitHub webhook secrets, the exe.dev token, the Tailscale auth key, Slack and, when `[agents.grok] allow_api_key` is set, `XAI_API_KEY`. Input is hidden. Each value is written envelope-encrypted to `PAWS_HOME/secrets`, except `XAI_API_KEY`, which goes into the env file `paws install` wrote. A webhook secret can be generated and is then shown once on the terminal. On a re-run each prompt says `set` or `not set`, and Enter keeps the value. It ends with the matching `paws doctor` checks.

For a scripted install, pass `--non-interactive` with flags such as `--paws-port 443`, or `--answers answers.toml` with the same keys in snake case (`paws_port = 443`, `github_repos = ["owner/repo"]`). Flags override the file, and a value left out keeps its current or default value.

A public dashboard also needs `PAWS_TLS_KEY_PATH` and `PAWS_TLS_CERT_PATH`. When `PAWS_PUBLIC_URL` is a tailnet name (`*.ts.net`), the installer offers to run `tailscale cert <host>` into `PAWS_HOME/tls/` (key 0600). That needs the tailscale CLI, HTTPS certificates turned on for the tailnet, and `sudo tailscale set --operator=$USER`; if it fails, the installer prints the commands to run and asks for paths instead. For any other URL it asks for existing key and certificate paths. The pair uses the certificate checks from `paws public-tls validate` against the public URL hostname. The runner listener on `PAWS_RUNNER_PORT` uses the same certificate unless `PAWS_RUNNER_TLS_KEY_PATH` and `PAWS_RUNNER_TLS_CERT_PATH` give it its own; `PAWS_RUNNER_HOST` is only its bind address, and `PAWS_RUNNER_URL` sets the origin runners connect to ([A separate runner address and certificate](runner-enrollment.md#a-separate-runner-address-and-certificate)). A wrong host, an expired certificate or a key readable by others is explained and asked again. A certificate from `tailscale cert` is renewed weekly by `~/.config/systemd/user/paws-tls-renew.timer`, which then reloads Paws (SIGHUP, exit 75 and restart). The installer finishes with the tailnet policy rule for the dashboard and runner ports ([Create VM](create-vm.md)). Scripted installs take `tailscale_cert`, `tls_key_path` and `tls_cert_path`. Supplied certificate paths default to skipping `tailscale cert`. Switching to existing certificates or disabling the public dashboard disables and removes the renewal timer.

`PAWS_PUBLIC_TLS=proxy` is for a public dashboard behind a proxy that terminates HTTPS. Paws then serves plain HTTP, takes no `PAWS_TLS_KEY_PATH` or `PAWS_TLS_CERT_PATH`, runs runner control only with `PAWS_RUNNER_URL`, `PAWS_RUNNER_TLS_KEY_PATH` and `PAWS_RUNNER_TLS_CERT_PATH`, and reads the client address for the sign-in limits from the last `X-Forwarded-For` entry. Any other value fails startup. See [Behind a proxy](workspace-access.md#behind-a-proxy).

## Settings pages

| Settings page                 | What it sets                                                                                           | API                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Settings › Agents             | The implementer and reviewer, their models and effort, and [presets](#agent-presets-and-linear-labels) | `/api/settings/agents`                                               |
| Settings › Merging            | How accepted pull requests reach main ([below](#merging))                                              | `/api/settings/merging`; `/api/settings/agents` for CI fix attempts  |
| Settings › Queue and limits   | The [queue](#queue) and the [time limits](#time-limits)                                                | `/api/settings/agents` for the queue, `/api/settings/time-limits`    |
| Settings › Agent instructions | The [brief](#agent-instructions), skills and hooks                                                     | `/api/settings/brief`, `/api/settings/skills`, `/api/settings/hooks` |

Whether an agent keeps running on extra usage is a runner setting, under Settings › Runners.

An older install kept these settings in `config.toml`, in the sections `[agents]`, `[agents.defaults…]`, `[agents.presets…]`, `[merge…]`, `[queue]`, `[time_limits…]` and `[brief…]`. Until the first save on one of these Settings pages, Paws reads them from the file; that save copies them into the database, and from then on Paws ignores them in `config.toml`. When `config.toml` still has one of those sections, Paws journals it at startup and `bun run paws doctor` notes it as `settings-overrides`, naming each ignored section.

### Agent presets and Linear labels

A preset on Settings › Agents names an implementer and a reviewer, each an agent, a model and an optional effort, stored alongside the global agent defaults. Each role uses the same agent, model and optional effort validation as other profiles,
and a preset's reviewer must differ from its implementer in agent or model; a preset
that fails is refused with its name.
Any profile can turn on the agent's fast mode (Claude Code and Codex); it is off by default. A model without fast mode runs at normal speed and Paws journals
`fast mode unavailable for <agent> <model>`; a runner older than 0.1.81 runs without it
and Paws journals `fast mode needs runner 0.1.81`.
Names contain 1–40 letters, digits, spaces, dots, underscores or hyphens.
Matching ignores case and surrounding spaces; duplicate names under that comparison
are refused.

A preset saved in the older single-profile form loads as that implementer with the default reviewer,
or with the reviewer fallback when the default reviewer would match the implementer.
The next save writes both roles.

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

The admin-protected `/api/settings/agents` endpoint reads and writes
a `presets` object keyed by name alongside `defaults`. Its
`defaults.reviewerFallback` is the [reviewer fallback](closeout.md#paws-closeout) profile.

Agent profiles are global: every repository uses the same implementer and
reviewer. Old `[agents.projects…]` tables keep loading; Paws ignores them and journals once at startup "agents.projects is no
longer supported; using the global profiles". The next save of agent settings
leaves them out.

### Merging

Settings › Merging (`/api/settings/merging`) holds the merge choices, and every item uses them. Each choice below is named by its field on the page or in the API body, and by its key in the saved `[merge]` settings. Paws still loads an `order` or `main_moved` under `[merge.projects.*]` and every `[[merge.rules]]` table, ignores them, and journals one line at startup; the next Settings › Merging save drops them.

- **Merge order** (`order`): how pull requests in one repository merge. `queue` (default) merges one at a time through the merge lane. `ci-green` merges each one on its own green CI. `github-queue` hands the merge to GitHub's merge queue.
- **When main moved before the merge** (`main_moved`): what the merge lane does when `main` moved before the merge.
  - `"ci"` (default), "Always update the branch and wait for CI": rebase onto `main`, and the new head merges once its CI is green. Closeout does not run again; the new head carries Closeout's acceptance of the head it was rebased from.
  - `"overlap"`, "Update and re-test only when main changed the same files or package": when main's new commits touch none of the pull request's files, grouped by the repository's `packages` roots, merge without a rebase. When they do, or when GitHub requires branches to be up to date before merging, rebase and wait for CI as with `"ci"`.
  - `"green"`, "Merge on green CI without updating the branch onto main": a pull request behind main merges once its own CI is green. Paws doesn't rebase it and doesn't compare main's new commits with its files. When GitHub requires branches to be up to date before merging, the branch is updated first, as with `"overlap"`. Main's new commits aren't tested together with the change before it merges; GitHub still refuses a pull request that conflicts.
  - `"closeout"`, "Always update the branch and run Closeout again": rebase and run Closeout again on the new head before it can merge.

  A changed Closeout policy sends a carried head back through Closeout under every value.

  Under every value the rebase runs on an online runner the item's owner may use, the item's last runner first, and the lane uses the pushed head only when it descends from `main` and `git patch-id --stable` matches the head it was rebased from. A refused head, a runner failure, no runner or no answer within 10 minutes makes the lane rebase on the Paws host once, and the journal says why. Paws keeps no worktree for a runner-backed item, so that fallback rebases in a temporary detached checkout under `~/.paws/tmp` and moves the item's candidate ref in the bare mirror to the pushed head.

- **`lanes`** (API `lanes`): which items wait for each other in a repository's merge queue under `order = "queue"`. Lanes always split by repository; `"project"` splits them by Linear project and `"person"` by the item's owner. The default `["project", "person"]` gives each person their own lane in each project; `[]` puts every item in the repository in one lane. The old `lane` key is still read: `"project"` means `["project", "person"]` and `"repository"` means `["person"]`; a save writes `lanes`. A `lane = "repository"` under `[merge.projects.*]` turns the project split off for that project; labels play no part. An item keeps the lane it joined with while it holds its place. Queue messages name the project: "Second in the acme/monorepo queue for Billing". Lanes in one repository can squash one after another; `mergeable(S)` still requires S to contain the current `main`, so the second lane's head goes through `main_moved` first.
- **`no_project`** (API `noProject`): where an item without a Linear project waits. `"own"` (default) gives it a lane of its own, so it never waits behind another item's merge; an overlap hold on shared files still applies. `"lane"` puts it in the lane without a project, split by person when `lanes` has `"person"`.
- **`parallel`**: how many pull requests of one lane may merge at once, from 1 (default) to 5. The head of the lane goes as before. A task behind it in the lane's first `parallel` ready tasks merges alongside it only when its pull request is green on its own head and its latest candidate changes none of the files of the tasks ahead of it; one that shares a file waits as before. A batch member is not rebased onto the others: under `main_moved = "green"` or `"overlap"` it merges as it is. When two or more pull requests of a lane merged within 10 minutes of each other and main's CI then fails, the lane merges one at a time until main is green again, and the journal names the batch's pull requests.

- **Let high-risk changes through when both reviews are clean** (`auto_approve_high_risk`): off by default. When on, a high-risk head needs no manual approval only if Closeout accepted that exact head under the current policy, both `security-review` and `independent-review` passed without P2-or-worse findings, including findings in pre-existing code, and no rule probe failed. Missing or unreadable evidence asks a person. Changes to `.paws/high-risk-paths`, any loaded Closeout policy input, `AGENTS.md`, `CLAUDE.md`, `.agents/**` or `.claude/**` always need a person. Review severities are stored with their exact Closeout attempt; the shared findings list cannot turn a P2 review into a clean review. Automatic approval is never stored and does not carry to a new or rebased head; both named reviews must run on that head. Manual approvals keep their existing carry-over behavior.

- **Quiet time** (`comment_quiet_seconds`), under Pull request comments: how long Paws waits after the latest pull request comment or changes-requested review before it sends what it collected to the agent in one fix round. Default 60, from 0 to 3600. A change applies to the next comment, without a restart.
- **Longest wait** (`comment_max_wait_seconds`): the longest Paws keeps collecting while comments keep arriving, counted from the first one. Default 300, from 0 to 3600, and never below the quiet time.
- **`review_wait_max_seconds`** (API `commentWait.reviewWaitMaxSeconds`): the longest pull request comments and changes-requested reviews wait for review apps that are still checking the head, counted from the head's push (its first check suite's creation). While GitHub's checks can't be read, the wait holds until this long after the feedback arrived. Default 900, from 0 to 3600. Past it, Paws restarts with what has arrived. A body without it keeps the stored value.
- **CI fix attempts** (`ci_fix_attempts`), under Pull request checks: legacy. Still read and shown, but it no longer sets a separate CI budget. Red CI on the pull request is a fix round and counts against the policy's `retry.fix_rounds_per_item`.
- **`[merge.repositories."owner/repo"] packages`**: package roots such as `apps/*`. With `main_moved = "overlap"`, a change anywhere under the same root on main counts as an overlap.
- **`[merge.repositories."owner/repo"] review_apps`**: GitHub App slugs such as `acme-review` whose check runs comments wait for. Bots whose comments Paws has recorded on the repository's pull requests count as review apps without being listed.
- **Bot accounts** (`[merge.repositories."owner/repo"] ignore_comment_bots`), under Ignored PR comments: bot logins such as `codecov[bot]` whose pull request comments only report status, so they never restart the item. Replaces the default list (Cloudflare Pages, Linear, Codecov, Netlify, Vercel, changesets) for that repository; `[]` ignores no bot.
- **Comment markers** (`[merge.repositories."owner/repo"] ignore_comment_markers`): literal strings, such as `<!-- deploy-security-proof -->`; a pull request comment whose body contains one never restarts the item. Use it for a bot such as `github-actions[bot]` that posts status comments and real failures under the same login. At most 100 markers of at most 200 characters, none empty or repeated. Edits and deletions of a comment never restart the item either, so an updated sticky comment needs no marker of its own.

  Settings › Merging › Ignored PR comments edits both lists for each repository, one entry per line. An invalid entry is shown next to its field and nothing is saved. A saved change applies to the next comment, without a restart.

- **`[merge.repositories."owner/repo"] suggested_findings`**: what Paws does with review findings below the review's `failOn` in code the pull request changed. `"off"` only lists them under the pull request's Open findings. `"next_turn"` (default) also hands them to the agent as suggestions in the next restart the item gets for any other reason. `"own_turn"` also starts one restart for them right after acceptance, once per item. A change applies to the next publication or restart, without a restart of Paws. [Suggested findings](closeout.md#suggested-findings) has the details.
- **Hold work that changes this file** (`[merge.repositories."owner/repo"] parallel_files`), under Conflict-prone files: exact paths of conflict-prone files Paws does not hold work for in that repository, such as `["src/index.ts"]`. A conflict-prone file is one that sent work back for a merge-queue conflict in the last 7 days; while a running or merge-queue item changes it, a queued item that changes it too waits. Turning the toggle off for a file adds it; the file stays listed as Not held. Applies to the next scheduling pass.

The merge lane squashes head S only when `mergeable(S)` holds: the pull request head is S, S contains the current `main`, Closeout accepted S under the current policy digest (while main's policy does not load, the lane holds the queue instead of sending items back), CI is green for S, no review thread is unresolved and branch protection is satisfied. [After acceptance](closeout.md#after-acceptance) has the details.

### Queue

Settings › Queue and limits › Queue sets both, sent to `/api/settings/agents` as `queue`:

- **Fail an item that has not started after, in hours** (`startTimeoutHours`): how long an item may wait for a runner slot before Paws fails it. Default 24, from 1 to 720.
- **Most items one person or project runs at once** (`maxRunningPerOwner`): how many items one owner may run at once. Empty means no cap; at most 1000.

### Time limits

Settings › Queue and limits › Time limits (`/api/settings/time-limits`) gives each stage its own limit in minutes, or Not counted. The stage of an agent turn comes from the restart that started it:

- **Implementation**: the first turn, a follow-up and an answer to a question.
- **Fixes**: turns for CI, review comments, Closeout findings and merge conflicts. Fix rounds are already limited by count, so by default their time is not counted.
- **Closeout**: Closeout's checks of a head.

The limits are global: every item uses the same ones. Until they are saved, implementation is limited to `PAWS_MAX_AWAKE_MS`, else `[caps] max_awake_ms` in `config.toml` (3 hours by default), and neither fixes nor Closeout are counted. Limits are fixed when an item is delegated and when a person asks for more time. An old `[time_limits.projects…]` table still loads; Paws ignores it, journals once at startup "time_limits.projects is no longer supported; using the global time limits", and the next save of time limits leaves it out.

Time limits count active work only. Waiting does not spend them: queued items, runner capacity waits, questions, pauses, usage limits, retry backoff, Closeout waiting on CI or a runner, and the merge queue all count zero. Time-limit messages report each stage's time separately from waiting.

When a stage reaches its limit, Paws stops the agent or the Closeout run and asks in the Linear session, naming the stage ("Implementation reached its 3 h limit"): Continue or Stop, plus Merge once Closeout accepted a head. Continue after a stopped Closeout run checks the same head again. Accepted work in the merge queue or re-verification is not stopped. A task without a Linear session pauses when Closeout accepted a head, and fails otherwise.

Continue, or a typed answer to the time-limit question, starts over only the stage that reached its limit, and Paws says so in the session. A reply in the Linear session starts every stage over. Paws' own restarts (CI repair, review comments, conflicts, Closeout findings, recovery) do not reset any stage.

### Agent instructions

The agent brief on Settings › Agent instructions (`/api/settings/brief`) replaces the built-in agent brief for every repository. An old `[brief.projects…]` table still loads; Paws ignores it, journals once at startup "brief.projects is no longer supported; using the global brief template", and the next save of the template leaves it out.

## `config.toml`

| Section                              | Keys                                                                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[linear]`                           | `team`, `team_id`, `viewer_id`, `secret`, `client_file`, `webhooks`, `comment_agents` | Written by setup. `secret` and `client_file` are paths under `~/.paws`, never the secret itself. `comment_agents` lists the Linear app user ids of external agents whose issue comments reach the agent; see [Ordinary issue comments](linear-agent-sessions.md#ordinary-issue-comments).                                                                                             |
| `[github]`                           | `auth`, `repo`, `repos`, `agent_read_off`, `mirrors`                                  | `auth` accepts only `"app"`; see [GitHub App](github-app.md). `agent_read_off` lists repositories whose agent turns get no read-only GitHub token; see [the agent's token](runner-enrollment.md#the-agents-read-only-github-token). `mirrors = false` reads Closeout policy at `main` through the GitHub API instead of the bare git mirror in `~/.paws/repos`; missing means `true`. |
| `[tracker]`                          | `kind`                                                                                | Only `"linear"`.                                                                                                                                                                                                                                                                                                                                                                      |
| `[checkout]`                         | `path`                                                                                | The repository checkout Paws works from.                                                                                                                                                                                                                                                                                                                                              |
| `[caps]`                             | `max_awake_ms`                                                                        | Implementation time limit when the [time limits](#time-limits) have no implementation limit. An older `max_turns` key is ignored.                                                                                                                                                                                                                                                     |
| `[agents.grok]`, `[agents.opencode]` | `path`, `allow_api_key`                                                               | `path` runs that agent from a `PATH` command or an absolute path instead of the pinned package. `[agents.grok] allow_api_key` lets Grok sign in with `XAI_API_KEY`.                                                                                                                                                                                                                   |
| `[member_vm]`                        | `cpu`, `memory_gb`, `disk_gb`, `image`, `pool`                                        | The size [Create VM](create-vm.md) asks exe.dev for. `paws install` asks for it. A missing key uses exe.dev's default.                                                                                                                                                                                                                                                                |
| `[closeout.projects."owner/repo"]`   | `policy_root`                                                                         | A [local Closeout policy](local-closeout.md).                                                                                                                                                                                                                                                                                                                                         |
| `[skills.projects."owner/repo"]`     | `root`                                                                                | [Local skills](local-skills.md).                                                                                                                                                                                                                                                                                                                                                      |
| `[findings]`                         | `grouping_time`                                                                       | See [below](#findings).                                                                                                                                                                                                                                                                                                                                                               |
| `[database]`                         | `url`                                                                                 | A Postgres URL, a secret; `PAWS_DATABASE_URL` wins. Without it Paws uses PGlite in `~/.paws/pglite`: see [Database](postgres.md).                                                                                                                                                                                                                                                     |

### `[findings]`

`grouping_time = "06:00"` schedules daily review-finding grouping at that UTC time. It accepts `HH:MM` and defaults to `06:00`. Unchanged findings skip the helper and the Linear title read. Each workspace can spend at most one helper turn per UTC day, including **Run now** from the Findings page. Failed or interrupted attempts consume that day's allowance. An admin can turn grouping off for a workspace with the switch at the top of the Findings page; while it is off, the daily job skips that workspace and **Run now** is refused.

Grouping uses a paired runner owned by an active workspace owner or admin who can authorize the reporting session, signed in to the configured implementer, on runner 0.1.53 or later. When an earlier admin has no runner, the job uses an admin who does. A runner whose owner cannot see that session is not selected. It runs read-only without a repository checkout. The job only reads open issue titles. A member must choose **File as one issue**, **Add to** the suggested issue, or **Dismiss group** with a reason. Filing creates an undelegated Triage issue with the `review finding` label. Open groups are replaced on the next changed snapshot; groups already acted on remain in history.

Grouping bounds each helper prompt to 65,000 characters. Linear title reads stop at each team’s share of a 65,000-character total, with at most 1,000 titles per team. Large snapshots rotate a batch of findings and the sampled issue titles daily; finding text is capped at 4,000 characters and titles at 500. Partial snapshots are revisited without requiring another finding change. Grouping helpers have a ten-minute command lifetime.

Grouping is maintenance work. An interactive classification or repository-selection helper fences an unfinished grouping helper only when dispatch commits to that runner. Ranking prefers an idle helper slot and never interrupts grouping. The runner has one helper slot independently of its work capacity; the interrupted grouping turn still counts against its daily allowance. This is the issue’s explicit cost cap, confirmed by the team: report preemption as a failed attempt and pick the findings up on the next UTC day. Overflow processing saves the last processed finding ID and resumes after it, including when earlier findings close. A batch wraps from the tail to the head to fill its prompt budget. Legacy list-position cursors start a fresh pass. It preserves groups outside the processed batch, finishes a pass through the snapshot, then records an explicit skip reason while the findings stay unchanged.

## Closeout `retry`

```yaml
retry:
  attempts_per_check: 3
  fix_rounds_per_item: 3
```

- **`attempts_per_check`**: failed attempts one Closeout check gets, on the agent side and the Paws side. Default 3. A check that reaches it is exhausted and Paws asks the team. `maxFailedAttemptsPerItem` is a legacy alias.
- **`fix_rounds_per_item`**: fix rounds per item, counted since the latest reply from a person in the item's session. Default 3. Closeout findings, red CI and changes-requested reviews all count. When they are spent, Paws asks the team.

Rebase returns are not configurable: three in a row on a known main commit or a conflicting push, and six in any rolling hour, then Paws asks. Only a person's reply in the session refills a budget. [Fix rounds](closeout.md#fix-rounds) and [When Paws asks the team](closeout.md#when-paws-asks-the-team) describe both.
