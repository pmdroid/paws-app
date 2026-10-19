import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerCommand } from "../src/runner-protocol";
import { executeRunnerCommand } from "../src/runner-worker";

const executionId = "0".repeat(26);
function command(purpose: "answer" | "artifact"): Extract<RunnerCommand, { type: "task" }> {
  return {
    id: "command",
    type: "task",
    runnerId: "runner",
    workspaceId: "workspace",
    runId: "run",
    itemId: "item",
    generation: 1,
    sessionId: "session",
    sessionGeneration: 1,
    taskModeGeneration: 1,
    purpose,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    profile: { agent: "claude", model: "fixture-model" },
    prompt: `Return the requested ${purpose} without a code candidate`,
  };
}

for (const purpose of ["answer", "artifact"] as const) {
  test(`repository-free ${purpose} preserves its task tool authority`, async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-task-worker-"));
    try {
      const input = command(purpose);
      const workRoot = join(root, "work");
      const worktree = join(workRoot, executionId);
      const outputDirectory = join(root, "output");
      const home = join(root, "home");
      for (const path of [worktree, outputDirectory, home])
        mkdirSync(path, { recursive: true, mode: 0o700 });
      const script = join(root, "script.json");
      const recorded = join(root, "agent.json");
      writeFileSync(
        script,
        JSON.stringify({
          model: "fixture-model",
          steps: [
            {
              type: "permission",
              toolCall: {
                toolCallId: "write-note",
                kind: "edit",
                locations: [{ path: join(worktree, "note.txt") }],
              },
            },
            { type: "fs_write", path: join(worktree, "note.txt"), content: "private" },
            { type: "terminal", command: "sh", args: ["-c", "printf artifact > report.txt"] },
            { type: "ask_team", question: "Include the report?" },
            { type: "publish_artifact", path: "report.txt", displayName: "Report" },
            {
              type: "update",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "The requested response is ready." },
              },
            },
            { type: "end" },
          ],
        }),
      );
      const result = await executeRunnerCommand({
        job: { executionId, command: input },
        outputDirectory,
        workRoot,
        home,
        resultsGid: process.getgid!(),
        launch: {
          command: process.execPath,
          args: [
            "--no-env-file",
            fileURLToPath(new URL("../src/acp/testing/fake-agent.ts", import.meta.url)),
            recorded,
            script,
          ],
          env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
        },
        async answer(requestId) {
          const events = readFileSync(join(outputDirectory, "events.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const artifact = events.find(
            (event) => event.type === "artifact" && event.requestId === requestId,
          );
          if (artifact) {
            expect(readFileSync(join(outputDirectory, `artifact-${requestId}.bytes`), "utf8")).toBe(
              "artifact",
            );
            return { answer: JSON.stringify({ url: "https://fixture.invalid/report" }) };
          }
          expect(
            events.some((event) => event.type === "question" && event.requestId === requestId),
          ).toBe(true);
          return { answer: "Yes" };
        },
      });
      expect(result.run.stopReason).toBe("end_turn");
      expect(result.candidateSha).toBeUndefined();
      expect(result.reviewText).toBeUndefined();
      expect(result.text).toBeUndefined();
      const trace = JSON.parse(readFileSync(recorded, "utf8"));
      expect(JSON.stringify(trace.prompts)).toContain(input.prompt);
      expect(trace.askTeam.ok).toBe(true);
      expect(trace.permissions[0].outcome.outcome).toEqual(
        purpose === "answer"
          ? { outcome: "cancelled" }
          : { outcome: "selected", optionId: "allow" },
      );
      if (purpose === "answer") {
        expect(trace.terminals).toMatchObject([{ ok: false }]);
        expect(trace.fs).toMatchObject([{ op: "write", ok: false }]);
        expect(trace.artifact.ok).toBe(false);
        expect(trace.tools).toEqual(["ask_team", "update_plan", "post_update", "get_closeout"]);
        expect(existsSync(join(worktree, "note.txt"))).toBe(false);
        expect(existsSync(join(worktree, "report.txt"))).toBe(false);
      } else {
        expect(trace.terminals).toMatchObject([{ ok: true, exitCode: 0 }]);
        expect(trace.fs).toMatchObject([{ op: "write", ok: true }]);
        expect(trace.artifact.ok).toBe(true);
        expect(trace.tools).toEqual([
          "ask_team",
          "update_plan",
          "publish_artifact",
          "post_update",
          "get_closeout",
          "run_closeout",
          "request_closeout_skip",
        ]);
        expect(readFileSync(join(worktree, "note.txt"), "utf8")).toBe("private");
        expect(readFileSync(join(worktree, "report.txt"), "utf8")).toBe("artifact");
      }
      expect(readFileSync(join(outputDirectory, "events.jsonl"), "utf8")).toContain(
        "The requested response is ready.",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("task worker refuses a replaced prepared workspace before ACP dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-task-worker-symlink-"));
  try {
    const workRoot = join(root, "work");
    const outputDirectory = join(root, "output");
    const home = join(root, "home");
    for (const path of [workRoot, outputDirectory, home]) mkdirSync(path, { mode: 0o700 });
    symlinkSync(home, join(workRoot, executionId));
    await expect(
      executeRunnerCommand({
        job: { executionId, command: command("answer") },
        outputDirectory,
        workRoot,
        home,
        resultsGid: process.getgid!(),
        launch: { command: "/no-agent-may-launch" },
      }),
    ).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
