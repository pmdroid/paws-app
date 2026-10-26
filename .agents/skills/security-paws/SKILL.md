---
name: security-paws
description: Review a Paws candidate that changes a high-risk path against the security rules Paws sets for itself, when Closeout requests the security review.
---

Review the supplied base and candidate commits without changing the implementation. Read AGENTS.md for the module layout and repository rules.

This review runs only when the candidate changes a high-risk path. It runs beside the general review, so do not report ordinary bugs, style, or test gaps. Report a finding only when the change creates a concrete risk under one of the rules below, or removes or weakens a check that enforced one. Name the input or caller that reaches it. Report any suspected real credential as P0 without repeating its value.

## Rules

### Secrets stay in `~/.paws/secrets`

- Secrets are read and written through `src/credentials` (`readSecretFile`, `writeSecretFile`), under `~/.paws/secrets` with directory mode `0700`. A new secret file elsewhere, a wider mode, or a secret stored in SQLite, `config.toml`, or the repository is a finding.
- A secret never reaches a log, journal entry, error message, HTTP response, Linear activity, pull request body, or Closeout output. Command output that can carry one goes through `scrubText` with `credentialSecrets()`.
- The agent environment comes from the allowlist in `src/acp/env.ts` (`ALLOWED_AGENT_ENV`). Adding a variable that holds a token, key, or password, or passing `process.env` through to an agent, hook, or Closeout command, is a finding. Short-lived tokens the agent needs reach it through a tool or credential helper, not the environment.

### Webhooks fail closed

- A webhook handler (`src/linear/webhook.ts`, `src/github/webhook.ts`, `src/slack/webhook.ts`) answers 401 and does no work until the signature over the raw body passes. A missing secret, missing signature, or stale timestamp is a failure, not a skip.
- Signatures compare with `timingSafeEqual` on equal-length buffers. The body is parsed only after verification.
- A path that returns 200 or enqueues work for an unverified body is P0.

### Authorization on routes and answers

- Every route that reads workspace data or changes state checks the caller: the dashboard session and CSRF token for browser routes, the runner identity for runner routes, and the enrollment token for enrollment. A new route branch in `src/server/serve.ts` or a module's route without that check is a finding.
- A runner may only act on its own runs, leases, and repositories. Trusting a runner id, item id, or workspace id from the body instead of the authenticated identity is a finding.
- Answers to questions go through `canAnswer` in `src/questions` and `canAct` in `src/workspace`. An answer, approval, or bypass accepted from someone the policy does not allow is a finding. An agent's reply never counts as a person's approval, and a Linear reply never bypasses a check or approves a screen.

### SQL built from input

- Values reach SQLite only as bound parameters. A query string built with template literals or concatenation from a request, webhook body, Linear or GitHub data, branch name, or agent output is a finding. Interpolated identifiers come from a fixed list in code.

### Paths stay inside the worktree

- A path from an agent, request, webhook, Linear input file, artifact name, or repository content is resolved and checked before use: `assertSafeSegment` for single segments, `isInside` or `resolveInsideWorktree` in `src/acp/permissions.ts` for paths. Watch for `..`, absolute paths, symlinks followed out of the worktree, and checks done before `join` or `resolve` instead of after.
- Agent tools must not read or write `~/.paws/secrets`, another item's worktree, or the Paws database.

### Child processes started from input

- Commands run as an argv array without a shell. Passing input to `sh -c`, `bash -lc`, or `shell: true`, or building one command string from input, is a finding.
- An argument from input that could start with `-` is separated by `--` or validated, so it cannot become an option of `git`, `gh`, or another tool.
- A spawned process gets the filtered environment, a working directory inside the worktree, and a timeout or owner that stops it.

## Findings

Return findings with severity, location, explanation, and supporting evidence. Use P0 for an exploitable bypass or a leaked secret, P1 for a rule broken on a reachable path, P2 for a hardening gap with no reachable exploit, and P3 for minor issues. Return an empty findings array when the change breaks none of these rules. The Closeout runner decides acceptance from the findings.
