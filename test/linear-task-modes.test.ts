import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isTerminalWorkItemState } from "../src/core";
import {
  completeAnswerTask,
  beginImplementRun,
  getTaskMode,
  getWorkItem,
  insertQueuedItem,
  applyWorkItemEvent,
  listOutbox,
  migrate,
  openDatabase,
  saveTaskMode,
} from "../src/db";
import { classifyTask, parseTaskClassification } from "../src/loop";
import { createLiveStatusProvider } from "../src/web";
import { tempDb, tempHome } from "./helpers";

test("task classification accepts supported modes and explicit clarification", () => {
  expect(parseTaskClassification('{"mode":"code"}')).toEqual({ mode: "code" });
  expect(parseTaskClassification('```json\n{"mode":"answer"}\n```')).toEqual({ mode: "answer" });
  expect(parseTaskClassification('{"mode":"artifact"}')).toEqual({ mode: "artifact" });
  expect(parseTaskClassification('{"mode":"answer","repository":true}')).toEqual({
    mode: "answer",
    repository: true,
  });
  expect(parseTaskClassification('{"mode":"artifact","repository":false}')).toEqual({
    mode: "artifact",
  });
  expect(() => parseTaskClassification('{"mode":"answer","repository":"true"}')).toThrow("boolean");
  expect(
    parseTaskClassification('{"mode":"clarify","question":"Create a file or explain it?"}'),
  ).toEqual({ mode: "clarify", question: "Create a file or explain it?" });
  for (const text of ["[]", "null", '{"mode":"unknown"}', '{"mode":"clarify"}', "probably code"])
    expect(() => parseTaskClassification(text)).toThrow();
});

test.each(["code", "answer", "artifact"] as const)(
  "classification runs real ACP in an empty workspace and produces %s without a checkpoint",
  async (mode) => {
    const home = tempHome();
    const root = join(home, "paws");
    mkdirSync(root);
    const script = join(home, "script.json");
    writeFileSync(
      script,
      JSON.stringify({
        steps: [
          { type: "fs_write", path: "forbidden.txt", content: "must be denied" },
          {
            type: "update",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: JSON.stringify({ mode }) },
            },
          },
          { type: "end" },
        ],
      }),
    );
    const result = await classifyTask({
      itemId: "ENG-1",
      runId: "run-1",
      pawsRoot: root,
      home,
      request: "Classify this image https://uploads.linear.app/private/image.png?signature=secret",
      profile: { agent: "codex", model: null },
      signal: new AbortController().signal,
      launch: (input) => {
        expect(input.purpose).toBe("classify");
        expect(input.prompt).toContain(
          "Any request combining repository changes and files is code",
        );
        expect(existsSync(join(root, "worktrees"))).toBe(false);
        return {
          command: process.execPath,
          args: [
            resolve(import.meta.dir, "../src/acp/testing/fake-agent.ts"),
            join(home, "result.json"),
            script,
          ],
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
        };
      },
    });
    expect(result).toEqual({ mode });
    const trace = JSON.parse(readFileSync(join(home, "result.json"), "utf8"));
    expect(JSON.stringify(trace.prompts)).toContain("[private input file]");
    expect(JSON.stringify(trace.prompts)).not.toContain("signature=secret");
    expect(existsSync(join(root, "tasks", "ENG-1", "classify", ".git"))).toBe(false);
    expect(existsSync(join(root, "tasks", "ENG-1", "classify", "forbidden.txt"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "result.json"), "utf8")).fs[0]).toMatchObject({
      op: "write",
      ok: false,
    });
    expect(existsSync(join(root, "worktrees"))).toBe(false);
  },
);

test("answer mode and full prepared response survive reopen as a terminal completion", () => {
  const file = join(tempHome(), "paws.db");
  const db = openDatabase(file);
  migrate(db);
  const item = insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
  beginImplementRun(db, item.id, 1);
  saveTaskMode(db, item.id, "answer");
  const response = "Full public answer. ".repeat(1_000);
  completeAnswerTask(db, item.id, response);
  db.close();
  const restored = openDatabase(file);
  try {
    expect(getTaskMode(restored, item.id)).toBe("answer");
    expect(getWorkItem(restored, item.id)?.state).toBe("completed");
    expect(isTerminalWorkItemState(getWorkItem(restored, item.id)!.state)).toBe(true);
    const dashboard = createLiveStatusProvider(restored).snapshot();
    expect(dashboard.items[0]?.state).toBe("completed");
    expect(dashboard.runs[0]?.state).toBe("done");
    expect(listOutbox(restored, "session")[0]?.payload).toEqual({
      sessionId: "session",
      kind: "response",
      body: response,
    });
    expect(() => applyWorkItemEvent(restored, item.id, "restart")).toThrow();
  } finally {
    restored.close();
  }
});

test.each(["code", "artifact"] as const)("%s cannot complete at the answer boundary", (mode) => {
  const db = tempDb();
  try {
    const item = insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
    applyWorkItemEvent(db, item.id, "dispatched");
    saveTaskMode(db, item.id, mode);
    expect(() => completeAnswerTask(db, item.id, "Done")).toThrow("Only answer tasks");
    expect(getWorkItem(db, item.id)?.state).toBe("running");
    expect(listOutbox(db)).toEqual([]);
    expect(() => saveTaskMode(db, item.id, "answer")).toThrow("already selected");
  } finally {
    db.close();
  }
});

test("Stop and empty responses cannot complete an answer task", () => {
  const db = tempDb();
  try {
    const item = insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
    applyWorkItemEvent(db, item.id, "dispatched");
    saveTaskMode(db, item.id, "answer");
    expect(() => completeAnswerTask(db, item.id, " ")).toThrow("prepared response");
    applyWorkItemEvent(db, item.id, "cancel");
    expect(() => completeAnswerTask(db, item.id, "Done")).toThrow("no longer running");
    expect(listOutbox(db)).toEqual([]);
  } finally {
    db.close();
  }
});
