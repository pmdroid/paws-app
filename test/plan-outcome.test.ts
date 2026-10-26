import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { git } from "../src/acp";
import { systemClock, type SubIssueDraft } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  getPlanProposal,
  getTaskMode,
  getWorkItem,
  listOutbox,
  migrate,
  openDatabase,
} from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator, parsePlanResult, planDecision, type AgentLaunch } from "../src/loop";
import { findOpenQuestion } from "../src/questions";
import { workspaceAdmission } from "./fake-workspace";
import { tempHome } from "./helpers";

const drafts: SubIssueDraft[] = [
  {
    title: "Add the plan task mode",
    description: "The classifier returns plan for requests to split work.",
    acceptanceCriteria: ["Closeout test passes with classifier fixtures"],
    blockedBy: [],
  },
  {
    title: "File approved sub-issues",
    description: "createSubIssues files drafts under the parent.",
    acceptanceCriteria: ["Closeout test passes", "Screenshot of the filed sub-issues in Linear"],
    blockedBy: [0],
  },
  {
    title: "Record the smoke run",
    description: "",
    acceptanceCriteria: ["docs/smoke-test.md lists the plan outcome"],
    blockedBy: [0, 1],
  },
];

const planMessage = (subIssues: readonly SubIssueDraft[]) =>
  `Three steps, each one pull request.\n\n\`\`\`json\n${JSON.stringify({ subIssues })}\n\`\`\``;

test("a plan turn's message yields its summary and validated drafts", () => {
  expect(parsePlanResult(planMessage(drafts))).toEqual({
    summary: "Three steps, each one pull request.",
    drafts,
  });
  expect(() => parsePlanResult("No plan here.")).toThrow("JSON block");
  expect(() => parsePlanResult(planMessage([{ ...drafts[0]!, blockedBy: [0] }]))).toThrow(
    "earlier sub-issues",
  );
  expect(() => parsePlanResult(planMessage([{ ...drafts[0]!, acceptanceCriteria: [] }]))).toThrow(
    "acceptance criteria",
  );
  expect(
    ["Create 3 sub-issues", "Discard", "Edit", "edit.", "Split the second one"].map(planDecision),
  ).toEqual(["create", "discard", "edit-ask", "edit-ask", "edit"]);
});

async function setupPlan() {
  const home = tempHome();
  const root = join(home, "paws");
  const source = join(home, "source");
  mkdirSync(root);
  await git(["init", "-b", "main", source]);
  writeFileSync(join(source, "app.txt"), "Application source");
  await git(["-C", source, "add", "."]);
  await git([
    "-C",
    source,
    "-c",
    "user.name=Paws Test",
    "-c",
    "user.email=paws@example.com",
    "commit",
    "-m",
    "Seed",
  ]);
  const db = openDatabase(join(root, "paws.db"));
  migrate(db);
  const tracker = createFakeTracker([
    {
      linearIssueId: "parent",
      identifier: "ENG-1",
      title: "Plan the plan outcome",
      description: "Split this into sub-issues.",
      subIssues: [],
    },
  ]);
  const repository = { owner: "acme", repo: "app", remoteUrl: source };
  const purposes: string[] = [];
  const prompts: string[] = [];
  const launch: AgentLaunch = (input) => {
    purposes.push(input.purpose);
    prompts.push(input.prompt);
    const plans = purposes.filter((purpose) => purpose === "plan").length;
    const script = join(home, `${purposes.length}.script.json`);
    const trace = join(home, `${purposes.length}.trace.json`);
    writeFileSync(
      script,
      JSON.stringify({
        steps: [
          ...(input.purpose === "plan"
            ? [
                { type: "fs_read", path: "repository/app.txt" },
                { type: "fs_write", path: "repository/app.txt", content: "Changed by a plan" },
              ]
            : []),
          {
            type: "update",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text:
                  input.purpose === "classify"
                    ? JSON.stringify({ mode: "plan" })
                    : planMessage(plans === 1 ? drafts : drafts.slice(0, 2)),
              },
            },
          },
          { type: "end" },
        ],
      }),
    );
    return {
      command: process.execPath,
      args: [resolve(import.meta.dir, "../src/acp/testing/fake-agent.ts"), trace, script],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
    };
  };
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const orchestrator = attachOrchestrator({
    db,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    home,
    pawsRoot: root,
    tracker,
    secretsDir: join(root, "secrets"),
    linearTaskModes: true,
    repositories: [repository],
    repositoryAccess: async (_selected, _signal, access) => {
      expect(access).toBe("read");
      return true;
    },
    launch,
  });
  const created: AcceptedLinearEvent = {
    dedupeKey: "created",
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: "session",
    issueId: "parent",
    activityId: null,
    actorId: "human",
    body: null,
    signal: null,
    updatedAtMs: 1,
    payload: JSON.stringify({ agentSession: { creatorId: "human" } }),
  };
  let at = Date.now();
  const reply = (key: string, body: string) => {
    at = Math.max(at + 1, (findOpenQuestion(db, "session")?.createdAt ?? 0) + 1);
    return orchestrator.onLinearEvent({
      ...created,
      dedupeKey: key,
      action: "prompted",
      activityId: key,
      body,
      payload: JSON.stringify({ agentActivity: { userId: "human" } }),
      updatedAtMs: at,
      activityCreatedAtMs: at,
    });
  };
  return {
    db,
    home,
    source,
    tracker,
    purposes,
    prompts,
    jobs,
    outbox,
    orchestrator,
    created,
    reply,
  };
}

