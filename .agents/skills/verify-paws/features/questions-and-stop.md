# Questions and stopping work

Paws pauses when it needs a decision, resumes from the accepted answer, and lets a teammate stop active work through Linear. A question remains answerable after Paws restarts.

## Sub-features

- `question-thread` accepts the answer in the question's Linear thread.
- `question-session` accepts structured choices and free text through agent sessions.
- `question-restart` recovers a pending question and schedules one resume.
- `question-access` checks who may answer or stop work.
- `work-stop` cancels the addressed work item.

## How to get to it (user POV)

- Reply `yes`, `no` or free text to the Linear question thread.
- Reply to a Paws agent-session question in Linear.
- Choose `Answer in Linear` from the dashboard's question display.
- Post `/paws stop` on the issue in comment mode, or send `stop` in the agent session.
- After restarting Paws, answer the original pending question.

## Driving it with verify-local

Preconditions:

- Use the launcher so HOME, credentials and scratch data are isolated.
- Use the dashboard recipe when proving the visible handoff. Use the audit and workspace recipes for accepted answers and access decisions.

- **Answer a threaded question.** Run `bun --no-env-file scripts/verify-local.ts audit`. Inspect the saved parked snapshot and the `threaded question reply survives owned process restart and ignores unrelated replies` observation. Require an answered question, `answeredBy: human-owner`, one resume job and empty duplicate and ignored results.
- **Keep the original thread after restart.** Retain `linear-question-restart/ready.json`, the scenario database and the observation's stopped PID and exit. The fixture stops the first process and answers through a fresh process.
- **Stop work.** In the same audit, require `Linear stop targets the durable work item` to record `state: cancelled`. That fixture posts `/paws stop` as a teammate and reads the persisted item afterwards.
- **Check session answers and active cancellation.** Inspect `test/loop.ask.test.ts` and the `stop from Linear cancels the live` cases in `test/loop.e2e.test.ts`. Run `bun --no-env-file scripts/verify-local.ts check` and retain the suite log for structured choices, free text and stopping implementation or review.
- **Check answer authority.** Run `bun --no-env-file scripts/verify-local.ts workspace`. Require the question to stay open for denied actors, a recorded denial, and exactly one accepted answer from the authorized teammate. Retain `workspace-linear-actions/` and `observations.json`.
- **Check the dashboard handoff.** Run the [dashboard browser recipe](dashboard.md). Require the rendered `Answer in Linear` target to equal the parked question's recorded link. Capture the link and question text together.

## Gotchas

- An unrelated comment or a reply to an old question must not count as the answer. Read duplicate and ignored-result evidence.
- A successful HTTP acknowledgment does not prove an answer was authorized. Read the question state and access audit.
- The stop observation in the audit proves durable cancellation. The active-process cases in the suite prove the running ACP session stops.
- Record actual process restart separately from rebuilding an adapter in the same process.
