# Configuration reference

Paws reads two kinds of configuration:

- `~/.paws/config.toml`, the Paws server's settings. Setup writes it; you can edit it by hand while Paws is stopped. The Settings page saves to the database's `setting` table instead, so a save reaches every other Paws process sharing the database within 5 seconds. While that table is empty, `config.toml` supplies every setting. After the first save, the database holds the sections the Settings page owns (`[agents]`, `[agents.defaults…]`, `[agents.projects…]`, `[merge…]`, `[queue]`, `[time_limits…]`, `[checkout.projects…]` and `[brief…]`), and Paws ignores those sections in `config.toml`; every other section still comes from the file. When `config.toml` still has one of those sections, Paws journals it at startup and `bun run paws doctor` notes it as `settings-overrides`, naming each ignored section; change it on the Settings page instead. An unknown section or key, or a value Paws no longer accepts, stops Paws at startup with the line number and what to change.
- The Closeout policy for each repository, `.agents/closeout.yaml` on `origin/main` or a [local Closeout policy](local-closeout.md). Its `retry` block sets the fix budgets.

Changes that need action on upgrade are in the [changelog](../CHANGELOG.md).

## `paws install`

`bun run paws install` sets up a control plane as a systemd user service. It asks for the checkout path (`~/.local/share/paws/app`), `PAWS_HOME` (`~/.paws`), `PAWS_HOST`, `PAWS_PORT`, `PAWS_PUBLIC_DASHBOARD`, `PAWS_PUBLIC_URL`, `PAWS_RUNNER_HOST`, `PAWS_RUNNER_PORT`, the Linear team and the GitHub repositories. It writes `PAWS_HOME/https.env` (mode 0600), the `[linear] team` and `[github] repo`/`repos` keys of `config.toml`, `~/.config/systemd/user/paws.service` and its `paws.service.d/working-directory.conf` drop-in, then runs `systemctl --user daemon-reload`. It does not start the service.

Run it again to change a value: each prompt shows the current value as its default, and other env lines and `config.toml` keys stay as they are. Type `-` to clear an optional value. It needs bun 1.4.4 on `PATH` (`mise use -g bun@1.4.4`).

`bun run paws install secrets` asks for the GitHub App, the Linear OAuth client, the Linear and GitHub webhook secrets, the exe.dev token, the Tailscale auth key, Slack and, when `[agents.grok] allow_api_key` is set, `XAI_API_KEY`. Input is hidden. Each value is written envelope-encrypted to `PAWS_HOME/secrets`, except `XAI_API_KEY`, which goes into the env file `paws install` wrote. A webhook secret can be generated and is then shown once on the terminal. On a re-run each prompt says `set` or `not set`, and Enter keeps the value. It ends with the matching `paws doctor` checks.

For a scripted install, pass `--non-interactive` with flags such as `--paws-port 443`, or `--answers answers.toml` with the same keys in snake case (`paws_port = 443`, `github_repos = ["owner/repo"]`). Flags override the file, and a value left out keeps its current or default value.

A public dashboard also needs `PAWS_TLS_KEY_PATH` and `PAWS_TLS_CERT_PATH`. When `PAWS_PUBLIC_URL` is a tailnet name (`*.ts.net`), the installer offers to run `tailscale cert <host>` into `PAWS_HOME/tls/` (key 0600). That needs the tailscale CLI, HTTPS certificates turned on for the tailnet, and `sudo tailscale set --operator=$USER`; if it fails, the installer prints the commands to run and asks for paths instead. For any other URL it asks for existing key and certificate paths. The pair uses the certificate checks from `paws public-tls validate` against the public URL hostname. The runner listener on `PAWS_RUNNER_PORT` uses the same certificate; `PAWS_RUNNER_HOST` is only its bind address. A wrong host, an expired certificate or a key readable by others is explained and asked again. A certificate from `tailscale cert` is renewed weekly by `~/.config/systemd/user/paws-tls-renew.timer`, which then reloads Paws (SIGHUP, exit 75 and restart). The installer finishes with the tailnet policy rule for the dashboard and runner ports ([Create VM](create-vm.md)). Scripted installs take `tailscale_cert`, `tls_key_path` and `tls_cert_path`. Supplied certificate paths default to skipping `tailscale cert`. Switching to existing certificates or disabling the public dashboard disables and removes the renewal timer.

