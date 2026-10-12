---
name: verify-paws
description: Verify Paws locally in disposable instances with scripted ACP agents, fake trackers, real SQLite, Git worktrees, native Closeout and local squash merges. Use for setup, chat, orchestration, stop/recovery and verification-trust regressions.
---

# Verify Paws

## Contract

State the claim before testing: given a particular epic, agent script and failure, which observable state, comment, evidence record and Git ref must result? A green unit suite alone does not prove an epic is safe to merge.

Read `AGENTS.md`, `package.json`, `scripts/verify-local.ts`, `test/local/instance.ts` and `test/local/probes.ts`. Inspect the diff and source commit. Install locked dependencies if needed, using an isolated temporary HOME and KYOTOAGENT_ROOT together.

## Run

Use Linux with Bun 1.4.2+, Git, Python 3, OpenSSL 3 and GNU `timeout` available. From the repository root, use a tracked background task:

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

The same command drives browser sign-in through a real loopback HTTP listener and production OAuth handlers. Linear token exchange, identity and paginated membership responses are scripted. Check `workspace-browser/requests.json`, the access audit and observations for actor=user/read scope/PKCE, pending login after handler reconstruction with no stored verifier, first-owner teams after an advancing-clock membership read, separate member identities, outsider rejection, callback replay, delayed sign-in response after membership removal, guest caps with equal-time restrictive precedence and preserved manual-role restoration, CSRF, logout during a Linear outage and membership refresh after five minutes.

The authorization probe uses the production server and real SQLite to verify organization, installation, team and repository scope on status, conversations and artifact reads. It proves owner settings, recent sign-in, CSRF, last-owner protection, guest restrictions, delayed promotion after a newer guest cap, rejection of non-string roles, atomic role changes after actor demotion, forced membership refresh and the authenticated principal passed to runner control. The authenticated status HTML token is used for an owner host-control action and for logout after a dashboard reload during a Linear outage, while data requests remain closed. Artifact denials are checked before the injected reader sees an ID. Inspect `workspace-authorization/audit.json` with the observation journal.

The workspace refresh probe holds an earlier active snapshot open while permission invalidations arrive. It proves one nonoverlapping follow-up applies the later revocation and deletes persistent sessions. A forced invalidation during an HTTP lookup fetches a fresh snapshot afterward. An invalidation at the completion boundary starts a fresh pass, and shutdown joins accepted refresh and request work. Browser and membership operations reject as soon as shutdown starts, while accepted follow-up passes finish. Inspect `workspace-refresh/` and the observation journal.

For the login and owner controls in a browser, run `bun --no-env-file scripts/verify-local.ts workspace-serve`. Read the fixture origin and synthetic operator setup code from `workspace-ui.json` in the printed evidence directory. Intercept `/auth/linear` with `route.fetch({ maxRedirects: 0 })` and rewrite its redirect to the provider URL's `redirect_uri`, preserving `state` and adding `code=owner` or `code=member`; fulfill with the original response and cookies. Abort browser requests outside the fixture origin. Token and membership responses are injected fixtures. Complete first-workspace setup, sign out, sign in as the second identity, and inspect owner controls at desktop and mobile widths. The production server stops after five minutes or on SIGINT/SIGTERM; preserve `workspace-ui-audit.json` and confirm its printed port is closed. For outage recovery, intercept `/api/auth/session` with503, reload, inspect Sign out at desktop and mobile widths, then restore the session route and verify sign-out returns200 and a new session read returns401.

The workspace probe also uses fake Slack HTTP responses with the existing credential adapter to match nine of ten Linear emails. Check `workspace-identity-links/links.json` and `slack-requests.json` for unmatched accounts, per-workspace mapping methods, manual Slack/GitHub updates, clearing a manual Slack override to restore email matching, CSRF and recent-auth denials, audited administrator demotion during body parsing and at transaction entry from a second SQLite connection, stale manual-write rejection, duplicate identity rejection, installation validation and access audits. An owned fresh process reopens SQLite read-only and records the persisted manual links and audit count in `restart.json`.

For browser inspection:

```sh
bun --no-env-file scripts/verify-local.ts serve
```

`serve` builds the dashboard, runs the happy-path fixture and prints an ephemeral loopback `/status` URL plus `/__fixture` for fake issue comments and PR records. Inspect desktop and narrow mobile viewports in one pass. Open Agent runs, Open questions, Closeout, Merge queue and the Engine dialog; test keyboard navigation and record console errors. Use saved `happy-parked.json` to inspect the actual question snapshot. The server expires after five minutes or accepts SIGINT/SIGTERM during the inspection window. Keep the task ID, wait for completion and confirm the printed port is closed. Never stop any other Paws or Kyoto server.

## What the fixture exercises

