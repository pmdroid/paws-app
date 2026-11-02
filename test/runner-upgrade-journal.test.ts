import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openExecutionJournal } from "../src/runner-journal";
import {
  RunnerCommandSchema,
  type RunnerCommand,
  type RunnerTermination,
} from "../src/runner-protocol";
import { LEGACY_EXECUTION_PAYLOADS } from "./fixtures/runner-journal-legacy";
import { runtimeProcess } from "./fixtures/runner-runtime-process";

const PHASES = ["complete", "interrupted", "preparing", "running", "publishing", "cleaning"];

type LegacyRow = { id: string; commandId: string; runId: string; itemId: string; phase: string };

function seedLegacyJournal(root: string): LegacyRow[] {
  openExecutionJournal(root).close();
  const db = new Database(join(root, "executions.db"));
  const rows: LegacyRow[] = [];
  try {
    LEGACY_EXECUTION_PAYLOADS.forEach(({ payload }, shape) => {
      for (const phase of PHASES) {
        const n = `${shape}-${phase}`;
        const row = {
          id: `execution-${n}`,
          commandId: `command-${n}`,
          runId: `run-${n}`,
          itemId: `item-${n}`,
          phase,
        };
        db.run("INSERT INTO execution(id,command_id,payload,phase) VALUES (?,?,?,?)", [
          row.id,
          row.commandId,
          JSON.stringify({
            ...payload,
            id: row.commandId,
            runId: row.runId,
            itemId: row.itemId,
            generation: 1,
          }),
          phase,
        ]);
        rows.push(row);
      }
    });
  } finally {
    db.close();
  }
  return rows;
}

test("every legacy payload is one today's command schema rejects", () => {
  for (const { shape, payload } of LEGACY_EXECUTION_PAYLOADS)
    expect(
      RunnerCommandSchema.safeParse({
        ...payload,
        id: "command",
        runId: "run",
        itemId: "item",
        generation: 1,
      }).success,
      shape,
    ).toBe(false);
});

test("the startup reads of the journal survive rows written by older releases", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-upgrade-journal-"));
  try {
    const rows = seedLegacyJournal(root);
    const journal = openExecutionJournal(root);
    try {
      const current: Extract<RunnerCommand, { type: "task" }> = {
        id: "current-command",
        type: "task",
        runnerId: "runner",
        workspaceId: "workspace",
        runId: "current-run",
        itemId: "current-item",
        generation: 1,
        sessionId: "session",
        sessionGeneration: 1,
        taskModeGeneration: 1,
        purpose: "answer",
        issuedAt: 1000,
        expiresAt: 2000,
        profile: { agent: "claude", model: null },
        prompt: "prompt",
      };
      const admitted = journal.admit(current, 1000)!;
      expect(journal.executions(true).map((execution) => execution.id)).toEqual([admitted.id]);
      expect(journal.executions(false)).toEqual([]);
      for (const row of rows) {
        expect(journal.resultPending(row.id)).toBe(false);
        expect(journal.publication(row.id)).toBeFalsy();
      }
      const reconcile = [...journal.unconfirmedTerminations(), ...journal.unreadableExecutions()];
      expect(reconcile.map((execution) => execution.id).sort()).toEqual(
        rows.map((row) => row.id).sort(),
      );
      for (const execution of reconcile) {
        const row = rows.find((candidate) => candidate.id === execution.id)!;
        expect(execution.command).toEqual({
          id: row.commandId,
          runId: row.runId,
          generation: 1,
          itemId: row.itemId,
        });
        journal.confirmTermination(execution.command);
      }
      expect(journal.unconfirmedTerminations()).toEqual([]);
      expect(journal.unreadableExecutions()).toEqual([]);
      expect(journal.executions(true).map((execution) => execution.id)).toEqual([admitted.id]);
    } finally {
      journal.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux" || process.getuid!() === 0)(
  "a runner upgraded over legacy journal rows heartbeats and reports each termination once",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-upgrade-runtime-"));
    const rows = seedLegacyJournal(root);
    const now = Date.now();
    const spool = {
      root: join(root, "spool"),
      runnerUid: process.getuid!(),
      agentGid: process.getgid!(),
    };
    mkdirSync(spool.root);
    chmodSync(spool.root, 0o750);
    const paired = {
      phase: "paired" as const,
      runnerId: "runner",
      workspaceId: "workspace",
      fingerprint: "fixture",
      expiresAt: now + 3_600_000,
    };
    let heartbeats = 0;
    const reported: RunnerTermination[] = [];
    const stopped: string[] = [];
    const runtime = await runtimeProcess({
      root,
      spool,
      results: {
        root: join(root, "results"),
        agentUid: process.getuid!(),
        resultsGid: process.getgid!(),
      },
      repositoryRoot: join(root, "repositories"),
      home: root,
      broker: {
        async start() {
          throw new Error("No legacy execution may start a worker");
        },
        async stop(id) {
          stopped.push(id);
        },
        alive: () => false,
      },
      daemon: {
        status: () => paired,
        async heartbeat(_skills, _runtimes, _agents, _renewals, terminations = []) {
          heartbeats++;
          reported.push(...terminations);
          return { leases: [], fenced: [], terminated: [...terminations] };
        },
        async pollCommands() {
          return { commands: [], rejected: [], deniedRepositories: [] };
        },
        pendingCommands: () => [],
        async acknowledgeCommand() {},
        async issueRunGrant() {
          throw new Error("No legacy execution may ask for a grant");
        },
        async sendEvent() {
          return { duplicate: false };
        },
        async answers() {
          return { answers: [] };
        },
        async postResult() {
          throw new Error("No legacy execution may post a result");
        },
        async repositoryCredential() {
          throw new Error("No legacy execution may ask for a credential");
        },
        async renewCertificate() {
          return paired;
        },
        async uploadArtifact() {
          return { ok: true };
        },
        async uploadTranscript(_runId, chunk) {
          return { offset: chunk.offset, duplicate: false };
        },
        async finishTranscript() {
          return { uri: "transcript" };
        },
      },
    });
    try {
      for (let i = 0; i < 200 && reported.length < rows.length; i++) {
        await runtime.tick();
        await Bun.sleep(10);
      }
      await runtime.tick();
      expect(heartbeats).toBeGreaterThan(0);
      expect(stopped.sort()).toEqual(rows.map((row) => row.id).sort());
      expect(
        reported
          .map(({ commandId, runId, generation }) => ({ commandId, runId, generation }))
          .sort((a, b) => a.commandId.localeCompare(b.commandId)),
      ).toEqual(
        rows
          .map(({ commandId, runId }) => ({ commandId, runId, generation: 1 }))
          .sort((a, b) => a.commandId.localeCompare(b.commandId)),
      );
    } finally {
      await runtime.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
