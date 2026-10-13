import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db";
import { RunnerRequestError } from "../src/runner-daemon";
import { openRunnerHealthRuntime } from "../src/runner-health-runtime";
import { RunnerHelperResultSchema, type RunnerCommand } from "../src/runner-protocol";
import { executeRunnerCommand } from "../src/runner-worker";

function command(now: number): Extract<RunnerCommand, { type: "helper" }> {
  return {
    id: randomUUID(),
    type: "helper",
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: now,
    expiresAt: now + 60_000,
    sessionId: "session",
    sessionGeneration: 1,
    purpose: "classify",
    profile: { agent: "claude", model: "fixture-model" },
    prompt: "Classify this request without tools",
  };
}

for (const text of ["界".repeat(250_000), "\u0000".repeat(152_917)]) {
  test("helper worker accepts canonical bounded JSON text through actual read-only ACP", async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-helper-worker-"));
    try {
      const input = command(Date.now());
      const outputDirectory = join(root, "output");
      const home = join(root, "home");
      mkdirSync(outputDirectory);
      mkdirSync(home);
      const script = join(root, "script.json");
      const recorded = join(root, "agent.json");
      writeFileSync(
        script,
        JSON.stringify({
          model: "fixture-model",
          steps: [
            { type: "fs_write", path: "forbidden.txt", content: "denied" },
            ...Array.from({ length: Math.ceil(text.length / 25_000) }, (_, index) => ({
              type: "update",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: text.slice(index * 25_000, (index + 1) * 25_000) },
              },
            })),
            { type: "end" },
          ],
        }),
      );
      const result = await executeRunnerCommand({
        job: { executionId: "0".repeat(26), command: input },
        outputDirectory,
        workRoot: join(root, "work"),
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
          env: { PATH: "/usr/bin:/bin" },
        },
      });
      expect(result.text).toBe(text);
      const bytes = readFileSync(join(outputDirectory, "result.json"));
      expect(bytes.byteLength).toBeLessThanOrEqual(1_048_576);
      const saved = JSON.parse(bytes.toString());
      expect(saved.run.models).toBeUndefined();
      expect(
        RunnerHelperResultSchema.parse({
          ...saved.run,
          executionId: saved.executionId,
          commandId: saved.commandId,
          text: saved.text,
        }).text,
      ).toBe(text);
      const calls = JSON.parse(readFileSync(recorded, "utf8"));
      expect(calls.methods).toContain("session/prompt");
      expect(JSON.stringify(calls.prompts)).toContain(input.prompt);
      expect(calls.mcpServers).toEqual([]);
      expect(calls.fs[0].ok).toBe(false);
      expect(result.run.agentExited).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
}

for (const loss of ["before-start", "after-start", "running", "expiry", "stop"] as const) {
  test.skipIf(process.getuid!() === 0)(
    `helper authority loss ${loss} joins stop without relaunch or result publication`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "paws-helper-fence-"));
      mkdirSync(join(root, "spool"), { mode: 0o750 });
      chmodSync(join(root, "spool"), 0o750);
      let now = Date.now();
      const input = command(now);
      let allowed = loss !== "before-start";
      const calls: string[] = [];
      const runtime = await openRunnerHealthRuntime({
        root,
        now: () => now,
        daemon: {
          status: () => ({
            phase: "paired",
            runnerId: "runner",
            workspaceId: "workspace",
            fingerprint: "fixture",
            expiresAt: now + 3_600_000,
          }),
          pendingCommands: () => [input],
          async pollCommands() {
            return { commands: [], rejected: [] };
          },
          async pollHelperCommands() {
            return { commands: [input], rejected: [] };
          },
          async helperLease() {
            calls.push("lease");
            if (!allowed) throw new RunnerRequestError(409);
            return { expiresAt: input.expiresAt };
          },
          async acknowledgeCommand() {
            calls.push("ack");
          },
          async postHelperResult() {
            calls.push("result");
            return { duplicate: false };
          },
          async postHealth() {
            throw new Error("Helper cannot post health");
          },
          async heartbeat() {
            throw new Error("Helper cannot use run heartbeat leases");
          },
        },
        spool: {
          root: join(root, "spool"),
          runnerUid: process.getuid!(),
          agentGid: process.getgid!(),
        },
        results: {
          root: join(root, "results"),
          agentUid: process.getuid!(),
          resultsGid: process.getgid!(),
        },
        broker: {
          async start() {
            calls.push("start");
            if (loss === "after-start") allowed = false;
            return { alreadyAdmitted: false };
          },
          async stop() {
            calls.push("stop");
          },
        },
      });
      try {
        await runtime.tick();
        if (loss === "running") allowed = false;
        if (loss === "expiry") now = input.expiresAt;
        if (loss === "stop") await runtime.stop();
        else {
          await runtime.tick();
          await runtime.tick();
        }
        const db = openDatabase(join(root, "health.db"));
        try {
          expect(
            db.query<{ phase: string }, []>("SELECT phase FROM health_execution").all(),
          ).toEqual([{ phase: "interrupted" }]);
        } finally {
          db.close();
        }
        expect(calls.filter((call) => call === "start").length).toBe(
          loss === "before-start" ? 0 : 1,
        );
        expect(calls.filter((call) => call === "result")).toEqual([]);
        expect(calls).toContain("stop");
      } finally {
        await runtime.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
