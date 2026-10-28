import { tickWithRestarts } from "./helpers";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { runAgent, type RunAgentOptions, type RunAgentResult } from "../src/acp";
import { systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  getWorkItem,
  listWorkItems,
  migrate,
  openDatabase,
  saveCheckpoint,
} from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { emptyReview, repoLayout, stateOf, writeOk } from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;

test("a run handed over after ask_team keeps its question and waits for the answer", async () => {
  const result = await handOver({ ask: "Include archived rows?" });
  expect(result.state, result.detail).toBe("awaiting_input");
  expect(result.questions, result.detail).toEqual(["Include archived rows?"]);
  expect(result.checkpoint, result.detail).toMatchObject({
    phase: "awaiting_input",
    wipCommit: result.wip,
  });
}, 90_000);

test("a run handed over without a question stays running with its WIP commit as checkpoint", async () => {
  const result = await handOver({});
  expect(result.state, result.detail).toBe("running");
  expect(result.questions, result.detail).toEqual([]);
  expect(result.checkpoint, result.detail).toMatchObject({ wipCommit: result.wip });
}, 90_000);

test("a handover that fails after the interrupt sends the item back to the agent on the same session", async () => {
  const result = await handOver({ failure: "snapshot" });
  expect(result.state, result.detail).toBe("running");
  expect(result.prompts.length, result.detail).toBe(2);
  expect(result.prompts[1], result.detail).toContain("the move failed after your turn was stopped");
}, 90_000);

test("a candidate whose rebase onto its branch conflicts goes back to the agent for a conflict round", async () => {
  const result = await handOver({ conflict: true });
  expect(result.state, result.detail).toBe("running");
  expect(result.questions, result.detail).toEqual([]);
  expect(result.prompts.length, result.detail).toBe(2);
  expect(result.prompts[1], result.detail).toContain(
    "Rebase your work onto origin/paws/eng-8 without fetching again",
  );
  expect(result.prompts[1], result.detail).toContain("conflicted in `wip.txt`");
  expect(result.restarts, result.detail).toContain("conflict");
}, 90_000);

/**
 * The remote runner hands the run over: it optionally asks, then Paws holds the WIP commit. With
 * `failure`, the first turn's handover fails after the interrupt instead.
 */
async function handOver(options: {
  ask?: string;
  failure?: "commit" | "snapshot" | "publication";
  /** The first turn's candidate conflicts with its branch on GitHub instead. */
  conflict?: boolean;
}) {
  const layout = await repoLayout("paws-handover-loop-");
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-8",
      title: "Write ok.txt",
      description: null,
      subIssues: [],
    },
  ]);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  let wip = "";
  let handed = false;
  let sequence = 0;
  const prompts: string[] = [];
  const orchestrator = attachOrchestrator({
    db,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    tracker,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
    retryBaseMs: 10,
    remoteExecution: {
      agentForSession() {
        throw new Error("This fixture does not request a routing helper");
      },
      agentForItem() {
        return async (input: RunAgentOptions): Promise<RunAgentResult> => {
          if (input.prepareOnly) return runAgent(input);
          prompts.push(input.prompt);
          const failing =
            (options.failure !== undefined || options.conflict === true) && prompts.length === 1;
          if (options.ask)
            await input.askTeam!.ask(
              { question: options.ask },
              { itemId: input.itemId, runId: input.runId, role: input.role, signal: input.signal! },
            );
          // What the remote backend leaves after importing the runner's WIP commit.
          writeFileSync(
            path.join(input.worktreePath, "wip.txt"),
            `half done, turn ${prompts.length}\n`,
          );
          const git = (args: string[]) =>
            execFileSync("git", ["-C", input.worktreePath, ...args], {
              encoding: "utf8",
              env: {
                ...process.env,
                GIT_AUTHOR_NAME: "Paws",
                GIT_AUTHOR_EMAIL: "paws@localhost",
                GIT_COMMITTER_NAME: "Paws",
                GIT_COMMITTER_EMAIL: "paws@localhost",
              },
            }).trim();
          git(["add", "-A"]);
          git(["commit", "-q", "-m", "Save work in progress"]);
          wip = git(["rev-parse", "HEAD"]);
          saveCheckpoint(db, listWorkItems(db)[0]!.id, {
            phase: "running",
            baseSha: git(["rev-parse", "HEAD~1"]),
            wipCommit: wip,
          });
          handed = !failing;
          if (failing && options.conflict)
            return {
              role: input.role,
              stopReason: "error",
              cancelled: false,
              timedOut: false,
              authRequired: false,
              agentExited: true,
              errorMessage: "The runner stopped this run: the candidate conflicts.",
              candidateConflict: {
                branch: "paws/eng-8",
                tip: "a".repeat(40),
                files: ["wip.txt"],
              },
            };
          return {
            role: input.role,
            stopReason: "cancelled",
            cancelled: false,
            ...(failing ? { handoverFailure: options.failure } : { handedOver: true }),
            timedOut: false,
            authRequired: false,
            agentExited: true,
            sessionId: "claude-session",
          };
        };
      },
    },
    launch(input) {
      sequence += 1;
      const script = path.join(layout.root, `handover-${sequence}.json`);
      writeFileSync(
        script,
        JSON.stringify({
          model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
          steps:
            input.purpose === "review"
              ? emptyReview().steps
              : [writeOk(input.worktree), { type: "end", stopReason: "end_turn" }],
        }),
      );
      return { command: process.execPath, args: [fakeAgent, "", script], env: process.env };
    },
  });
  try {
    await orchestrator.onLinearEvent(createdEvent());
    const deadline = Date.now() + 60_000;
    const started = () => handed;
    while (Date.now() < deadline && !started()) {
      const job = await tickWithRestarts(jobs, orchestrator, db);
      // The follow-up after a failed handover waits for admission like any resumed turn.
      orchestrator.reconcileExecution();
      await jobs.tick(["run.resume"]);
      if (job === null) {
        outbox.tick();
        await Bun.sleep(20);
      }
    }
    // Let the turn that handed over settle and its outbox rows post.
    for (let index = 0; index < 50; index++) {
      const job = await tickWithRestarts(jobs, orchestrator, db);
      outbox.tick();
      await outbox.idle();
      if (job === null) await Bun.sleep(10);
    }
    const item = listWorkItems(db)[0]!;
    return {
      wip,
      prompts,
      state: stateOf(db, "ENG-8"),
      checkpoint: getWorkItem(db, item.id)?.checkpoint,
      questions: tracker.questions.map((question) => question.body),
      restarts: db
        .query<{ reason: string }, [string]>(
          "SELECT reason FROM work_item_event WHERE item_id=? AND kind='restart' ORDER BY id",
        )
        .all(item.id)
        .map((row) => row.reason),
      detail: JSON.stringify({
        items: db.query("SELECT linear_identifier, state FROM work_item").all(),
        progress: tracker.progress.map((update) => `${update.kind}: ${update.body}`),
      }),
    };
  } finally {
    await orchestrator.shutdown().catch(() => undefined);
    db.close();
    await layout.cleanup();
  }
}

function createdEvent(): AcceptedLinearEvent {
  return {
    dedupeKey: "created:issue",
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: "ses_1",
    issueId: "issue",
    activityId: null,
    actorId: null,
    body: null,
    signal: null,
    updatedAtMs: Date.now(),
    payload: "{}",
  };
}
