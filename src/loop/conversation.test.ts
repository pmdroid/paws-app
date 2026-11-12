import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  beginImplementRun,
  getConversation,
  insertQueuedItem,
  saveConversation,
  type Db,
} from "../db";
import { executeItem, FOLLOW_UP_INTERRUPTION } from "../acp";
import { createAcpFixRunner } from "./agents";
import { durableConversation } from "./conversation";
import { tempStore } from "../../test/pglite";

async function insertRunningItem(db: Db) {
  await insertQueuedItem(db, { id: "item", now: 1 });
  await beginImplementRun(db, "item", 1);
}

test("recovery consumes only new public transcript observations once after an interrupted append", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-transcript-recovery-"));
  const { db, close } = await tempStore();
  try {
    await insertRunningItem(db);
    const line = (update: unknown) =>
      JSON.stringify({ event: { type: "session_update", update } }) + "\n";
    const text = (sessionUpdate: string, value: string) =>
      line({ sessionUpdate, content: { type: "text", text: value } });
    const prior = text("agent_message_chunk", "ALREADY_SAVED");
    const path = join(root, "acp.jsonl");
    writeFileSync(
      path,
      prior +
        text("agent_message_chunk", "PUBLIC_OBSERVATION") +
        text("agent_thought_chunk", "PRIVATE_HIDDEN") +
        line({
          sessionUpdate: "tool_call",
          toolCallId: "write",
          status: "completed",
          rawOutput: "PUBLIC_EFFECT",
        }) +
        '{"event":',
    );
    await saveConversation(
      db,
      "item",
      JSON.stringify([{ kind: "request", body: "INITIAL_REQUEST" }]),
      path,
      false,
      Buffer.byteLength(prior),
    );
    await durableConversation(db, "item");
    const recovered = await getConversation(db, "item");
    expect(recovered.transcript).toBeNull();
    expect(recovered.entries).toContain("INITIAL_REQUEST");
    expect(recovered.entries).toContain("PUBLIC_OBSERVATION");
    expect(recovered.entries).toContain("PUBLIC_EFFECT");
    expect(recovered.entries).not.toContain("PRIVATE_HIDDEN");
    expect(recovered.entries).not.toContain("ALREADY_SAVED");
    await durableConversation(db, "item");
    expect((await getConversation(db, "item")).entries).toBe(recovered.entries);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("executor and Closeout fixer share the durable ACP conversation through real prompts", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-conversation-callers-"));
  const source = join(root, "source");
  const evidence = join(root, "prompts.jsonl");
  const { db, close } = await tempStore();
  const git = (...args: string[]) => execFileSync("git", args).toString().trim();
  try {
    mkdirSync(source);
    git("init", "-b", "main", source);
    git(
      "-C",
      source,
      "-c",
      "user.name=Paws Test",
      "-c",
      "user.email=paws@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "Seed",
    );
    await insertRunningItem(db);
    const runner = await durableConversation(db, "item");
    const agent = new URL("../../test/fixtures/brief-agent.ts", import.meta.url).pathname;
    const launch = (purpose: string) => ({
      command: process.execPath,
      args: [agent, purpose, evidence],
      env: { PATH: process.env.PATH!, HOME: root },
    });
    const implemented = await executeItem({
      owner: "acme",
      repo: "widgets",
      remoteUrl: source,
      pawsRoot: root,
      home: root,
      itemId: "ENG-1",
      runId: "implement",
      prompt: "Required output: `ALPHA`",
      promptRunner: runner,
      ...launch("implement"),
    });
    expect(implemented.run.stopReason).toBe("end_turn");
    const head = git("-C", implemented.worktreePath, "rev-parse", "HEAD");
    const fixed = await createAcpFixRunner({
      pawsRoot: root,
      home: root,
      brief: "Required output: `ALPHA`",
      promptRunner: runner,
      launch: () => launch("fix"),
    }).applyFix({
      worktree: implemented.worktreePath,
      taskId: "ENG-1",
      fixAttempt: 1,
      maxFixAttempts: 1,
      base: head,
      head,
      items: [],
      reviewFindings: [],
      summary: "Append the fixed suffix.",
    });
    expect(fixed.ok).toBe(true);
    expect(readFileSync(join(implemented.worktreePath, "result.txt"), "utf8")).toBe("ALPHA-fixed");
    const prompts = readFileSync(evidence, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { purpose: string; prompt: string });
    expect(prompts.map((row) => row.purpose)).toEqual(["implement", "fix"]);
    expect(prompts[1]!.prompt).toContain('"kind":"request","body":"Required output: `ALPHA`"');
    expect(JSON.parse((await getConversation(db, "item")).entries)).toHaveLength(2);
    expect((await getConversation(db, "item")).transcript).toBeNull();
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("a failed pending snapshot cannot start an ACP process", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-conversation-save-failure-"));
  const marker = join(root, "spawned");
  const { db, close } = await tempStore();
  try {
    const runner = await durableConversation(db, "missing-item");
    await expect(
      runner({
        role: "implementer",
        itemId: "missing-item",
        runId: "missing-run",
        worktreePath: root,
        pawsRoot: root,
        home: root,
        prompt: "Must remain pending",
        command: process.execPath,
        args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)},"spawned")`],
        env: { PATH: process.env.PATH!, HOME: root },
      }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringContaining("violates foreign key constraint") },
    });
    await Bun.sleep(150);
    expect(existsSync(marker)).toBe(false);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a concurrent prompt rejects without replacing the active transcript snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-conversation-concurrent-"));
  const { db, close } = await tempStore();
  const controller = new AbortController();
  let running: Promise<unknown> | undefined;
  try {
    await insertRunningItem(db);
    const script = join(root, "script.json");
    writeFileSync(
      script,
      JSON.stringify({
        steps: [
          {
            type: "update",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "READY" },
            },
          },
          { type: "hang" },
        ],
      }),
    );
    let ready!: () => void;
    const started = new Promise<void>((resolve) => (ready = resolve));
    const runner = await durableConversation(db, "item");
    const options = {
      role: "implementer" as const,
      itemId: "item",
      runId: "first",
      worktreePath: root,
      pawsRoot: root,
      home: root,
      prompt: "FIRST_REQUEST",
      command: process.execPath,
      args: [
        new URL("../acp/testing/fake-agent.ts", import.meta.url).pathname,
        join(root, "result.json"),
        script,
      ],
      env: { PATH: process.env.PATH!, HOME: root },
      signal: controller.signal,
      readOnly: true,
      checkpoint: false,
      cancelGraceMs: 100,
      onEvent: (event: { type: string }) => {
        if (event.type === "session_update") ready();
      },
    };
    running = runner(options);
    await started;
    const active = await getConversation(db, "item");
    expect(active.transcript).toContain("/first/acp.jsonl");
    await expect(runner({ ...options, runId: "second", prompt: "SECOND_REQUEST" })).rejects.toThrow(
      "ACP prompt already running",
    );
    expect(await getConversation(db, "item")).toEqual(active);
    controller.abort(FOLLOW_UP_INTERRUPTION);
    await running;
    expect((await getConversation(db, "item")).transcript).toBeNull();
    expect((await getConversation(db, "item")).entries).not.toContain("SECOND_REQUEST");
  } finally {
    controller.abort();
    await running;
    await close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
