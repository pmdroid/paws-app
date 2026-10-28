import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  applyWorkItemEvent,
  beginImplementRun,
  bindWorkItemRepository,
  getConversation,
  getWorkItem,
  insertQueuedItem,
  migrate,
  openDatabase,
  type WorkItemRecord,
} from "../src/db";
import { createFakeTracker } from "../src/linear";
import { attachOrchestrator, type Orchestrator } from "../src/loop";
import { answerQuestion, findOpenQuestion } from "../src/questions";

type PreflightRunner = { runItem(item: WorkItemRecord, handoff?: string): Promise<void> };

test.each(["implementer", "reviewer"] as const)(
  "lost %s preflight ownership blocks another agent after answer and database reopen",
  async (lostRole) => {
    const root = mkdtempSync(join(tmpdir(), "paws-preflight-cleanup-"));
    const seed = join(root, "seed");
    const bare = join(root, "origin.git");
    const pawsRoot = join(root, "paws");
    const databasePath = join(root, "paws.db");
    const families = join(root, "families.jsonl");
    const writes = join(root, "writes");
    const script = join(root, "preflight.ts");
    const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
    let db = openDatabase(databasePath);
    let orchestrator: Orchestrator | undefined;
    let launches = 0;
    try {
      mkdirSync(pawsRoot);
      git("init", "--bare", "-b", "main", bare);
      git("clone", bare, seed);
      git("-C", seed, "config", "user.name", "Paws Test");
      git("-C", seed, "config", "user.email", "paws-test@example.com");
      git("-C", seed, "config", "commit.gpgsign", "false");
      mkdirSync(join(seed, ".agents/skills/review"), { recursive: true });
      writeFileSync(join(seed, ".agents/skills/review/SKILL.md"), "Review acceptance.");
      writeFileSync(
        join(seed, ".agents/closeout.yaml"),
        'specVersion: "0.1"\nretry:\n  maxFailedAttemptsPerItem: 3\n  scope: task\nitems:\n  - id: review\n    kind: review\n    gate: beforePR\n    skill: .agents/skills/review/SKILL.md\n    independence:\n      differentSession: true\n      differentModel: true\n    failOn: P1\n',
      );
      git("-C", seed, "add", ".");
      git("-C", seed, "commit", "-m", "Seed preflight policy");
      git("-C", seed, "push", "origin", "main");
      writeFileSync(
        script,
        `import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  if (message.method === "initialize") send({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
  if (message.method === "session/new") {
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(`const fs = require("node:fs"); process.on("SIGTERM", () => {}); setInterval(() => fs.appendFileSync(${JSON.stringify(writes)}, "x"), 5);`)}], { stdio: "ignore" });
    appendFileSync(${JSON.stringify(families)}, JSON.stringify({ command: process.pid, descendant: child.pid }) + "\\n");
    process.kill(process.ppid, "SIGKILL");
    send({ sessionId: "lost-owner", models: { currentModelId: "test-model", availableModels: [{ modelId: "test-model", name: "Test" }] } });
  }
}
`,
      );
      migrate(db);
      const item = insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
      beginImplementRun(db, item.id, 1);
      bindWorkItemRepository(db, item.id, { owner: "acme", repo: "app", remoteUrl: bare });
      const create = () =>
        attachOrchestrator({
          db,
          jobs: new JobLoop(db, systemClock),
          outbox: new OutboxDispatcher(db, systemClock),
          pawsRoot,
          home: root,
          tracker: createFakeTracker(),
          repositories: [{ owner: "acme", repo: "app", remoteUrl: bare }],
          launch(input) {
            launches++;
            if (input.role === lostRole)
              return { command: process.execPath, args: [script], env: process.env };
            return {
              command: process.execPath,
              args: [new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname],
              env: process.env,
            };
          },
        });
      orchestrator = create();
      await (orchestrator as unknown as PreflightRunner).runItem(getWorkItem(db, item.id)!);
      const question = findOpenQuestion(db, "session");
      expect(question).not.toBeNull();
      expect(getWorkItem(db, item.id)?.state).toBe("awaiting_input");
      const before = existsSync(writes) ? readFileSync(writes, "utf8").length : 0;
      for (let i = 0; i < 100; i++) {
        if (existsSync(writes) && readFileSync(writes, "utf8").length > before) break;
        await Bun.sleep(5);
      }
      expect(readFileSync(writes, "utf8").length).toBeGreaterThan(before);
      expect(getConversation(db, item.id).blocked).toBe(true);
      await expect(orchestrator.shutdown()).rejects.toThrow("cleanup could not be verified");
      db.close();
      db = openDatabase(databasePath);
      expect(getConversation(db, item.id).blocked).toBe(true);
      answerQuestion(db, question!.id, { answer: "Retry", answeredBy: "human" });
      applyWorkItemEvent(db, item.id, "answer_received");
      orchestrator = create();
      const priorLaunches = launches;
      await (orchestrator as unknown as PreflightRunner).runItem(
        getWorkItem(db, item.id)!,
        "Retry",
      );
      expect(launches).toBe(priorLaunches);
      expect(getConversation(db, item.id).blocked).toBe(true);
      expect(readFileSync(families, "utf8").trim().split("\n")).toHaveLength(1);
      await expect(orchestrator.shutdown()).rejects.toThrow("cleanup could not be verified");
    } finally {
      if (existsSync(families)) {
        for (const line of readFileSync(families, "utf8").trim().split("\n")) {
          const family = JSON.parse(line) as { command: number; descendant: number };
          for (const pid of [family.command, family.descendant]) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
        }
      }
      await orchestrator?.shutdown().catch(() => {});
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);
