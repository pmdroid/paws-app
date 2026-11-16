---
name: verify-paws
description: Verify Paws behavior in disposable local instances with scripted ACP agents, fake providers, PGlite/Postgres, Git worktrees and browser proofs. Use for orchestration, access, runner, recovery and dashboard changes.
---

# Verify Paws

State a falsifiable claim before running commands: given the person's action and any injected failure, which visible result, tracker activity, evidence record and Git ref should follow?

Read `AGENTS.md`, `package.json`, the changed source and its relevant tests. Source and executable assertions define current behavior. Discover scenarios from `test/proofs/`, focused probes from `test/local/`, and browser drivers from `scripts/verify-*-ui.ts`; inspect a driver's arguments and prerequisites before invoking it. Do not reconstruct implementation contracts from old documentation.

## Isolation and prerequisites

Use Linux with Bun 1.4.4 or newer, Git, Python 3, OpenSSL and GNU `timeout`. Browser proofs need Playwright's Chromium installed. Check required executables and locked dependencies before the first drive. After a failed drive, recheck its prerequisite and process health before retrying; reset a wedged fixture rather than continuing against it.

Run launchers with `bun --no-env-file` so a repository `.env` is not loaded. `scripts/throwaway-environment.ts` creates an explicit credential-free environment with temporary HOME, KYOTOAGENT_ROOT, PAWS_HOME, Git configuration, XDG directories and disabled desktop secret access. The proof and local launchers use it. For a standalone probe, read its environment setup first and use that helper when it needs isolation. Install missing locked dependencies with temporary HOME and KYOTOAGENT_ROOT together.

Use fake Linear and GitHub providers and the scripted ACP agent. Never drive the installed Paws service, personal workspace, real agent login or real provider account. The control-plane fixtures use PGlite/Postgres; runner-owned journal and daemon stores may use SQLite. Preserve evidence outside temporary homes and directories the launcher removes.

## Behavioral proofs

Start with the proof scenarios covering the changed behavior:

```sh
PAWS_EVIDENCE_DIR=/absolute/fresh/evidence bun --no-env-file scripts/verify-proof.ts --changed origin/main
```

`--changed` selects scenarios by their `covers` globs. Read the selected scenarios and confirm they exercise the claim. No matching scenario is not a passing behavioral proof. Run named scenarios when the claim needs them, for example:

```sh
PAWS_EVIDENCE_DIR=/absolute/fresh/evidence bun --no-env-file scripts/verify-proof.ts happy-path question-answered cancel-closes-pr
```

Omit names and `--changed` to run every scenario. Each runs in a fresh disposable environment with real storage and Git, fake providers and scripted agent subprocesses. Inspect every retained `proof-<name>.json` assertion and its `.md` companion, as well as the command exit code.

For a focused regression, inspect the appropriate `test/local/` driver and its companion tests. Current examples include `current-run-startup.ts`, `linear-session-stop.ts` and `runner-public-activity.ts`. Derive arguments and expected observations from the selected driver's source instead of assuming every probe has the same interface.

## Agent accounts and usage limits

Agent accounts are signed in on the control plane and bound to the owner's runners. A change to accounts, credentials, usage readings or placement must still pause work when an account's quota is spent and resume it after the reset. Prove that through the path production uses: `bindingReadinessSteps` in `src/runner-placement`, which placement calls for every candidate runner. A helper that production no longer calls proves nothing, even when its test passes. Check with `git grep` that the function a test exercises has a production caller.

Run the usage proof and the focused tests:

```sh
PAWS_EVIDENCE_DIR=/absolute/fresh/evidence bun --no-env-file scripts/verify-proof.ts account-provider-usage
bun --no-env-file test test/provider-usage-cooldown-pglite.test.ts test/usage-pause-pglite.test.ts test/runner-cli-cause.test.ts src/agent-auth src/acp/acp.test.ts
```

Require each of these:

- A provider reading with a window at 100% makes a bound account's readiness `exhausted` until the reset plus slack. After that the account is ready again.
- An account with extra usage stays available while a window is spent.
- A reading with nothing spent does not clear a cooldown that a failed run recorded.
- A run that fails on quota is classified as a usage limit, not as `api_error: temporary provider failure`. That includes Codex's ACP `Internal error`, whose message travels in `error.data`.

If a change removes or reroutes one of these signals, add a proof step for the new path. Confirm the step fails without the change, then keep it.

## Local integration audit

```sh
bun --no-env-file scripts/verify-local.ts audit
bun --no-env-file scripts/verify-local.ts workspace
```

Drive these serially. `audit` builds the dashboard and runs `test/local/instance.ts`, including orchestration and boundary probes. `workspace` runs `test/local/workspace-instance.ts` for workspace access, authentication, authorization, refresh and startup behavior over local HTTP with scripted providers.

The launcher prints its `paws-verify-*` evidence directory. Read `manifest.json`, `commands.json`, command logs and `observations.json`. Require every relevant observation to pass. It retains evidence and removes its temporary home and scratch directory after the run.

`bun --no-env-file scripts/verify-local.ts check` runs lint, formatting, type checks, the test suite, dashboard build and links before the integration audit. For the repository's complete static and test checks, run `bun --no-env-file run check`; read `package.json` for its current contents. These are separate entry points.

## Browser verification

Build the dashboard and run its maintained browser proof:

```sh
bun --no-env-file run build:dashboard
bun --no-env-file scripts/verify-dashboard-ui.ts /absolute/fresh/browser-evidence
```

Inspect the driver's retained results and desktop/mobile screenshots, not just its exit code. Use the relevant focused UI driver for behavior the main dashboard proof does not exercise. Read its fixture and network interception before driving it.

For interactive inspection, start one owned disposable fixture:

```sh
bun --no-env-file scripts/verify-local.ts serve
```

For workspace sign-in and settings, use `workspace-serve`, adding `--settings` for the settings fixture. Read the printed origin and evidence files and the selected fixture's source for scripted identities and login handling. Keep hosted navigation blocked. Inspect keyboard use, errors, loading and failure recovery, and desktop/mobile layouts for the changed flow.

Track the launched process and its printed port. These interactive fixtures expire after five minutes or accept SIGINT/SIGTERM. After the final drive, stop only processes this verification started and confirm their ports close. Clean failed-iteration residue without deleting evidence. Never stop another Paws instance.

## Report

Record the tested source SHA and diff, exact commands, exits, evidence locations and observed outcomes in scratch notes. State which claim passed, failed or could not be exercised. A green unit suite alone does not establish the behavioral claim. If a drive reveals a product failure, retain its evidence and report the failure rather than changing the expected result. Keep deferred work in tracker issues.
