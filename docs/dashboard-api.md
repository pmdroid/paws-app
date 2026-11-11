# Dashboard API

How the browser reaches the dashboard and what each page reads. The response fields are in [`src/dashboard/README.md`](../src/dashboard/README.md#contract), with types and runtime parsers in [`src/dashboard/src/contract.ts`](../src/dashboard/src/contract.ts). Byte budgets are in [Dashboard payload budget](dashboard-payload.md).

## Pages

`/dashboard` is the canonical address. `/` answers 307 to `/dashboard/`, keeping the query. HTML served under `/dashboard` carries `<base href="/dashboard/">`, and assets are `/dashboard/assets/<file>`, cached for a year by their content hash.

| Page                           | Path                                                                                                            | Reads                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Overview                       | `/dashboard/`                                                                                                   | `GET /api/overview`                               |
| Issues                         | `/dashboard/issues`                                                                                             | `GET /api/issues`                                 |
| Issue                          | `/dashboard/issues/<id>`                                                                                        | `GET /api/issues/<id>`                            |
| Questions                      | `/dashboard/questions`, `/dashboard/questions/<id>`                                                             | `GET /api/questions[/<id>]`                       |
| Merge queue                    | `/dashboard/merge-queue`                                                                                        | `GET /api/merge-queue`                            |
| Evidence                       | `/dashboard/evidence`, `/dashboard/evidence/<id>`                                                               | `GET /api/evidence[/<id>/metadata]`               |
| Run, session and verdict links | `/dashboard/runs/<id>`, `/dashboard/sessions/<id>`, `/dashboard/verdicts/<id>`                                  | `GET /api/aliases/<kind>/<id>`                    |
| Runners                        | `/dashboard/runners[/<id>]`                                                                                     | `GET /api/runners...`                             |
| Findings                       | `/dashboard/findings`                                                                                           | `GET /api/findings`, `GET /api/finding-groups`    |
| Improvements                   | `/dashboard/improvements[/<id>]`, `/dashboard/improvements/reports/<id>`, `/history`, `/settings`               | `GET /api/improvements...`, `GET /api/retros/...` |
| Settings                       | `/dashboard/settings/<page>`: agents, merging, limits, brief, findings, integrations, workspace, account, audit | `/api/settings/...`, `/api/workspaces/...`        |
| Agent transcript               | `/dashboard/runs/<id>/transcript` (its own HTML page)                                                           | `GET /api/runs/transcript?run=<id>`               |

Improvements is the shared inbox for daily findings and weekly retros; [Improvement review API](improvement-review.md#dashboard) describes the page. `/retros` opens it filtered to weekly retros and `/retros/<id>` opens that retro's report.

`/overview` and `/queue` open the Overview, `/epics` and `/runs`, `/sessions` or `/verdicts` without an id open the Issues list. A run, session or verdict link asks `/api/aliases` once and replaces the address with the owning issue's page, keeping the query and fragment; an unknown or hidden id says the link was not found.

## Old links

Links Paws posted before the rename keep working:

- `GET` or `HEAD` `/status` and `/status/<path>` answer 307 to `/dashboard/<path>` with the same query. The browser keeps the fragment, so `/status/issues/PAS-1?from=linear#closeout` opens the same decision card. Other methods answer 405.
- `/evidence/<id>` answers 307 to `/dashboard/evidence/<id>`.
- A `#/issues/PAS-1` address from the hash router is replaced in the browser with `/dashboard/issues/PAS-1`.
- `GET /api/status`, its `slices` query, `/api/status/items/<id>` and its log route are gone and answer 404. API routes never redirect.

| Old request                                  | Now                                                |
| -------------------------------------------- | -------------------------------------------------- |
| `GET /api/status?slices=items,runs,verdicts` | `GET /api/issues`                                  |
| `GET /api/status?slices=questions`           | `GET /api/questions`                               |
| `GET /api/status?slices=mergeQueue`          | `GET /api/merge-queue`                             |
| `GET /api/status?slices=evidence`            | `GET /api/evidence`                                |
| `GET /api/status` for the overview           | `GET /api/overview`                                |
| `GET /api/status/items/PAS-1`                | `GET /api/issues/PAS-1`                            |
| `.../items/PAS-1/attempts/2/checks/test/log` | `GET /api/issues/PAS-1/attempts/2/checks/test/log` |

## Authorization

With workspace access on, the server authenticates every `/api/` request before any reader runs:

- No Paws session answers 401. A `workspaceId` query or `x-paws-workspace` header naming another workspace answers 403 and is audited.
- The reader's Linear sessions come from current membership on each request. Lists contain only items in those sessions, and an item, question, evidence file, alias or transcript outside them answers the same 404 as an unknown one.
- `/api/settings/...` needs a workspace administrator for every method.
- A method other than `GET`, `HEAD` or `OPTIONS` needs an `Origin` equal to the workspace origin and an `x-paws-csrf` header with the session's token. The dashboard reads the token from its page and from `GET /api/auth/session`.
- Dashboard pages load without a session and show sign-in; they carry no work data.

The improvement inbox and retro review routes add per-item repository checks; see [Improvement review API](improvement-review.md).

## Freshness and caching

Every page resource answers with `generatedAt` in the body, `Cache-Control: no-store`, `Paws-Generated-At` and a weak `ETag` computed without `generatedAt`. `If-None-Match` with the current tag answers 304 with no body; the page keeps the body it has and takes the time from the header.

The server reuses a built body for one second per resource, parameters, data source and the reader's sorted session set, so tabs polling together build it once and a body or 304 never crosses readers. Authorization runs before the cache on every request, so a membership change applies to the next request even while a body for the old session set is warm.

A page polls its own resource every 5 seconds while the tab is visible, stops while it is hidden and loads once when it is shown. The Evidence pages load once and never poll, so playback is not interrupted. Runners, Findings and Settings load their own APIs and do not poll the page resources. The client applies a response, error, 404 or loading state only while its request is the newest, the page has not changed since it started and the signed-in reader is the same. Sign-out or a workspace change clears loaded bodies and their tags. Actions reload the open resource through the same loader.

## Logs and media

No list or page resource carries check `stdout` or `stderr`. `GET /api/issues/<id>/attempts/<n>/checks/<check id>/log` returns the last 64 KB of each stream with `truncated`; `full=1` returns all of it and `run=<run id>` reads the check from that run's agent Closeout. The issue page asks for a log only when its row is open.

`GET /api/evidence/<id>` streams the file with `Range`, `HEAD` and a download name; images load as the page shows them, and video.js loads as its own chunk the first time a video plays. `GET /api/runs/transcript?run=<id>` returns a run's full agent transcript for the transcript page.

## Blocker checks

A queued item waiting only on Linear blockers shows when Paws last read its relations. Linear sends no webhook for a relation, so Paws reads the relations of blocked items every minute in one request, and every 5 minutes for all open items or while less than 20% of the Linear request budget is left. An `Issue` webhook for an item or its blocker refreshes it at once.

**Check blockers now** sends `POST /api/blocker-checks` with `{"itemId": "<id>"}` (the item id or its Linear identifier) and reads that item's relations at once. A second press for the same item within 15 seconds answers 429 with `Retry-After`; an item that is not waiting on a blocker answers 409; a relations read that Linear fails answers 502.

## Extra usage

`POST /api/runners/<id>/agents/<agent>/extra-usage` with `{"extraUsage": true}` keeps Paws sending that agent work on that runner after a usage window is spent; the provider bills the extra usage. The runner's owner and workspace admins may change it, others get 403, and an agent never signed in on the runner answers 403. `GET /api/runners/<id>/policy` returns `extraUsage` per agent, and `GET /api/runners` reports a spent window with the switch on as status `extra_usage` instead of `usage_limit`. It also carries `hostWarnings` on a runner that refused every waiting item for a host-config reason, one sentence per repository. Placement uses such a runner only when no runner the item may use with quota left was free, and the runner history says so.

## Agent sign-in

Each runner signs in to its agents on the Runners page: `GET /api/runners/<id>/accounts` reads each agent's sign-in, `POST /api/runners/<id>/accounts/<agent>/login` starts one and `GET /api/runners/<id>/accounts/<agent>/login/<loginId>` follows it. `GET /api/runners/<id>/health` reads the runner's health. Placement uses each runner's own sign-in only. Named agent accounts and the account and fallback orders were retired: `/api/runners/accounts` and every path under it, including the old `/preview`, answer 410 with `{"error": "Agent accounts were replaced by per-runner sign-in on the Runners page"}`.

## Route coverage

[`test/dashboard-routes.ts`](../test/dashboard-routes.ts) lists every dashboard page shape, settings page, HTML entrypoint, old link and HTTP route family with its method, a disposition and its owning issue or module:

| Disposition | Meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| `canonical` | A dashboard page or resource at its address.                         |
| `alias`     | An old address that reaches its page by redirect or browser replace. |
| `preserved` | An action, workspace, webhook or settings API kept as it was.        |
| `delegated` | Served by a module the server hands the request to, tested there.    |
| `removed`   | Gone; it answers 404.                                                |

[`test/dashboard-route-coverage.test.ts`](../test/dashboard-route-coverage.test.ts) reads every route-shaped string and anchored path regex in production source and fails when one has no entry or when an entry no longer has a source registration. It also checks the SPA `matchRoute` heads, the settings registry and the HTML entrypoints, and asks the production server for each entry's sample anonymously and as a member. A change that adds a route adds its entry in the same change.

## Verify

```sh
bun test test/dashboard-route-coverage.test.ts test/dashboard-http.test.ts src/dashboard/src/live/payload-budget.test.ts
bun run verify:ui /absolute/disposable/evidence
```

`bun run verify:improvements-ui <dir>` drives the Improvements page the same way; see [Improvement review API](improvement-review.md#dashboard).

Both use [`test/dashboard-fixture.ts`](../test/dashboard-fixture.ts): the production server over a disposable SQLite file with a fake Linear membership reader and two teams. `test/dashboard-http.test.ts` covers anonymous access, session filtering, membership revocation through warm caches and stored ETags, CSRF and Origin on mutations, and the old-link matrix with a direct refresh of each target. `verify:ui` builds the dashboard and drives Chromium at 1440 and 390 pixels through every page, old links, Back and Forward, a late 404 after navigation, keyboard focus, the transcript page and revocation. It writes screenshots, `network.json` (each API request with its bytes), `pages.json` (requests, bytes and SQL statements per page) and `old-links.json` to the evidence directory, and fails on any `/api/status` request or a page that reads another page's resource.
