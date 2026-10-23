# Paws status

Read-only status for a local Paws engine: epics, items and their states, current runs, open questions, Closeout verdicts, and the merge queue.

The engine cannot run on Vercel. This directory is a static site plus the local status routes. The live reader imports `src/db` through its public index.

## Contract

`GET /api/status` returns one JSON object, `StatusSnapshot` in [`src/contract.ts`](src/contract.ts).

- `version` is `1`.
- `source` is `"demo"` for the sample stub and `"live"` when the engine built the body from its own state.
- `questions` lists open questions only. The page does not answer them.
- Unknown fields are ignored. The parser rejects a body that does not match.
- Each entry in `items` carries `linearRequests`, the Linear API requests Paws made for that task so far. The run page shows it next to the start time.
- `mergeQueue` lists every task Closeout accepted that waits to merge. Each entry carries its `repository`, its `position` in that repository's queue (`null` while it holds no place, such as when it waits for a review or the repository merges each pull request when green), `waitingFor` (`ahead`, `ci`, `review`, `branch_update` or `closeout`), `acceptedAt`, and the merge `settings` it resolved. `mergeHistory` lists what merged in the last 24 hours and what went back to the agent after CI failed or a branch update conflicted. The Merge queue page at `/status/merge-queue` renders both.
- `intake` lists the Linear delegations Paws recorded and has not taken in yet, oldest first, each with its `issue`, `title`, `receivedAt`, failed `attempts`, `nextAttemptAt` and `lastError`. It is read from `inbox_event`. `linearBudget` carries the requests left this hour (`requestsRemaining`, `requestsLimit`, `resetAt`) and `holdUntil` during a rate-limit hold, from Paws's own Linear ledger. Neither makes a Linear call. The overview renders both in its Intake section.

Example:

```json
{
  "version": 1,
  "source": "demo",
  "generatedAt": "2026-10-09T22:15:00.000Z",
  "project": { "name": "Platform", "team": "ENG", "repo": "acme/platform", "workspace": "acme" },
  "epics": [],
  "items": [],
  "runs": [],
  "questions": [],
  "verdicts": [],
  "mergeQueue": [],
  "events": []
}
```

`createLiveStatusProvider(db)` is exported from [`index.ts`](index.ts) and reads the engine database (`source: "live"`). `fakeStatusProvider()` still returns the fictional acme / ENG snapshot. The server mounts the live reader like this:

```ts
import { createLiveStatusProvider, handleStatusRequest } from "../web";

const response = await handleStatusRequest(request, {
  provider: createLiveStatusProvider(db),
});
if (response) return response;
```

`?engine=demo` or `PAWS_STATUS_DEMO=1` serves the sample snapshot instead.

Closeout videos and screenshots arrive in the snapshot's `evidence` list, limited to the items the reader can see. The run page shows them in a gallery, and `/status/evidence/<id>` (or `/evidence/<id>`, which redirects there) shows one of them. Files load from `GET /api/evidence/<id>`. video.js is bundled as a separate chunk the first time a video plays; nothing loads from a CDN.

`null` means the request is not `/status` or `/api/status`. Leave webhook routes alone.

The process binds `127.0.0.1`. `GET /api/status` responds with `Access-Control-Allow-Origin: *` and `Cache-Control: no-store`, so a static deployment can poll a tunnel of that route. The dashboard uses path routes such as `/status/runs/<id>`. HTML served by the process gets `<base href="/status/">` so relative assets resolve on every route; the Vercel build keeps `<base href="/">` and rewrites every path to `index.html`.

## Local

From the repo root:

```bash
bun install
bun run build:status
bun run paws
```

- Page: http://127.0.0.1:8787/status
- API: http://127.0.0.1:8787/api/status

When the page is served under `/status`, it calls the same origin's `/api/status`. That body is `source: "live"`. An empty database shows no items. The sample snapshot is served only with `?engine=demo` or `PAWS_STATUS_DEMO=1`.

## Vercel

`vercel.json` at the repo root is the static-site config. From the repo root:

```bash
vercel deploy --prod
```

The build runs `bun run build:status` and publishes `src/web/dist` only. It does not start the engine. With no engine URL, the site shows the bundled demo snapshot and a demo label.

To bake a default engine origin:

```bash
PAWS_ENGINE_URL=https://<tunnel-host> vercel deploy --prod
```

Visitors can also set the origin in the Engine control (stored in the browser) or open:

```text
https://<deployment>/?engine=https://<tunnel-host>
```

`?engine=demo` forces the sample snapshot. The saved value is an `http` or `https` URL; the page requests `GET /api/status` on that origin and sends `ngrok-skip-browser-warning` so a free ngrok tunnel can answer.

## Check

```bash
bun run check
```

That runs oxlint, oxfmt, `tsc` (engine plus the browser client), the tests, and the static build.
