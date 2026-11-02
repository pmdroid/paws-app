# Recovery invariants suite

A bounded CI suite drives Paws' recovery paths through crash, restart, partition and clock sequences, then checks the combined state. It calls no external services. Every crash closes the SQLite database file and opens it again, so only committed rows survive into the next step.

| File                                    | What it runs                                                          |
| --------------------------------------- | --------------------------------------------------------------------- |
| `test/workflow-world.ts`                | The file-backed world, its item fixtures and the invariant checker    |
| `test/workflow-recovery-matrix.test.ts` | Every fixture through every recovery entry, plus open-gap reproducers |
| `test/workflow-sequences.test.ts`       | Seeded random event sequences, shrinking and preserved reproducers    |
| `test/workflow-scenarios.test.ts`       | Combined scenarios for specific fixes, including real runner control  |

## What one world holds

One database holds every fixture at once, so one item's recovery has to leave the others alone. Each fixture is an item in a named state, with the rows that state has in production:

- a claimed `running` job, as a live process leaves it, and a live runner lease;
- a recorded candidate, with an accepted head and a later rejection of that head;
- a parked capacity wait and a transient retry backoff;
- a merge queue place, a pending merge job and an in-flight merge call;
- an agent question, a CI help question from the merge lane, and a pause;
- the `manual`, `failed`, `completed`, `merged` and `cancelled` states.

The world models what recovery reads: item state and version, run and runner generation, actionable jobs, human holds and questions, runner cleanup obligations, inbox receipts, the latest Closeout verdict on the accepted head, and an unresolved merge call. Recovery runs through the real `recoverOnStartup`, `prepareShutdown`, `closeExpiredRunnerLeases` and `requeueOrphanedWork` in `src/db/recovery.ts`.

The world does not run job handlers. In production the job loop reclaims a crashed process's `running` row once its lease expires, and a handler whose item version moved on does nothing. The world reproduces only that last step: a sweep marks such a fenced row done. Settling repeats the sweeps until three rounds in a row change nothing.

## Invariants

The checker splits the invariants into two groups. Safety invariants hold after every step:

- At most one pending current-version agent job, re-verify job and merge job per item. Only one actionable question per item.
- A terminal item has no live execution job and no actionable question, and keeps no merge call unless it was cancelled.
- A paused, `manual`, `failed`, question or restart hold has no live execution job.
- An item in the merge queue has an accepted head, and the latest Closeout verdict on that head is not a rejection. It has no live agent job.
- An unknown merge outcome keeps the item in the merge queue.

Liveness invariants hold after settling:

- Every nonterminal item that is not queued, cancelled or held has an owner. The owner is a current job or live runner work. A cancelled job, or a pending job from an older item version, does not count.
- A question or restart hold has an open question or a pending ask job.
- An unknown merge outcome has a merge job to read it.

The sequence runner also checks every step against the state before it:

- An item version never goes back, and terminal work never leaves its terminal state.
- A hold leaves only through its own release: an answer for a question, or a Stop.
- A recovery attempt is never handed back, except by an answer or a Stop.
- An unknown merge outcome is never forgotten.
- The rejected head never becomes accepted again and never reaches the merge queue.

## Recovery entries

The matrix runs every fixture through each of these entries, then checks once right after the entry and once after settling:

| Entry            | What happens                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crash            | The process is killed, the database reopens and Paws starts.                                                                                                                              |
| SIGTERM          | The shutdown hook commits, then the database reopens and Paws starts.                                                                                                                     |
| Repeated startup | Three crashes one minute apart.                                                                                                                                                           |
| Partition        | Paws stays up and keeps renewing its job leases. Runner leases lapse past their grace, and the periodic sweeps run.                                                                       |
| Clock back       | Paws restarts with the wall clock one hour earlier.                                                                                                                                       |
| Clock jump       | Paws stops, then starts three hours later.                                                                                                                                                |
| Write failure    | A trigger aborts the startup transaction when it inserts a job, updates an item or records a transition. The database must equal its state before the attempt. Startup then runs cleanly. |

Each entry also checks fix-specific expectations:

- Holds and terminal items do not change. The only exception is that a question hold's run releases its capacity.
- A verifying candidate re-verifies and never starts an agent turn (PAS-952).
- A rejected head never reaches the merge queue (PAS-950).
- Items keeping their merge place keep the same merge job, while another item's re-verify cancels only its own jobs (PAS-953). An unknown merge outcome stays recorded (PAS-956).
- Parked and backed-off waits keep their single job and payload, without spending recovery (PAS-955).
- A runner that still holds the work keeps the item's recovery budget.
- A second unfinished start asks a person (PAS-941), unless the resume-again window has passed.

