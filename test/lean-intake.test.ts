import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher, getLinearSession, getTaskMode, getWorkItem } from "../src/db";
import {
  acknowledgeNewSession,
  createFakeTracker,
  type AcceptedLinearEvent,
  type EpicSnapshot,
  type TrackerAdapter,
} from "../src/linear";
import { attachOrchestrator, type AgentLaunch } from "../src/loop";
import { tempDb, tempHome } from "./helpers";

const created: AcceptedLinearEvent = {
  dedupeKey: "session:session:created",
  deliveryId: null,
  source: "webhook",
  action: "created",
  sessionId: "session",
  issueId: "solo",
  activityId: null,
  actorId: "human",
  body: null,
  signal: null,
  updatedAtMs: Date.now(),
  payload: JSON.stringify({
    agentSession: { creatorId: "human" },
    promptContext: "Explain how this works without changing any files.",
  }),
};

function setup(epic: EpicSnapshot) {
  const db = tempDb();
  const home = tempHome();
  const root = join(home, "paws");
  mkdirSync(root);
  const launches: string[] = [];
  const calls: string[] = [];
  const launch: AgentLaunch = (input) => {
    launches.push(`${input.purpose}@${calls.length}`);
    const script = join(home, `${launches.length}.script.json`);
    const text = input.purpose === "classify" ? JSON.stringify({ mode: "answer" }) : "Answer.";
    writeFileSync(
      script,
      JSON.stringify({
        steps: [
          {
            type: "update",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          },
          { type: "end" },
        ],
      }),
    );
    return {
      command: process.execPath,
      args: [
        resolve(import.meta.dir, "../src/acp/testing/fake-agent.ts"),
        join(home, `${launches.length}.result.json`),
        script,
      ],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
    };
  };
  const fake: TrackerAdapter = {
    ...createFakeTracker([epic]),
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
        issue: {
          id: epic.linearIssueId,
          identifier: epic.identifier,
          title: epic.title,
          description: null,
        },
        comment: null,
        sourceComment: null,
        summary: null,
        plan: null,
        context: null,
        externalLinks: [],
        pullRequest: null,
      };
    },
    async listSessionActivities() {
      return [];
    },
  };
  const tracker = new Proxy(fake, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(key));
        return value.apply(target, args);
      };
    },
  });
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    pawsRoot: root,
    home,
    tracker,
    launch,
    linearTaskModes: true,
    secretsDir: join(root, "secrets"),
  });
  const intakeCalls: string[] = [];
  const intake = () =>
    acknowledgeNewSession(tracker, created, async (event) => {
      const acknowledged = calls.length;
      await orchestrator.onLinearEvent(event);
      intakeCalls.push(...calls.slice(acknowledged));
    });
  return { db, jobs, orchestrator, calls, intakeCalls, launches, intake };
}

const solo: EpicSnapshot = {
  linearIssueId: "solo",
  identifier: "ENG-1",
  title: "Explain the architecture",
  description: "Existing issue",
  subIssues: [],
};

test("intake of a lone issue reads the issue and its relations after the first activity, posts nothing more and classifies nothing", async () => {
  const f = setup(solo);
  try {
    await f.intake();
    expect(f.calls[0]).toBe("postProgress");
    expect(f.intakeCalls).toEqual(["loadEpic", "listDeps"]);
    expect(f.launches).toEqual([]);
    expect(getWorkItem(f.db, getLinearSession(f.db, "session")!.activeItemId!)?.state).toBe(
      "queued",
    );
  } finally {
    f.db.close();
  }
});

test("a lone issue hydrates its session context and classifies at start", async () => {
  const f = setup(solo);
  try {
    await f.intake();
    const intakeCalls = f.calls.length;
    await f.jobs.tick();
    const started = f.calls.slice(intakeCalls);
    expect(started).not.toContain("loadEpic");
    expect(started).toContain("getSession");
    expect(started).toContain("listSessionActivities");
    const hydrated = intakeCalls + started.indexOf("listSessionActivities") + 1;
    const [classify, answer] = f.launches.map((launch) => launch.split("@"));
    expect(classify?.[0]).toBe("classify");
    expect(Number(classify?.[1])).toBeGreaterThanOrEqual(hydrated);
    expect(answer?.[0]).toBe("answer");
    const item = getWorkItem(f.db, getLinearSession(f.db, "session")!.activeItemId!)!;
    expect(getTaskMode(f.db, item.id)).toBe("answer");
    expect(item.state).toBe("completed");
  } finally {
    f.db.close();
  }
});

test("a parent with open sub-issues still classifies at intake", async () => {
  const f = setup({
    ...solo,
    subIssues: [{ linearIssueId: "child", identifier: "ENG-2", title: "Implement a feature" }],
  });
  try {
    await f.intake();
    expect(f.launches.map((launch) => launch.split("@")[0])).toEqual(["classify"]);
    const item = getWorkItem(f.db, getLinearSession(f.db, "session")!.activeItemId!)!;
    expect(item.linearIssueId).toBe("solo");
    expect(getTaskMode(f.db, item.id)).toBe("answer");
  } finally {
    f.db.close();
  }
});
