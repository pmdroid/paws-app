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
  saveTaskMode,
} from "../src/db";
import { classifyTask, parseTaskClassification } from "../src/loop";
import { createLiveStatusProvider } from "../src/dashboard";
import { tempHome, withHomeStore } from "./helpers";
import { tempStore } from "./pglite";

test("task classification accepts supported modes and explicit clarification", () => {
  expect(parseTaskClassification('{"mode":"code"}')).toEqual({ mode: "code" });
  expect(parseTaskClassification('```json\n{"mode":"answer"}\n```')).toEqual({ mode: "answer" });
  expect(parseTaskClassification('{"mode":"artifact"}')).toEqual({ mode: "artifact" });
  // A plan always reads the repository it splits the work for.
  expect(parseTaskClassification('{"mode":"plan"}')).toEqual({ mode: "plan", repository: true });
  expect(parseTaskClassification('{"mode":"plan","repository":false}')).toEqual({
    mode: "plan",
    repository: true,
  });
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

test.each(["code", "answer", "artifact", "plan"] as const)(
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
        expect(input.prompt).toContain("plan: a request to plan, split, scope");
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
    expect(result).toEqual(mode === "plan" ? { mode, repository: true } : { mode });
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

test("answer mode and full prepared response survive reopen as a terminal completion", async () => {
  const home = tempHome();
  const response = "Full public answer. ".repeat(1_000);
  const item = await withHomeStore(home, async (db) => {
    const queued = await insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
    await beginImplementRun(db, queued.id, 1);
    await saveTaskMode(db, queued.id, "answer");
    await completeAnswerTask(db, queued.id, response);
    return queued;
  });
  await withHomeStore(home, async (restored) => {
    expect(await getTaskMode(restored, item.id)).toBe("answer");
    expect((await getWorkItem(restored, item.id))?.state).toBe("completed");
    expect(isTerminalWorkItemState((await getWorkItem(restored, item.id))!.state)).toBe(true);
    const dashboard = await createLiveStatusProvider(restored).issues();
    expect(dashboard.issues[0]?.state).toBe("completed");
    expect(dashboard.runs[0]?.state).toBe("done");
    expect((await listOutbox(restored, "session"))[0]?.payload).toEqual({
      sessionId: "session",
      kind: "response",
      body: response,
    });
    await expect(applyWorkItemEvent(restored, item.id, "restart")).rejects.toThrow();
  });
});

test.each(["code", "artifact"] as const)(
  "%s cannot complete at the answer boundary",
  async (mode) => {
    const { db, close } = await tempStore();
    try {
      const item = await insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
      await applyWorkItemEvent(db, item.id, "dispatched");
      await saveTaskMode(db, item.id, mode);
      await expect(completeAnswerTask(db, item.id, "Done")).rejects.toThrow("Only answer tasks");
      expect((await getWorkItem(db, item.id))?.state).toBe("running");
      expect(await listOutbox(db)).toEqual([]);
      await expect(saveTaskMode(db, item.id, "answer")).rejects.toThrow("already selected");
    } finally {
      await close();
    }
  },
);

test("Stop and empty responses cannot complete an answer task", async () => {
  const { db, close } = await tempStore();
  try {
    const item = await insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
    await applyWorkItemEvent(db, item.id, "dispatched");
    await saveTaskMode(db, item.id, "answer");
    await expect(completeAnswerTask(db, item.id, " ")).rejects.toThrow("prepared response");
    await applyWorkItemEvent(db, item.id, "cancel");
    await expect(completeAnswerTask(db, item.id, "Done")).rejects.toThrow("no longer running");
    expect(await listOutbox(db)).toEqual([]);
  } finally {
    await close();
  }
});
