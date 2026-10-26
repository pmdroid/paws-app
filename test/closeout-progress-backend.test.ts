import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  CloseoutProgress,
  CloseoutProgressIdentity,
  CloseoutProgressStep,
} from "../src/closeout";
import { evaluateCandidate, runCloseoutGate } from "../src/closeout";
import type { FixRunner } from "../src/closeout/fixer";
import { credentialSecrets } from "../src/closeout-spec";
import { isTransient } from "../src/core";
import { createStreamScrubber } from "../src/closeout-spec/run/scrub";
import {
  applyWorkItemEvent,
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listCloseoutProgress,
  migrate,
  openDatabase,
  saveCheckpoint,
  type CloseoutProgressRecord,
} from "../src/db";
import { createDbCloseoutProgress } from "../src/loop/closeout-progress";
import { createLiveStatusProvider } from "../src/web/src/live/provider";

const exec = promisify(execFile);
const TASK = "ENG-74";
const API_KEY = "synthetic-api-key-value-99";
const PASSWORD = "synthetic-password-value-88";
const SECRET = "synthetic-secret-value-66";
const TOKEN = "synthetic-token-value-77";
const GHP = `ghp_${"abcdefghijklmnopqrstuvwxyz"}`;
const SK = `sk-${"abcdefghijklmnopqrstuvwxyz"}`;

const SKILL = `---
name: adversarial-review
description: Review the candidate. Report findings. Do not decide acceptance.
---

# Review

Report findings. An empty list means the change is fine.
`;

