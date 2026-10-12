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

For browser inspection:

```sh
bun --no-env-file scripts/verify-local.ts serve
```

`serve` builds the dashboard, runs the happy-path fixture and prints an ephemeral loopback `/status` URL plus `/__fixture` for fake issue comments and PR records. Inspect desktop and narrow mobile viewports in one pass. Open Agent runs, Open questions, Closeout, Merge queue and the Engine dialog; test keyboard navigation and record console errors. Use saved `happy-parked.json` to inspect the actual question snapshot. The server expires after five minutes or accepts SIGINT/SIGTERM during the inspection window. Keep the task ID, wait for completion and confirm the printed port is closed. Never stop any other Paws or Kyoto server.

## What the fixture exercises

- Linear tracker and comment adapters against local fakes; a Linear epic with two dependent items.
- Real SQLite migrations, jobs, outbox, intake and orchestrator.
- Exact Ed25519-signed Linux release manifests and SHA-256 artifact verification. Ephemeral signing fixtures exercise wrong keys, unsigned or modified content, platform/version fields, duplicate paths, archive traversal, links and unsafe modes. Inspect `linux-release-verification.log`.
- Existing `src/acp/testing/fake-agent.ts` subprocess over real ACP JSON-RPC, including fragmented text, filesystem writes and ask_team through MCP. Each fake subprocess has a bounded timeout.
- A real acceptance-test failure, fix commit and native Closeout re-evaluation; scripted independent-review text.
- Real local branches, pushes, expected-head validation and squash merges into a disposable bare origin. Check final main content, not just fake merge calls.
- Production status HTTP handlers and browser assets reading that database, plus a fresh `startPaws` process object for startup routes.
- Negative probes for missing issue instructions, discarded review instructions, malformed reviewer output, Codex independence, login visibility, setup detection, token-store failure, source-question links, Linear same-account replies, question restart, Linear stop identity and merge-job recovery.

Use the existing suite for Linear delivery/HMAC, dedupe, rate limits, trusted replies, permission checks, stop/timeouts, shutdown, recovery and Closeout conformance. Open the specific test before crediting it with a claim. For a new bug, add a deterministic fixture at its actual boundary; do not replace real orchestration with an expected boolean. Review stop reasons, not only findings arrays. For restart claims, distinguish adapter reconstruction from an actual process restart.

## Linux runner installation

Run `bun --no-env-file test/local/linux-release.ts` with Node 22+ at `/usr/bin/node`, Python 3, OpenSSL 3, util-linux flock, systemd tools and a cached rootless Docker proof image. `PAWS_RELEASE_PROOF_NODE` selects another existing Node binary for the disposable namespace. `PAWS_RELEASE_PROOF_IMAGE` and `PAWS_RELEASE_PROOF_DOCKER_HOST` select its cached image and local rootless socket.

The probe builds the production pinned-runtime/source package, verifies exact manifest signatures, and installs it into a fresh namespace with external networking disabled. It runs genuine systemd-sysusers and systemd-tmpfiles, checks separate nonlogin runner, agent and check identities, fixed root-owned units, regular adapter launchers and private trust state. It rejects aliased private input-group membership, membership in the dedicated metadata group for every service account, and unrelated supplemental groups before release-state mutation. Privileged installation creates the root-only verifier key and public fingerprint; update preserves that identity and every nonroot service UID must fail to read the private key. Rejections cover unsigned/modified/wrong-key releases, older/equal versions, a changed pinned signing key, active agent/check/witness executions before stopping their broker, and changed pending-install digests. Run the installer under a restrictive umask and verify that the agent UID can still read the installed source and adapter launchers. Build a second signed archive with different Bun bytes that report the same pinned version. SIGKILL an actual installer process after the pending state, release-directory publication, runtime publication and current-pointer replacement; each checkpoint must preserve the previous release and recover only the exact pinned artifact. Verify that a different newer release cannot supersede a pending artifact, changed selected trees fail without removing the current directory, and exact recovery preserves its directory inode. A preexisting dangling current pointer must install a complete release with its runtime. The fixed Bun path must select the runtime inside the current release; interruptions before pointer replacement preserve the previous runtime bytes, and a changed runtime pointer fails before release-state mutation. Launcher targets must pass the same path validation as archive members and exist in the completed archive. Inspect `installation.log` and `observations.json`; systemctl lifecycle calls use a recording fixture, and the observation records that fact.

Run the same command with `--selected-recovery` to interrupt initial release publication behind a preexisting dangling current pointer and require exact recovery with its runtime present. Then interrupt the actual installer after current-pointer replacement, then recover the exact pending artifact while a tripwire stops any temporary-file creation inside its verified deployed assets. Recovery must complete without triggering that tripwire and preserve every selected asset inode and byte, the release directory inode and the verifier identity.

## Safety and evidence

Use synthetic requirements and tokens only. All scenario Git remotes are local paths; injected HTTP routes assert the fake origin and the scenario rejects non-loopback fetches. These are deterministic trusted fixtures, not an OS sandbox: do not run arbitrary issue-supplied code or a real agent in them. Use a disposable container/VM with blocked external egress for hostile-code isolation claims.

Never copy operator credentials, use the operator's Kyoto root, call real tracker/GitHub mutation APIs, or invoke `paws setup`, `doctor`, or login against the operator's environment. Setup/auth probes must inject fetch, token store, browser and command behavior. An EnvSource argument alone is insufficient because some modules read ambient process.env.

Evidence remains in the printed directory: manifest with source SHA/diff digest, command logs/exits, observations, network journal, prompts, ACP scripts/results/transcripts, SQLite state, Closeout reports, fake API journal and local origin history. Temporary HOME and scratch files are removed by the launcher after commands exit. Inspect evidence before deleting that exact directory; never use broad process matching or wildcard cleanup.

Report `VERIFIED`, `NOT VERIFIED` or `INCONCLUSIVE` for the stated claim. Name passing checks, failing checks and skipped checks separately. State which components were real and which were scripted. Do not infer real OAuth, subscription login, model judgment or hosted-service compatibility from a fake pass. For fixes, retain a baseline and treatment with the same scenario, and publish the smallest useful evidence artifact.
