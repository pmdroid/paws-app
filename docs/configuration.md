# Configuration reference

Paws reads two kinds of configuration:

- `~/.paws/config.toml`, the Paws server's settings. Setup and the Settings page write it; you can edit it by hand while Paws is stopped. An unknown section or key, or a value Paws no longer accepts, stops Paws at startup with the line number and what to change.
- The Closeout policy for each repository, `.agents/closeout.yaml` on `origin/main` or a [local Closeout policy](local-closeout.md). Its `retry` block sets the fix budgets.

Changes that need action on upgrade are in the [changelog](../CHANGELOG.md).

## `paws install`

`bun run paws install` sets up a control plane as a systemd user service. It asks for the checkout path (`~/.local/share/paws/app`), `PAWS_HOME` (`~/.paws`), `PAWS_HOST`, `PAWS_PORT`, `PAWS_PUBLIC_DASHBOARD`, `PAWS_PUBLIC_URL`, `PAWS_RUNNER_HOST`, `PAWS_RUNNER_PORT`, the Linear team and the GitHub repositories. It writes `PAWS_HOME/https.env` (mode 0600), the `[linear] team` and `[github] repo`/`repos` keys of `config.toml`, `~/.config/systemd/user/paws.service` and its `paws.service.d/working-directory.conf` drop-in, then runs `systemctl --user daemon-reload`. It does not start the service.

Run it again to change a value: each prompt shows the current value as its default, and other env lines and `config.toml` keys stay as they are. Type `-` to clear an optional value. It needs bun 1.4.2 on `PATH` (`mise use -g bun@1.4.2`).

`bun run paws install secrets` asks for the GitHub App, the Linear OAuth client, the Linear and GitHub webhook secrets, the exe.dev token, the Tailscale auth key, Slack and, when `[agents.grok] allow_api_key` is set, `XAI_API_KEY`. Input is hidden. Each value is written envelope-encrypted to `PAWS_HOME/secrets`, except `XAI_API_KEY`, which goes into the env file `paws install` wrote. A webhook secret can be generated and is then shown once on the terminal. On a re-run each prompt says `set` or `not set`, and Enter keeps the value. It ends with the matching `paws doctor` checks.

For a scripted install, pass `--non-interactive` with flags such as `--paws-port 443`, or `--answers answers.toml` with the same keys in snake case (`paws_port = 443`, `github_repos = ["owner/repo"]`). Flags override the file, and a value left out keeps its current or default value.

A public dashboard also needs `PAWS_TLS_KEY_PATH` and `PAWS_TLS_CERT_PATH`. When `PAWS_PUBLIC_URL` is a tailnet name (`*.ts.net`), the installer offers to run `tailscale cert <host>` into `PAWS_HOME/tls/` (key 0600). That needs the tailscale CLI, HTTPS certificates turned on for the tailnet, and `sudo tailscale set --operator=$USER`; if it fails, the installer prints the commands to run and asks for paths instead. For any other URL it asks for existing key and certificate paths. The pair uses the certificate checks from `paws public-tls validate` against the public URL hostname. The runner listener on `PAWS_RUNNER_PORT` uses the same certificate; `PAWS_RUNNER_HOST` is only its bind address. A wrong host, an expired certificate or a key readable by others is explained and asked again. A certificate from `tailscale cert` is renewed weekly by `~/.config/systemd/user/paws-tls-renew.timer`, which then reloads Paws (SIGHUP, exit 75 and restart). The installer finishes with the tailnet policy rule for the dashboard and runner ports ([Create VM](create-vm.md)). Scripted installs take `tailscale_cert`, `tls_key_path` and `tls_cert_path`. Supplied certificate paths default to skipping `tailscale cert`. Switching to existing certificates or disabling the public dashboard disables and removes the renewal timer.

## `config.toml`

