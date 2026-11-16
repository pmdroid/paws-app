import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { candidateRef, mirrorPath, runAgent, type RunAgentOptions } from "../src/acp";
import { SavedWorkRewritten, systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher, getWorkItem, saveCheckpoint } from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { restartCandidateFrom } from "../src/runner-backend";
import { emptyReview, repoLayout, stateOfPg, tickWithRestartsPg, writeOk } from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";
import { tempStore } from "./pglite";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const tip = "b".repeat(40);
const issue = { linearIssueId: "issue", identifier: "ENG-7", title: "Ok", description: null };

for (const [answer, restartFrom] of [
  [`Continue from ${tip.slice(0, 7)}`, { tip }],
  ["Start over from main", "main"],
] as const)
  test(`a rewritten work branch asks instead of failing, and ${answer} restarts from it`, async () => {
    const layout = await repoLayout("paws-rewritten-");
    const { db, close } = await tempStore();
    const tracker = createFakeTracker([{ ...issue, subIssues: [] }]);
    const jobs = new JobLoop(db, systemClock);
    const outbox = new OutboxDispatcher(db, systemClock);
    let restarted: unknown;
    let sequence = 0;
    const orchestrator = attachOrchestrator({
      store: db,
      admission: workspaceAdmission(db),
      jobs,
      outbox,
      tracker,
      pawsRoot: layout.pawsRoot,
      home: layout.home,
      repositories: [{ owner: "acme", repo: "widgets", remoteUrl: layout.bare }],
      retryBaseMs: 10,
      remoteExecution: {
        agentForSession() {
          throw new Error("This fixture does not request a routing helper");
        },
        agentForItem: (itemId) => async (options: RunAgentOptions) => {
          if (options.prepareOnly) return runAgent(options);
          const checkpoint = (await getWorkItem(db, itemId))?.checkpoint;
          if (checkpoint?.restartFrom) {
            restarted = checkpoint.restartFrom;
            return new Promise<never>((_resolve, reject) =>
              options.signal?.addEventListener("abort", () => reject(new Error("stopped"))),
            );
          }
          await saveCheckpoint(db, itemId, { phase: "running", wipCommit: "a".repeat(40) });
          throw new Error("restore", {
            cause: new SavedWorkRewritten("paws/eng-7", "a".repeat(40), tip),
          });
        },
      },
      launch(input) {
        const script = path.join(layout.root, `rewritten-${++sequence}.json`);
        const steps =
          input.purpose === "review"
            ? emptyReview().steps
            : [writeOk(input.worktree), { type: "end", stopReason: "end_turn" }];
        const model = `test-${input.role === "reviewer" ? "codex" : "claude"}-model`;
        writeFileSync(script, JSON.stringify({ model, steps }));
        return { command: process.execPath, args: [fakeAgent, "", script], env: process.env };
      },
    });
    let ticking: Promise<unknown> | null = null;
    const until = async (done: () => Promise<boolean>) => {
      for (let deadline = Date.now() + 60_000; Date.now() < deadline && !(await done());) {
        ticking ??= tickWithRestartsPg(jobs, orchestrator, db).finally(() => (ticking = null));
        await Promise.race([ticking, Bun.sleep(100)]);
        await outbox.tick();
      }
    };
    try {
      await orchestrator.onLinearEvent(event("created", null));
      await until(async () => tracker.questions.length > 0);
      expect(await stateOfPg(db, "ENG-7")).toBe("awaiting_input");
      expect(tracker.questions[0]!.body).toStartWith("The saved work branch was rewritten.");
      expect(tracker.questions[0]!.options).toEqual([
        `Continue from ${tip.slice(0, 7)}`,
        "Start over from main",
      ]);
      await orchestrator.onLinearEvent(event("prompted", answer));
      await until(async () => restarted !== undefined);
      expect(restarted).toEqual(restartFrom);
    } finally {
      await orchestrator.shutdown().catch(() => undefined);
      await close();
      await layout.cleanup();
    }
  }, 90_000);

test("each answer restores the matching tree", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "paws-rewritten-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=F", "-c", "user.email=f@example.invalid", ...args], {
      env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" },
    })
      .toString()
      .trim();
  const commit = (work: string, file: string) => {
    writeFileSync(path.join(work, file), file);
    git("-C", work, "add", ".");
    git("-C", work, "commit", "-q", "-m", file);
    return git("-C", work, "rev-parse", "HEAD");
  };
  try {
    const work = path.join(root, "work");
    const github = path.join(root, "github.git");
    git("init", "-q", "-b", "main", work);
    const main = commit(work, "a.txt");
    const rewritten = commit(work, "c.txt");
    git("clone", "-q", "--bare", work, github);
    git("--git-dir", github, "update-ref", "refs/heads/paws/eng-7", rewritten);
    const mirror = mirrorPath(root, "acme", "widgets");
    git("clone", "-q", "--bare", work, mirror);
    git("--git-dir", mirror, "update-ref", "refs/paws/upstream-main", main);
    const ref = candidateRef("display-item");
    const input = {
      ...{ mirror, ref, branch: "paws/eng-7", remoteUrl: github },
      networkGit: async (args: string[]) => git(...args),
      signal: new AbortController().signal,
    };
    git("--git-dir", mirror, "update-ref", ref, main);
    const restart = (from: { tip: string } | "main") =>
      restartCandidateFrom({ ...input, from, base: main });
    expect(await restart({ tip: rewritten })).toEqual({ start: rewritten, base: main });
    expect(git("--git-dir", mirror, "ls-tree", "--name-only", ref)).toBe("a.txt\nc.txt");
    await expect(restart({ tip: main })).rejects.toThrow(
      "Fetched runner candidate does not match.",
    );
    expect(await restart("main")).toEqual({ start: main, base: main });
    expect(git("--git-dir", mirror, "ls-tree", "--name-only", ref)).toBe("a.txt");
    expect(git("--git-dir", github, "rev-parse", "refs/heads/paws/eng-7")).toBe(main);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function event(action: "created" | "prompted", body: string | null): AcceptedLinearEvent {
  return {
    ...{ dedupeKey: `${action}:issue`, deliveryId: null, source: "webhook", action },
    ...{ sessionId: "ses_1", issueId: "issue", signal: null, body, payload: "{}" },
    activityId: action === "prompted" ? "answer" : null,
    actorId: action === "prompted" ? "human" : null,
    updatedAtMs: Date.now(),
  };
}