## `config.toml`

| Section                                                         | Keys                                                                                                                                                       | Notes                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[linear]`                                                      | `team`, `team_id`, `viewer_id`, `secret`, `client_file`, `webhooks`, `comment_agents`                                                                      | Written by setup. `secret` and `client_file` are paths under `~/.paws`, never the secret itself. `comment_agents` lists the Linear app user ids of external agents whose issue comments reach the agent; see [Ordinary issue comments](linear-agent-sessions.md#ordinary-issue-comments). |
| `[github]`                                                      | `auth`, `repo`, `repos`, `agent_read_off`                                                                                                                  | `auth` accepts only `"app"`; see [GitHub App](github-app.md). `agent_read_off` lists repositories whose agent turns get no read-only GitHub token; see [the agent's token](runner-enrollment.md#the-agents-read-only-github-token).                                                       |
| `[tracker]`                                                     | `kind`                                                                                                                                                     | Only `"linear"`.                                                                                                                                                                                                                                                                          |
| `[checkout]`                                                    | `path`                                                                                                                                                     | The repository checkout Paws works from.                                                                                                                                                                                                                                                  |
| `[checkout.projects."owner/repo"]`                              | `exclude`                                                                                                                                                  | Folders left out of worktrees; see the [README](../README.md).                                                                                                                                                                                                                            |
| `[caps]`                                                        | `max_awake_ms`                                                                                                                                             | Implementation time limit when `[time_limits]` has no `implementation_minutes`. An older `max_turns` key is ignored.                                                                                                                                                                      |
| `[time_limits]`, `[time_limits.projects."<Linear project id>"]` | `implementation_minutes`, `fixes_minutes`, `closeout_minutes`                                                                                              | See [below](#time_limits).                                                                                                                                                                                                                                                                |
| `[agents]`, `[agents.grok]`                                     | `implementer`, `path`, `allow_api_key`                                                                                                                     | `implementer` is `claude`, `grok` or `codex`. Models and effort are set in Settings, under Agents. Whether an agent keeps running on extra usage is a runner setting, under Settings › Runners.                                                                                           |
| `[closeout.projects."owner/repo"]`                              | `policy_root`                                                                                                                                              | A [local Closeout policy](local-closeout.md).                                                                                                                                                                                                                                             |
| `[skills.projects."owner/repo"]`                                | `root`                                                                                                                                                     | [Local skills](local-skills.md).                                                                                                                                                                                                                                                          |
| `[merge]`                                                       | `order`, `main_moved`, `lane`, `ci_fix_attempts`, `comment_quiet_seconds`, `comment_max_wait_seconds`, `review_wait_max_seconds`, `auto_approve_high_risk` | See [below](#merge).                                                                                                                                                                                                                                                                      |
| `[queue]`                                                       | `start_timeout_hours`, `max_running_per_owner`                                                                                                             | See [below](#queue).                                                                                                                                                                                                                                                                      |
| `[database]`                                                    | `url`                                                                                                                                                      | A Postgres URL, a secret; `PAWS_DATABASE_URL` wins. Without it Paws uses PGlite in `~/.paws/pglite`: see [Database](postgres.md).                                                                                                                                                         |

Time limits count active work only. Waiting does not spend them: queued items, runner capacity waits, questions, pauses, usage limits, retry backoff, Closeout waiting on CI or a runner, and the merge queue all count zero. Time-limit messages report each stage's time separately from waiting.

### `[time_limits]`

```toml
[time_limits]
implementation_minutes = 180
fixes_minutes = 0
closeout_minutes = 0