describe("closeout progress backend", () => {
  test("redacts credential values and tokens split across chunks", () => {
    const scrubber = createStreamScrubber([API_KEY, PASSWORD, SECRET, TOKEN]);
    const parts = [
      scrubber.push(`alpha ${API_KEY.slice(0, 12)}`),
      scrubber.push(`${API_KEY.slice(12)} beta ${PASSWORD.slice(0, 10)}`),
      scrubber.push(`${PASSWORD.slice(10)} `),
      scrubber.push(`ghp_${"abcdefghij"}`),
      scrubber.push("klmnopqrstuvwxyz "),
      scrubber.push(`sk-${"abcdefghij"}`),
      scrubber.push("klmnopqrstuvwxyz "),
      scrubber.push(SECRET),
      scrubber.push(` ${TOKEN}`),
    ];
    const text = parts.join("") + scrubber.flush();
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(GHP);
    expect(text).not.toContain(SK);
    expect(text).toContain("[redacted]");
    const bare = createStreamScrubber([]);
    const tokenText =
      bare.push(`x ${GHP.slice(0, 14)}`) + bare.push(`${GHP.slice(14)} y`) + bare.flush();
    expect(tokenText).not.toContain(GHP);
    const continued = createStreamScrubber([]);
    expect(
      continued.push(GHP.slice(0, 25)) + continued.push(GHP.slice(25)) + continued.flush(),
    ).toBe("[redacted]");
    expect(
      credentialSecrets({ DEMO_API_KEY: API_KEY, DEMO_PASSWORD: PASSWORD, PATH: "/usr/bin" }),
    ).toEqual([PASSWORD, API_KEY]);
    expect(credentialSecrets({ GH_TOKEN: "ghp_legacytokenvalue", HOME: "/home/dev" })).toEqual([
      "ghp_legacytokenvalue",
    ]);
    expect(credentialSecrets({ HOME: "/home/dev", PATH: "/usr/bin" })).toEqual([]);
  });

  test("a new running attempt clears earlier output and timestamps and keeps other identities", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    let clock = 1_000;
    const progress = createDbCloseoutProgress(db, "item-1", () => clock);
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    const otherHead = "c".repeat(40);
    const otherBase = "d".repeat(40);
    const identity = ident({ base, head, policyDigest: "sha256:one" });
    const samePolicyOtherHead = ident({ base, head: otherHead, policyDigest: "sha256:one" });
    const otherBaseSameHead = ident({ base: otherBase, head, policyDigest: "sha256:one" });
    const otherPolicy = ident({ base, head, policyDigest: "sha256:two" });

    progress.begin(identity);
    progress.step(
      identity,
      progressStep({ state: "running", attempt: 1, startedAt: 100, logPath: "logs/1.log" }),
    );
    progress.output(identity, "probe", "stdout", "OLD-OUT", false);
    progress.output(identity, "probe", "stderr", "OLD-ERR", true);
    progress.step(
      identity,
      progressStep({
        state: "running",
        attempt: 1,
        startedAt: 180,
        detail: "still going",
      }),
    );
    expect(only(db, identity).steps[0]).toMatchObject({
      startedAt: 100,
      stdout: "OLD-OUT",
      state: "running",
    });
    progress.step(
      identity,
      progressStep({
        state: "failed",
        attempt: 1,
        startedAt: null,
        finishedAt: 250,
        detail: "command exited 1",
        truncated: false,
        logPath: "logs/1.log",
        findings: "kept-finding",
      }),
    );

    progress.begin(samePolicyOtherHead);
    progress.step(
      samePolicyOtherHead,
      progressStep({
        state: "passed",
        attempt: 1,
        detail: "other-head",
        startedAt: 10,
        finishedAt: 20,
      }),
    );
    progress.begin(otherBaseSameHead);
    progress.step(
      otherBaseSameHead,
      progressStep({
        state: "passed",
        attempt: 1,
        detail: "other-base",
        startedAt: 10,
        finishedAt: 20,
      }),
    );
    progress.begin(otherPolicy);
    progress.step(
      otherPolicy,
      progressStep({
        state: "passed",
        attempt: 1,
        detail: "other-policy",
        startedAt: 10,
        finishedAt: 20,
      }),
    );

    clock = 2_000;
    progress.begin(identity);
    progress.step(
      identity,
      progressStep({ state: "pending", attempt: 0, findings: null, logPath: null }),
    );
    const pending = only(db, identity).steps[0];
    expect(pending).toMatchObject({
      state: "pending",
      stdout: "",
      stderr: "",
      truncated: false,
      startedAt: null,
      finishedAt: null,
      attempt: 1,
      findings: "kept-finding",
    });
    progress.step(
      identity,
      progressStep({ state: "running", attempt: 2, startedAt: 500, logPath: "logs/2.log" }),
    );
    progress.output(identity, "probe", "stdout", "NEW-OUT", false);
    const running = only(db, identity);
    expect(running.decision).toBeNull();
    expect(running.steps[0]).toMatchObject({
      state: "running",
      attempt: 2,
      stdout: "NEW-OUT",
      stderr: "",
      truncated: false,
      startedAt: 500,
      finishedAt: null,
      findings: null,
    });
    expect(running.steps[0]?.stdout).not.toContain("OLD");
    progress.finish(identity, "rejected");
    expect(only(db, samePolicyOtherHead).steps[0]?.detail).toBe("other-head");
    expect(only(db, samePolicyOtherHead).decision).toBeNull();
    expect(only(db, otherBaseSameHead).steps[0]?.detail).toBe("other-base");
    expect(only(db, otherPolicy).steps[0]?.detail).toBe("other-policy");
    expect(only(db, identity).decision).toBe("rejected");
    expect(listCloseoutProgress(db)).toHaveLength(4);
  });

  test("direct evaluation does not publish before a progress identity exists", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const result = await evaluateCandidate({
      worktree: "/tmp/closeout-progress-unused",
      taskId: TASK,
      base: "not-a-commit",
      head: "also-not",
      candidate: candidate(),
      reviewer: {
        async review() {
          throw new Error("reviewer should not run");
        },
      },
      progress: createDbCloseoutProgress(db, "item-1"),
    });
    expect(result.outcome).toBe("invalid");
    expect(listCloseoutProgress(db)).toEqual([]);
  });

  test("streams output before the step finishes and a later attempt replaces it", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([
        {
          id: "probe",
          kind: "command",
          gate: "beforePR",
          exec: [
            "bun",
            "-e",
            "const fs=require('node:fs'); const phase=fs.readFileSync(process.env.PAWS_TEST_PHASE,'utf8').trim(); process.stdout.write('OUT:'+phase+'\\n'); process.stderr.write('ERR:'+phase+'\\n'); if (phase==='one') process.stdout.write('x'.repeat(70*1024)); process.exit(1)",
          ],
          timeoutSeconds: 30,
        },
      ]),
    });
    const phase = path.join(repo.root, "phase.txt");
    const dbPath = path.join(repo.root, "state.sqlite");
    const previous = process.env.PAWS_TEST_PHASE;
    process.env.PAWS_TEST_PHASE = phase;
    const db = openDatabase(dbPath);
    migrate(db);
    try {
      await writeFile(phase, "one\n");
      const progress = createDbCloseoutProgress(db, "item-1", () => Date.now());
      const first = await evaluateCandidate(evalInput(repo, progress));
      expect(first.outcome).toBe("rejected");
      const firstRow = only(db, rowIdentity(db));
      const firstStep = firstRow.steps[0];
      expect(firstStep?.stdout).toContain("OUT:one");
      expect(firstStep?.stderr).toContain("ERR:one");
      expect(firstStep?.truncated).toBe(true);
      expect(firstStep?.startedAt).not.toBeNull();
      expect(firstStep?.finishedAt).not.toBeNull();
      const firstLog = evidenceFile(repo.pawsHome, firstStep?.logPath ?? "");
      const firstLogText = await readFile(firstLog, "utf8");
      expect(firstLogText).toContain("OUT:one");
      expect(firstLogText).toContain("ERR:one");

      await writeFile(phase, "two\n");
      await wait(40);
      let live: CloseoutProgressRecord | null = null;
      const second = await evaluateCandidate(
        evalInput(
          repo,
          watching(progress, () => {
            const current = listCloseoutProgress(db)[0];
            const step = current?.steps[0];
            if (current && step?.state === "running" && step.stdout.includes("OUT:two"))
              live = current;
          }),
        ),
      );
      expect(second.outcome).toBe("rejected");
      expect(live).not.toBeNull();
      const seen = live as unknown as CloseoutProgressRecord;
      expect(seen.decision).toBeNull();
      expect(seen.steps[0]).toMatchObject({
        state: "running",
        attempt: 2,
        truncated: false,
        finishedAt: null,
      });
      expect(seen.steps[0]?.stdout).toContain("OUT:two");
      expect(seen.steps[0]?.stdout).not.toContain("OUT:one");
      expect(seen.steps[0]?.stdout).not.toContain("xxxx");
      expect(seen.steps[0]?.stderr).toContain("ERR:two");
      expect(seen.steps[0]?.stderr).not.toContain("ERR:one");
      expect(seen.steps[0]?.startedAt).toBeGreaterThan(firstStep?.finishedAt ?? 0);

      const stored = only(db, rowIdentity(db));
      expect(stored.decision).toBe("rejected");
      expect(stored.steps[0]?.stdout).toContain("OUT:two");
      expect(stored.steps[0]?.stdout).not.toContain("OUT:one");
      expect(await readFile(firstLog, "utf8")).toBe(firstLogText);
      const secondLog = evidenceFile(repo.pawsHome, stored.steps[0]?.logPath ?? "");
      expect(secondLog).not.toBe(firstLog);
      expect(await readFile(secondLog, "utf8")).toContain("OUT:two");
      expect(await readFile(secondLog, "utf8")).not.toContain("OUT:one");

      db.close();
      const reopened = openDatabase(dbPath);
      migrate(reopened);
      const again = listCloseoutProgress(reopened)[0];
      expect(again?.decision).toBe("rejected");
      expect(again?.steps[0]?.stdout).toContain("OUT:two");
      expect(again?.steps[0]?.stdout).not.toContain("OUT:one");
      expect(again?.steps[0]?.stderr).toContain("ERR:two");
      reopened.close();
      expect(await readFile(firstLog, "utf8")).toContain("OUT:one");
    } finally {
      if (previous === undefined) delete process.env.PAWS_TEST_PHASE;
      else process.env.PAWS_TEST_PHASE = previous;
      db.close();
      await repo.cleanup();
    }
  });

  test("direct blocked review finishes the established identity and keeps the review clock", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([reviewItem("adversarial-review")], 3),
      ".agents/skills/adversarial-review/SKILL.md": SKILL,
    });
    const db = openDatabase(":memory:");
    migrate(db);
    const progress = createDbCloseoutProgress(db, "item-1");
    const previous = process.env.DEMO_API_KEY;
    process.env.DEMO_API_KEY = API_KEY;
    let startedAt: number | null = null;
    try {
      const result = await evaluateCandidate({
        ...evalInput(repo, progress),
        reviewer: {
          async review() {
            const row = listCloseoutProgress(db)[0];
            const step = row?.steps.find((entry) => entry.kind === "review");
            expect(row?.decision).toBeNull();
            expect(row?.decision).not.toBe("accepted");
            expect(row?.policyDigest.length).toBeGreaterThan(0);
            expect(step?.state).toBe("running");
            startedAt = step?.startedAt ?? null;
            await wait(50);
            throw new Error(`review broke ${API_KEY}`);
          },
        },
      });
      expect(result.outcome).toBe("blocked");
      const row = listCloseoutProgress(db)[0];
      const step = row?.steps.find((entry) => entry.kind === "review");
      expect(row?.decision).toBe("blocked");
      expect(row?.policyDigest.length).toBeGreaterThan(0);
      expect(row?.head).toBe(repo.head);
      expect(step?.state).toBe("blocked");
      expect(step?.startedAt).toBe(startedAt);
      expect((step?.finishedAt ?? 0) - (step?.startedAt ?? 0)).toBeGreaterThanOrEqual(30);
      expect(step?.detail ?? "").not.toContain(API_KEY);
      expect(step?.detail ?? "").toContain("[redacted]");
      expect(JSON.stringify(row)).not.toContain(API_KEY);
      const invalid = await evaluateCandidate({ ...evalInput(repo, progress), head: "invalid" });
      expect(invalid.outcome).toBe("invalid");
      expect(listCloseoutProgress(db)[0]).toEqual(row);
    } finally {
      if (previous === undefined) delete process.env.DEMO_API_KEY;
      else process.env.DEMO_API_KEY = previous;
      await repo.cleanup();
    }
  });

  test("a policy fetch that fails on the network is retried, not blocked", async () => {
    const repo = await originRepo({ ".agents/closeout.yaml": policy([]) });
    const db = openDatabase(":memory:");
    migrate(db);
    try {
      await exec("git", [
        "-C",
        repo.dir,
        "remote",
        "set-url",
        "origin",
        "http://127.0.0.1:1/x.git",
      ]);
      const thrown = await evaluateCandidate(
        evalInput(repo, createDbCloseoutProgress(db, "item-1")),
      ).catch((error: unknown) => error);
      expect(isTransient(thrown)).toBe(true);
      expect(String(thrown)).toContain("origin/main is unavailable");
      await exec("git", [
        "-C",
        repo.dir,
        "remote",
        "set-url",
        "origin",
        path.join(repo.root, "gone"),
      ]);
      const missing = await evaluateCandidate(
        evalInput(repo, createDbCloseoutProgress(db, "item-1")),
      );
      expect(missing.outcome).toBe("blocked");
    } finally {
      db.close();
      await repo.cleanup();
    }
  });

  test("a temporary error puts its running step back as retrying, not blocked, and the retry starts clean", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([reviewItem("adversarial-review")], 3),
      ".agents/skills/adversarial-review/SKILL.md": SKILL,
    });
    const db = openDatabase(":memory:");
    migrate(db);
    insertQueuedItem(db, { id: "item-1", now: 1 });
    beginImplementRun(db, "item-1", 1, {
      phase: "running",
      baseSha: repo.head,
      wipCommit: repo.head,
    });
    applyWorkItemEvent(db, "item-1", "turn_ended");
    const progress = createDbCloseoutProgress(db, "item-1");
    const outage = Object.assign(new Error("503 Service Unavailable"), { status: 503 });
    try {
      const thrown = await evaluateCandidate({
        ...evalInput(repo, progress),
        reviewRetryDelaysMs: [],
        reviewer: {
          async review() {
            await wait(20);
            throw outage;
          },
        },
      }).catch((error: unknown) => error);
      expect(thrown).toBe(outage);
      const stopped = listCloseoutProgress(db)[0];
      const step = stopped?.steps.find((entry) => entry.kind === "review");
      expect(stopped?.steps.some((entry) => entry.state === "running")).toBe(false);
      expect(stopped?.finishedAt).not.toBeNull();
      expect(stopped?.decision).toBe("running");
      expect(step?.state).toBe("pending");
      expect(step?.detail).toBe("Retrying: 503 Service Unavailable");
      const provider = createLiveStatusProvider(db);
      const verdict = provider.item(provider.snapshot().items[0]!.id)?.verdicts[0];
      const check = verdict?.checks.find((entry) => entry.id === "adversarial-review");
      expect(verdict?.summary).toBe("Closeout is running.");
      expect(check?.active).toBe(false);
      expect(check?.state).toBe("pending");
      expect(check?.detail).toBe("Retrying: 503 Service Unavailable");

      const retried = await evaluateCandidate({
        ...evalInput(repo, progress),
        reviewer: {
          async review() {
            const row = listCloseoutProgress(db)[0];
            expect(row?.decision).toBeNull();
            expect(row?.finishedAt).toBeNull();
            return { session: "review-session", model: "gpt-5", provider: "openai", findings: [] };
          },
        },
      });
      expect(retried.outcome).toBe("accepted");
      const sealed = listCloseoutProgress(db);
      expect(sealed).toHaveLength(1);
      expect(sealed[0]?.decision).toBe("accepted");
      expect(sealed[0]?.steps.find((entry) => entry.kind === "review")?.state).toBe("passed");
    } finally {
      await repo.cleanup();
    }
  });

  test("a failed review records the attempt and findings without accepting early", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([reviewItem("adversarial-review")], 3),
      ".agents/skills/adversarial-review/SKILL.md": SKILL,
    });
    const db = openDatabase(":memory:");
    migrate(db);
    let startedAt: number | null = null;
    try {
      const result = await evaluateCandidate({
        ...evalInput(repo, createDbCloseoutProgress(db, "item-1")),
        reviewer: {
          async review() {
            const row = listCloseoutProgress(db)[0];
            startedAt = row?.steps.find((entry) => entry.kind === "review")?.startedAt ?? null;
            expect(row?.decision).not.toBe("accepted");
            await wait(20);
            return {
              session: "review-session",
              model: "gpt-5",
              provider: "openai",
              findings: [
                {
                  severity: "P0" as const,
                  location: "src/export.ts",
                  explanation: "header row is missing",
                  evidence: "the export file has no header row",
                },
              ],
            };
          },
        },
      });
      expect(result.outcome).toBe("rejected");
      const row = listCloseoutProgress(db)[0];
      const step = row?.steps.find((entry) => entry.kind === "review");
      expect(row?.decision).toBe("rejected");
      expect(step).toMatchObject({ state: "failed", attempt: 1 });
      expect(step?.findings).toContain("header row is missing");
      expect(step?.evidencePath).toContain("/adversarial-review/1.json");
      expect(
        await readFile(evidenceFile(repo.pawsHome, step?.evidencePath ?? ""), "utf8"),
      ).toContain("header row is missing");
      expect(step?.startedAt).toBe(startedAt);
      expect(step?.finishedAt).toBeGreaterThan(startedAt ?? 0);
    } finally {
      await repo.cleanup();
    }
  });

  test("an exhausted review stays exhausted with its attempt and findings", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([reviewItem("adversarial-review")], 1),
      ".agents/skills/adversarial-review/SKILL.md": SKILL,
    });
    const db = openDatabase(":memory:");
    migrate(db);
    let calls = 0;
    try {
      const result = await evaluateCandidate({
        ...evalInput(repo, createDbCloseoutProgress(db, "item-1")),
        reviewer: {
          async review() {
            calls += 1;
            const row = listCloseoutProgress(db)[0];
            expect(row?.decision).not.toBe("accepted");
            return {
              session: "review-session",
              model: "gpt-5",
              provider: "openai",
              findings: [
                {
                  severity: "P0" as const,
                  location: "src/export.ts",
                  explanation: "retry budget spent",
                  evidence: "the same header row is still missing",
                },
              ],
            };
          },
        },
      });
      expect(result.outcome).toBe("exhausted");
      expect(calls).toBe(1);
      const row = listCloseoutProgress(db)[0];
      const step = row?.steps.find((entry) => entry.kind === "review");
      expect(row?.decision).toBe("exhausted");
      expect(step).toMatchObject({ state: "exhausted", attempt: 1 });
      expect(step?.findings).toContain("retry budget spent");
      expect(step?.startedAt).not.toBeNull();
      expect(step?.finishedAt).toBeGreaterThan(step?.startedAt ?? 0);
    } finally {
      await repo.cleanup();
    }
  });

  test("a fix commit advances the checkpoint to the current candidate and survives reopen", async () => {
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([
        {
          id: "probe",
          kind: "command",
          gate: "beforePR",
          exec: [
            "bun",
            "-e",
            "const fs=require('node:fs'); if (!fs.existsSync('ok.txt')) { console.log('STILL-OLD'); process.exit(1) } console.log('NOW-NEW')",
          ],
          timeoutSeconds: 30,
        },
      ]),
    });
    const dbPath = path.join(repo.root, "state.sqlite");
    const db = openDatabase(dbPath);
    migrate(db);
    insertQueuedItem(db, { id: "item-1", now: 1 });
    beginImplementRun(db, "item-1", 1, {
      phase: "running",
      baseSha: repo.head,
      wipCommit: repo.head,
      turn: 4,
    });
    applyWorkItemEvent(db, "item-1", "turn_ended");
    saveCheckpoint(db, "item-1", {
      phase: "verifying",
      baseSha: repo.head,
      wipCommit: repo.head,
      turn: 4,
    });
    const progress = createDbCloseoutProgress(db, "item-1", () => Date.now());
    let liveHead: string | undefined;
    try {
      const result = await runCloseoutGate({
        worktree: repo.dir,
        taskId: TASK,
        base: repo.head,
        head: repo.head,
        candidate: candidate(),
        home: repo.home,
        pawsHome: repo.pawsHome,
        reviewer: {
          async review() {
            throw new Error("no review item");
          },
        },
        fixer: committingFixer(repo.dir),
        progress: watching(progress, () => {
          const checkpoint = getWorkItem(db, "item-1")?.checkpoint;
          const rows = listCloseoutProgress(db);
          const current = rows.find((row) => row.head === checkpoint?.wipCommit);
          const step = current?.steps.find((entry) => entry.id === "probe");
          if (current && step?.stdout.includes("NOW-NEW") && step.state === "running") {
            liveHead = current.head;
            expect(checkpoint?.wipCommit).not.toBe(repo.head);
            expect(current.decision).toBeNull();
            expect(step.stdout).not.toContain("STILL-OLD");
            const previous = rows.find((row) => row.head === repo.head);
            expect(previous?.decision).toBe("rejected");
            expect(previous?.steps[0]?.stdout).toContain("STILL-OLD");
            expect(previous?.steps[0]?.stdout).not.toContain("NOW-NEW");
          }
        }),
      });
      expect(result.outcome).toBe("accepted");
      expect(liveHead).toBeDefined();
      const checkpoint = getWorkItem(db, "item-1")?.checkpoint;
      expect(checkpoint?.phase).toBe("verifying");
      expect(checkpoint?.turn).toBe(4);
      expect(checkpoint?.baseSha).toBe(repo.head);
      expect(checkpoint?.wipCommit).toBe(liveHead);
      expect(checkpoint?.wipCommit).not.toBe(repo.head);
      const rows = listCloseoutProgress(db);
      expect(rows).toHaveLength(2);
      const previous = rows.find((row) => row.head === repo.head);
      const current = rows.find((row) => row.head === liveHead);
      expect(previous?.decision).toBe("rejected");
      expect(previous?.steps[0]?.stdout).toContain("STILL-OLD");
      expect(current?.decision).toBe("accepted");
      expect(current?.base).toBe(repo.head);
      expect(current?.steps[0]?.stdout).toContain("NOW-NEW");
      expect(current?.steps[0]?.stdout).not.toContain("STILL-OLD");
      const oldLog = evidenceFile(repo.pawsHome, previous?.steps[0]?.logPath ?? "");
      const newLog = evidenceFile(repo.pawsHome, current?.steps[0]?.logPath ?? "");
      expect(await readFile(oldLog, "utf8")).toContain("STILL-OLD");
      expect(await readFile(newLog, "utf8")).toContain("NOW-NEW");
      db.close();
      const reopened = openDatabase(dbPath);
      migrate(reopened);
      const again = listCloseoutProgress(reopened);
      expect(again.find((row) => row.head === repo.head)?.decision).toBe("rejected");
      expect(again.find((row) => row.head === liveHead)?.decision).toBe("accepted");
      expect(again.find((row) => row.head === liveHead)?.steps[0]?.stdout).toContain("NOW-NEW");
      expect(getWorkItem(reopened, "item-1")?.checkpoint?.wipCommit).toBe(liveHead);
      reopened.close();
      expect(await readFile(oldLog, "utf8")).toContain("STILL-OLD");
    } finally {
      db.close();
      await repo.cleanup();
    }
  });

  test("command output and stored logs redact env secrets and credential tokens", async () => {
    const script = [
      "const value = process.argv[2] ?? '';",
      "const mid = Math.ceil(value.length / 2);",
      "process.stdout.write('L' + value.slice(0, mid));",
      "await new Promise((resolve) => setTimeout(resolve, 30));",
      "process.stdout.write(value.slice(mid) + 'R ' + (process.argv[3] ?? '') + ' ' + (process.argv[4] ?? '') + ' ' + (process.argv[5] ?? '') + '\\n');",
      "process.stderr.write('ghp_' + 'abcdefghij');",
      "await new Promise((resolve) => setTimeout(resolve, 30));",
      "process.stderr.write('klmnopqrstuvwxyz sk-' + 'abcdefghij');",
      "await new Promise((resolve) => setTimeout(resolve, 30));",
      "process.stderr.write('klmnopqrstuvwxyz\\n');",
    ].join(" ");
    const repo = await originRepo({
      ".agents/closeout.yaml": policy([
        {
          id: "probe",
          kind: "command",
          gate: "beforePR",
          exec: ["bun", "-e", script, API_KEY, PASSWORD, SECRET, TOKEN],
          timeoutSeconds: 30,
        },
      ]),
    });
    const db = openDatabase(":memory:");
    migrate(db);
    const previous = {
      DEMO_API_KEY: process.env.DEMO_API_KEY,
      DEMO_PASSWORD: process.env.DEMO_PASSWORD,
      DEMO_SECRET: process.env.DEMO_SECRET,
      DEMO_TOKEN: process.env.DEMO_TOKEN,
    };
    process.env.DEMO_API_KEY = API_KEY;
    process.env.DEMO_PASSWORD = PASSWORD;
    process.env.DEMO_SECRET = SECRET;
    process.env.DEMO_TOKEN = TOKEN;
    let runningClean = false;
    try {
      const result = await evaluateCandidate(
        evalInput(
          repo,
          watching(createDbCloseoutProgress(db, "item-1"), () => {
            const row = listCloseoutProgress(db)[0];
            const step = row?.steps[0];
            if (step?.state !== "running") return;
            const dump = JSON.stringify(step);
            if (dump.includes(API_KEY) || dump.includes(GHP) || dump.includes(SK)) return;
            if (step.stdout.includes("[redacted]") && step.stderr.includes("[redacted]"))
              runningClean = true;
          }),
        ),
      );
      expect(result.outcome).toBe("accepted");
      expect(runningClean).toBe(true);
      const row = listCloseoutProgress(db)[0];
      const dump = JSON.stringify(row);
      for (const secret of [API_KEY, PASSWORD, SECRET, TOKEN, GHP, SK]) {
        expect(dump).not.toContain(secret);
      }
      expect(row?.steps[0]?.stdout).toContain("[redacted]");
      expect(row?.steps[0]?.stderr).toContain("[redacted]");
      expect(row?.steps[0]?.command).not.toContain(API_KEY);
      const log = await readFile(evidenceFile(repo.pawsHome, row?.steps[0]?.logPath ?? ""), "utf8");
      for (const secret of [API_KEY, PASSWORD, SECRET, TOKEN, GHP, SK]) {
        expect(log).not.toContain(secret);
      }
      expect(log).toContain("[redacted]");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await repo.cleanup();
    }
  });
});

