# Status payload budget

The status contract is in [`src/dashboard/README.md`](../src/dashboard/README.md#contract). The dashboard polls it, so its size is a budget, not a detail. Version 1 of `GET /api/status` grew to 13.7 MB per poll before anyone noticed.

| Response                                        | Budget |
| ----------------------------------------------- | ------ |
| `GET /api/status` (the list)                    | 200 KB |
| `GET /api/status/items/<id>` (one issue's page) | 1 MB   |
| `GET /api/issues` (the Issues page)             | 200 KB |
| `GET /api/issues/<id>` (one issue's page)       | 1 MB   |
| `GET /api/overview` (the Overview page)         | 50 KB  |

Check `stdout` and `stderr` are in neither. They come from `GET /api/status/items/<id>/attempts/<n>/checks/<check id>/log` or `GET /api/issues/<id>/attempts/<n>/checks/<check id>/log`, 64 KB of each stream unless the page asks for the full log.

## The test

`src/dashboard/src/live/payload-budget.test.ts` builds 100 finished items and 10 open ones. Each finished item has one Closeout attempt with two failing checks; each open item has three attempts of six failing checks. Every check stores `stdout` and `stderr` at the 64 KB cap. The test serves both lists and both item details through the status handler and fails when any is over its budget. A second test serves `/api/issues` and `/api/overview` from the same fixture and fails if either reads a check log or carries check output. On that fixture `/api/overview` is about 8 KB and 98 SQL statements, where the overview's four status slices were about 156 KB and 1,293 statements; the test fails if the overview is not under a tenth of the slices. A change that puts check output or every finished item back in the list fails it; today the list is about 145 KB of its 200 KB.

## The journal line

The status handler measures every `200` body it serves from `/api/status`, `/api/issues`, `/api/overview`, `/api/questions` and their item, question and log routes. A page asks for only the slices it renders (`/api/status?slices=…`), and that smaller body is what is measured; a `304` for an unchanged list has no body and is not counted. Once per minute in which it served one, it journals the largest:

```
status payload minute=2026-10-27T09:14:00.000Z largest_bytes=144410 path=/api/status responses=12
```

`minute` is the start of the minute, `path` is the route that served the largest body, and `responses` counts the bodies served in that minute. The line is written when the minute ends, to the process's standard error with its other journal lines, so it lands in `journalctl` wherever Paws runs as a service. Search for `status payload` to see growth over time.