| Section                            | Keys                                                                                          | Notes                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `[linear]`                         | `team`, `team_id`, `viewer_id`, `secret`, `client_file`, `webhooks`                           | Written by setup. `secret` and `client_file` are paths under `~/.paws`, never the secret itself.   |
| `[github]`                         | `auth`, `repo`, `repos`                                                                       | `auth` accepts only `"app"`; see [GitHub App](github-app.md).                                      |
| `[tracker]`                        | `kind`                                                                                        | Only `"linear"`.                                                                                   |
| `[checkout]`                       | `path`                                                                                        | The repository checkout Paws works from.                                                           |
| `[checkout.projects."owner/repo"]` | `exclude`                                                                                     | Folders left out of worktrees; see the [README](../README.md).                                     |
| `[caps]`                           | `max_turns`, `max_awake_ms`                                                                   | Turn and awake-time caps.                                                                          |
| `[agents]`, `[agents.grok]`        | `implementer`, `path`, `allow_api_key`                                                        | `implementer` is `claude`, `grok` or `codex`. Models and effort are set in Settings, under Agents. |
| `[closeout.projects."owner/repo"]` | `policy_root`                                                                                 | A [local Closeout policy](local-closeout.md).                                                      |
| `[skills.projects."owner/repo"]`   | `root`                                                                                        | [Local skills](local-skills.md).                                                                   |
| `[merge]`                          | `order`, `main_moved`, `ci_fix_attempts`, `comment_quiet_seconds`, `comment_max_wait_seconds` | See [below](#merge).                                                                               |
| `[queue]`                          | `start_timeout_hours`, `max_running_per_owner`                                                | See [below](#queue).                                                                               |

### `[merge]`

```toml
[merge]
order = "queue"

[merge.projects."<Linear project id>"]
order = "ci-green"

[[merge.rules]]
label = "hotfix"
order = "ci-green"
```

- **`order`**: how pull requests in one repository merge. `queue` (default) merges one at a time through the merge lane. `ci-green` merges each one on its own green CI. `github-queue` hands the merge to GitHub's merge queue. A rule matching one of the issue's labels wins over the issue's Linear project, which wins over the default. A rule with `project` applies only to that project and wins over a rule without one.
- **`main_moved`**: what the merge lane does when `main` moved before the merge. Set it in `[merge]`, `[merge.projects.*]` or `[[merge.rules]]`, or in Settings › Merging as "When main moved before the merge".
  - `"ci"` (default, and what a missing key means): rebase onto `main`, and the new head merges once its CI is green. Closeout does not run again; the new head carries Closeout's acceptance of the head it was rebased from.
  - `"overlap"`: when main's new commits touch none of the pull request's files, grouped by the repository's `packages` roots, merge without a rebase. When they do, or when GitHub requires branches to be up to date before merging, rebase and wait for CI as with `"ci"`.
  - `"closeout"`: rebase and run Closeout again on the new head before it can merge.

  A changed Closeout policy sends a carried head back through Closeout under every value.

- **`comment_quiet_seconds`**: how long Paws waits after the latest pull request comment or changes-requested review before it sends what it collected to the agent in one fix round. Default 60, from 0 to 3600. Settings › Merging › Pull request comments sets it as "Quiet time". A change applies to the next comment, without a restart.
- **`comment_max_wait_seconds`**: the longest Paws keeps collecting while comments keep arriving, counted from the first one. Default 300, from 0 to 3600, and never below the quiet time. Settings › Merging calls it "Longest wait".
- **`ci_fix_attempts`**: legacy. Still read and shown in Settings, but it no longer sets a separate CI budget. Red CI on the pull request is a fix round and counts against the policy's `retry.fix_rounds_per_item`.
- **`[merge.repositories."owner/repo"] packages`**: package roots such as `apps/*`. With `main_moved = "overlap"`, a change anywhere under the same root on main counts as an overlap.
- **`[merge.repositories."owner/repo"] ignore_comment_bots`**: bot logins such as `codecov[bot]` whose pull request comments only report status, so they never restart the item. Replaces the default list (Cloudflare Pages, Linear, Codecov, Netlify, Vercel, changesets) for that repository; `[]` ignores no bot.

The merge lane squashes head S only when `mergeable(S)` holds: the pull request head is S, S contains the current `main`, Closeout accepted S under the current policy digest, CI is green for S, no review thread is unresolved and branch protection is satisfied. [After acceptance](closeout.md#after-acceptance) has the details.

### `[findings]`

`grouping_time = "06:00"` schedules daily review-finding grouping at that UTC time. It accepts `HH:MM` and defaults to `06:00`. Unchanged findings skip the helper and the Linear title read. Each workspace can spend at most one helper turn per UTC day, including **Run now** from the Findings page. Failed or interrupted attempts consume that day's allowance. An admin can turn grouping off for a workspace in **Settings → Findings**; while it is off, the daily job skips that workspace and **Run now** is refused.

Grouping uses a paired runner owned by an active workspace owner or admin who can authorize the reporting session, signed in to the configured implementer, on runner 0.1.53 or later. When an earlier admin has no runner, the job uses an admin who does. A runner whose owner cannot see that session is not selected. It runs read-only without a repository checkout. The job only reads open issue titles. A member must choose **File as one issue**, **Add to** the suggested issue, or **Dismiss group** with a reason. Filing creates an undelegated Triage issue with the `review finding` label. Open groups are replaced on the next changed snapshot; groups already acted on remain in history.

### `[queue]`

- **`start_timeout_hours`**: how long an item may wait for a runner slot before Paws fails it. Default 24, from 1 to 720.
- **`max_running_per_owner`**: how many items one owner may run at once. Missing means no cap; at most 1000.

## Closeout `retry`

```yaml
retry:
  attempts_per_check: 3
  fix_rounds_per_item: 3
```

- **`attempts_per_check`**: failed attempts one Closeout check gets, on the agent side and the Paws side. Default 3. A check that reaches it is exhausted and Paws asks the team. `maxFailedAttemptsPerItem` is a legacy alias.
- **`fix_rounds_per_item`**: fix rounds per item, counted since the latest reply from a person in the item's session. Default 3. Closeout findings, red CI and changes-requested reviews all count. When they are spent, Paws asks the team.

Rebase returns are not configurable: three in a row on a known main commit and six in any rolling hour, then Paws asks. Only a person's reply in the session refills a budget. [Fix rounds](closeout.md#fix-rounds) and [When Paws asks the team](closeout.md#when-paws-asks-the-team) describe both.

Grouping bounds each helper prompt to 65,000 characters. Linear title reads stop at each team’s share of a 65,000-character total, with at most 1,000 titles per team. Large snapshots rotate a batch of findings and the sampled issue titles daily; finding text is capped at 4,000 characters and titles at 500. Partial snapshots are revisited without requiring another finding change. Grouping helpers have a ten-minute command lifetime.

Grouping is maintenance work. An interactive classification or repository-selection helper fences an unfinished grouping helper only when dispatch commits to that runner. Ranking prefers an idle helper slot and never interrupts grouping. The runner has one helper slot independently of its work capacity; the interrupted grouping turn still counts against its daily allowance. This is the issue’s explicit cost cap, confirmed by the team: report preemption as a failed attempt and pick the findings up on the next UTC day. Overflow processing saves the last processed finding ID and resumes after it, including when earlier findings close. A batch wraps from the tail to the head to fill its prompt budget. Legacy list-position cursors start a fresh pass. It preserves groups outside the processed batch, finishes a pass through the snapshot, then records an explicit skip reason while the findings stay unchanged.
