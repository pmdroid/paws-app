---
name: verify-paws
description: Verify Paws locally in disposable instances with scripted ACP agents, fake trackers, real SQLite, Git worktrees, native Closeout and local squash merges. Use for setup, chat, orchestration, stop/recovery and verification-trust regressions.
---

# Verify Paws

## Contract

State the claim before testing: given a particular epic, agent script and failure, which observable state, comment, evidence record and Git ref must result? A green unit suite alone does not prove an epic is safe to merge.

Read `AGENTS.md`, `package.json`, `scripts/verify-local.ts`, `test/local/instance.ts` and `test/local/probes.ts`. Inspect the diff and source commit. Install locked dependencies if needed, using an isolated temporary HOME and KYOTOAGENT_ROOT together.

## Run

Use Linux with Bun 1.4.2+, Git, OpenSSL 3 and GNU `timeout` available. From the repository root, use a tracked background task:

```sh
bun --no-env-file scripts/verify-local.ts check
```

`bun run verify:local check` is the package shortcut. The direct command also prevents Bun loading a repository `.env` before the launcher starts.

The launcher creates a fresh `paws-verify-*` temporary directory, checks resolved paths, passes an explicit credential-free environment, and sets HOME, KYOTOAGENT_ROOT, PAWS_HOME, TMPDIR and XDG directories together. It isolates Git configuration and disables desktop Secret Service access. It never invokes a real coding agent or real login.

`check` runs lint, formatting, both TypeScript checks, the full existing test suite, dashboard build and Markdown links, then the behavioral audit. It preserves each command's exit code and log. A prerequisite failure stops execution. Behavioral failures produce exit 1; read `observations.json` to distinguish product failures from a harness exception. Keep failing assertions enabled and rerun after the corresponding product fix.

For the behavioral audit without repeating the suite:

```sh
bun --no-env-file scripts/verify-local.ts audit
```

For workspace ownership and browser session evidence, run `bun --no-env-file scripts/verify-local.ts workspace`. This uses real SQLite and two owned HTTP subprocesses to prove persistent identity across an actual process restart. It checks organization-bound single-use bootstrap, hashed session storage, cookie attributes, idle and absolute expiry, manual owner preservation, membership revocation, revocation precedence at equal observation times and verified restoration. The same probe runs in the normal test suite. Inspect `workspace-access/audit.json` and the observation journal. User identities and organization membership are synthetic fixtures.

For browser inspection:

```sh
bun --no-env-file scripts/verify-local.ts serve
```

`serve` builds the dashboard, runs the happy-path fixture and prints an ephemeral loopback `/status` URL plus `/__fixture` for fake issue comments and PR records. Inspect desktop and narrow mobile viewports in one pass. Open Agent runs, Open questions, Closeout, Merge queue and the Engine dialog; test keyboard navigation and record console errors. Use saved `happy-parked.json` to inspect the actual question snapshot. The server expires after five minutes or accepts SIGINT/SIGTERM during the inspection window. Keep the task ID, wait for completion and confirm the printed port is closed. Never stop any other Paws or Kyoto server.

## What the fixture exercises

For Linux execution spool changes, run `bun test test/runner-execution.test.ts test/boundaries.test.ts`. These checks publish and reload the production strict unsigned job schema, verify immutable repository-bundle copies, reject unsafe directory modes, symlinks, hardlinks and extra credential fields, and drive the Unix broker client against a delayed local response. The production subprocess fixture `test/local/runner-execution-process.ts` accepts `publish`, `read`, `result` and `verify` operations against its supplied fixture root.

