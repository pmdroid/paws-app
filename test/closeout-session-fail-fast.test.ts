import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCloseoutSession,
  workspacePolicyFiles,
  type CloseoutFocus,
} from "../src/closeout-spec";

const roots: string[] = [];
const inheritedBail = process.env.PAWS_TEST_BAIL;

beforeAll(() => {
  delete process.env.PAWS_TEST_BAIL;
});

afterAll(() => {
  if (inheritedBail !== undefined) process.env.PAWS_TEST_BAIL = inheritedBail;
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Report = {
  pending: string[];
  required: { id: string; status: string; detail?: string }[];
  rules?: { id: string; result?: unknown }[];
};

type Acme = {
  repo: string;
  ran: () => string[];
  fail: (id: string, failing: boolean) => void;
  probes: () => number;
};

function acme(slow: Record<string, number> = {}, attempts?: number): Acme {
  const root = mkdtempSync(join(tmpdir(), "paws-closeout-fail-fast-"));
  roots.push(root);
  const repo = join(root, "repo");
  const log = join(root, "ran");
  const failing = join(root, "failing");
  const probeLog = join(root, "probes");
  mkdirSync(failing);
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "acme\n");
  commit(repo);
  git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const step = (id: string) =>
    JSON.stringify([
      "sh",
      "-c",
      `sleep ${slow[id] ?? 0}; echo "${id} bail=$PAWS_TEST_BAIL" >> ${log}; test ! -e ${join(failing, id)}`,
    ]);
  const command = (id: string, timeoutSeconds: number) => [
    `  - id: ${id}`,
    "    kind: command",
    "    gate: beforePR",
    `    exec: ${step(id)}`,
    `    timeoutSeconds: ${timeoutSeconds}`,
  ];
  mkdirSync(join(repo, ".agents", "skills", "review"), { recursive: true });
  mkdirSync(join(repo, ".agents", "probes"));
  writeFileSync(join(repo, ".agents", "skills", "review", "SKILL.md"), "# Review\n");
  writeFileSync(
    join(repo, ".agents", "probes", "rule.ts"),
    `require("node:fs").appendFileSync(${JSON.stringify(probeLog)}, "x");\n`,
  );
  writeFileSync(
    join(repo, ".agents", "closeout.yaml"),
    [
      'specVersion: "0.1"',
      ...(attempts === undefined ? [] : ["retry:", `  maxFailedAttemptsPerItem: ${attempts}`]),
      "setup:",
      "  - id: install",
      `    exec: ${step("install")}`,
      "    timeoutSeconds: 600",
      "items:",
      ...command("lint", 300),
      ...command("format", 300),
      ...command("test", 1800),
      ...command("typecheck", 600),
      "  - id: independent-review",
      "    kind: review",
      "    gate: beforePR",
      "    skill: .agents/skills/review/SKILL.md",
      "    independence:",
      "      differentSession: true",
      "      differentModel: true",
      "    failOn: P1",
      "rules:",
      "  - id: api-contract",
      "    summary: No removed field.",
      "    probe: .agents/probes/rule.ts",
      "    failOn: P1",
      "    onFail: approve",
      "",
    ].join("\n"),
  );
  writeFileSync(join(repo, "widget.ts"), "export const acme = 1;\n");
  commit(repo);
  return {
    repo,
    ran: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
    fail: (id, on) => {
      if (on) writeFileSync(join(failing, id), "");
      else rmSync(join(failing, id), { force: true });
    },
    probes: () => (existsSync(probeLog) ? readFileSync(probeLog, "utf8").length : 0),
  };
}

const session = (repo: string, focus?: CloseoutFocus) =>
  createCloseoutSession(repo, {
    policy: async () => workspacePolicyFiles(repo),
    ...(focus ? { focus } : {}),
  });

const runPending = async (closeout: ReturnType<typeof session>) => {
  const report = JSON.parse(await closeout.report()) as Report;
  return Promise.all(report.pending.map((id) => closeout.run(id)));
};

const statusOf = (report: Report, id: string) => report.required.find((item) => item.id === id);

test("in-turn, a failing lint stops the other checks; test, reviews and probes never start", async () => {
  const fx = acme({ format: 10, typecheck: 10 });
  fx.fail("lint", true);
  const closeout = session(fx.repo);
  const pending = (JSON.parse(await closeout.report()) as Report).pending;
  expect(pending).toEqual(["install", "lint", "format", "typecheck", "test"]);

  const started = Date.now();
  const answers = await Promise.all(pending.map((id) => closeout.run(id)));
  expect(Date.now() - started).toBeLessThan(5_000);

  expect(answers[1]).toStartWith("lint failed (exit 1).");
  expect(answers[2]).toStartWith("format not run: fix lint first.");
  expect(answers[3]).toStartWith("typecheck not run: fix lint first.");
  expect(answers[4]).toStartWith("test not run: fix lint first.\nlint failed (exit 1).");
  expect(fx.ran().map((line) => line.split(" ")[0])).not.toContain("test");
  expect(fx.ran().map((line) => line.split(" ")[0])).not.toContain("format");

  const report = JSON.parse(await closeout.report({ probes: true })) as Report;
  expect(statusOf(report, "lint")).toMatchObject({ status: "failed" });
  expect(statusOf(report, "lint")?.detail).toBeUndefined();
  for (const id of ["format", "typecheck", "test"])
    expect(statusOf(report, id)).toMatchObject({
      status: "missing",
      detail: "not run: fix lint first",
    });
  expect(report.pending).toEqual(["lint", "format", "typecheck", "test"]);
  expect(statusOf(report, "independent-review")?.status).toBe("missing");
  expect(report.rules?.[0]?.result).toBeUndefined();
  expect(fx.probes()).toBe(0);
}, 30_000);

test("in-turn, test runs last with PAWS_TEST_BAIL=1 and its failure starts no probe", async () => {
  const fx = acme();
  fx.fail("test", true);
  const closeout = session(fx.repo);
  const answers = await runPending(closeout);

  expect(answers.at(-1)).toStartWith("test failed (exit 1).");
  const ran = fx.ran();
  expect(ran.at(-1)).toBe("test bail=1");
  expect(ran.slice(0, 1)).toEqual(["install bail="]);
  expect(ran.slice(1, -1).toSorted()).toEqual(["format bail=1", "lint bail=1", "typecheck bail=1"]);
  const report = JSON.parse(await closeout.report({ probes: true })) as Report;
  expect(report.rules?.[0]?.result).toBeUndefined();
  expect(fx.probes()).toBe(0);
}, 30_000);

test("in-turn, a failed test runs first in the next round, right after setup, and stops there", async () => {
  const fx = acme();
  fx.fail("test", true);
  const closeout = session(fx.repo);
  await runPending(closeout);
  const first = fx.ran().length;

  writeFileSync(join(fx.repo, "widget.ts"), "export const acme = 2;\n");
  expect((JSON.parse(await closeout.report()) as Report).pending).toEqual([
    "test",
    "lint",
    "format",
    "typecheck",
  ]);
  const again = await runPending(closeout);
  expect(fx.ran().slice(first)).toEqual(["test bail=1"]);
  expect(again[1]).toStartWith("lint not run: fix test first.\ntest failed (exit 1).");

  fx.fail("test", false);
  await runPending(closeout);
  const third = fx.ran().slice(first + 1);
  expect(third[0]).toBe("test bail=1");
  expect(third.slice(1).toSorted()).toEqual(["format bail=1", "lint bail=1", "typecheck bail=1"]);
  const report = JSON.parse(await closeout.report({ probes: true })) as Report;
  expect(report.pending).toEqual([]);
  expect(fx.probes()).toBe(1);
}, 30_000);

test("in-turn, an exhausted lint keeps blocking the later checks without running it again", async () => {
  const fx = acme({ format: 10, typecheck: 10 }, 1);
  fx.fail("lint", true);
  const closeout = session(fx.repo);
  await runPending(closeout);
  const ran = fx.ran().length;

  expect(await closeout.run("test")).toBe(
    "test not run: fix lint first. Check lint is exhausted. Stop retrying and report the blocker.",
  );
  expect(fx.ran()).toHaveLength(ran);
  const report = JSON.parse(await closeout.report()) as Report;
  expect(statusOf(report, "lint")?.status).toBe("exhausted");
  for (const id of ["format", "typecheck", "test"])
    expect(statusOf(report, id)).toMatchObject({
      status: "deferred",
      detail: "not run: fix lint first",
    });
  expect(report.pending).toEqual([]);
}, 30_000);

test("a fix round's Closeout focus runs the check that failed on the last head first", async () => {
  const fx = acme();
  const policy = await workspacePolicyFiles(fx.repo);
  if (!policy.ok || policy.absent) throw new Error("acme policy is missing");
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: fx.repo, encoding: "utf8" });
  writeFileSync(join(fx.repo, "widget.ts"), "export const acme = 2;\n");
  fx.fail("test", true);
  const closeout = session(fx.repo, {
    scope: "changed",
    head: head.stdout.trim(),
    policyDigest: policy.digest,
    passed: ["install", "lint", "format", "typecheck"],
  });

  expect((JSON.parse(await closeout.report()) as Report).pending).toEqual([
    "install",
    "test",
    "lint",
    "format",
    "typecheck",
  ]);
  await runPending(closeout);
  expect(fx.ran()).toEqual(["install bail=", "test bail=1"]);
}, 30_000);

function commit(repo: string): void {
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=Acme", "-c", "user.email=dev@acme.test", "commit", "-qm", "acme"]);
}

function git(repo: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}
