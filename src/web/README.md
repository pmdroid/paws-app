# Paws status

Read-only status for a local Paws engine: items and their states, current runs, open questions, Closeout results, and the merge queue.

The Paws process serves the dashboard files and status routes. The live reader imports `src/db` through its public index.

## Contract

`GET /api/status` returns one JSON object, `StatusSnapshot` in [`src/contract.ts`](src/contract.ts).

- `version` is `2`. Version 1 carried every Closeout attempt with its check output and a journal of `events`, about 13.7 MB per poll.
- `source` is `"live"`. The serving process builds the body from its own state.
- `items` lists every open item, and items that finished (merged, completed or cancelled) in the last 24 hours, at most the 50 that finished last. An item counts as finished when it last changed state in `work_item_event`. An older item opens only through its own page.
- `verdicts` has one summary per item: its latest `decision`, `headSha`, and each check's `id`, `kind` and `state`. Attempts, commands, output, findings and log paths are only in the item detail.
- `agentCloseout` has the latest state of each run: the latest attempt's `decision` and `headSha`, `blocked`, `updatedAt`, and `endedAt` and `continuesIn` once the run ended. Its attempts and steps are only in the item detail.
- `questions` lists open questions only. The page answers only a link ask: a question with `linkAsk` (`kind` `bypass`, `screenshots`, `risk`, `question`, `rounds` or `rule`, the `head` commit it is bound to, `title`, `detail` and the `link` Linear carries). The overview's Needs you list shows it with one button per kind, and the issue page shows its card at `#closeout`, `#visual-review`, `#risk`, `#question`, `#review-rounds` or `#rule`, which posts the decision to `POST /api/link-asks` with the CSRF token. A `bypass` ask carries `bypass`: the `policyDigest` it binds to, the `passed` check ids, and each failed `checks` entry with `id`, `kind`, `state`, `attempt` and `finding` (the finding, or the last lines of the output). Its card posts `bypasses: [{ checkId, reason }]` for the selected checks, `changes` with a note for guidance, and Stop uses `POST /api/execution-controls`. A `rounds` ask, opened when review attempts run out, carries `rounds`: each failed round's commit and finding count, the findings still open with their class of bug, the recurring class, and how many rounds Keep going grants. Its card posts `rethink` with an optional note, `continue` or `stop`. A `rule` ask, opened when a rule set to `onFail: approve` breaks, carries `bypass` with the broken rules as `checks`; its card posts `approve` with the reason as the note, or `changes` (Send back) with a note.
- Unknown fields are ignored. The parser rejects a body that does not match.
- The list stays under 200 KB and an item detail under 1 MB. [`docs/status-payload.md`](../../docs/status-payload.md) has the budget, the test that holds it and the per-minute journal line with the largest response.

`GET /api/status?slices=items,questions` returns only the named slices: `version`, `source`, `generatedAt`, `project`, `slices` naming what was asked for, and each slice's fields (`STATUS_SLICE_FIELDS` in [`src/contract.ts`](src/contract.ts)). `items` carries `items`, `runs`, `verdicts`, `agentCloseout` and `mergedTimes`, which the overview shows as "Last 24 hours"; `intake` carries `intake`, `linearBudget` and `linearWebhook`; `mergeQueue` carries `mergeQueue` and `pushOutages`, since the overview and the Merge queue page show the push outage banners; `questions`, `mergeHistory`, `evidence`, `ciRounds` and `dead` carry the field of that name. The parser reads a required field of a slice that was not asked for as empty. An unknown slice is 400. Without `slices` the whole list comes back.

Every `/api/status` response carries a weak `ETag` over the body without `generatedAt`, and `Paws-Generated-At`. A request whose `If-None-Match` matches answers 304 with no body; the page keeps the list it has and takes the newer time from the header.

Each page asks only for the slices it renders (`ROUTE_SLICES` in [`src/client/route.ts`](src/client/route.ts)): the overview `items`, `questions`, `mergeQueue` and `intake`; the issue list and run links `items`; the Merge queue page `items`, `mergeQueue` and `mergeHistory`; Questions `items` and `questions`; an evidence page `items` and `evidence`, since its other evidence from the issue follows the run's earlier attempts in `runs`. An issue page loads its item detail and asks for `items` only when the issue is not visible. Settings and Runners use their own endpoints and load no status. The page polls every 5 seconds while the tab is visible, stops while it is hidden, and loads once when it is shown again.

`GET /api/status/items/<id>` returns one issue for its page, `StatusItemDetail`: the snapshot fields for that issue only (every session of it, its runs, questions, Closeout attempts with checks and findings, agent Closeout, evidence, CI rounds and merge state), plus `blocks` and `risk`, whether or not the issue is still in the list. Its `verdicts` and `agentCloseout` have the full shape, and check `stdout` and `stderr` are left out. It has the same session gate and session filter as `/api/status`; an issue outside the reader's sessions is 404 like an unknown one. The issue page fetches it when it opens and polls only it while it stays open.