[time_limits.projects."<Linear project id>"]
fixes_minutes = 60
```

Each stage has its own limit, and `0` means the stage's time is not counted. The stage of an agent turn comes from the restart that started it:

- **Implementation**: the first turn, a follow-up and an answer to a question.
- **Fixes**: turns for CI, review comments, Closeout findings and merge conflicts. Fix rounds are already limited by count (`ci_fix_attempts`), so by default their time is not counted.
- **Closeout**: Closeout's checks of a head.

A key missing from a project's table comes from `[time_limits]`. A missing `implementation_minutes` is `[caps] max_awake_ms`, so a file without `[time_limits]` limits implementation to `max_awake_ms` (3 hours by default) and counts neither fixes nor Closeout. Limits are fixed when an item is delegated and when a person asks for more time. Settings › Queue and limits › Time limits (`/api/settings/time-limits`) reads and writes these tables.

When a stage reaches its limit, Paws stops the agent or the Closeout run and asks in the Linear session, naming the stage ("Implementation reached its 3 h limit"): Continue or Stop, plus Merge once Closeout accepted a head. Continue after a stopped Closeout run checks the same head again. Accepted work in the merge queue or re-verification is not stopped. A task without a Linear session pauses when Closeout accepted a head, and fails otherwise.

Continue, or a typed answer to the time-limit question, starts over only the stage that reached its limit, and Paws says so in the session. A reply in the Linear session starts every stage over. Paws' own restarts (CI repair, review comments, conflicts, Closeout findings, recovery) do not reset any stage.

### `[merge]`

```toml
[merge]
order = "queue"
auto_approve_high_risk = false

[merge.projects."<Linear project id>"]
order = "ci-green"
lane = "repository"

