# GitHub issues

GitHub issues are the default tracker. Paws polls the repositories in `tracker.github.repos` with your OAuth user token from [GitHub sign-in](github-login.md). The run stays on your machine: there is no webhook, no public URL, and no GitHub App on this path.

Sign-in, scopes, and `github.auth` are in [GitHub sign-in](github-login.md). The real-machine run is in [the smoke test](smoke-test.md).

## Config

```toml
[tracker]
kind = "github"

[tracker.github]
trigger_label = "paws"
mention = "@paws"
trusted = ["OWNER", "MEMBER", "COLLABORATOR"]
repos = ["owner/name"]

[tracker.github.status_labels]
running = "paws:running"
awaiting_input = "paws:awaiting-input"
done = "paws:done"
```

| Key              | Role                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `[tracker] kind` | `github` (default) or `linear`                                                                       |
| `trigger_label`  | Label that hands an issue to Paws. Default `paws`                                                    |
| `mention`        | Plain-text trigger. Default `@paws`                                                                  |
| `trusted`        | GitHub author associations that may trigger, answer, and stop. The signed-in user is trusted as well |
| `repos`          | `owner/name` repositories to poll                                                                    |
| `status_labels`  | Labels Paws sets while an item is running, waiting for an answer, or done                            |

`github.repo` is the repository Paws pushes branches to. `tracker.github.repos` is the set it polls. A one-repository setup lists the same `owner/name` in both places. `agents.implementer` is `claude`, `grok`, or `codex`.

## Triggers

Paws starts an issue when either of these is true and the actor is trusted:

- The issue carries `trigger_label` (default `paws`), and the person who added it is trusted.
- The issue body or a comment contains `mention` (default `@paws`) as plain text, and the author is trusted.

Trusted means the signed-in account, or a GitHub author association of `OWNER`, `MEMBER`, or `COLLABORATOR`. Other associations are ignored. An untrusted `@paws` does not start work, does not answer a question, and does not stop a run.

Add the label after the epic's sub-issues and blocked-by links exist, so the first poll sees the whole epic.

## Why `@paws` is plain text

Comments and issue edits are made with the OAuth user token, so they appear as your GitHub account. `@paws` is plain text Paws searches for. A separate bot user, one GitHub can mention as its own account, is the optional GitHub App: `github.auth = "app"` in [GitHub sign-in](github-login.md).

## Epics and order

The labeled or mentioned issue is the epic.

- When it has sub-issues, those sub-issues are the work items.
- When it has no sub-issues, Paws reads unchecked task-list lines of the form `- [ ] #123` in the epic body. Checked lines and other issue references are left alone.

Paws runs one item at a time, and merges are serial. An item starts after every issue it is blocked by has merged. Among items that are ready, sub-issue order wins, then task-list order.

## Comments

The comment protocol matches [Linear comment mode](linear-modes.md), on GitHub issues.

- Progress is one comment per item. The body starts with `Paws:`. The first post creates it. Later posts edit that same comment, at most once every 5 seconds. Posts inside the window are kept and written on the next allowed edit.
- A question is a new comment. The body starts with `Paws:`, lists options as `1.`, `2.`, …, and ends with the marker `<!-- paws:q:<id> -->`.
- The answer is the first later comment in that thread that Paws did not write, from a trusted author. A comment counts as Paws when its body starts with `Paws:` or contains the question marker. Your reply is from the same GitHub account as the status comment, so the marker and the prefix are what separate them. A second reply does not replace the first. Reply with the option number or with your own words.
- A comment with its own line `/paws stop`, from a trusted author, stops the item. The same line inside a comment Paws wrote does not stop it.

## Status labels

These labels are separate from the trigger label `paws`. Paws sets one of them for the current state, using the names in `status_labels`:

| State                 | Label                 |
| --------------------- | --------------------- |
| Work in progress      | `paws:running`        |
| Waiting on a question | `paws:awaiting-input` |
| Item finished         | `paws:done`           |

Paws creates a missing status label in the repository when it first needs it.

## Pull requests

Each pull request body starts with `Closes #<n>`, where `<n>` is the work item's issue number. GitHub closes that issue when the pull request merges. See [Linking a pull request to an issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue).

When every work item has merged, Paws comments `Epic complete.` on the epic and closes the epic.

## Polling

| Situation                                          | Interval   |
| -------------------------------------------------- | ---------- |
| A watched item is running or waiting for an answer | 5 seconds  |
| Idle                                               | 15 seconds |

Requests send `If-None-Match` after GitHub has returned an ETag. An HTTP 304 does not count against the primary rate limit. GitHub documents that in [Best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate).

Intake is this poll. A webhook, a public URL, and a GitHub App are outside this tracker.