`/api/status` leaves check `stdout` and `stderr` out as well. `GET /api/status/items/<id>/attempts/<n>/checks/<check id>/log` returns one check's output, `StatusCheckLog`: `stdout` and `stderr`, the last 64 KB of each, `truncated` when either was cut, and `fullPath`, the same path with `full=1`, which returns all of it. `run=<run id>` reads the check from that run's agent Closeout. A check that is not in that attempt of the issue's Closeout, or an issue outside the reader's sessions, is 404. The issue page loads a check's log when its row is open, once per check state, so polling does not load it again; "Load the full log" and "Download output" ask for the full log.

- `risk` on the item detail feeds the issue page's Risk card, or is `null` when there is nothing to show yet. It has the `tier` (`high` or `normal`, `null` until Paws classifies a head when Closeout accepts it) of the newest session's latest classified `head` and its `base`, each high-risk path in `paths` with the `lists` that matched it (`settings` for Settings › Merging › High-risk paths, `file` for the repository's `.paws/high-risk-paths`), and `securityReview`: the `state`, `detail` and `head` of the `security-review` step of the latest Closeout run, read from Closeout progress so a skipped review keeps its reason. `securityReview` is `null` when the policy has no such check.
- Each entry in `items` carries `linearRequests`, the Linear API requests Paws made for that item since it was queued. The issue page shows it with the item's other facts.
- Each entry in `items` may carry `timeline`, every state change of the item from `work_item_event`, oldest first: `at`, `kind` (`transition`, `restart` or `ask`), the engine states `from` and `to`, the `event`, and `reason` and `actor` or `null`. A `restart` names why the item went back to the agent and an `ask` names why Paws asked. The issue page shows it as the "Item timeline" section after the pull request.
- Each entry in `items` carries `stateTimes`, the time it spent in each engine state since it was created: `since`, `until`, the `current` state (`null` once it finished) and `states`, each `state` with its `ms`. Before its first `work_item_event` row the item was in that row's `from` state. An open item's current state counts up to the time the body was built and a finished one stops at its last change, so `states` add up to `until - since`. The issue page shows it as the "Time in each state" bar, each segment labelled with its minutes. The overview and the Issues list show an open item's age and the waiting state (queued, recovering, awaiting input, paused, merge queue, failed or manual) it spent longest in, such as "3 h 10 min · 2 h recovering".
- The list carries `mergedTimes` while a visible item merged in the last 24 hours: how many merged, the `medianMs` and nearest-rank `p90Ms` from creation to merge, and `states`, the average time per merged item in each state, largest first. The overview shows it as "Last 24 hours". Both are read from `work_item` and `work_item_event`; nothing new is written.
- A queued entry in `items` carries `held` while the scheduler holds it back: a `reason` (`blocked`, `project`, `reconciling`, `snapshot`, `cap`, `slot` or `workspace`) and, for `blocked`, the `blockers` that have not merged yet. The scheduler stores it on each pass and writes a journal line each time it changes. The issue page shows it as a "Waiting:" line, such as "Waiting: blocked by PAS-367".
- A repository rule's probe is a Closeout check of kind `rule`. Closeout records it as a command whose argv ends `--base <base> --head <head> --repo .`, and the reader names it `rule` by that. In the item detail a rule carries `probeSha256`, the hash its evidence record lists for the probe that ran (`null` without the record), and a failed rule carries `approval` when a bypass ask offered it: `waiting` with the open `questionId`, or `approved` or `bypassed` with `by`, `reason`, `at` and the `head` it covers. Each attempt and verdict lists `skippedRules`, the rules whose paths matched none of the change. The issue page shows rules in their own "Repository rules" section; a waiting rule's Approve posts `bypasses: [{ checkId, reason }]` to `POST /api/link-asks` and Send back posts `changes` with the reason as the note.
- In the item detail, `agentCloseout` has one entry for an item's first run and one for its current run, each keyed by `runId`. The issue page shows the entry for the item's current run. Once the run ended, the entry carries `endedAt`, a check it started and never finished has state `stopped` with its duration up to `endedAt`, and `continuesIn` names the item's current run when that is a newer one.
- `mergeQueue` lists every item Closeout accepted that waits to merge. Each entry carries its `repository`, its `position` in that repository's queue (`null` while it holds no place, such as when it waits for a review or the repository merges each pull request when green), `waitingFor` (`ahead`, `ci`, `review`, `branch_update` or `closeout`), `acceptedAt`, and the merge `settings` it resolved. `mergeHistory` lists what merged in the last 24 hours and what went back to the agent after CI failed or a branch update conflicted. The Merge queue page at `/status/merge-queue` renders both.
- `intake` lists the Linear delegations Paws recorded and has not taken in yet, oldest first, each with its `issue`, `title`, `receivedAt`, failed `attempts`, `nextAttemptAt` and `lastError`. It is read from `inbox_event`. `linearBudget` carries the requests left this hour (`requestsRemaining`, `requestsLimit`, `resetAt`) and `holdUntil` during a rate-limit hold, from Paws's own Linear ledger. `linearWebhook` is present while Linear may have disabled the Paws webhook: the catch-up poll found an event no webhook delivered, or no verified delivery came for an hour while a work item has a session. It carries the `warning`, the `fix` and `lastVerifiedAt`, from the `sync_cursor` rows. None of them makes a Linear call. The overview renders all three in its Intake section.

Example:

```json
{
  "version": 2,
  "source": "live",
  "generatedAt": "2026-10-09T22:15:00.000Z",
  "project": { "name": "Platform", "team": "ENG", "repo": "acme/platform", "workspace": "acme" },
  "items": [],
  "runs": [],
  "questions": [],
  "verdicts": [],
  "mergeQueue": []
}
```

`GET /api/findings` feeds the Findings page at `/status/findings`, `FindingsResponse` in [`src/findings.ts`](src/findings.ts). It reads `review_finding`: one row per distinct review finding that did not block a merge (pre-existing, or below the review's `failOn`), keyed by `reviewFindingKey` in `src/core` (repository, path, line range and normalized text). Paws records them when Closeout accepts a head, from the stored review evidence, and a one-time job backfilled the runs accepted before. The query filters by `repository`, `severity`, `review`, `status` (`open` by default, `all` for any) and `path` prefix; the list is newest last seen first, at most 500, with `counts` per severity over the other filters, and shows a finding only when the reader can open an item that reported it. `POST /api/findings` with the CSRF token lets an active member send `{ id, action: "dismiss", reason }` or `{ id, action: "reopen" }` on a dismissed one. `filed`, with the Linear issue, is written through `markReviewFindingFiled`; `gone` is set by Paws when a later accepted review of the same path no longer reports it.

`createLiveStatusProvider(db)` is exported from [`index.ts`](index.ts) and reads the engine database (`source: "live"`). `fakeStatusProvider()` returns an empty live snapshot. The server mounts the live reader like this:

```ts
import { createLiveStatusProvider, handleStatusRequest } from "../web";

const response = await handleStatusRequest(request, {
  provider: createLiveStatusProvider(db),
});
if (response) return response;
```

Closeout videos and screenshots arrive in the snapshot's `evidence` list, limited to the items the reader can see. The issue page shows them in a gallery, and `/status/evidence/<id>` (or `/evidence/<id>`, which redirects there) shows one of them. Files load from `GET /api/evidence/<id>`. video.js is bundled as a separate chunk the first time a video plays; nothing loads from a CDN.

`null` means the request is not `/status` or `/api/status`. Leave webhook routes alone.

The process binds `127.0.0.1`. `GET /api/status` responds with `Cache-Control: no-store`; the page sends `If-None-Match` itself. The dashboard uses path routes such as `/status/issues/PAS-367`. Each issue has one page: its state, project, runner and agent, the timeline of every engine run, Closeout with checks and evidence, reviews, questions, fix rounds, and the pull request and merge state. An earlier Linear session on the same issue (`endedAt` on its item) is a section further down, and `session.shared` names sub-issues worked in the same session. `/status/runs/<id>` (any engine run id), `/status/sessions/<id>` and `/status/verdicts/<id>` redirect to that issue page, so links already posted in Linear keep working. HTML served by the process gets `<base href="/status/">` so relative assets resolve on every route.

## Local

From the repo root:

```bash
bun install
bun run build:status
bun run paws
```

- Page: http://127.0.0.1:8787/status
- API: http://127.0.0.1:8787/api/status

When the page is served under `/status`, it calls the same origin's `/api/status`. That body is `source: "live"`. An empty database shows no items.

## Check

```bash
bun run check
```

That runs oxlint, oxfmt, `tsc` (engine plus the browser client), the tests, and the static build.

The Findings page also loads `GET /api/finding-groups`. Its Groups view lists the shared fix, scope, member severities and links to individual rows, alongside the last grouping run's time, duration, tokens when reported, and group count. `POST /api/finding-groups` accepts `run` for admins, or `file`, `add`, and `dismiss` with a group `id`; dismissal includes `reason`. Workspace access and CSRF apply to every mutation. Each member must have access to every finding in a group to act on it. Filing and commenting use stable Linear ids for safe retries. The daily job never writes to Linear.

Run `bun scripts/verify-finding-groups-ui.ts /tmp/finding-groups-evidence` after `bun run build:status` for light and dark desktop and 390 px captures, linked-row navigation, and group action checks using a local fixture server.

Groups load independently of the Findings list and do not reload on finding filter changes. The API returns up to 200 groups, with open groups first, and batches member reads. A confirmed refusal before an issue or comment write releases the action so members can choose another action. Uncertain writes keep their stable identifier and must be retried to reconcile the result safely. Interrupted grouping runs are marked failed after their ten-minute execution window and one minute of grace.

Untouched groups shrink when a member finding is dismissed individually. A claimed Linear action can still reconcile its stable identifier if a review later marks members gone. Missing targets and deterministic mutation refusals release the claim; transport errors retain it for safe retries. The Groups run status explains when an unchanged snapshot was skipped.
