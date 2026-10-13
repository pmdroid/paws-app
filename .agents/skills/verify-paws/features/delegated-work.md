# Delegated work and merge

Hand Paws a Linear issue with dependent sub-issues. Paws reports progress, asks for an answer, repairs a failed check, and publishes and merges the work in dependency order.

## Sub-features

- `work-intake` accepts delegated or labeled issues.
- `work-order` keeps dependent work queued until its blocker merges.
- `work-repair` fixes a failed Closeout check before publication.
- `work-publish` creates pull requests with issue references and verification evidence.
- `work-complete` reports the final results and leaves the merged content in Git.

## How to get to it (user POV)

- Add the `paws` label to a Linear issue or delegate it to the configured Linear user.
- In agent-session mode, delegate to the installed Paws app.
- Read the issue comments or agent-session activity for progress and questions.
- Open the linked GitHub pull request and inspect its verification and merge result.
- Open Overview in the dashboard to inspect the same work.

## Driving it with verify-local

Preconditions:

- Use a fresh disposable launch. Its local epic is `LOCAL-1`, with `LOCAL-2` blocking `LOCAL-3`.
- Use fake Linear and GitHub adapters and the scripted ACP agent supplied by the existing launcher.

- **Complete the workflow.** Run `bun --no-env-file scripts/verify-local.ts serve`, wait for readiness and pass Doctor. The launcher supplies the accepted Linear intake event, answers `Include archived rows?` with `yes`, and completes two local merges.
- **Read progress.** Fetch `curl --fail --silent --show-error "$PAWS_VERIFY_ORIGIN/__fixture"` into `"$PAWS_VERIFY_EVIDENCE/issue-thread.json"`. Require two pull requests, two merges and one final `Paws: Epic complete.` comment containing both item results.
- **Inspect the transition.** Read `happy-parked.json` and `happy.json`. The parked states must be `awaiting_input,queued`; the final states must be `merged,merged`. The recorded runs must include a fix after the failing check.
- **Confirm Git.** Run `git --git-dir "$PAWS_VERIFY_EVIDENCE/happy/origin.git" show main:result.txt`. Require `yes` and compare `git --git-dir "$PAWS_VERIFY_EVIDENCE/happy/origin.git" rev-parse main` with `happy.json`'s final head. The initial and final heads must differ.
- **Check rejection cases.** Run `bun --no-env-file scripts/verify-local.ts audit` in a separate task. Require the malformed-review and same-model observations to pass with zero merges. Preserve `observations.json` and `commands.json` from that run.
- **Check trigger entry points.** Inspect `test/linear-poller.test.ts`, `test/linear-webhook.test.ts` and `test/loop.e2e.test.ts`, then run `bun --no-env-file scripts/verify-local.ts check`. Match the relevant test assertions to labeling, delegation or agent-session intake before crediting that entry point.

## Gotchas

- The ready browser fixture has already completed intake. Use the trigger tests to prove label selection and webhook acceptance; the completed screen alone does not prove either action.
- Git repositories and squash merges are real local side effects. Pull requests and tracker delivery use the recorded fake adapters.
- `observations.json` and final command exits appear after the browser fixture stops. Keep the readiness log and inspect the final report after Cleanup.
- Check the exact candidate and stored Closeout evidence alongside final Git content. A completion comment alone is insufficient.
