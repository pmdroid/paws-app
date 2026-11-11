import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  appendCloseoutOutput,
  applyWorkItemEvent,
  beginImplementRun,
  enterMergeQueue,
  finishCloseoutProgress,
  insertQueuedItem,
  migrate,
  saveEvidence,
  openDatabase,
  upsertCloseoutStep,
  sqliteDb,
} from "../../../db";
import { createLiveStatusProvider, handleStatusRequest } from "../engine";

/** The budget in `docs/dashboard-payload.md`. */
const LIST_BUDGET_BYTES = 200 * 1024;
const DETAIL_BUDGET_BYTES = 1024 * 1024;
const OVERVIEW_BUDGET_BYTES = 50 * 1024;
const MERGE_QUEUE_BUDGET_BYTES = 64 * 1024;
const QUESTIONS_BUDGET_BYTES = 64 * 1024;
const QUESTION_BUDGET_BYTES = 8 * 1024;
const CHECK_LOG_BUDGET_BYTES = 160 * 1024;
const EVIDENCE_METADATA_BUDGET_BYTES = 16 * 1024;
/** What `src/db` keeps of one check stream. */
const OUTPUT_CAP_BYTES = 64 * 1024;

const open: Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

const CHECKS = ["install", "lint", "format", "typecheck", "test", "build"];
const base = "d".repeat(40);

/** Closeout attempts on `item`, each check failing with `stderr` at the stored cap. */
async function closeout(db: Database, item: string, attempts: number, checks: number, now: number) {
  const stderr = `error: expected 1 to be 2\n${"    at <anonymous> (src/loop/turn.test.ts:42:7)\n".repeat(OUTPUT_CAP_BYTES / 48)}`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const at = now + attempt;
    const identity = {
      taskId: item,
      base,
      head: String(attempt).repeat(40),
      policyDigest: "sha256:policy",
      policyPath: null,
    };
    for (const [ordinal, id] of CHECKS.slice(0, checks).entries()) {
      await upsertCloseoutStep(
        sqliteDb(db),
        item,
        identity,
        {
          id,
          kind: "command",
          state: "failed",
          command: `bun run ${id}`,
          detail: null,
          attempt,
          timeoutSeconds: null,
          startedAt: at,
          finishedAt: at,
          exitCode: 1,
          timedOut: false,
          timeoutReason: null,
          truncated: false,
          logPath: null,
          evidencePath: null,
          findings: `${id} failed`,
          ordinal,
        },
        at,
      );
      await appendCloseoutOutput(sqliteDb(db), item, identity, id, "stderr", stderr, false, at);
      await appendCloseoutOutput(sqliteDb(db), item, identity, id, "stdout", stderr, false, at);
    }
    await finishCloseoutProgress(sqliteDb(db), item, identity, "rejected", at);
  }
}

