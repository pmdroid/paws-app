import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  accrueAwake,
  appendCloseoutOutput,
  applyWorkItemEvent,
  beginImplementRun,
  enqueueOutbox,
  enterMergeQueue,
  ensureCloseoutProgress,
  finishCloseoutProgress,
  insertQueuedItem,
  markRun,
  migrate,
  openDatabase,
  saveCheckpoint,
  upsertCloseoutStep,
  type CloseoutProgressIdentity,
  type CloseoutStepWrite,
} from "../src/db";
import { handleStatusRequest } from "../src/web";
import { render, type RenderModel } from "../src/web/src/client/render";
import { createLiveStatusProvider } from "../src/web/src/live/provider";
import type { StatusSnapshot, StatusVerdict } from "../src/web/src/contract";

const open: Database[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of open) db.close();
  open.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function database(file?: string): Database {
  const db = openDatabase(file ?? ":memory:");
  migrate(db);
  open.push(db);
  return db;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paws-74-ui-"));
  dirs.push(dir);
  return dir;
}

function sha(char: string): string {
  return char.repeat(40);
}

function policy(char: string): string {
  return `sha256:${char.repeat(64)}`;
}

function identity(
  taskId: string,
  head: string,
  digest: string,
  base = sha("c"),
): CloseoutProgressIdentity {
  return {
    taskId,
    base,
    head,
    policyDigest: digest,
    policyPath: ".agents/closeout.yaml",
  };
}

function step(
  id: string,
  state: CloseoutStepWrite["state"],
  patch: Partial<CloseoutStepWrite> = {},
): CloseoutStepWrite {
  return {
    id,
    kind: "command",
    state,
    command: "bun test",
    detail: null,
    attempt: 1,
    timeoutSeconds: 30,
    startedAt: 1,
    finishedAt: state === "running" || state === "pending" ? null : 2,
    exitCode: state === "passed" ? 0 : null,
    timedOut: false,
    timeoutReason: null,
    truncated: false,
    logPath: null,
    evidencePath: null,
    findings: null,
    ordinal: 0,
    ...patch,
  };
}

function portable(
  kind: "logs" | "evidence",
  digest: string,
  head: string,
  checkId: string,
): string {
  const hex = digest.slice("sha256:".length);
  const ext = kind === "logs" ? "log" : "json";
  return `${kind}/${hex}/${head}/${checkId}/1.${ext}`;
}

function seedVerifying(db: Database, id: string, head: string, now: number): void {
  const started = beginImplementRun(db, id, now, {
    phase: "verifying",
    baseSha: sha("c"),
    wipCommit: head,
  });
  markRun(db, started.run.id, "ended", now);
  applyWorkItemEvent(db, id, "turn_ended");
  saveCheckpoint(db, id, { phase: "verifying", baseSha: sha("c"), wipCommit: head });
}

function acceptVerdict(db: Database, id: string, head: string, body: string, now: number): void {
  enqueueOutbox(db, {
    target: "linear",
    op: "activity",
    orderingKey: "session",
    idempotencyKey: `${id}:verdict:${head}:accepted`,
    payload: { sessionId: "session", kind: "response", body },
    now,
  });
}

function snapshotOf(db: Database, now: number, env: NodeJS.ProcessEnv = {}): StatusSnapshot {
  return createLiveStatusProvider(db, { now: () => new Date(now), env }).snapshot();
}

function verdictOf(snapshot: StatusSnapshot, id: string): StatusVerdict {
  const verdict = snapshot.verdicts.find((entry) => entry.itemId === id);
  if (verdict === undefined) throw new Error(`missing verdict ${id}`);
  return verdict;
}

function paint(snapshot: StatusSnapshot, id: string, checkId: string): string {
  const item = snapshot.items.find((entry) => entry.id === id);
  const runId =
    item?.runId && snapshot.runs.some((run) => run.id === item.runId)
      ? item.runId
      : snapshot.runs.find((run) => run.itemId === id)?.id;
  if (!runId) throw new Error(`missing run for ${id}`);
  const model: RenderModel = {
    route: { view: "runs", id: runId },
    phase: "ready",
    snapshot,
    via: "engine",
    error: null,
    engineUrl: "http://127.0.0.1:8787",
    selectedCheck: { itemId: id, checkId },
  };
  return render(model).content;
}

