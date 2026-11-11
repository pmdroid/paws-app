import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listCloseoutRecoveries,
  listJobs,
  listOpenPolicyBlocks,
  migrate,
  openDatabase,
  saveCheckpoint,
  sqliteDb,
} from "../db";
import { findOpenQuestion, getQuestion } from "../questions";
import { askCloseoutHelp, type CloseoutHelp } from "./closeout-help";
import { recoveryOptions } from "./closeout-recovery";
import {
  policyBlockedRepositories,
  POLICY_BLOCK_CHECK_MS,
  retryPolicyBlocks,
} from "./policy-block";
import { policyOutageNote, type MainPolicyError } from "./policy-outage";

const NOW = 1_700_000_000_000;
const REPOSITORY = "acme/monorepo";
const FIXED = "f1".padEnd(40, "0");
const BROKEN: MainPolicyError = {
  message: ".agents/closeout.yaml: /rules/0 must have required property 'probe'",
  path: ".agents/closeout.yaml",
  main: "a".repeat(40),
  commit: "c0ffee".padEnd(40, "0"),
};
const LOADS = { digest: "sha256:fixed", recheck: "" };
const UNREADABLE = { ok: false as const, ...BROKEN };

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database() {
  const db = openDatabase(":memory:");
  migrate(db);
  open.push(db);
  return db;
}

function parked(db: Database, id: string) {
  insertQueuedItem(db, { id, sessionKey: `ses-${id}`, now: NOW });
  beginImplementRun(db, id, NOW);
  applyWorkItemEvent(db, id, "blocking_question");
  saveCheckpoint(db, id, { phase: "awaiting_input", baseSha: "base", wipCommit: "head" });
}

function help(id: string): CloseoutHelp {
  return {
    itemId: id,
    taskId: id,
    base: "base",
    head: "head",
    policyDigest: "",
    failedChecks: [],
    retryBaseline: ["test:1"],
    summary: `Closeout: blocked\nMessage: ${BROKEN.message}`,
  };
}

async function blockedOnMain(db: Database, id: string, repository = REPOSITORY) {
  parked(db, id);
  await askCloseoutHelp(db, `ses-${id}`, help(id), {
    now: NOW,
    reason: "blocked_check",
    error: await policyOutageNote(db, repository, id, null, BROKEN),
    checks: [],
    policyBlock: { repository, unreadable: BROKEN },
  });
  return question(db, id);
}

function question(db: Database, id: string) {
  return getQuestion(db, listCloseoutRecoveries(db, id).at(-1)!.questionId)!;
}

const reverifies = (db: Database) =>
  listJobs(db)
    .filter((job) => job.queue === JOB_KIND.reverify)
    .map((job) => job.jobKey);

const retry = async (db: Database, policy: Parameters<typeof retryPolicyBlocks>[1]["policy"]) =>
  await retryPolicyBlocks(db, { repository: REPOSITORY, main: FIXED, policy, now: NOW + 100 });