- Fresh startup configures Linear issue tracking. Linear tracker and comment adapters use local fakes with an epic and two dependent items.
- Real SQLite migrations, jobs, outbox, intake and orchestrator.
- Direct HTTPS using production TLS configuration, a fresh local certificate and a client that verifies the certificate. A fresh child reads the service’s `NODE_ENV` setting and verifies that an uncaught enrollment error returns HTTP 500 without its error details. Run this probe from a checkout path containing spaces or Unicode when checking child-import portability.
- Exact Ed25519-signed Linux release manifests and SHA-256 artifact verification. Ephemeral signing fixtures exercise wrong keys, unsigned or modified content, platform/version fields, duplicate paths, archive traversal, links and unsafe modes. Inspect `linux-release-verification.log`.
- Existing `src/acp/testing/fake-agent.ts` subprocess over real ACP JSON-RPC, including fragmented text, filesystem writes and ask_team through MCP. Each fake subprocess has a bounded timeout.
- Direct host ACP execution, credential environment filtering and guarded filesystem requests, with a retained scripted-agent trace. Removed container CLI commands must fail before starting Paws.
- A real acceptance-test failure, fix commit and native Closeout re-evaluation; scripted independent-review text.
- Real local branches, pushes, expected-head validation and squash merges into a disposable bare origin. The GitHub request journal proves each Linear item publishes a pull request with its issue reference and Closeout evidence. Check final main content, not just fake merge calls.
- Production status HTTP handlers and browser assets reading that database, plus a fresh `startPaws` process object for startup routes.
- Negative probes for missing issue instructions, discarded review instructions, malformed reviewer output, Codex independence, login visibility, setup detection, token-store failure, source-question links, Linear same-account replies, threaded question restart excluding unthreaded and previous-thread replies, Linear stop identity and merge-job recovery.
- Real P-256 client certificates and an HTTPS listener on Bun's HTTP/2 server in HTTP/1.1 compatibility mode. Runner probes check actual peer identity, forged headers, missing and untrusted certificates, server hostname and trust failures, expiry on an established connection, live socket closure and response cancellation on revocation, encrypted issuer reload, concurrent issuer creation after a stale legacy lock, CSR rejection, rejected request body closure, oversized request rejection, serialized server certificate replacement and shutdown during reload. The expiry probe advances the authorization clock while retaining a real TLS connection.

Use the existing suite for Linear delivery/HMAC, dedupe, rate limits, trusted replies, permission checks, stop/timeouts, shutdown, recovery and Closeout conformance. Open the specific test before crediting it with a claim. For a new bug, add a deterministic fixture at its actual boundary; do not replace real orchestration with an expected boolean. Review stop reasons, not only findings arrays. For restart claims, distinguish adapter reconstruction from an actual process restart.

The Linear Closeout cases in `test/loop.e2e.test.ts` reconstruct the adapter, reject bypass replies without a reason or naming an unfailed check, preserve the replacement question's retry history, ignore replies to the old question, and queue no resume or reverify work.

For HTTP shutdown, run `bun --no-env-file test test/server-drain.test.ts`. The production listener holds an accepted artifact read while shutdown begins, then performs a final real SQLite query. Verify shutdown waits for that query before the caller closes SQLite. A second test starts Paws with an offline Linear adapter, holds a real HTTP session request, and verifies `paws.stop()` keeps SQLite open until that request finishes. Both tests also run in the normal suite.

## Safety and evidence

Use synthetic requirements and tokens only. All scenario Git remotes are local paths; injected HTTP routes assert the fake origin and the scenario rejects non-loopback fetches. These are deterministic trusted fixtures: do not run arbitrary issue-supplied code or a real agent in them. ACP runs directly on its host; environment filtering and guarded ACP requests do not establish filesystem isolation for terminal commands. Use a disposable VM with blocked external egress for hostile-code isolation claims.

Never copy operator credentials, use the operator's Kyoto root, call real tracker/GitHub mutation APIs, or invoke `paws setup`, `doctor`, or login against the operator's environment. Setup/auth probes must inject fetch, token store, browser and command behavior. An EnvSource argument alone is insufficient because some modules read ambient process.env.

Evidence remains in the printed directory: manifest with source SHA/diff digest, command logs/exits, observations, network journal, prompts, ACP scripts/results/transcripts, SQLite state, Closeout reports, fake API journal and local origin history. Temporary HOME and scratch files are removed by the launcher after commands exit. Inspect evidence before deleting that exact directory; never use broad process matching or wildcard cleanup.

Runner TLS evidence includes `runner-tls/certificate-metadata.json` with certificate fingerprints, serials, validity, key extended usages and accepted peer observations. Certificates and keys in this fixture are synthetic. Publish the metadata and observations, keeping private key files out of PR artifacts. These probes use the real TLS stack and no provider accounts.

Report `VERIFIED`, `NOT VERIFIED` or `INCONCLUSIVE` for the stated claim. Name passing checks, failing checks and skipped checks separately. State which components were real and which were scripted. Do not infer real OAuth, subscription login, model judgment or hosted-service compatibility from a fake pass. For fixes, retain a baseline and treatment with the same scenario, and publish the smallest useful evidence artifact.

The command-runner recipe keeps real origin-policy loading, detached candidate Git worktrees, native Closeout evaluation and evidence records. Command execution is injected and scripted. It checks accepted execution, nonzero exit, dirty worktree, moved HEAD, timeout and failed setup, and proves policy commands do not execute in the coordinator process when the runner is supplied.

The TLS probe also rejects invalid replacement server key material and proves the unchanged previous listener still serves an authenticated request on the same port.

The TLS probe advances the authorization clock while an actual POST body is still arriving and inside an awaited handler returning an empty response. Both expire with 403 before command delivery or successful response headers.

The TLS probe expires an identity during asynchronous authorization and before a streaming response starts. It verifies that the handler is not called after the failed access check and that a rejected response stream receives cancellation.
