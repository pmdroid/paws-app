import { tickWithRestarts } from "./helpers";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { worktreePath } from "../src/acp";
import { JobLoop, OutboxDispatcher, getWorkItem, migrate, openDatabase } from "../src/db";
import { systemClock } from "../src/core";
import {
  createFakeTracker,
  createLinearTracker,
  type EpicSnapshot,
  type LinearClient,
} from "../src/linear";
import { attachOrchestrator, itemPathId } from "../src/loop";
import { workspaceAdmission } from "./fake-workspace";

const agent = new URL("./fixtures/brief-agent.ts", import.meta.url).pathname;
const childDescription =
  "Keep this entire description.\n\n## Acceptance criteria\nRequired output: `BODY_ONLY_37_雪`\n- Preserve unicode and trailing context.\n\nEnd of child description.";
const parentDescription =
  "Epic context: export must preserve user data.\n\n## Acceptance criteria\nKeep every row.";
const policy = `specVersion: "0.1"
retry:
  maxFailedAttemptsPerItem: 3
  scope: task
items:
  - id: brief-review
    kind: review
    gate: beforePR
    skill: .agents/skills/review/SKILL.md
    independence:
      differentSession: true
      differentModel: true
    failOn: P1
`;

test("linear intake delivers a persisted body-only requirement to real implementation, fix and review prompts", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-brief-"));
  const seed = join(root, "seed");
  const bare = join(root, "origin.git");
  const pawsRoot = join(root, "paws");
  const evidence = join(root, "prompts.jsonl");
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();
  mkdirSync(pawsRoot);
  git("init", "--bare", "-b", "main", bare);
  git("clone", bare, seed);
  git("-C", seed, "config", "user.name", "Paws Test");
  git("-C", seed, "config", "user.email", "paws@example.com");
  git("-C", seed, "config", "commit.gpgsign", "false");
  mkdirSync(join(seed, ".agents", "skills", "review"), { recursive: true });
  writeFileSync(join(seed, ".agents", "closeout.yaml"), policy);
  writeFileSync(
    join(seed, ".agents", "skills", "review", "SKILL.md"),
    "Review the change against the supplied task brief.",
  );
  git("-C", seed, "add", ".");
  git("-C", seed, "commit", "-m", "Seed policy");
  git("-C", seed, "push", "origin", "main");
  const snapshot = await linearSnapshot();
  const tracker = createFakeTracker([snapshot]);
  tracker.listSessionActivities = async () => [
    {
      id: "immutable-request",
      sessionId: "brief-session",
      createdAt: "2026-10-11T00:00:00Z",
      updatedAt: "2026-10-11T00:00:00Z",
      userId: "human",
      content: { type: "prompt", body: "Immutable user followup" },
      signal: null,
      signalMetadata: null,
      sourceCommentId: "mention",
      ephemeral: false,
    },
  ];
  tracker.getSession = async () => ({
    id: "brief-session",
    status: "active",
    createdAt: "2026-10-11T00:00:00Z",
    updatedAt: "2026-10-11T00:00:00Z",
    endedAt: null,
    dismissedAt: null,
    appUserId: "app",
    creatorId: "human",
    issue: {
      id: "parent",
      identifier: "ENG-1",
      title: "Export epic",
      description: "API issue snapshot",
    },
    comment: null,
    sourceComment: {
      id: "source",
      body: "API source thread request",
      createdAt: "2026-10-11T00:00:00Z",
    },
    summary: null,
    plan: null,
    context: null,
    externalLinks: [],
    pullRequest: null,
  });
  const dbPath = join(root, "paws.db");
  let db = openDatabase(dbPath);
  migrate(db);
  const launch = (input: { purpose: string; role: string }) => ({
    command: process.execPath,
    args: [agent, input.purpose, evidence, input.role],
    env: process.env,
  });
  const repository = { owner: "acme", repo: "widgets", remoteUrl: bare };
  let jobs = new JobLoop(db, systemClock);
  let outbox = new OutboxDispatcher(db, systemClock);
  let orchestrator = attachOrchestrator({
    db,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    tracker,
    repository,
    pawsRoot,
    home: process.env.HOME,
    launch,
  });
  try {
    await orchestrator.onLinearEvent({
      dedupeKey: "brief-created",
      deliveryId: null,
      source: "poll",
      action: "created",
      sessionId: "brief-session",
      issueId: snapshot.linearIssueId,
      activityId: null,
      body: null,
      signal: null,
      updatedAtMs: 1,
      payload: JSON.stringify({
        promptContext: "Initial mention request",
        agentSession: { comment: { id: "mention", body: "Comment instruction" } },
        previousComments: [{ body: "Earlier discussion" }],
        guidance: [{ body: "Team instruction", origin: { type: "team", id: "team" } }],
      }),
    });
    const itemId = db.query<{ id: string }, []>("SELECT id FROM work_item").get()?.id;
    expect(itemId).toBeDefined();
    db.close();
    tracker.epics.clear();
    db = openDatabase(dbPath);
    migrate(db);
    jobs = new JobLoop(db, systemClock);
    outbox = new OutboxDispatcher(db, systemClock);
    orchestrator = attachOrchestrator({
      db,
      admission: workspaceAdmission(db),
      jobs,
      outbox,
      tracker,
      repository,
      pawsRoot,
      home: process.env.HOME,
      launch,
    });
    await tickWithRestarts(jobs, orchestrator, db);
    const item = getWorkItem(db, itemId!);
    const prompts = readFileSync(evidence, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { purpose: string; prompt: string });
    if (process.env.PAWS_BRIEF_EVIDENCE)
      appendFileSync(
        process.env.PAWS_BRIEF_EVIDENCE,
        `${JSON.stringify({ source: "linear", state: item?.state, prompts })}\n`,
      );
    for (const { prompt } of prompts.filter((entry) => entry.purpose !== "review")) {
      for (const requirement of [
        "Initial mention request",
        "Comment instruction",
        "Earlier discussion",
        "Team instruction",
        "Immutable user followup",
        "API source thread request",
        "API issue snapshot",
      ])
        expect(prompt).toContain(requirement);
      expect(prompt).toContain(childDescription);
      expect(prompt).toContain(parentDescription);
      expect(prompt).toContain(snapshot.linearIssueId);
      expect(prompt).toContain(snapshot.subIssues[0]!.linearIssueId);
    }
    for (const { prompt } of prompts.filter((entry) => entry.purpose === "review")) {
      for (const requirement of [
        "Initial mention request",
        "Comment instruction",
        "Earlier discussion",
        "Team instruction",
        "Immutable user followup",
        "API source thread request",
        "API issue snapshot",
      ])
        expect(prompt).toContain(requirement);
      expect(prompt).toContain(childDescription);
      expect(prompt).toContain(parentDescription);
      expect(prompt).toContain(snapshot.linearIssueId);
      expect(prompt).toContain(snapshot.subIssues[0]!.linearIssueId);
    }
    expect(item?.state, JSON.stringify(prompts)).toBe("merge_queue");
    expect(prompts.map((entry) => entry.purpose)).toEqual(["implement", "review", "fix", "review"]);
    const pathId = itemPathId(item!);
    expect(readFileSync(join(worktreePath(pawsRoot, pathId), "result.txt"), "utf8")).toBe(
      "BODY_ONLY_37_雪-fixed",
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

async function linearSnapshot(): Promise<EpicSnapshot> {
  const client: LinearClient = {
    async query() {
      return {
        issue: {
          id: "parent",
          identifier: "ENG-1",
          title: "Export epic",
          description: parentDescription,
          children: {
            nodes: [
              {
                id: "child",
                identifier: "ENG-2",
                title: "Export child",
                description: childDescription,
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    },
  };
  return createLinearTracker(client).loadEpic("parent");
}
