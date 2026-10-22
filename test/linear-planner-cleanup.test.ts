import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  blockLinearSessionCleanup,
  ensureLinearSession,
  getConversation,
  getLinearSession,
  getWorkItem,
  JobLoop,
  migrate,
  openDatabase,
  OutboxDispatcher,
} from "../src/db";
import { systemClock } from "../src/core";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator, createTaskPlanner, type AgentLaunch } from "../src/loop";
import { tempHome } from "./helpers";

// The classifiers ignore SIGTERM, so each stop waits out the grace twice.
const CANCEL_GRACE_MS = 200;

test.skipIf(process.platform !== "linux")(
  "lost classifier ownership blocks Stop, a new prompt and reopened planning before another writer",
  async () => {
    const home = tempHome();
    const database = join(home, "planning.db");
    const script = join(home, "classifier.ts");
    const ready = join(home, "ready.json");
    const writes = join(home, "descendant-writes");
    writeOwnerScript(home);
    let launches = 0;
    const launch: AgentLaunch = () => {
      launches++;
      return {
        command: process.execPath,
        args: [script],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
        cancelGraceMs: CANCEL_GRACE_MS,
      };
    };
    let db = openDatabase(database);
    migrate(db);
    ensureLinearSession(db, { sessionId: "session" });
    const planner = () =>
      createTaskPlanner({
        db,
        home,
        pawsRoot: join(home, "paws"),
        launch,
        profile: () => ({ agent: "codex", model: null }),
      });
    const firstPlanner = planner();
    const plan = (owner = firstPlanner, taskKey = "first") =>
      owner.plan({ taskKey, sessionId: "session", request: async () => "Explain this." });
    const first = plan().catch((error: unknown) => error);
    let family: { anchor: number; command: number; descendant: number } | undefined;
    try {
      await until(() => existsSync(ready) && existsSync(writes));
      family = JSON.parse(readFileSync(ready, "utf8"));
      process.kill(family!.anchor, "SIGKILL");
      await expect(firstPlanner.stop("session")).rejects.toThrow("cleanup");
      expect(await first).toBeInstanceOf(Error);
      // The descendant outlived the lost anchor and keeps writing.
      const before = readFileSync(writes, "utf8").length;
      await until(() => readFileSync(writes, "utf8").length > before);
      await expect(plan(firstPlanner, "replacement")).rejects.toThrow("cleanup");
      expect(launches).toBe(1);
      db.close();
      db = openDatabase(database);
      migrate(db);
      const reopened = planner();
      await expect(reopened.stop()).rejects.toThrow("cleanup");
      await expect(plan(reopened, "after-restart")).rejects.toThrow("cleanup");
      expect(launches).toBe(1);
    } finally {
      await firstPlanner.stop().catch(() => undefined);
      if (family)
        for (const pid of [family.command, family.descendant]) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      db.close();
    }
  },
  15000,
);

