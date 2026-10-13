# Dashboard

The dashboard shows current work, run logs, questions, verification and merge progress. It keeps the last snapshot visible when the engine becomes unavailable.

## Sub-features

- `dashboard-details` reaches runs, questions, verification, merge queue, Linear conversations and dependencies from Overview.
- `dashboard-run` opens a completed run and its logs.
- `dashboard-refresh` retains keyboard focus and the question handoff through a refresh.
- `dashboard-outage` shows the last snapshot during an outage and reconnects.
- `dashboard-layout` fits desktop and mobile viewports.

## How to get to it (user POV)

- Open `/status` on the Paws instance.
- Choose Overview in the sidebar, then its work-detail links or a run link.
- Open the direct hashes `#/runs`, `#/questions`, `#/verdicts`, `#/queue`, `#/sessions` and `#/epics`.
- Use Refresh to request the latest state. Open a question's `Answer in Linear` link to reach its source thread.

## Driving it with Playwright

Preconditions:

- Launch `bun --no-env-file scripts/verify-local.ts serve` and pass Doctor.
- Set `PAWS_VERIFY_ORIGIN` and `PAWS_VERIFY_EVIDENCE` from that fixture. Resolve Playwright before launch.

- **Run the browser recipe.** Execute `bun --no-env-file test/local/dashboard-browser.cjs "$PAWS_VERIFY_ORIGIN" "$PAWS_VERIFY_EVIDENCE"`. Require exit 0 and stdout `verified: true`.
- **Open work details.** The driver clicks `.work-navigation a[href="#/runs"]` and the equivalent links for the other five hashes. Each URL must change to its hash while Overview stays selected. For direct navigation, use `page.goto` with each origin plus `/status` and hash, then retain `page.locator("#content").ariaSnapshot()` with that entry point.
- **Read a run.** From Overview, open `.overview-work a` whose `href` names the first run in the live `/api/status` response. The driver requires `#content .log` and records the run ID.
- **Refresh a question.** The driver replays the actual saved `happy-parked.json`, requires `Answer in Linear`, focuses the Questions link and clicks `[data-action="refresh"]`. The same link must retain focus after the repaint.
- **Recover from outage.** The driver injects HTTP 503 for `/api/status`, requires `.err-bar` to say `Showing the last snapshot`, then removes the interception and requires `.live-bar` again.
- **Retain proof.** Inspect `dashboard-browser.json`, the command exit and `overview-desktop.png` / `overview-mobile.png`. The screenshots use 1440 and 390 pixel widths. Retain accessible snapshots when extending the recipe. Confirm the JSON has no browser errors.

## Gotchas

- The fixture's `/api/status` is live; its question screenshot uses a saved live snapshot because the scripted teammate has already answered by readiness.
- The browser driver blocks requests outside the fixture origin. Inspect the Linear link target without opening a hosted issue.
- The driver clicks all six detail links. Direct hash navigation needs the separate `page.goto` action before crediting that entry point.
- The fixture listener serves dashboard routes and `/__fixture`; its Doctor uses those routes. `/health` belongs to the normal Paws server and the workspace fixture.
- Wait for the launcher to finish after the browser exits, then confirm the evidence survives Cleanup.