describe("a closeout-help question blocked by an unreadable policy on main", () => {
  test("records the cause and says Paws retries by itself", async () => {
    const db = database();
    const asked = await blockedOnMain(db, "ENG-1");
    expect(await listOpenPolicyBlocks(sqliteDb(db), REPOSITORY)).toEqual([
      {
        questionId: asked.id,
        itemId: "ENG-1",
        repository: REPOSITORY,
        cause: "policy_unreadable",
        error: BROKEN.message,
        policyPath: BROKEN.path,
        main: BROKEN.main,
        changedBy: BROKEN.commit,
        createdAt: NOW,
      },
    ]);
    expect(asked.body).toContain("The Closeout policy on main doesn't load");
    expect(asked.body).toContain(`Commit ${BROKEN.commit} last changed \`${BROKEN.path}\`.`);
    expect(
      asked.body.endsWith(
        "Paws retries by itself once main's policy loads. You don't need to reply.",
      ),
    ).toBe(true);
    expect(await policyBlockedRepositories(sqliteDb(db))).toEqual([
      { repository: REPOSITORY, itemId: "ENG-1" },
    ]);
    expect(POLICY_BLOCK_CHECK_MS).toBeLessThanOrEqual(5 * 60_000);
  });

  test("is answered as retry by Paws once main's policy loads, and re-verifies without the agent", async () => {
    const db = database();
    const asked = await blockedOnMain(db, "ENG-1");
    expect(await retry(db, LOADS)).toEqual([asked.id]);
    expect(getQuestion(db, asked.id)).toMatchObject({
      status: "answered",
      answer: "Answered by Paws: the policy on main loads again at f100000.",
      answeredBy: "paws",
    });
    expect(getWorkItem(db, "ENG-1")?.state).toBe("verifying");
    expect(reverifies(db)).toEqual([`retry-closeout:${asked.id}`]);
    expect(listJobs(db).filter((job) => job.queue === JOB_KIND.resume)).toEqual([]);
    expect((await recoveryOptions(db, "ENG-1")).retryBaseline).toEqual([]);
    expect(await policyBlockedRepositories(sqliteDb(db))).toEqual([]);
  });

  test("one fix on main retries every item blocked in that repository, and no other", async () => {
    const db = database();
    const first = await blockedOnMain(db, "ENG-1");
    const second = await blockedOnMain(db, "ENG-2");
    const elsewhere = await blockedOnMain(db, "ENG-3", "acme/website");
    expect(await retry(db, LOADS)).toEqual([first.id, second.id]);
    expect(getWorkItem(db, "ENG-1")?.state).toBe("verifying");
    expect(getWorkItem(db, "ENG-2")?.state).toBe("verifying");
    expect(getQuestion(db, elsewhere.id)?.status).toBe("open");
  });

  test("a new question after the retry is a normal one, and the old one is not retried again", async () => {
    const db = database();
    const asked = await blockedOnMain(db, "ENG-1");
    await retry(db, LOADS);
    applyWorkItemEvent(db, "ENG-1", "blocking_question");
    await askCloseoutHelp(
      db,
      "ses-ENG-1",
      { ...help("ENG-1"), summary: "Closeout: blocked\nMessage: runner lost" },
      {
        now: NOW + 200,
        reason: "blocked_check",
        checks: [],
      },
    );
    const next = findOpenQuestion(db, "ses-ENG-1")!;
    expect(next.id).not.toBe(asked.id);
    expect(next.body).not.toContain("Paws retries by itself");
    expect(await retry(db, LOADS)).toEqual([]);
    expect(findOpenQuestion(db, "ses-ENG-1")?.id).toBe(next.id);
    expect(getQuestion(db, asked.id)?.answeredAt).toBe(NOW + 100);
    expect(reverifies(db)).toEqual([`retry-closeout:${asked.id}`]);
  });

  test("with main still broken, the check retries nothing", async () => {
    const db = database();
    const asked = await blockedOnMain(db, "ENG-1");
    expect(await retry(db, UNREADABLE)).toEqual([]);
    expect(await retry(db, null)).toEqual([]);
    expect(getQuestion(db, asked.id)?.status).toBe("open");
    expect(getWorkItem(db, "ENG-1")?.state).toBe("awaiting_input");
    expect(reverifies(db)).toEqual([]);
  });

  test("a closeout-help question with another cause is never answered by Paws", async () => {
    const db = database();
    parked(db, "ENG-1");
    await askCloseoutHelp(db, "ses-ENG-1", help("ENG-1"), {
      now: NOW,
      reason: "blocked_check",
      checks: [],
    });
    const asked = question(db, "ENG-1");
    expect(asked.options).toEqual(["Retry Closeout"]);
    expect(await retry(db, LOADS)).toEqual([]);
    expect(getQuestion(db, asked.id)?.status).toBe("open");
    expect(getWorkItem(db, "ENG-1")?.state).toBe("awaiting_input");
  });
});