function writeOwnerScript(home: string): void {
  const script = join(home, "classifier.ts");
  const ready = join(home, "ready.json");
  const writes = join(home, "descendant-writes");
  writeFileSync(
    script,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize") process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}})+"\\n");
  if (message.method === "session/new") process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result:{sessionId:"classifier"}})+"\\n");
  if (message.method === "session/prompt") {
    const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(`const fs=require('fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(writes)},'x'),5);`)}], {stdio:"ignore"});
    writeFileSync(${JSON.stringify(ready)},JSON.stringify({anchor:process.ppid,command:process.pid,descendant:descendant.pid}));
  }
}
`,
  );
}

test.skipIf(process.platform !== "linux")(
  "a lost clarification classifier blocks its existing task and administrative shutdown",
  async () => {
    const home = tempHome();
    const db = openDatabase(join(home, "existing.db"));
    migrate(db);
    writeOwnerScript(home);
    const classify = join(home, "initial.json");
    writeFileSync(
      classify,
      JSON.stringify({
        steps: [
          {
            type: "update",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: '{"mode":"clarify","question":"Which outcome?"}' },
            },
          },
          { type: "end" },
        ],
      }),
    );
    let launches = 0;
    const launch: AgentLaunch = () => ({
      command: process.execPath,
      args:
        launches++ === 0
          ? [
              new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname,
              join(home, "initial-result.json"),
              classify,
            ]
          : [join(home, "classifier.ts")],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
      cancelGraceMs: CANCEL_GRACE_MS,
    });
    const jobs = new JobLoop(db, systemClock);
    const orchestrator = attachOrchestrator({
      db,
      jobs,
      outbox: new OutboxDispatcher(db, systemClock),
      home,
      pawsRoot: join(home, "paws"),
      linearTaskModes: true,
      launch,
      tracker: createFakeTracker([
        {
          linearIssueId: "issue",
          identifier: "ENG-1",
          title: "Help",
          description: "Help me.",
          subIssues: [],
        },
      ]),
    });
    const created: AcceptedLinearEvent = {
      dedupeKey: "created",
      deliveryId: null,
      source: "webhook",
      action: "created",
      sessionId: "session",
      issueId: "issue",
      activityId: null,
      body: null,
      signal: null,
      updatedAtMs: Date.now(),
      payload: JSON.stringify({ agentSession: { creatorId: "human" }, promptContext: "Help me." }),
    };
    let family: { command: number; descendant: number; anchor: number } | undefined;
    try {
      await orchestrator.onLinearEvent(created);
      await jobs.tick();
      await orchestrator.onLinearEvent({
        ...created,
        action: "prompted",
        dedupeKey: "answer",
        activityId: "answer",
        actorId: "human",
        body: "Explain it.",
        updatedAtMs: Date.now(),
      });
      const work = jobs.tick();
      await until(
        () => existsSync(join(home, "ready.json")) && existsSync(join(home, "descendant-writes")),
      );
      family = JSON.parse(readFileSync(join(home, "ready.json"), "utf8"));
      process.kill(family!.anchor, "SIGKILL");
      await expect(orchestrator.interruptLinearSession("session")).rejects.toThrow("cleanup");
      await work;
      const itemId = getLinearSession(db, "session")!.activeItemId!;
      expect(getConversation(db, itemId).blocked).toBe(true);
      expect(getWorkItem(db, itemId)?.state).not.toBe("completed");
      await expect(orchestrator.shutdown()).rejects.toThrow("cleanup");
      expect(launches).toBe(2);
    } finally {
      await orchestrator.shutdown().catch(() => undefined);
      if (family)
        for (const pid of [family.command, family.descendant]) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      db.close();
    }
  },
  15000,
);

for (const operation of ["shutdown", "interrupt"] as const)
  test.skipIf(process.platform !== "linux")(
    `${operation} joins another live writer before rejecting a durable planner cleanup failure`,
    async () => {
      const home = tempHome();
      const blockedRoot = join(home, "blocked");
      const liveRoot = join(home, "live");
      for (const directory of [blockedRoot, liveRoot]) {
        mkdirSync(directory);
        writeOwnerScript(directory);
      }
      const db = openDatabase(join(home, "both.db"));
      migrate(db);
      const answer = join(home, "answer.json");
      writeFileSync(
        answer,
        JSON.stringify({
          steps: [
            {
              type: "update",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: '{"mode":"answer"}' },
              },
            },
            { type: "end" },
          ],
        }),
      );
      const jobs = new JobLoop(db, systemClock);
      const orchestrator = attachOrchestrator({
        db,
        jobs,
        outbox: new OutboxDispatcher(db, systemClock),
        home,
        pawsRoot: join(home, "paws"),
        linearTaskModes: true,
        tracker: createFakeTracker(
          ["blocked", "live"].map((id) => ({
            linearIssueId: id,
            identifier: id === "blocked" ? "ENG-1" : "ENG-2",
            title: id,
            description: id,
            subIssues: [],
          })),
        ),
        launch: (input) => ({
          command: process.execPath,
          args:
            input.purpose === "classify" && !input.prompt.includes("BLOCK_CLASSIFIER")
              ? [
                  new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname,
                  join(home, "answer-result.json"),
                  answer,
                ]
              : [join(input.purpose === "classify" ? blockedRoot : liveRoot, "classifier.ts")],
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
          cancelGraceMs: CANCEL_GRACE_MS,
        }),
      });
      const created = (id: string): AcceptedLinearEvent => ({
        dedupeKey: id,
        deliveryId: null,
        source: "webhook",
        action: "created",
        sessionId: id,
        issueId: id,
        activityId: null,
        body: null,
        signal: null,
        updatedAtMs: Date.now(),
        payload: JSON.stringify({
          agentSession: { creatorId: "human" },
          promptContext: id === "blocked" ? "BLOCK_CLASSIFIER" : "Explain this.",
        }),
      });
      const families: Array<{ anchor: number; command: number; descendant: number }> = [];
      const waitFamily = async (root: string) => {
        await until(
          () => existsSync(join(root, "ready.json")) && existsSync(join(root, "descendant-writes")),
        );
        const family = JSON.parse(readFileSync(join(root, "ready.json"), "utf8"));
        families.push(family);
        return family as (typeof families)[number];
      };
      const blocked = orchestrator
        .onLinearEvent(created("blocked"))
        .catch((error: unknown) => error);
      try {
        const classifier = await waitFamily(blockedRoot);
        await orchestrator.onLinearEvent(created("live"));
        const work = jobs.tick();
        const writer = await waitFamily(liveRoot);
        process.kill(classifier.anchor, "SIGKILL");
        if (operation === "interrupt") blockLinearSessionCleanup(db, "live");
        await expect(
          operation === "shutdown"
            ? orchestrator.shutdown()
            : orchestrator.interruptLinearSession("live"),
        ).rejects.toThrow("cleanup");
        expect(running(writer.descendant)).toBe(false);
        await work;
        const before = readFileSync(join(liveRoot, "descendant-writes"), "utf8").length;
        await Bun.sleep(30);
        expect(readFileSync(join(liveRoot, "descendant-writes"), "utf8").length).toBe(before);
        expect(running(writer.descendant)).toBe(false);
      } finally {
        await orchestrator.interruptLinearSession("live").catch(() => undefined);
        await orchestrator.shutdown().catch(() => undefined);
        await blocked;
        for (const family of families)
          for (const pid of [family.command, family.descendant]) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
        db.close();
      }
    },
    15000,
  );

// Polls until the condition holds; the test timeout bounds a loaded machine.
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await Bun.sleep(5);
}

function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
  } catch {
    return false;
  }
}