- Linear tracker and comment adapters against local fakes; a Linear epic with two dependent items.
- Real SQLite migrations, jobs, outbox, intake and orchestrator.
- Real Ed25519 runner command signatures with strict typed payloads, runner/workspace identity, repository allowlists, expiry and replay protection persisted through SQLite close/reopen. The protocol probe performs no repository fetch.
- Existing `src/acp/testing/fake-agent.ts` subprocess over real ACP JSON-RPC, including fragmented text, filesystem writes and ask_team through MCP. Each fake subprocess has a bounded timeout.
- A real acceptance-test failure, fix commit and native Closeout re-evaluation; scripted independent-review text.
- Real local branches, pushes, expected-head validation and squash merges into a disposable bare origin. Check final main content, not just fake merge calls.
- Production status HTTP handlers and browser assets reading that database, plus a fresh `startPaws` process object for startup routes.
- Negative probes for missing issue instructions, discarded review instructions, malformed reviewer output, Codex independence, login visibility, setup detection, token-store failure, source-question links, Linear same-account replies, question restart, Linear stop identity and merge-job recovery.
- Real P-256 client certificates and an HTTPS listener on Bun's HTTP/2 server in HTTP/1.1 compatibility mode. Runner probes check actual peer identity, forged headers, missing and untrusted certificates, server hostname and trust failures, expiry on an established connection, live socket closure and response cancellation on revocation, encrypted issuer reload, concurrent issuer creation after a stale legacy lock, CSR rejection, rejected request body closure, oversized request rejection, serialized server certificate replacement and shutdown during reload. The expiry probe advances the authorization clock while retaining a real TLS connection.

Use the existing suite for Linear delivery/HMAC, dedupe, rate limits, trusted replies, permission checks, stop/timeouts, shutdown, recovery and Closeout conformance. Open the specific test before crediting it with a claim. For a new bug, add a deterministic fixture at its actual boundary; do not replace real orchestration with an expected boolean. Review stop reasons, not only findings arrays. For restart claims, distinguish adapter reconstruction from an actual process restart.

## Safety and evidence

Use synthetic requirements and tokens only. All scenario Git remotes are local paths; injected HTTP routes assert the fake origin and the scenario rejects non-loopback fetches. These are deterministic trusted fixtures, not an OS sandbox: do not run arbitrary issue-supplied code or a real agent in them. Use a disposable container/VM with blocked external egress for hostile-code isolation claims.

Never copy operator credentials, use the operator's Kyoto root, call real tracker/GitHub mutation APIs, or invoke `paws setup`, `doctor`, or login against the operator's environment. Setup/auth probes must inject fetch, token store, browser and command behavior. An EnvSource argument alone is insufficient because some modules read ambient process.env.

Evidence remains in the printed directory: manifest with source SHA/diff digest, command logs/exits, observations, network journal, prompts, ACP scripts/results/transcripts, SQLite state, Closeout reports, fake API journal and local origin history. Temporary HOME and scratch files are removed by the launcher after commands exit. Inspect evidence before deleting that exact directory; never use broad process matching or wildcard cleanup.

Runner TLS evidence includes `runner-tls/certificate-metadata.json` with certificate fingerprints, serials, validity, key extended usages and accepted peer observations. Certificates and keys in this fixture are synthetic. Publish the metadata and observations, keeping private key files out of PR artifacts. These probes use the real TLS stack and no provider accounts.

Report `VERIFIED`, `NOT VERIFIED` or `INCONCLUSIVE` for the stated claim. Name passing checks, failing checks and skipped checks separately. State which components were real and which were scripted. Do not infer real OAuth, subscription login, model judgment or hosted-service compatibility from a fake pass. For fixes, retain a baseline and treatment with the same scenario, and publish the smallest useful evidence artifact.

The TLS probe also rejects invalid replacement server key material and proves the unchanged previous listener still serves an authenticated request on the same port.

The TLS probe advances the authorization clock while an actual POST body is still arriving and inside an awaited handler returning an empty response. Both expire with 403 before command delivery or successful response headers.

The TLS probe expires an identity during asynchronous authorization and before a streaming response starts. It verifies that the handler is not called after the failed access check and that a rejected response stream receives cancellation.