test("a planning request proposes sub-issues, takes an edit, and files them once on Create", async () => {
  const {
    db,
    home,
    source,
    tracker,
    purposes,
    prompts,
    jobs,
    outbox,
    orchestrator,
    created,
    reply,
  } = await setupPlan();
  try {
    await orchestrator.onLinearEvent(created);
    const itemId = db.query<{ id: string }, []>("SELECT id FROM work_item").get()!.id;
    await jobs.tick();
    expect(getTaskMode(db, itemId)).toBe("plan");

    // The proposal arrives as one select elicitation, and the run wrote nothing.
    expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
    const first = findOpenQuestion(db, "session")!;
    expect(first).toMatchObject({
      kind: "plan-approval",
      options: ["Create 3 sub-issues", "Edit", "Discard"],
    });
    expect(first.body).toContain("**2. File approved sub-issues**");
    expect(first.body).toContain("Blocked by 1.");
    expect(first.body).toContain("- [ ] Screenshot of the filed sub-issues in Linear");
    expect(getPlanProposal(db, first.id)?.drafts).toEqual(drafts);
    expect(prompts.at(-1)).toContain("read-only");
    expect(prompts.at(-1)).toContain(".agents/closeout.yaml");
    const trace = JSON.parse(readFileSync(join(home, `${purposes.length}.trace.json`), "utf8"));
    expect(trace.fs[0]).toMatchObject({ op: "read", ok: true });
    expect(trace.fs[1]).toMatchObject({ op: "write", ok: false });
    expect(readFileSync(join(source, "app.txt"), "utf8")).toBe("Application source");
    expect(tracker.progress.filter((update) => update.kind === "response")).toEqual([]);

    // A bare Edit asks what to change; the reply is the next planning turn.
    await reply("edit", "Edit");
    const edit = findOpenQuestion(db, "session")!;
    expect(edit.kind).toBe("plan-approval");
    expect(edit.body).toContain("What should change");
    expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
    await reply("change", "Drop the smoke-run sub-issue.");
    expect(getWorkItem(db, itemId)?.state).toBe("queued");
    await jobs.tick();
    expect(purposes).toEqual(["classify", "plan", "plan"]);
    expect(prompts.at(-1)).toContain("Requested change: Drop the smoke-run sub-issue.");
    const second = findOpenQuestion(db, "session")!;
    expect(second.options).toEqual(["Create 2 sub-issues", "Edit", "Discard"]);
    expect(tracker.subIssueRequests).toEqual([]);

    // Create files both under the parent in blocks order, with the repository label.
    await reply("create", "Create 2 sub-issues");
    expect(getWorkItem(db, itemId)?.state).toBe("completed");
    await outbox.idle();
    await outbox.idle();
    expect(tracker.subIssueRequests).toHaveLength(1);
    expect(tracker.subIssueRequests[0]).toMatchObject({
      key: second.id,
      parentIssueId: "parent",
      repository: "acme/app",
      drafts: drafts.slice(0, 2),
    });
    const filed = tracker.subIssues.get("parent")!;
    expect(filed.map((issue) => issue.identifier)).toEqual(["ENG-1-1", "ENG-1-2"]);
    expect(filed[1]!.blockedBy).toEqual([filed[0]!.id]);
    expect(tracker.repositoryLabels.map((label) => label.issueId)).toEqual(
      filed.map((issue) => issue.id),
    );
    expect(tracker.statuses).toEqual([]);
    const responses = () =>
      tracker.progress.filter((update) => update.kind === "response").map((update) => update.body);
    expect(responses()).toHaveLength(1);
    expect(responses()[0]).toContain("Created 2 sub-issues under ENG-1");
    expect(responses()[0]).toContain("[ENG-1-2](<https://linear.app/fake/issue/ENG-1-2>)");

    // A redelivered answer and a retried filing row file nothing twice.
    await reply("create", "Create 2 sub-issues");
    db.run("UPDATE outbox SET status='pending', attempts=0 WHERE op='linear.sub_issues'");
    await outbox.idle();
    expect(tracker.subIssueRequests).toHaveLength(1);
    expect(tracker.subIssues.get("parent")).toHaveLength(2);
    expect(responses()).toHaveLength(1);
    expect(
      listOutbox(db).filter((row) => row.idempotencyKey.startsWith("plan-create:")),
    ).toHaveLength(1);
  } finally {
    await orchestrator.shutdown();
    await outbox.idle();
    db.close();
  }
}, 30_000);

test("Discard completes the plan with one response and files nothing", async () => {
  const { db, tracker, jobs, outbox, orchestrator, created, reply } = await setupPlan();
  try {
    await orchestrator.onLinearEvent(created);
    const itemId = db.query<{ id: string }, []>("SELECT id FROM work_item").get()!.id;
    await jobs.tick();
    expect(findOpenQuestion(db, "session")?.kind).toBe("plan-approval");
    await reply("discard", "Discard");
    await outbox.idle();
    expect(getWorkItem(db, itemId)?.state).toBe("completed");
    expect(tracker.subIssueRequests).toEqual([]);
    expect(
      tracker.progress.filter((update) => update.kind === "response").map((update) => update.body),
    ).toEqual(["Discarded the proposal. Nothing was filed."]);
  } finally {
    await orchestrator.shutdown();
    await outbox.idle();
    db.close();
  }
}, 30_000);
