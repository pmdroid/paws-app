# Dashboard payload budget

The resource contract is in [`src/dashboard/README.md`](../src/dashboard/README.md#contract). Each page polls its own resource, so its size is a budget, not a detail. The global status snapshot these resources replaced grew to 13.7 MB per poll in its first version before anyone noticed.

| Response                                      | Budget |
| --------------------------------------------- | ------ |
| `GET /api/issues` (the Issues page)           | 200 KB |
| `GET /api/issues/<id>` (one issue's page)     | 1 MB   |
| `GET /api/overview` (the Overview page)       | 50 KB  |
| `GET /api/merge-queue` (the Merge queue page) | 64 KB  |
| `GET /api/evidence` (the Evidence gallery)    | 200 KB |

Check `stdout` and `stderr` are in none of them. They come from `GET /api/issues/<id>/attempts/<n>/checks/<check id>/log`, 64 KB of each stream unless the page asks for the full log.

## The test

`src/dashboard/src/live/payload-budget.test.ts` builds 100 finished items and 10 open ones. Each finished item has one Closeout attempt with two failing checks; each open item has three attempts of six failing checks. Every check stores `stdout` and `stderr` at the 64 KB cap. The test serves the issue list, a finished and an open issue's page, the overview and the merge queue through the dashboard handler and fails when any is over its budget, or when the overview is not under a tenth of the issue list. A second test serves `/api/issues` and `/api/overview` from the same fixture and fails if either reads a check log or carries check output. A change that puts check output or every finished item back in the list fails them. A third test lists eight files on each of the 60 issues the list keeps and serves `/api/evidence`; it is about 170 KB of its 200 KB. `GET /api/evidence/<id>/metadata` carries one issue's files and has no separate budget.

## The journal line

The dashboard handler measures every `200` body it serves from `/api/issues`, `/api/overview`, `/api/merge-queue`, `/api/questions`, `/api/evidence` and their issue, question, metadata and log routes; a `304` for an unchanged resource has no body and is not counted. Once per minute in which it served one, it journals the largest:

```
dashboard payload minute=2026-10-27T09:14:00.000Z largest_bytes=144410 path=/api/issues responses=12
```

`minute` is the start of the minute, `path` is the route that served the largest body, and `responses` counts the bodies served in that minute. The line is written when the minute ends, to the process's standard error with its other journal lines, so it lands in `journalctl` wherever Paws runs as a service. Search for `dashboard payload` to see growth over time.
