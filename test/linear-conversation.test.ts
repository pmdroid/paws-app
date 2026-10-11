import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  applyWorkItemEvent,
  getConversation,
  saveConversation,
  getTaskMode,
  getLinearSession,
  getWorkItem,
  listPendingLinearTurns,
  migrate,
  openDatabase,
} from "../src/db";
import { worktreePath } from "../src/acp";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator, itemPathId } from "../src/loop";

const agent = new URL("./fixtures/brief-agent.ts", import.meta.url).pathname;
const policy = `specVersion: "0.1"
retry:
  maxFailedAttemptsPerItem: 3
  scope: task
items:
  - id: conversation-review
    kind: review
    gate: beforePR
    skill: .agents/skills/review/SKILL.md
    independence:
      differentSession: true
      differentModel: true
    failOn: P1
`;

function event(
  key: string,
  body: string | null,
  at = 2,
  signal: string | null = null,
): AcceptedLinearEvent {
  return {
    dedupeKey: key,
    deliveryId: null,
    source: "webhook",
    action: body === null && signal === null ? "created" : "prompted",
    sessionId: "session",
    issueId: "issue",
    activityId: body === null ? null : key,
    body,
    signal,
    updatedAtMs: at,
    payload: JSON.stringify({
      promptContext: "INITIAL_CONTEXT",
      agentSession: { id: "session", creator: { id: "human" } },
    }),
  };
}

