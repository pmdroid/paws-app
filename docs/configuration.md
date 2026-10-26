# Configuration reference

Paws reads two kinds of configuration:

- `~/.paws/config.toml`, the Paws server's settings. Setup and the Settings page write it; you can edit it by hand while Paws is stopped. An unknown section or key, or a value Paws no longer accepts, stops Paws at startup with the line number and what to change.
- The Closeout policy for each repository, `.agents/closeout.yaml` on `origin/main` or a [local Closeout policy](local-closeout.md). Its `retry` block sets the fix budgets.

Changes that need action on upgrade are in the [changelog](../CHANGELOG.md).

## `config.toml`

| Section                            | Keys                                                                | Notes                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `[linear]`                         | `team`, `team_id`, `viewer_id`, `secret`, `client_file`, `webhooks` | Written by setup. `secret` and `client_file` are paths under `~/.paws`, never the secret itself.   |
| `[github]`                         | `auth`, `repo`, `repos`                                             | `auth` accepts only `"app"`; see [GitHub App](github-app.md).                                      |
| `[tracker]`                        | `kind`                                                              | Only `"linear"`.                                                                                   |
| `[checkout]`                       | `path`                                                              | The repository checkout Paws works from.                                                           |
| `[checkout.projects."owner/repo"]` | `exclude`                                                           | Folders left out of worktrees; see the [README](../README.md).                                     |
| `[caps]`                           | `max_turns`, `max_awake_ms`                                         | Turn and awake-time caps.                                                                          |
| `[agents]`, `[agents.grok]`        | `implementer`, `path`, `allow_api_key`                              | `implementer` is `claude`, `grok` or `codex`. Models and effort are set in Settings, under Agents. |
| `[closeout.projects."owner/repo"]` | `policy_root`                                                       | A [local Closeout policy](local-closeout.md).                                                      |
| `[skills.projects."owner/repo"]`   | `root`                                                              | [Local skills](local-skills.md).                                                                   |
| `[merge]`                          | `order`, `main_moved`, `ci_fix_attempts`                            | See [below](#merge).                                                                               |
| `[queue]`                          | `start_timeout_hours`, `max_running_per_owner`                      | See [below](#queue).                                                                               |

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
- **`main_moved`**: deprecated. The only accepted value is `"closeout"`, which is also what a missing key means: when `main` moves before the merge, the lane rebases and Closeout verifies the rebased head before it can merge. `"ci"` and `"overlap"` are rejected at startup, because they merged heads Closeout never saw. Set the key to `"closeout"` or delete it, in `[merge]`, in `[merge.projects.*]` and in `[[merge.rules]]`.
- **`ci_fix_attempts`**: legacy. Still read and shown in Settings, but it no longer sets a separate CI budget. Red CI on the pull request is a fix round and counts against the policy's `retry.fix_rounds_per_item`.
- **`[merge.repositories."owner/repo"] packages`**: package roots such as `apps/*`. Accepted and kept when Settings rewrites the file; no merge order reads them today.

The merge lane squashes head S only when `mergeable(S)` holds: the pull request head is S, S contains the current `main`, Closeout accepted S under the current policy digest, CI is green for S, no review thread is unresolved and branch protection is satisfied. [After acceptance](closeout.md#after-acceptance) has the details.

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
