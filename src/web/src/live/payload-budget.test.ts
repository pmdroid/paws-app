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
  openDatabase,
  upsertCloseoutStep,
} from "../../../db";
import { handleStatusRequest } from "../engine";

/** The budget in `docs/status-payload.md`. */
const LIST_BUDGET_BYTES = 200 * 1024;
const DETAIL_BUDGET_BYTES = 1024 * 1024;
/** What `src/db` keeps of one check stream. */
const OUTPUT_CAP_BYTES = 64 * 1024;

const open: Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

const CHECKS = ["install", "lint", "format", "typecheck", "test", "build"];
const base = "d".repeat(40);

/** Closeout attempts on `item`, each check failing with `stderr` at the stored cap. */
function closeout(db: Database, item: string, attempts: number, checks: number, now: number) {
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
      upsertCloseoutStep(
        db,
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
      appendCloseoutOutput(db, item, identity, id, "stderr", stderr, false, at);
      appendCloseoutOutput(db, item, identity, id, "stdout", stderr, false, at);
    }
    finishCloseoutProgress(db, item, identity, "rejected", at);
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
      beginImplementRun(db, id, now + index);
      closeout(db, id, 1, 2, now + index);
      applyWorkItemEvent(db, id, "cancel", { now: now + index + 10 });
    }
    for (let index = 0; index < 10; index += 1) {
      const id = `PAS-${2000 + index}`;
      insertQueuedItem(db, { id, title: `Open item ${index}`, now: now + index });
      beginImplementRun(db, id, now + index);
      enterMergeQueue(db, id, { phase: "merge_queue", baseSha: base, wipCommit: "c".repeat(40) });
      closeout(db, id, 3, CHECKS.length, now + index);
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
    const list = await get("/api/status");
    expect(list).toBeLessThanOrEqual(LIST_BUDGET_BYTES);
    // The busiest issue: three attempts of six checks, each with capped `stdout` and `stderr`.
    expect(3 * CHECKS.length * 2 * OUTPUT_CAP_BYTES).toBeGreaterThan(DETAIL_BUDGET_BYTES);
    const detail = await get("/api/status/items/PAS-2000");
    expect(detail).toBeLessThanOrEqual(DETAIL_BUDGET_BYTES);
    expect(await get("/api/status/items/PAS-1000")).toBeLessThanOrEqual(DETAIL_BUDGET_BYTES);
  });
});