function fixture(hang: "implement" | "review" | "classify" | null, taskModes = false) {
  const root = mkdtempSync(join(tmpdir(), "paws-conversation-"));
  const pawsRoot = join(root, "paws");
  const source = join(root, "source");
  const evidence = join(root, "prompts.jsonl");
  const dbPath = join(root, "paws.db");
  mkdirSync(source);
  mkdirSync(pawsRoot);
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();
  git("init", "-b", "main", source);
  mkdirSync(join(source, ".agents", "skills", "review"), { recursive: true });
  writeFileSync(join(source, ".agents", "closeout.yaml"), policy);
  writeFileSync(
    join(source, ".agents", "skills", "review", "SKILL.md"),
    "Review supplied instructions.",
  );
  git("-C", source, "add", ".");
  git(
    "-C",
    source,
    "-c",
    "user.name=Paws Test",
    "-c",
    "user.email=paws@example.com",
    "commit",
    "-m",
    "Seed",
  );
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-1",
      title: "Conversation",
      description: "Required output: `INITIAL`",
      subIssues: [],
    },
  ]);
  let db = openDatabase(dbPath);
  migrate(db);
  let jobs = new JobLoop(db, systemClock);
  let outbox = new OutboxDispatcher(db, systemClock);
  let didHang = false;
  const starts: string[] = [];
  const launch = (input: { purpose: string; role: string }) => {
    let behavior = "";
    if (input.purpose === hang && !didHang) {
      behavior = "hang";
      didHang = true;
    }
    if (
      input.purpose === "implement" &&
      starts.includes("implement") &&
      existsSync(evidence + ".descendant")
    )
      expect(running(Number(readFileSync(evidence + ".descendant", "utf8")))).toBe(false);
    if (taskModes && (input.purpose === "classify" || input.purpose === "answer")) {
      const path = join(root, `${starts.length}.script.json`);
      writeFileSync(
        path,
        JSON.stringify({
          steps: [
            ...(behavior ? [{ type: "hang" }] : []),
            {
              type: "update",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text:
                    input.purpose === "classify"
                      ? JSON.stringify({ mode: starts.includes("answer") ? "code" : "answer" })
                      : "Complete answer",
                },
              },
            },
            { type: "end" },
          ],
        }),
      );
      starts.push(input.purpose);
      return {
        command: process.execPath,
        args: [
          new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname,
          join(root, `${starts.length}.result.json`),
          path,
        ],
        env: process.env,
      };
    }
    starts.push(input.purpose);
    return {
      command: process.execPath,
      args: [agent, input.purpose, evidence, input.role, behavior],
      env: process.env,
    };
  };
  const options = () => ({
    db,
    jobs,
    outbox,
    tracker,
    pawsRoot,
    home: root,
    repository: { owner: "acme", repo: "widgets", remoteUrl: source },
    launch,
    linearTaskModes: taskModes,
  });
  let orchestrator = attachOrchestrator(options());
  return {
    root,
    pawsRoot,
    evidence,
    tracker,
    starts,
    get db() {
      return db;
    },
    get jobs() {
      return jobs;
    },
    get orchestrator() {
      return orchestrator;
    },
    item() {
      return getWorkItem(db, getLinearSession(db, "session")!.activeItemId!)!;
    },
    prompts() {
      return existsSync(evidence)
        ? readFileSync(evidence, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { purpose: string; prompt: string })
        : [];
    },
    reopen() {
      db.close();
      db = openDatabase(dbPath);
      migrate(db);
      jobs = new JobLoop(db, systemClock);
      outbox = new OutboxDispatcher(db, systemClock);
      orchestrator = attachOrchestrator(options());
    },
    async close() {
      await orchestrator.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function running(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error("Fixture condition did not arrive");
}

for (const phase of ["implement", "review"] as const) {
  test(`ordinary update interrupts ${phase}, joins cleanup and resumes full context after restart`, async () => {
    const f = fixture(phase);
    try {
      await f.orchestrator.onLinearEvent(event("created", null, 1));
      const first = f.jobs.tick();
      await until(() => f.prompts().some((row) => row.purpose === phase));
      if (phase === "implement") await until(() => existsSync(f.evidence + ".descendant"));
      const updates = Promise.all([
        f.orchestrator.onLinearEvent(event("update-one", "FIRST_UPDATE", 2)),
        f.orchestrator.onLinearEvent(event("update-two", "SECOND_UPDATE", 3)),
      ]);
      await Promise.all([first, updates]);
      const original = f.item();
      expect(original.state).toBe("queued");
      expect(listPendingLinearTurns(f.db, "session").map((turn) => turn.body)).toEqual([
        "FIRST_UPDATE",
        "SECOND_UPDATE",
      ]);
      if (phase === "implement")
        expect(running(Number(readFileSync(f.evidence + ".descendant", "utf8")))).toBe(false);
      expect(getConversation(f.db, original.id).entries).not.toContain("PRIVATE_HIDDEN");
      f.reopen();
      await f.jobs.tick();
      expect(f.item().id).toBe(original.id);
      expect(f.item().state).toBe("merge_queue");
      const prompt = f
        .prompts()
        .filter((row) => row.purpose === "implement")
        .at(-1)!.prompt;
      expect(prompt).toContain("INITIAL_CONTEXT");
      expect(prompt).toContain("FIRST_UPDATE");
      expect(prompt).toContain("SECOND_UPDATE");
      expect(prompt).not.toContain("PRIVATE_HIDDEN");
      if (phase === "implement") {
        expect(prompt).toContain("PUBLIC_OBSERVATION");
        expect(prompt).toContain("PUBLIC_TOOL_RESULT");
        expect(
          existsSync(join(worktreePath(f.pawsRoot, itemPathId(original)), "old-writes.txt")),
        ).toBe(true);
      }
      expect(listPendingLinearTurns(f.db, "session")).toEqual([]);
      const count = f.starts.length;
      await f.orchestrator.onLinearEvent(event("update-two", "SECOND_UPDATE", 3));
      expect(f.starts.length).toBe(count);
      expect(f.item().state).toBe("merge_queue");
    } finally {
      await f.close();
    }
  }, 15000);
}

test("new prompt after completion creates a new task and preserves the terminal task and source issue", async () => {
  const f = fixture(null);
  try {
    await f.orchestrator.onLinearEvent(event("created", null, 1));
    await f.jobs.tick();
    const original = f.item();
    applyWorkItemEvent(f.db, original.id, "merge_accepted");
    await f.orchestrator.onLinearEvent(event("later", "ANOTHER_REQUEST", 4));
    const next = f.item();
    expect(next.id).not.toBe(original.id);
    expect(next.linearIssueId).toBe(original.linearIssueId);
    expect(itemPathId(next)).not.toBe(itemPathId(original));
    expect(getWorkItem(f.db, original.id)?.state).toBe("merged");
    for (let attempt = 0; attempt < 3 && f.item().state === "queued"; attempt++)
      await f.jobs.tick();
    expect(f.item().state).toBe("merge_queue");
    expect(
      f
        .prompts()
        .filter((row) => row.purpose === "implement")
        .at(-1)!.prompt,
    ).toContain("ANOTHER_REQUEST");
  } finally {
    await f.close();
  }
}, 15000);

test("shutdown joins active writers before the database can close", async () => {
  const f = fixture("implement");
  try {
    await f.orchestrator.onLinearEvent(event("created", null, 1));
    const tick = f.jobs.tick();
    await until(() => existsSync(f.evidence + ".descendant"));
    await f.orchestrator.shutdown();
    await tick;
    expect(running(Number(readFileSync(f.evidence + ".descendant", "utf8")))).toBe(false);
    expect(f.item().state).toBe("running");
    expect(f.db.query("SELECT 1").get()).toBeDefined();
  } finally {
    await f.close();
  }
}, 15000);

test("prompt before creation recovers the authoritative issue and reuses its task after replay", async () => {
  const f = fixture(null);
  try {
    f.orchestrator.setTracker({
      ...f.tracker,
      async getSession() {
        return {
          id: "session",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          endedAt: null,
          dismissedAt: null,
          appUserId: "agent",
          creatorId: "human",
          issue: { id: "issue", identifier: "ENG-1", title: "Conversation", description: null },
          comment: null,
          sourceComment: null,
          summary: null,
          plan: null,
          context: null,
          externalLinks: [],
          pullRequest: null,
        };
      },
    });
    await f.orchestrator.onLinearEvent({ ...event("early", "EARLY_REQUEST", 2), issueId: null });
    const original = f.item();
    await f.orchestrator.onLinearEvent(event("created", null, 1));
    expect(f.item().id).toBe(original.id);
    f.reopen();
    for (let attempt = 0; attempt < 3 && f.item().state === "queued"; attempt++)
      await f.jobs.tick();
    expect(f.item().state).toBe("merge_queue");
    expect(f.prompts().find((row) => row.purpose === "implement")?.prompt).toContain(
      "EARLY_REQUEST",
    );
    expect(listPendingLinearTurns(f.db, "session")).toEqual([]);
  } finally {
    await f.close();
  }
}, 15000);

test("unresolved early prompt remains durable until creation supplies its issue", async () => {
  const f = fixture(null);
  try {
    await expect(
      f.orchestrator.onLinearEvent({ ...event("early", "PENDING_REQUEST", 2), issueId: null }),
    ).rejects.toThrow("user update remains pending");
    expect(listPendingLinearTurns(f.db, "session").map((turn) => turn.body)).toEqual([
      "PENDING_REQUEST",
    ]);
    f.reopen();
    await f.orchestrator.onLinearEvent(event("created", null, 1));
    await f.jobs.tick();
    expect(f.item().state).toBe("merge_queue");
    expect(f.prompts().find((row) => row.purpose === "implement")?.prompt).toContain(
      "PENDING_REQUEST",
    );
    expect(listPendingLinearTurns(f.db, "session")).toEqual([]);
  } finally {
    await f.close();
  }
}, 15000);

test("a prompt interrupts intake classification and is routed once after the old owner exits", async () => {
  const f = fixture("classify", true);
  try {
    const initial = f.orchestrator.onLinearEvent(event("created", null, 1));
    await until(() => f.starts.includes("classify"));
    const rejected = initial.then(
      () => null,
      (error: unknown) => error,
    );
    await f.orchestrator.onLinearEvent(event("early-update", "Explain the updated request", 2));
    expect(await rejected).toBeNull();
    expect(f.starts).toEqual(["classify", "classify"]);
    expect(getTaskMode(f.db, f.item().id)).toBe("answer");
    expect(f.db.query("SELECT id FROM work_item").all()).toHaveLength(1);
    expect(listPendingLinearTurns(f.db, "session").map((turn) => turn.body)).toEqual([
      "Explain the updated request",
    ]);
  } finally {
    await f.close();
  }
}, 15000);

test("shutdown retains a queued start without allowing a new writer", async () => {
  const f = fixture(null);
  try {
    await f.orchestrator.onLinearEvent(event("created", null, 1));
    await f.orchestrator.shutdown();
    await f.jobs.tick();
    expect(f.starts).toEqual([]);
    expect(f.item().state).toBe("queued");
    expect(
      f.db
        .query<{ status: string }, []>("SELECT status FROM job WHERE job_key LIKE 'start:%'")
        .get()?.status,
    ).toBe("pending");
  } finally {
    await f.close();
  }
});

test("administrative interruption joins a zero-item classifier without a Linear Stop response", async () => {
  const f = fixture("classify", true);
  try {
    const original = f.orchestrator
      .onLinearEvent(event("created", null, 1))
      .catch((error: unknown) => error);
    await until(() => f.starts.includes("classify"));
    const session = getLinearSession(f.db, "session");
    await f.orchestrator.interruptLinearSession("session");
    expect(await original).toMatchObject({ name: "AbortError" });
    expect(f.db.query("SELECT id FROM work_item").all()).toEqual([]);
    expect(getLinearSession(f.db, "session")).toEqual(session);
    expect(f.tracker.progress.filter((row) => row.kind === "response")).toEqual([]);
    expect(f.db.query("SELECT * FROM linear_stop_receipt").all()).toEqual([]);
  } finally {
    await f.close();
  }
}, 15000);

test.each(["shutdown", "interrupt"] as const)(
  "durable failed cleanup fences %s after the live owner is gone and SQLite reopens",
  async (operation) => {
    const f = fixture(null);
    try {
      await f.orchestrator.onLinearEvent(event("created", null, 1));
      saveConversation(f.db, f.item().id, "[]", null, true);
      f.reopen();
      const stopping =
        operation === "shutdown"
          ? f.orchestrator.shutdown()
          : f.orchestrator.interruptLinearSession("session");
      await expect(stopping).rejects.toThrow("ACP process cleanup could not be verified");
      expect(f.db.query("SELECT 1 AS open").get()).toEqual({ open: 1 });
      expect(getConversation(f.db, f.item().id).blocked).toBe(true);
    } finally {
      f.db.run("DELETE FROM linear_conversation");
      await f.close();
    }
  },
);
