import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  applyWorkItemEvent,
  approveCloseoutBypassChecks,
  beginImplementRun,
  closeLinkAsk,
  enqueueOutbox,
  finishCloseoutProgress,
  insertLinkAsk,
  insertQueuedItem,
  migrate,
  openDatabase,
  saveCloseoutBypassChecks,
  upsertCloseoutStep,
  type CloseoutStepWrite,
} from "../../../db";
import { parseStatusItemDetail, parseStatusSnapshot } from "../contract";
import { handleStatusRequest } from "../engine";
import { createLiveStatusProvider } from "./provider";

const open: Database[] = [];
const homes: string[] = [];

afterEach(() => {
  for (const db of open) db.close();
  open.length = 0;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;
const BASE = "d".repeat(40);
const HEAD = "c".repeat(40);
const DIGEST = "sha256:" + "e".repeat(64);
const PROBE_SHA = "sha256:" + "a".repeat(64);

/**
 * A fake Closeout result as `src/closeout-spec` writes it: one command check, then each rule's
 * probe as a command step with `probeArgv`, an evidence record listing the probe's hash, a rule
 * whose paths matched nothing, and the bypass ask Paws opened for the failed rules.
 */
function seed(): { db: Database; home: string } {
  const db = openDatabase(":memory:");
  migrate(db);
  open.push(db);
  const home = mkdtempSync(join(tmpdir(), "paws-rules-"));
  homes.push(home);
  const item = insertQueuedItem(db, { id: "ENG-7", title: "Rules", sessionKey: "ses_7", now: NOW });
  beginImplementRun(db, item.id, NOW);
  applyWorkItemEvent(db, item.id, "blocking_question");
  const identity = {
    taskId: item.id,
    base: BASE,
    head: HEAD,
    policyDigest: DIGEST,
    policyPath: ".agents/closeout.yaml",
  };
  const hex = DIGEST.slice("sha256:".length);
  const step = (
    id: string,
    state: CloseoutStepWrite["state"],
    ordinal: number,
    rule: boolean,
    exitCode: number | null,
  ): CloseoutStepWrite => ({
    id,
    kind: "command",
    state,
    command: rule
      ? `bun .agents/probes/${id}.ts --base ${BASE} --head ${HEAD} --repo .`
      : "bun run test",
    detail: state === "skipped" ? "no changed path matches" : null,
    attempt: state === "skipped" ? 0 : 1,
    timeoutSeconds: 120,
    startedAt: NOW,
    finishedAt: NOW + 1_200,
    exitCode,
    timedOut: false,
    timeoutReason: null,
    truncated: false,
    logPath: state === "skipped" ? null : `logs/${hex}/${HEAD}/${id}/1.log`,
    evidencePath: state === "skipped" ? null : `evidence/${hex}/${HEAD}/${id}/1.json`,
    findings: null,
    ordinal,
    durationMs: 1_200,
  });
  const steps = [
    step("api-contract", "failed", 0, true, 1),
    step("migrations-append-only", "passed", 1, true, 0),
    step("restart-and-ask-from-loop", "failed", 2, true, 1),
    step("runner-protocol-docs", "skipped", 3, true, null),
    step("test", "passed", 4, false, 0),
  ];
  for (const entry of steps) {
    upsertCloseoutStep(db, item.id, identity, entry, NOW);
    if (entry.evidencePath === null) continue;
    const file = join(home, "closeout", "evidence", item.id, ...entry.evidencePath.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        recordType: "command",
        itemId: entry.id,
        artifacts: [
          { path: entry.logPath, sha256: "sha256:" + "f".repeat(64) },
          ...(entry.command.includes("--repo .")
            ? [{ path: `probes/${PROBE_SHA}/${entry.id}.ts`, sha256: PROBE_SHA }]
            : []),
        ],
      }),
    );
  }
  finishCloseoutProgress(db, item.id, identity, "exhausted", NOW + 2_000);
  enqueueOutbox(db, {
    target: "linear",
    op: "activity",
    orderingKey: "ses_7",
    idempotencyKey: `${item.id}:verdict:${HEAD}:exhausted`,
    payload: {
      sessionId: "ses_7",
      kind: "response",
      body: "Closeout: exhausted\nItems:\n- api-contract (rule): failed attempt 1 — probe exited 1; P1 finding: No removed field.",
    },
    now: NOW + 2_000,
  });
  const ask = (questionId: string, checkId: string, at: number, status: string) => {
    db.run(
      "INSERT INTO question (id, item_id, session_id, kind, body, status, created_at) VALUES (?, ?, 'ses_7', 'link', 'Closeout needs your decision', ?, ?)",
      [questionId, item.id, status, at],
    );
    insertLinkAsk(db, {
      questionId,
      itemId: item.id,
      kind: "bypass",
      headCommit: HEAD,
      link: `https://paws.example/status/issues/ENG-7#closeout`,
      title: "Closeout needs your decision.",
      detail: `Closeout stopped: ${checkId} failed.`,
      answerers: ["delegator"],
      createdAt: at,
    });
    saveCloseoutBypassChecks(db, questionId, [
      { id: checkId, kind: "rule", state: "failed", attempt: 1, message: "probe exited 1" },
    ]);
  };
  ask("q-bypassed", "restart-and-ask-from-loop", NOW + 3_000, "answered");
  approveCloseoutBypassChecks(db, "q-bypassed", {
    checks: [{ checkId: "restart-and-ask-from-loop", reason: "The loop owns this call already." }],
    approvedBy: "user-1",
    approvedByName: "Ada Lovelace",
    now: NOW + 4_000,
  });
  closeLinkAsk(db, "q-bypassed", { reason: "cancelled", now: NOW + 4_000 });
  ask("q-waiting", "api-contract", NOW + 5_000, "open");
  return { db, home };
}