function ident(patch: Partial<CloseoutProgressIdentity>): CloseoutProgressIdentity {
  return {
    taskId: TASK,
    base: "a".repeat(40),
    head: "b".repeat(40),
    policyDigest: "sha256:one",
    policyPath: ".agents/closeout.yaml",
    ...patch,
  };
}

function progressStep(patch: Partial<CloseoutProgressStep>): CloseoutProgressStep {
  return {
    id: "probe",
    kind: "command",
    state: "pending",
    command: "probe",
    detail: null,
    attempt: 0,
    timeoutSeconds: 30,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
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

function only(
  db: ReturnType<typeof openDatabase>,
  identity: CloseoutProgressIdentity,
): CloseoutProgressRecord {
  const found = listCloseoutProgress(db).find(
    (row) =>
      row.taskId === identity.taskId &&
      row.base === identity.base &&
      row.head === identity.head &&
      row.policyDigest === identity.policyDigest,
  );
  if (found === undefined) throw new Error("missing progress row");
  return found;
}

function rowIdentity(db: ReturnType<typeof openDatabase>): CloseoutProgressIdentity {
  const row = listCloseoutProgress(db)[0];
  if (row === undefined) throw new Error("missing progress row");
  return {
    taskId: row.taskId,
    base: row.base,
    head: row.head,
    policyDigest: row.policyDigest,
    policyPath: row.policyPath,
  };
}

function watching(inner: CloseoutProgress, onOutput: () => void): CloseoutProgress {
  return {
    begin(identity) {
      inner.begin(identity);
    },
    step(identity, value) {
      inner.step(identity, value);
    },
    output(identity, stepId, stream, text, truncated) {
      inner.output(identity, stepId, stream, text, truncated);
      onOutput();
    },
    finish(identity, decision) {
      inner.finish(identity, decision);
    },
  };
}

function evalInput(
  repo: { dir: string; head: string; home: string; pawsHome: string },
  progress: CloseoutProgress,
) {
  return {
    worktree: repo.dir,
    taskId: TASK,
    base: repo.head,
    head: repo.head,
    candidate: candidate(),
    home: repo.home,
    pawsHome: repo.pawsHome,
    reviewer: {
      async review() {
        throw new Error("reviewer should not run");
      },
    },
    progress,
  };
}

function candidate() {
  return { session: "impl-session", model: "claude", provider: "anthropic", task: TASK };
}

function evidenceFile(pawsHome: string, relative: string): string {
  return path.join(pawsHome, "closeout", "evidence", TASK, ...relative.split("/"));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function committingFixer(dir: string): FixRunner {
  return {
    async applyFix(request) {
      await writeFile(path.join(dir, "ok.txt"), `ok ${request.fixAttempt}\n`);
      await exec("git", ["-C", dir, "add", "ok.txt"]);
      await exec("git", ["-C", dir, "commit", "-m", `fix ${request.fixAttempt}`]);
      const { stdout } = await exec("git", ["-C", dir, "rev-parse", "HEAD"]);
      return { ok: true, head: stdout.trim() };
    },
  };
}

function policy(items: unknown[], maxFailedAttempts = 3): string {
  return [
    'specVersion: "0.1"',
    "retry:",
    `  maxFailedAttemptsPerItem: ${maxFailedAttempts}`,
    "  scope: task",
    "items:",
    ...items.flatMap((item) => yamlItem(item as Record<string, unknown>)),
    "",
  ].join("\n");
}

function yamlItem(item: Record<string, unknown>): string[] {
  const lines = [
    `  - id: ${String(item.id)}`,
    `    kind: ${String(item.kind)}`,
    "    gate: beforePR",
  ];
  if (item.kind === "command") {
    const args = item.exec as string[];
    lines.push(
      `    exec: [${args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
      `    timeoutSeconds: ${String(item.timeoutSeconds)}`,
    );
  }
  if (item.kind === "review") {
    lines.push(
      `    skill: ${String(item.skill)}`,
      "    independence:",
      "      differentSession: true",
      "      differentModel: true",
      "    failOn: P1",
    );
  }
  return lines;
}

function reviewItem(id: string) {
  return { id, kind: "review", skill: ".agents/skills/adversarial-review/SKILL.md" };
}

async function originRepo(files: Record<string, string>): Promise<{
  root: string;
  dir: string;
  head: string;
  home: string;
  pawsHome: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "paws-closeout-progress-"));
  const bare = path.join(root, "origin.git");
  const dir = path.join(root, "repo");
  const home = path.join(root, "home");
  const pawsHome = path.join(root, "paws");
  await mkdir(home);
  await mkdir(pawsHome);
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  await exec("git", ["clone", bare, dir]);
  await exec("git", ["-C", dir, "config", "user.email", "paws-test@example.com"]);
  await exec("git", ["-C", dir, "config", "user.name", "Paws Test"]);
  await exec("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(dir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  await exec("git", ["-C", dir, "add", "."]);
  await exec("git", ["-C", dir, "commit", "-m", "init"]);
  await exec("git", ["-C", dir, "push", "origin", "HEAD:main"]);
  const { stdout } = await exec("git", ["-C", dir, "rev-parse", "HEAD"]);
  return {
    root,
    dir,
    head: stdout.trim(),
    home,
    pawsHome,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
