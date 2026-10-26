# Paws status

Read-only status for a local Paws engine: epics, items and their states, current runs, open questions, Closeout results, and the merge queue.

The Paws process serves the dashboard files and status routes. The live reader imports `src/db` through its public index.

## Contract

`GET /api/status` returns one JSON object, `StatusSnapshot` in [`src/contract.ts`](src/contract.ts).

- `version` is `2`. Version 1 carried every Closeout attempt with its check output and a journal of `events`, about 13.7 MB per poll.
- `source` is `"live"`. The serving process builds the body from its own state.
- `items` lists every open item, and items that finished (merged, completed or cancelled) in the last 24 hours, at most the 50 that finished last. An item counts as finished when it last changed state in `work_item_event`. An older item opens only through its own page.
- `verdicts` has one summary per item: its latest `decision`, `headSha`, and each check's `id`, `kind` and `state`. Attempts, commands, output, findings and log paths are only in the item detail.
- `agentCloseout` has the latest state of each run: the latest attempt's `decision` and `headSha`, `blocked`, `updatedAt`, and `endedAt` and `continuesIn` once the run ended. Its attempts and steps are only in the item detail.
- `questions` lists open questions only. The page answers only a link ask: a question with `linkAsk` (`kind` `bypass`, `screenshots`, `risk`, `question` or `rounds`, the `head` commit it is bound to, `title`, `detail` and the `link` Linear carries). The overview's Needs you list shows it with one button per kind, and the issue page shows its card at `#closeout`, `#visual-review`, `#risk`, `#question` or `#review-rounds`, which posts the decision to `POST /api/link-asks` with the CSRF token. A `bypass` ask carries `bypass`: the `policyDigest` it binds to, the `passed` check ids, and each failed `checks` entry with `id`, `kind`, `state`, `attempt` and `finding` (the finding, or the last lines of the output). Its card posts `bypasses: [{ checkId, reason }]` for the selected checks, `changes` with a note for guidance, and Stop uses `POST /api/execution-controls`. A `rounds` ask, opened when review attempts run out, carries `rounds`: each failed round's commit and finding count, the findings still open with their class of bug, the recurring class, and how many rounds Keep going grants. Its card posts `rethink` with an optional note, `continue` or `stop`.
- Unknown fields are ignored. The parser rejects a body that does not match.

`GET /api/status/items/<id>` returns one issue for its page, `StatusItemDetail`: the snapshot fields for that issue only (every session of it, its runs, questions, Closeout attempts with checks and findings, agent Closeout, evidence, CI rounds and merge state), plus `blocks`, whether or not the issue is still in the list. Its `verdicts` and `agentCloseout` have the full shape, and check `stdout` and `stderr` are left out. It has the same session gate and session filter as `/api/status`; an issue outside the reader's sessions is 404 like an unknown one. The issue page fetches it when it opens and polls only it while it stays open.

`/api/status` leaves check `stdout` and `stderr` out as well. `GET /api/status/items/<id>/attempts/<n>/checks/<check id>/log` returns one check's output, `StatusCheckLog`: `stdout` and `stderr`, the last 64 KB of each, `truncated` when either was cut, and `fullPath`, the same path with `full=1`, which returns all of it. `run=<run id>` reads the check from that run's agent Closeout. A check that is not in that attempt of the issue's Closeout, or an issue outside the reader's sessions, is 404. The issue page loads a check's log when its row is open, once per check state, so polling does not load it again; "Load the full log" and "Download output" ask for the full log.

- Each entry in `items` carries `linearRequests`, the Linear API requests Paws made for that item since it was queued. The issue page shows it with the item's other facts.
- Each entry in `items` may carry `timeline`, every state change of the item from `work_item_event`, oldest first: `at`, `kind` (`transition`, `restart` or `ask`), the engine states `from` and `to`, the `event`, and `reason` and `actor` or `null`. A `restart` names why the item went back to the agent and an `ask` names why Paws asked. The issue page shows it as the "Item timeline" section after the pull request.
- A queued entry in `items` carries `held` while the scheduler holds it back: a `reason` (`blocked`, `project`, `reconciling`, `snapshot`, `cap`, `slot` or `workspace`) and, for `blocked`, the `blockers` that have not merged yet. The scheduler stores it on each pass and writes a journal line each time it changes. The issue page shows it as a "Waiting:" line, such as "Waiting: blocked by PAS-367".
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
  "epics": [],
  "items": [],
  "runs": [],
  "questions": [],
  "verdicts": [],
  "mergeQueue": []
}
```

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

The process binds `127.0.0.1`. `GET /api/status` responds with `Cache-Control: no-store`. The dashboard uses path routes such as `/status/issues/PAS-367`. Each issue has one page: its state, project, runner and agent, the timeline of every engine run, Closeout with checks and evidence, reviews, questions, fix rounds, and the pull request and merge state. An earlier Linear session on the same issue (`endedAt` on its item) is a section further down, and `session.shared` names sub-issues worked in the same session. `/status/runs/<id>` (any engine run id), `/status/sessions/<id>` and `/status/verdicts/<id>` redirect to that issue page, so links already posted in Linear keep working. HTML served by the process gets `<base href="/status/">` so relative assets resolve on every route.

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