## Seeded sequences

Each seed picks seven fixtures and fourteen actions. The actions are:

- crash or SIGTERM, then start; a second start in the same process;
- a sweep, or settling;
- a time step forward, or the clock stepping back;
- an answer that is delivered again after a crash;
- a Stop;
- an injected write failure during startup;
- a runner reconnecting and renewing its lease;
- a claimed job whose acknowledgement is lost to a crash or sent twice.

CI runs 16 seeds. For a longer local search, set how many seeds to run and where to start:

```sh
PAWS_WORKFLOW_SEEDS=300 PAWS_WORKFLOW_FIRST_SEED=100 bun test test/workflow-sequences.test.ts --timeout=120000
```

A failure is shrunk: actions and fixtures are removed while it still fails. The error then prints the minimal sequence as JSON. Add it to `REPRODUCERS` in `test/workflow-sequences.test.ts` once the cause is fixed. The preserved reproducers there cover PAS-941, PAS-952/965, PAS-953, PAS-955 and PAS-956.

## Combined scenarios

The scenario file covers these cases:

- The same head fails CI twice around a crash (PAS-959). The second handoff reuses the job row, reaches the agent, and counts as round two.
- A rejected head goes through a transient retry and two restarts (PAS-950). A stale `accepted_head` cannot send it to the merge queue either.
- A merge outcome is unknown through a Stop and three restarts (PAS-956). After GitHub confirms the merge, a stale Stop, restart or second merge confirmation cannot revive the item.
- A GitHub review is delivered before a crash and replayed after each restart (PAS-942). It is applied once, and the startup re-verify of another item keeps this item's merge place (PAS-953).
- Runner leases lapse for running work, a verifying candidate and a merge-queue run (PAS-965). One sweep gives each a single follow-up on the transient retry budget, without the orphan grace: a resume, a re-verify and a re-verify. A crash and a SIGTERM restart add no job and spend no recovery attempt.
- The clock steps back, so a dead job's lease looks live. No second agent job is claimed until the old lease passes.
- Runner control runs the real control-plane code, `createRunnerWork`, for two cases (PAS-943). A Stop whose runner teardown is unconfirmed keeps the item cancelled and the runner slot occupied through restarts, sweeps, the cancel receipt and its expiry, until the runner confirms termination. After a runner lease is fenced, a runner that reconnects cannot act for the old generation across restarts.

## Open gaps

These scenarios fail today. Each is a `test.failing` reproducer in `test/workflow-recovery-matrix.test.ts`. The checker tags them as known gaps, so the rest of the suite still runs. When a fix lands, its reproducer starts passing and fails the build until `.failing` is removed.

- **Startup adds a second resume.** It adds a `process_restart` resume beside a resume that is already pending, for example an orphan resume queued just before a restart. The newer job is fenced once the first one runs, but startup spends the item's recovery attempt.
- **Orphan recovery can re-verify during an unknown merge.** If an item's merge job ends while its merge call is still unknown, orphan recovery moves the item from the merge queue to `verifying`.

## Not covered here

- **Runner offline authority (PAS-960), cancellation while the worker stop hangs (PAS-961) and runner liveness ordering (PAS-964).** The suite has no desired-behavior scenarios for them yet.
- **Runner daemon restarts mid-turn and inside the publishing phase (PAS-951, PAS-957).** Runner-side process tests cover these: `test/runner-paws-restart.test.ts` (through `test/fixtures/runner-paws-restart.ts`), `test/runner-runtime-outage.test.ts` and `test/runner-runtime-publication.test.ts`. The real-provider restart proof is PAS-751.
- **Job handlers and the merge lane's GitHub calls.** The lane's in-flight reads have their own regression tests in `src/merge/advance-restart.test.ts` and `src/loop/merge-outcome.test.ts`.
- **Clock gaps the host observes while Paws stays up (PAS-940, PAS-954, PAS-955).** These are in `test/clock-gap-holds.test.ts` and `test/clock-gap-parked-waits.test.ts`. This suite only steps the wall clock between process starts.
- **Retry and typed infrastructure holds (PAS-936).** The suite checks that existing retry budgets survive recovery. It does not exercise new hold types.