[[merge.rules]]
label = "hotfix"
order = "ci-green"
```

- **`order`**: how pull requests in one repository merge. `queue` (default) merges one at a time through the merge lane. `ci-green` merges each one on its own green CI. `github-queue` hands the merge to GitHub's merge queue. A rule matching one of the issue's labels wins over the issue's Linear project, which wins over the default. A rule with `project` applies only to that project and wins over a rule without one.
- **`main_moved`**: what the merge lane does when `main` moved before the merge. Set it in `[merge]`, `[merge.projects.*]` or `[[merge.rules]]`, or in Settings › Merging as "When main moved before the merge".
  - `"ci"` (default, and what a missing key means): rebase onto `main`, and the new head merges once its CI is green. Closeout does not run again; the new head carries Closeout's acceptance of the head it was rebased from.
  - `"overlap"`: when main's new commits touch none of the pull request's files, grouped by the repository's `packages` roots, merge without a rebase. When they do, or when GitHub requires branches to be up to date before merging, rebase and wait for CI as with `"ci"`.
  - `"green"`: a pull request behind main merges once its own CI is green. Paws doesn't rebase it and doesn't compare main's new commits with its files. When GitHub requires branches to be up to date before merging, the branch is updated first, as with `"overlap"`. Main's new commits aren't tested together with the change before it merges; GitHub still refuses a pull request that conflicts. In Settings › Merging it is "Merge on green CI without updating the branch onto main".
  - `"closeout"`: rebase and run Closeout again on the new head before it can merge.

  A changed Closeout policy sends a carried head back through Closeout under every value.

  Under every value the rebase runs on an online runner the item's owner may use, the item's last runner first, and the lane uses the pushed head only when it descends from `main` and `git patch-id --stable` matches the head it was rebased from. A refused head, a runner failure, no runner or no answer within 10 minutes makes the lane rebase on the Paws host once, and the journal says why. Paws keeps no worktree for a runner-backed item, so that fallback rebases in a temporary detached checkout under `~/.paws/tmp` and moves the item's candidate ref in the bare mirror to the pushed head.

- **`lane`**: which items wait for each other in a repository's merge queue under `order = "queue"`. `"project"` (default) gives each Linear project its own lane in the repository, and items without a project share the repository-wide lane. `"repository"` puts every item in the repository in one lane. Set it in `[merge]` or `[merge.projects.*]`, where a project's value wins; labels play no part. An item keeps the lane it joined with while it holds its place. Queue messages name the project: "Second in the acme/monorepo queue for Billing". Lanes in one repository can squash one after another; `mergeable(S)` still requires S to contain the current `main`, so the second lane's head goes through `main_moved` first.

- **`auto_approve_high_risk`**: off by default. Settings › Merging offers "Let high-risk changes through when both reviews are clean". When on, a high-risk head needs no manual approval only if Closeout accepted that exact head under the current policy, both `security-review` and `independent-review` passed without P2-or-worse findings, including findings in pre-existing code, and no rule probe failed. Missing or unreadable evidence asks a person. Changes to `.paws/high-risk-paths`, any loaded Closeout policy input, `AGENTS.md`, `CLAUDE.md`, `.agents/**` or `.claude/**` always need a person. Review severities are stored with their exact Closeout attempt; the shared findings list cannot turn a P2 review into a clean review. Automatic approval is never stored and does not carry to a new or rebased head; both named reviews must run on that head. Manual approvals keep their existing carry-over behavior.

- **`comment_quiet_seconds`**: how long Paws waits after the latest pull request comment or changes-requested review before it sends what it collected to the agent in one fix round. Default 60, from 0 to 3600. Settings › Merging › Pull request comments sets it as "Quiet time". A change applies to the next comment, without a restart.
- **`comment_max_wait_seconds`**: the longest Paws keeps collecting while comments keep arriving, counted from the first one. Default 300, from 0 to 3600, and never below the quiet time. Settings › Merging calls it "Longest wait".
- **`review_wait_max_seconds`**: the longest pull request comments and changes-requested reviews wait for review apps that are still checking the head, counted from the head's push (its first check suite's creation). While GitHub's checks can't be read, the wait holds until this long after the feedback arrived. Default 900, from 0 to 3600. Past it, Paws restarts with what has arrived. The Settings API sends it as `commentWait.reviewWaitMaxSeconds`; a body without it keeps the stored value.
- **`ci_fix_attempts`**: legacy. Still read and shown in Settings › Merging › Pull request checks as "CI fix attempts", but it no longer sets a separate CI budget. Red CI on the pull request is a fix round and counts against the policy's `retry.fix_rounds_per_item`.
- **`[merge.repositories."owner/repo"] packages`**: package roots such as `apps/*`. With `main_moved = "overlap"`, a change anywhere under the same root on main counts as an overlap.
- **`[merge.repositories."owner/repo"] review_apps`**: GitHub App slugs such as `acme-review` whose check runs comments wait for. Bots whose comments Paws has recorded on the repository's pull requests count as review apps without being listed.
- **`[merge.repositories."owner/repo"] ignore_comment_bots`**: bot logins such as `codecov[bot]` whose pull request comments only report status, so they never restart the item. Replaces the default list (Cloudflare Pages, Linear, Codecov, Netlify, Vercel, changesets) for that repository; `[]` ignores no bot.
- **`[merge.repositories."owner/repo"] ignore_comment_markers`**: literal strings; a pull request comment whose body contains one never restarts the item. Use it for a bot such as `github-actions[bot]` that posts status comments and real failures under the same login. At most 100 markers of at most 200 characters, none empty or repeated. Edits and deletions of a comment never restart the item either, so an updated sticky comment needs no marker of its own.

  ```toml
  [merge.repositories."acme/monorepo"]
  ignore_comment_markers = ["<!-- add-pr-comment:todo-count -->", "<!-- deploy-security-proof -->"]
  ```

  Settings › Merging › Ignored PR comments edits both lists for each repository, one entry per line: **Bot accounts** (`ignore_comment_bots`) and **Comment markers** (`ignore_comment_markers`). An invalid entry is shown next to its field and nothing is saved. A saved change applies to the next comment, without a restart.

- **`[merge.repositories."owner/repo"] suggested_findings`**: what Paws does with review findings below the review's `failOn` in code the pull request changed. `"off"` only lists them under the pull request's Open findings. `"next_turn"` (default) also hands them to the agent as suggestions in the next restart the item gets for any other reason. `"own_turn"` also starts one restart for them right after acceptance, once per item. A change applies to the next publication or restart, without a restart of Paws. [Suggested findings](closeout.md#suggested-findings) has the details.

The merge lane squashes head S only when `mergeable(S)` holds: the pull request head is S, S contains the current `main`, Closeout accepted S under the current policy digest (while main's policy does not load, the lane holds the queue instead of sending items back), CI is green for S, no review thread is unresolved and branch protection is satisfied. [After acceptance](closeout.md#after-acceptance) has the details.

### `[findings]`

`grouping_time = "06:00"` schedules daily review-finding grouping at that UTC time. It accepts `HH:MM` and defaults to `06:00`. Unchanged findings skip the helper and the Linear title read. Each workspace can spend at most one helper turn per UTC day, including **Run now** from the Findings page. Failed or interrupted attempts consume that day's allowance. An admin can turn grouping off for a workspace in **Settings → Findings**; while it is off, the daily job skips that workspace and **Run now** is refused.

Grouping uses a paired runner owned by an active workspace owner or admin who can authorize the reporting session, signed in to the configured implementer, on runner 0.1.53 or later. When an earlier admin has no runner, the job uses an admin who does. A runner whose owner cannot see that session is not selected. It runs read-only without a repository checkout. The job only reads open issue titles. A member must choose **File as one issue**, **Add to** the suggested issue, or **Dismiss group** with a reason. Filing creates an undelegated Triage issue with the `review finding` label. Open groups are replaced on the next changed snapshot; groups already acted on remain in history.

### `[queue]`

- **`start_timeout_hours`**: how long an item may wait for a runner slot before Paws fails it. Default 24, from 1 to 720.
- **`max_running_per_owner`**: how many items one owner may run at once. Missing means no cap; at most 1000.

Settings › Queue and limits › Queue sets both.

## Closeout `retry`

```yaml
retry:
  attempts_per_check: 3
  fix_rounds_per_item: 3
```

- **`attempts_per_check`**: failed attempts one Closeout check gets, on the agent side and the Paws side. Default 3. A check that reaches it is exhausted and Paws asks the team. `maxFailedAttemptsPerItem` is a legacy alias.
- **`fix_rounds_per_item`**: fix rounds per item, counted since the latest reply from a person in the item's session. Default 3. Closeout findings, red CI and changes-requested reviews all count. When they are spent, Paws asks the team.

Rebase returns are not configurable: three in a row on a known main commit or a conflicting push, and six in any rolling hour, then Paws asks. Only a person's reply in the session refills a budget. [Fix rounds](closeout.md#fix-rounds) and [When Paws asks the team](closeout.md#when-paws-asks-the-team) describe both.

Grouping bounds each helper prompt to 65,000 characters. Linear title reads stop at each team’s share of a 65,000-character total, with at most 1,000 titles per team. Large snapshots rotate a batch of findings and the sampled issue titles daily; finding text is capped at 4,000 characters and titles at 500. Partial snapshots are revisited without requiring another finding change. Grouping helpers have a ten-minute command lifetime.

Grouping is maintenance work. An interactive classification or repository-selection helper fences an unfinished grouping helper only when dispatch commits to that runner. Ranking prefers an idle helper slot and never interrupts grouping. The runner has one helper slot independently of its work capacity; the interrupted grouping turn still counts against its daily allowance. This is the issue’s explicit cost cap, confirmed by the team: report preemption as a failed attempt and pick the findings up on the next UTC day. Overflow processing saves the last processed finding ID and resumes after it, including when earlier findings close. A batch wraps from the tail to the head to fill its prompt budget. Legacy list-position cursors start a fresh pass. It preserves groups outside the processed batch, finishes a pass through the snapshot, then records an explicit skip reason while the findings stay unchanged.

### Agent presets and Linear labels

Named profiles can be stored alongside agent defaults and project overrides:

```toml
[agents.presets.Opus]
agent = "claude"
model = "opus"
effort = "high"

[agents.presets.Codex]
agent = "codex"
model = "codex"
```

Presets use the same agent, model and optional effort validation as other profiles.
Names contain 1–40 letters, digits, spaces, dots, underscores or hyphens.
Matching ignores case and surrounding spaces; duplicate names under that comparison
are refused. Quote TOML names containing spaces or dots.

The Linear label groups are **Implementer** and **Reviewer**. Each group's label
name identifies a preset. The profile resolver accepts these names independently:
label preset, then repository override, then global default. Unknown names and
reviewer labels matching the implementer's agent and model return label problems
and retain the inherited profile for that role. Reviewer fallback is still omitted
when it uses the resolved reviewer's agent.

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

The existing admin-protected `/api/settings/agents` endpoint reads and writes
a `presets` object keyed by name alongside `defaults` and `projects`.