describe("status payload budget", () => {
  test("the list stays under 200 KB and an item detail under 1 MB with large check output", async () => {
    const db = openDatabase(":memory:");
    open.push(db);
    migrate(db);
    const now = Date.now() - 60 * 60 * 1000;
    for (let index = 0; index < 100; index += 1) {
      const id = `PAS-${1000 + index}`;
      insertQueuedItem(db, { id, title: `Finished item ${index}`, now: now + index });
      await beginImplementRun(sqliteDb(db), id, now + index);
      await closeout(db, id, 1, 2, now + index);
      applyWorkItemEvent(db, id, "cancel", { now: now + index + 10 });
    }
    for (let index = 0; index < 10; index += 1) {
      const id = `PAS-${2000 + index}`;
      insertQueuedItem(db, { id, title: `Open item ${index}`, now: now + index });
      await beginImplementRun(sqliteDb(db), id, now + index);
      await enterMergeQueue(sqliteDb(db), id, {
        phase: "merge_queue",
        baseSha: base,
        wipCommit: "c".repeat(40),
      });
      await closeout(db, id, 3, CHECKS.length, now + index);
      db.run(
        "INSERT INTO question (id, item_id, session_id, body, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)",
        [
          `q-${id}`,
          id,
          `session-${id}`,
          `Which retention window should exports use?\n\n${"Context. ".repeat(220)}`,
          now,
        ],
      );
    }

    const get = async (path: string) => {
      const response = (await handleStatusRequest(new Request(`http://127.0.0.1${path}`), {
        db,
        env: {},
        responseSizes: { record() {}, flush() {} },
      }))!;
      expect(response.status).toBe(200);
      return Buffer.byteLength(await response.text());
    };
    // The busiest issue: three attempts of six checks, each with capped `stdout` and `stderr`.
    expect(3 * CHECKS.length * 2 * OUTPUT_CAP_BYTES).toBeGreaterThan(DETAIL_BUDGET_BYTES);
    expect(await get("/api/issues")).toBeLessThanOrEqual(LIST_BUDGET_BYTES);
    expect(await get("/api/issues/PAS-2000")).toBeLessThanOrEqual(DETAIL_BUDGET_BYTES);
    expect(await get("/api/issues/PAS-1000")).toBeLessThanOrEqual(DETAIL_BUDGET_BYTES);
    const overviewBytes = await get("/api/overview");
    expect(overviewBytes).toBeLessThanOrEqual(OVERVIEW_BUDGET_BYTES);
    expect(overviewBytes * 10).toBeLessThan(await get("/api/issues"));
    expect(await get("/api/merge-queue")).toBeLessThanOrEqual(MERGE_QUEUE_BUDGET_BYTES);
    expect(await get("/api/questions")).toBeLessThanOrEqual(QUESTIONS_BUDGET_BYTES);
    expect(await get("/api/questions/q-PAS-2000")).toBeLessThanOrEqual(QUESTION_BUDGET_BYTES);
    expect(await get("/api/issues/PAS-2000/attempts/3/checks/test/log")).toBeLessThanOrEqual(
      CHECK_LOG_BUDGET_BYTES,
    );

    const live = createLiveStatusProvider(db, { env: {} });
    const calls: string[] = [];
    const provider = {
      issues: async () => (calls.push("issues"), await live.issues()),
      overview: async () => (calls.push("overview"), await live.overview()),
      checkLog: async (request: Parameters<typeof live.checkLog>[0]) => (
        calls.push("checkLog"),
        await live.checkLog(request)
      ),
    };
    const response = (await handleStatusRequest(new Request("http://127.0.0.1/api/issues"), {
      provider,
      responseSizes: { record() {}, flush() {} },
    }))!;
    const body = await response.text();
    expect(calls).toEqual(["issues"]);
    expect(body).not.toMatch(/"stdout"|"stderr"|expected 1 to be 2/);
    expect((JSON.parse(body) as { issues: unknown[] }).issues).toHaveLength(60);

    calls.length = 0;
    const overview = (await handleStatusRequest(new Request("http://127.0.0.1/api/overview"), {
      provider,
      responseSizes: { record() {}, flush() {} },
    }))!;
    const overviewBody = await overview.text();
    expect(calls).toEqual(["overview"]);
    expect(overviewBody).not.toMatch(/"stdout"|"stderr"|expected 1 to be 2/);
    expect((JSON.parse(overviewBody) as { issues: unknown[] }).issues).toHaveLength(10);
  });
});

describe("evidence gallery budget", () => {
  test("GET /api/evidence stays under 200 KB with eight files on each of the 60 listed issues", async () => {
    const db = openDatabase(":memory:");
    open.push(db);
    migrate(db);
    const now = Date.now();
    for (let index = 0; index < 110; index += 1) {
      const item = `PAS-${1000 + index}`;
      insertQueuedItem(db, { id: item, now: now - index });
      if (index >= 10) db.run("UPDATE work_item SET state = 'merged' WHERE id = ?", [item]);
      for (let file = 0; file < 8; file += 1)
        await saveEvidence(sqliteDb(db), {
          id: `01J${String(index).padStart(3, "0")}${file}`.padEnd(26, "Z"),
          itemId: item,
          runId: `run-${item}`,
          checkId: "visual-proof",
          attempt: 1,
          mediaType: file === 0 ? "video/webm" : "image/png",
          sizeBytes: 250_000,
          sha256: "0".repeat(64),
          displayName: `Runner card with three sessions · desktop ${file}.png`,
          headCommit: base,
          createdAt: now - index,
          assetUrl: null,
        });
    }
    const response = await handleStatusRequest(new Request("http://paws.test/api/evidence"), {
      provider: createLiveStatusProvider(db),
    });
    const body = await response!.text();
    expect(response!.status).toBe(200);
    expect((JSON.parse(body) as { evidence: unknown[] }).evidence).toHaveLength(480);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(LIST_BUDGET_BYTES);
    const metadata = await handleStatusRequest(
      new Request(`http://paws.test/api/evidence/${"01J0000".padEnd(26, "Z")}/metadata`),
      { provider: createLiveStatusProvider(db) },
    );
    expect(metadata!.status).toBe(200);
    expect(Buffer.byteLength(await metadata!.text())).toBeLessThanOrEqual(
      EVIDENCE_METADATA_BUDGET_BYTES,
    );
  });
});