describe("live closeout ui", () => {
  test("a paused task retains its status when its prior session is lost", () => {
    const db = database();
    const id = "ENG-302";
    insertQueuedItem(db, { id });
    const { run } = beginImplementRun(db, id, 1);
    applyWorkItemEvent(db, id, "pause");
    markRun(db, run.id, "lost", 2);
    expect(snapshotOf(db, 3).runs.find((entry) => entry.itemId === id)?.state).toBe("paused");
  });

  test("a cap during verification shows the stopped run and its reason", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const id = "ENG-302";
    insertQueuedItem(db, { id, title: "Capped repair", maxAwakeMs: 1_000, now });
    seedVerifying(db, id, sha("b"), now);
    accrueAwake(db, id, 0, now);
    accrueAwake(db, id, 1_000, now + 1_000);
    const run = snapshotOf(db, now + 1_000).runs.find((entry) => entry.itemId === id);
    expect(run?.state).toBe("stopped");
    expect(run?.summary).toBe("Run hit the awake time cap (1 min).");
    expect(run?.activity.at(-1)?.kind).toBe("err");
  });

  test("shows streamed checks before closeout finishes", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const id = "ENG-74";
    const head = sha("b");
    insertQueuedItem(db, { id, title: "Live closeout", now });
    seedVerifying(db, id, head, now);
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "session",
      idempotencyKey: `${id}:note:done`,
      payload: {
        sessionId: "session",
        kind: "response",
        body: "Implementation finished. The completed response remains visible while Closeout checks run.",
      },
      now,
    });
    const current = identity(id, head, policy("b"));
    ensureCloseoutProgress(db, id, current, now, true);
    upsertCloseoutStep(
      db,
      id,
      current,
      step("typecheck", "running", {
        logPath: portable("logs", policy("b"), head, "typecheck"),
        evidencePath: portable("evidence", policy("b"), head, "typecheck"),
      }),
      now + 1,
    );
    appendCloseoutOutput(
      db,
      id,
      current,
      "typecheck",
      "stdout",
      "line one\n<script>alert(1)</script>\nline two",
      false,
      now + 2,
    );

    const snapshot = snapshotOf(db, now + 3);
    const verdict = verdictOf(snapshot, id);
    expect(verdict.decision).toBe("running");
    expect(verdict.sealed).toBe(false);
    expect(verdict.headSha).toBe(head);
    expect(verdict.checks.map((check) => [check.id, check.state, check.stdout])).toEqual([
      ["typecheck", "running", "line one\n<script>alert(1)</script>\nline two"],
    ]);
    const run = snapshot.runs.find((entry) => entry.itemId === id);
    expect(run?.activity.some((line) => line.text.includes("Implementation finished"))).toBe(true);
    const html = paint(snapshot, id, "typecheck");
    expect(html).toContain("Implementation finished. Closeout is verifying this candidate.");
    expect(html).toContain("The task is not complete.");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("line one");
    expect(html).toContain("line two");
    expect(html).toContain('data-log="ENG-74:typecheck:stdout"');
    expect(html).not.toContain("/api/closeout-artifact?");
    expect(html).toContain("Download log");
    expect(html).toContain('aria-current="true"');
  });

  test("keeps a merge-queue recheck running until the new decision is stored", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const id = "ENG-75";
    const oldHead = sha("a");
    const newHead = sha("d");
    insertQueuedItem(db, { id, title: "Recheck", now });
    beginImplementRun(db, id, now, {
      phase: "merge_queue",
      baseSha: sha("c"),
      wipCommit: oldHead,
    });
    enterMergeQueue(db, id, { phase: "merge_queue", baseSha: sha("c"), wipCommit: oldHead });
    const accepted = [
      "Closeout: accepted",
      `Task: ${id}`,
      `Base: ${sha("c")}`,
      `Head: ${oldHead}`,
      "Fix attempts: 0",
      "Evaluations: 1",
      "Exit: 0",
      "Items:",
      "- stale-check (command): passed attempt 1 — previous candidate",
    ].join("\n");
    acceptVerdict(db, id, oldHead, accepted, now + 1);
    const previous = identity(id, oldHead, policy("a"));
    ensureCloseoutProgress(db, id, previous, now + 1, true);
    upsertCloseoutStep(db, id, previous, step("stale-check", "passed"), now + 2);
    finishCloseoutProgress(db, id, previous, "accepted", now + 3);

    const current = identity(id, newHead, policy("b"));
    ensureCloseoutProgress(db, id, current, now + 4, true);
    upsertCloseoutStep(db, id, current, step("recheck", "pending"), now + 5);
    upsertCloseoutStep(db, id, current, step("recheck", "running"), now + 6);

    const running = verdictOf(snapshotOf(db, now + 7), id);
    expect(running.decision).toBe("running");
    expect(running.summary).toBe("Closeout is running.");
    expect(running.summary).not.toContain("Closeout: accepted");
    expect(running.headSha).toBe(newHead);
    expect(running.policyDigest).toBe(policy("b"));
    expect(running.checks.map((check) => check.id)).toEqual(["recheck"]);
    const runningHtml = paint(snapshotOf(db, now + 7), id, "recheck");
    expect(runningHtml).toContain("Implementation finished. Closeout is verifying this candidate.");
    expect(runningHtml).not.toContain("Closeout accepted. Waiting to merge.");

    upsertCloseoutStep(db, id, current, step("recheck", "failed", { exitCode: 1 }), now + 8);
    finishCloseoutProgress(db, id, current, "rejected", now + 9);
    const finished = verdictOf(snapshotOf(db, now + 10), id);
    expect(finished.decision).toBe("rejected");
    expect(finished.summary).toBe("Closeout rejected.");
    expect(finished.headSha).toBe(newHead);
    expect(finished.checks.map((check) => [check.id, check.state])).toEqual([
      ["recheck", "failed"],
    ]);
  });

  test("does not attach an older accepted verdict to another candidate or policy", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const id = "ENG-76";
    const oldHead = sha("a");
    const newHead = sha("e");
    insertQueuedItem(db, { id, title: "Fixer", now });
    seedVerifying(db, id, oldHead, now);
    const accepted = [
      "Closeout: accepted",
      `Head: ${oldHead}`,
      "Items:",
      "- stale-check (command): passed attempt 1 — old head",
    ].join("\n");
    acceptVerdict(db, id, oldHead, accepted, now + 1);
    const stale = identity(id, oldHead, policy("a"));
    ensureCloseoutProgress(db, id, stale, now + 10, true);
    upsertCloseoutStep(db, id, stale, step("stale-check", "passed"), now + 11);
    finishCloseoutProgress(db, id, stale, "accepted", now + 50);
    const fresh = identity(id, newHead, policy("b"));
    ensureCloseoutProgress(db, id, fresh, now + 12, true);
    upsertCloseoutStep(
      db,
      id,
      fresh,
      step("fresh-check", "running", { startedAt: now + 13 }),
      now + 13,
    );

    const verdict = verdictOf(snapshotOf(db, now + 14), id);
    expect(verdict.decision).toBe("running");
    expect(verdict.headSha).toBe(newHead);
    expect(verdict.policyDigest).toBe(policy("b"));
    expect(verdict.checks.map((check) => check.id)).toEqual(["fresh-check"]);
    expect(verdict.summary).not.toContain("stale-check");
    expect(verdict.summary).not.toContain("Closeout: accepted");

    upsertCloseoutStep(db, id, fresh, step("fresh-check", "failed", { exitCode: 1 }), now + 60);
    finishCloseoutProgress(db, id, fresh, "rejected", now + 61);
    const settled = verdictOf(snapshotOf(db, now + 62), id);
    expect(settled.decision).toBe("rejected");
    expect(settled.headSha).toBe(newHead);
    expect(settled.policyDigest).toBe(policy("b"));
    expect(settled.summary).toBe("Closeout rejected.");
    expect(settled.checks.map((check) => check.id)).toEqual(["fresh-check"]);
  });

  test("serves only the named log or evidence file and redacts secrets", async () => {
    const db = database();
    const root = tempDir();
    const evidence = join(root, "closeout", "evidence");
    const now = 1_700_000_000_000;
    const id = "ENG-77";
    const other = "ENG-78";
    const head = sha("f");
    const digest = policy("c");
    const secret = "super-secret-token-value";
    const pat = `github_pat_${"p".repeat(24)}`;
    const ghp = `ghp_${"g".repeat(24)}`;
    insertQueuedItem(db, { id, title: "Artifacts", now });
    insertQueuedItem(db, { id: other, title: "Other", now: now + 1 });
    seedVerifying(db, id, head, now);
    seedVerifying(db, other, head, now);
    const current = identity(id, head, digest);
    const logRel = portable("logs", digest, head, "typecheck");
    const evidenceRel = portable("evidence", digest, head, "typecheck");
    ensureCloseoutProgress(db, id, current, now, true);
    upsertCloseoutStep(
      db,
      id,
      current,
      step("typecheck", "running", { logPath: logRel, evidencePath: evidenceRel }),
      now + 1,
    );
    const otherIdentity = identity(other, head, digest);
    ensureCloseoutProgress(db, other, otherIdentity, now, true);
    upsertCloseoutStep(
      db,
      other,
      otherIdentity,
      step("typecheck", "running", {
        logPath: portable("logs", digest, head, "typecheck"),
      }),
      now + 1,
    );
    const taskDir = join(evidence, id);
    const logFile = join(taskDir, ...logRel.split("/"));
    const evidenceFile = join(taskDir, ...evidenceRel.split("/"));
    mkdirSync(join(logFile, ".."), { recursive: true });
    mkdirSync(join(evidenceFile, ".."), { recursive: true });
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside-secret-value");
    writeFileSync(logFile, `token ${secret}\n${pat}\n${ghp}\nline two\n`);
    writeFileSync(evidenceFile, `{"note":"${secret}"}\n`);
    appendCloseoutOutput(
      db,
      id,
      current,
      "typecheck",
      "stdout",
      `seen ${secret}\n`,
      false,
      now + 2,
    );
    const otherFile = join(evidence, other, ...logRel.split("/"));
    mkdirSync(join(otherFile, ".."), { recursive: true });
    writeFileSync(otherFile, "other-only\n");
    const linkedRel = portable("logs", digest, head, "linked").replace("/1.log", "/2.log");
    const link = join(taskDir, ...linkedRel.split("/"));
    mkdirSync(join(link, ".."), { recursive: true });
    symlinkSync(outside, link);
    upsertCloseoutStep(
      db,
      id,
      current,
      step("linked", "running", {
        attempt: 2,
        ordinal: 1,
        logPath: linkedRel,
      }),
      now + 2,
    );
    upsertCloseoutStep(
      db,
      id,
      current,
      step("escape", "running", {
        attempt: 1,
        ordinal: 2,
        logPath: "logs/../../outside.txt",
      }),
      now + 2,
    );

    const env = { API_KEY: secret };
    const read = (
      query: string,
      home: { evidenceRoot?: string; closeoutHome?: string } = { closeoutHome: root },
    ) =>
      handleStatusRequest(new Request(`http://127.0.0.1/api/closeout-artifact?${query}`), {
        db,
        env,
        staticDir: null,
        ...home,
      });
    const params = new URLSearchParams({
      item: id,
      check: "typecheck",
      kind: "log",
      head,
      policy: digest,
    });
    const log = await read(params.toString());
    expect(log?.status).toBe(200);
    const logBody = await log?.text();
    expect(logBody).toContain("[redacted]");
    expect(logBody).toContain("line two");
    expect(logBody).not.toContain(secret);
    expect(logBody).not.toContain("other-only");
    expect(logBody).not.toContain(pat);
    expect(logBody).not.toContain(ghp);
    expect(log?.headers.get("x-content-type-options")).toBe("nosniff");

    const evidenceParams = new URLSearchParams(params);
    evidenceParams.set("kind", "evidence");
    const evidenceResponse = await read(evidenceParams.toString());
    expect(evidenceResponse?.status).toBe(200);
    expect(await evidenceResponse?.text()).not.toContain(secret);

    const direct = new URLSearchParams(params);
    const fromEvidenceRoot = await read(direct.toString(), { evidenceRoot: evidence });
    expect(fromEvidenceRoot?.status).toBe(200);

    const wrongPolicy = new URLSearchParams(params);
    wrongPolicy.set("policy", policy("d"));
    expect((await read(wrongPolicy.toString()))?.status).toBe(404);
    const wrongHead = new URLSearchParams(params);
    wrongHead.set("head", sha("9"));
    expect((await read(wrongHead.toString()))?.status).toBe(404);
    const wrongItem = new URLSearchParams(params);
    wrongItem.set("item", other);
    const otherLog = await read(wrongItem.toString());
    expect(otherLog?.status).toBe(200);
    expect(await otherLog?.text()).toBe("other-only\n");
    const symlink = new URLSearchParams({
      item: id,
      check: "linked",
      kind: "log",
      head,
      policy: digest,
    });
    const escaped = await read(symlink.toString());
    expect(escaped?.status).toBe(404);
    expect(await escaped?.text()).not.toContain("outside-secret-value");
    const linkedTask = "ENG-SYMLINK";
    insertQueuedItem(db, { id: linkedTask, now });
    const linkedIdentity = identity(linkedTask, head, digest);
    ensureCloseoutProgress(db, linkedTask, linkedIdentity, now, true);
    upsertCloseoutStep(
      db,
      linkedTask,
      linkedIdentity,
      step("typecheck", "passed", { logPath: logRel }),
      now + 1,
    );
    symlinkSync(taskDir, join(evidence, linkedTask), "dir");
    const crossTask = new URLSearchParams(params);
    crossTask.set("item", linkedTask);
    expect((await read(crossTask.toString()))?.status).toBe(404);
    const otherPolicyPath = portable("logs", policy("d"), head, "wrong-policy-path");
    const otherPolicyFile = join(taskDir, ...otherPolicyPath.split("/"));
    mkdirSync(join(otherPolicyFile, ".."), { recursive: true });
    writeFileSync(otherPolicyFile, "another policy's output");
    upsertCloseoutStep(
      db,
      id,
      current,
      step("wrong-policy-path", "passed", { logPath: otherPolicyPath }),
      now + 1,
    );
    const crossPolicy = new URLSearchParams(params);
    crossPolicy.set("check", "wrong-policy-path");
    expect((await read(crossPolicy.toString()))?.status).toBe(404);
    const traversal = new URLSearchParams({
      item: id,
      check: "escape",
      kind: "log",
      head,
      policy: digest,
    });
    expect((await read(traversal.toString()))?.status).toBe(404);
    expect((await read(params.toString(), {}))?.status).toBe(404);

    const bulky = Buffer.alloc(300 * 1024, 0x61);
    bulky.write(`${secret}\n`);
    writeFileSync(logFile, bulky);
    const capped = await read(params.toString());
    const cappedBody = (await capped?.text()) ?? "";
    expect(cappedBody.length).toBeLessThanOrEqual(256 * 1024);
    expect(cappedBody).not.toContain(secret);
    expect(cappedBody).toContain("[redacted]");

    const live = verdictOf(snapshotOf(db, now + 3, env), id);
    const streamed = live.checks.find((check) => check.id === "typecheck")?.stdout ?? "";
    expect(streamed).toContain("[redacted]");
    expect(streamed).not.toContain(secret);
  });

  test("reopens a persisted database without replaying closeout", () => {
    const dir = tempDir();
    const file = join(dir, "status.db");
    const now = 1_700_000_000_000;
    const id = "ENG-79";
    const head = sha("1");
    const first = database(file);
    insertQueuedItem(first, { id, title: "Persisted", now });
    seedVerifying(first, id, head, now);
    const current = identity(id, head, policy("1"));
    ensureCloseoutProgress(first, id, current, now, true);
    upsertCloseoutStep(first, id, current, step("typecheck", "passed"), now + 1);
    appendCloseoutOutput(
      first,
      id,
      current,
      "typecheck",
      "stdout",
      "kept line\nsecond line",
      false,
      now + 2,
    );
    finishCloseoutProgress(first, id, current, "accepted", now + 3);
    const before = verdictOf(snapshotOf(first, now + 4), id);
    first.close();
    open.pop();

    const again = database(file);
    const after = verdictOf(snapshotOf(again, now + 5), id);
    expect(after.decision).toBe("accepted");
    expect(after.headSha).toBe(before.headSha);
    expect(after.checks.map((check) => [check.id, check.state, check.stdout])).toEqual(
      before.checks.map((check) => [check.id, check.state, check.stdout]),
    );
    expect(after.checks[0]?.stdout).toBe("kept line\nsecond line");
    const html = paint(snapshotOf(again, now + 5), id, "typecheck");
    expect(html).toContain("kept line");
    expect(html).toContain("second line");
    expect(html).not.toContain("<script>");
  });
});
