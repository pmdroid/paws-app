# Paws verification map

Read this index before driving Paws, then follow the matching feature recipe. The [verification skill](../SKILL.md) owns launch, Doctor, evidence and cleanup. Commands run from the repository root.

## Baseline preconditions

- Use the disposable launcher with installed locked dependencies and the prerequisites in Launch.
- Keep the tracked background task handle, printed evidence directory, URL and PID for every launch.
- Run Doctor before driving a browser fixture. Set `PAWS_VERIFY_EVIDENCE` and `PAWS_VERIFY_ORIGIN` from that run. A workspace fixture has its own `PAWS_WORKSPACE_EVIDENCE` directory.
- Install or locate Playwright and matching Chromium before starting the five-minute browser window. Use the module and browser-cache variables described in Helpers.
- Fixtures use synthetic accounts, scripted ACP and external adapters, real SQLite and local Git. Drive only the instances this run created.

## Driving conventions

- Start each recipe from a fresh fixture unless the recipe explicitly reuses one.
- Prefer accessible names, route hashes and the selectors listed in each recipe.
- Label captured actions with the feature ID and entry point. Preserve both initial and resulting state.
- Distinguish live HTTP responses from saved-state replay and injected failures in the browser driver.
- Check persisted side effects alongside the screen. Keep command exit codes, browser errors and reports.
- Report an unreachable entry point with its attempted command and unmet precondition. A different entry point does not prove it.
- Run Cleanup after failed attempts too. Keep the printed evidence directory after the process exits.

## Features

| Feature                                              | User entry points                                                            | Driver and expected proof                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [Dashboard](dashboard.md)                            | `/status`, Overview links, run details, refresh                              | `serve` and Playwright; navigation, logs, handoffs and recovery at two widths                      |
| [Delegated work and merge](delegated-work.md)        | Linear delegation or `paws` label, issue progress, GitHub pull request       | `serve` or `audit`; two ordered merges, repaired check, final comments and Git content             |
| [Questions and stopping work](questions-and-stop.md) | Linear question thread, agent-session reply, `/paws stop`, dashboard handoff | `audit` and focused tests; one accepted answer, durable recovery and cancellation                  |
| [Workspace sign-in and access](workspace-access.md)  | First-workspace setup, Linear sign-in, Settings, sign-out                    | `workspace-serve`, Playwright and `workspace`; saved access mapping and identity-specific controls |