describe("rule results in the status payload", () => {
  test("the list summarizes each rule as a check of kind rule", async () => {
    const { db, home } = seed();
    const response = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      db,
      env: {},
      closeoutHome: home,
    });
    const parsed = parseStatusSnapshot(await response!.json());
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.snapshot.verdicts[0]?.checks).toEqual([
      { id: "api-contract", kind: "rule", state: "failed" },
      { id: "migrations-append-only", kind: "rule", state: "passed" },
      { id: "restart-and-ask-from-loop", kind: "rule", state: "failed" },
      { id: "test", kind: "command", state: "passed" },
    ]);
  });

  test("the item detail carries each rule's probe hash, exit code, duration and decision", async () => {
    const { db, home } = seed();
    const response = await handleStatusRequest(
      new Request("http://127.0.0.1/api/status/items/ENG-7"),
      { db, env: {}, closeoutHome: home },
    );
    const parsed = parseStatusItemDetail(await response!.json());
    if (!parsed.ok) throw new Error(parsed.error);
    const verdict = parsed.detail.verdicts[0]!;
    const rules = verdict.checks.filter((check) => check.kind === "rule");
    expect(
      rules.map((rule) => [rule.id, rule.state, rule.probeSha256, rule.exitCode, rule.elapsedMs]),
    ).toEqual([
      ["api-contract", "failed", PROBE_SHA, 1, 1_200],
      ["migrations-append-only", "passed", PROBE_SHA, 0, 1_200],
      ["restart-and-ask-from-loop", "failed", PROBE_SHA, 1, 1_200],
    ]);
    expect(rules[0]?.approval).toEqual({
      state: "waiting",
      questionId: "q-waiting",
      head: HEAD,
      by: null,
      reason: null,
      at: null,
    });
    expect(rules[1]?.approval).toBeUndefined();
    expect(rules[2]?.approval).toEqual({
      state: "bypassed",
      questionId: null,
      head: HEAD,
      by: "Ada Lovelace",
      reason: "The loop owns this call already.",
      at: new Date(NOW + 4_000).toISOString(),
    });
    expect(verdict.checks.find((check) => check.id === "test")?.probeSha256).toBeUndefined();
    expect(verdict.skippedRules).toEqual(["runner-protocol-docs"]);
    expect(verdict.attempts?.at(-1)?.skippedRules).toEqual(["runner-protocol-docs"]);
    expect(verdict.attempts?.at(-1)?.checks[0]?.approval?.state).toBe("waiting");
  });

  test("a rule's probe output loads like a check's log", () => {
    const { db, home } = seed();
    const provider = createLiveStatusProvider(db, { pawsHome: home });
    expect(
      provider.checkLog({ itemId: "ENG-7", attempt: 1, checkId: "api-contract", run: null }),
    ).toEqual({ stdout: "", stderr: "" });
  });

  test("without the evidence record the probe hash is null", () => {
    const { db } = seed();
    const detail = createLiveStatusProvider(db, { env: {} }).item("ENG-7");
    expect(detail?.verdicts[0]?.checks[0]?.probeSha256).toBeNull();
  });
});
