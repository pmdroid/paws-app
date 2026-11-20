import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  carriedMessage,
  createCloseoutGate,
  evidencePath,
  runCloseoutGate,
  type CarriedPass,
} from "../src/closeout";

const exec = promisify(execFile);
const roots: string[] = [];
const A = "a1b2c3d4e5f6".padEnd(40, "0");
const CARRIED = carriedMessage(A);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function policy(root: string): string {
  const ran = path.join(root, "ran");
  const mark = (id: string, extra = "") =>
    JSON.stringify(["sh", "-c", `${extra}echo ${id} >> ${ran}`]);
  const command = (id: string, extra = "", paths?: string) => [
    `  - id: ${id}`,
    "    kind: command",
    "    gate: beforePR",
    ...(paths ? [`    paths: ["${paths}"]`] : []),
    `    exec: ${mark(id, extra)}`,
    "    timeoutSeconds: 30",
  ];
  return [
    'specVersion: "0.1"',
    "setup:",
    "  - id: install",
    `    exec: ${mark("install")}`,
    "    timeoutSeconds: 30",
    "items:",
    ...command("lint", "test -f ok && "),
    ...command("typecheck"),
    ...command("test"),
    ...command("proof"),
    ...command("web", "", "apps/web/**"),
    "  - id: review",
    "    kind: review",
    "    gate: beforePR",
    "    skill: .agents/skills/review/SKILL.md",
    "    independence:",
    "      differentSession: true",
    "      differentModel: true",
    "    failOn: P1",
    "rules:",
    "  - id: contract",
    "    summary: Nothing breaks.",
    "    probe: .agents/probes/contract.ts",
    "    failOn: P1",
    "",
  ].join("\n");
}

async function seed(edit: (yaml: string) => string = (yaml) => yaml) {
  const root = mkdtempSync(path.join(tmpdir(), "paws-carried-"));
  roots.push(root);
  const dir = path.join(root, "repo");
  const home = path.join(root, "home");
  const pawsHome = path.join(root, "paws");
  await mkdir(home);
  await mkdir(pawsHome);
  await exec("git", ["init", "--bare", "-b", "main", path.join(root, "origin.git")]);
  await exec("git", ["clone", path.join(root, "origin.git"), dir]);
  await mkdir(path.join(dir, ".agents/skills/review"), { recursive: true });
  await mkdir(path.join(dir, ".agents/probes"), { recursive: true });
  await writeFile(path.join(dir, ".agents/closeout.yaml"), edit(policy(root)));
  await writeFile(path.join(dir, ".agents/skills/review/SKILL.md"), "# Review\n");
  await writeFile(
    path.join(dir, ".agents/probes/contract.ts"),
    `require("node:fs").appendFileSync(${JSON.stringify(path.join(root, "ran"))}, "contract\\n");\n`,
  );
  const base = await commit(dir, "init");
  await exec("git", ["-C", dir, "push", "origin", "HEAD:main"]);
  await writeFile(path.join(dir, "ok"), "acme widget\n");
  const head = await commit(dir, "change");
  let reviews = 0;
  const input = {
    worktree: dir,
    taskId: "ACME-1-task",
    base,
    candidate: { session: "impl", model: "claude", provider: "anthropic" },
    home,
    pawsHome,
    maxFixAttempts: 0,
    reviewer: {
      async review() {
        reviews += 1;
        return { session: "codex", model: "codex", provider: "openai", findings: [] };
      },
    },
    fixer: {
      async applyFix(): Promise<never> {
        throw new Error("no fixes");
      },
    },
  };
  return {
    dir,
    head,
    input,
    pawsHome,
    reviews: () => reviews,
    ran: () => {
      const file = path.join(root, "ran");
      const lines = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
      rmSync(file, { force: true });
      return lines.filter(Boolean);
    },
  };
}

const carry = (...ids: string[]): CarriedPass[] => ids.map((id) => ({ id, head: A }));

function commands(result: Awaited<ReturnType<typeof runCloseoutGate>>) {
  return Object.fromEntries(
    (result.decision?.items ?? [])
      .filter((item) => item.kind === "command")
      .map((item) => [item.id, item.message]),
  );
}

test("carried checks are recorded at the new head; the rest, the rule and the review run", async () => {
  const repo = await seed();
  const result = await runCloseoutGate({ ...repo.input, carried: carry("test", "proof") });
  expect(result.outcome).toBe("accepted");
  expect(repo.ran().sort()).toEqual(["contract", "install", "lint", "typecheck"]);
  expect(repo.reviews()).toBe(1);
  const messages = commands(result);
  expect(messages.test).toBe(CARRIED);
  expect(messages.proof).toBe(CARRIED);
  expect(messages.lint).toBe("exited 0");
  expect(messages.web).toBe("no changed path matches");
  expect(CARRIED).toBe(
    "carried from a1b2c3d4e5f6: passed there, not run again after the conflict fix",
  );

  const records = await recordsAt(evidencePath(repo.input.taskId, repo.pawsHome), repo.head);
  for (const id of ["test", "proof"]) {
    expect(records.find((record) => record.itemId === id)).toMatchObject({
      exec: { exitCode: 0, durationMs: 0 },
      artifacts: [],
      carried: { head: A },
    });
  }
  expect(records.find((record) => record.itemId === "lint")?.carried).toBeUndefined();

  const decided = await createCloseoutGate(repo.input).decide({
    taskId: repo.input.taskId,
    worktree: repo.dir,
    baseSha: repo.input.base,
    headSha: repo.head,
    attempt: 1,
  });
  expect(decided.decision).toBe("accepted");
  expect(decided.result && commands(decided.result).test).toBe(CARRIED);
}, 60_000);

test("a result from CI at this head wins over a carried one", async () => {
  const repo = await seed((yaml) =>
    yaml.replace("  - id: proof\n", '  - id: proof\n    ci: "proof"\n'),
  );
  const head = repo.head;
  const run = "https://github.com/acme/widget/actions/runs/1";
  const result = await runCloseoutGate({
    ...repo.input,
    head,
    fromCi: [{ id: "proof", run, checks: [{ name: "proof", conclusion: "success", url: null }] }],
    carried: carry("test", "proof"),
  });
  expect(result.outcome).toBe("accepted");
  expect(commands(result).proof).toBe(`from CI run ${run}: \`proof\` success`);
  expect(commands(result).test).toBe(CARRIED);
  const records = await recordsAt(evidencePath(repo.input.taskId, repo.pawsHome), head);
  const proof = records.find((record) => record.itemId === "proof");
  expect(proof?.ci).toBeDefined();
  expect(proof?.carried).toBeUndefined();
}, 60_000);

test("a setup step, a rule or an unknown id named in carried runs as today", async () => {
  const repo = await seed();
  const result = await runCloseoutGate({
    ...repo.input,
    carried: carry("install", "contract", "nope"),
  });
  expect(result.outcome).toBe("accepted");
  expect(repo.ran().sort()).toEqual(["contract", "install", "lint", "proof", "test", "typecheck"]);
  expect(Object.values(commands(result))).not.toContain(CARRIED);
}, 60_000);

test("after the fix loop moves the head, the second head runs every check", async () => {
  const repo = await seed();
  await exec("git", ["-C", repo.dir, "rm", "-q", "ok"]);
  await writeFile(path.join(repo.dir, "other"), "acme\n");
  const head = await commit(repo.dir, "drop ok");
  repo.ran();
  const result = await runCloseoutGate({
    ...repo.input,
    head,
    maxFixAttempts: 1,
    carried: carry("test", "proof"),
    fixer: {
      async applyFix() {
        await writeFile(path.join(repo.dir, "ok"), "fixed\n");
        return { ok: true as const, head: await commit(repo.dir, "fix") };
      },
    },
  });
  expect(result.outcome).toBe("accepted");
  expect(result.fixAttempts).toBe(1);
  const ran = repo.ran();
  expect(ran.filter((id) => id === "test")).toEqual(["test"]);
  expect(ran.filter((id) => id === "proof")).toEqual(["proof"]);
  expect(Object.values(commands(result))).not.toContain(CARRIED);
}, 60_000);

test("checks that are all carried or skipped create no worktree", async () => {
  const repo = await seed((yaml) =>
    yaml.replace(/setup:\n {2}- id: install\n.*\n.*\n/, "").replace(/rules:\n[\s\S]*$/, ""),
  );
  const head = repo.head;
  const worktrees = path.join(repo.pawsHome, "closeout", "tmp");
  const result = await runCloseoutGate({
    ...repo.input,
    head,
    carried: carry("lint", "typecheck", "test", "proof", "web"),
  });
  expect(result.outcome).toBe("accepted");
  expect(repo.ran()).toEqual([]);
  expect(existsSync(worktrees)).toBe(false);
  const listed = (await exec("git", ["-C", repo.dir, "worktree", "list"])).stdout.trim();
  expect(listed.split("\n")).toHaveLength(1);
}, 60_000);

type Stored = { itemId: string; head: string; ci?: unknown; carried?: unknown };

async function recordsAt(dir: string, head: string): Promise<Stored[]> {
  const found: Stored[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const file = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith(".json")) {
        const record = JSON.parse(await readFile(file, "utf8"));
        if (record.head === head && record.recordType === "command") found.push(record);
      }
    }
  };
  await walk(path.join(dir, "evidence"));
  return found;
}

async function commit(dir: string, message: string): Promise<string> {
  await exec("git", ["-C", dir, "add", "-A"]);
  await exec("git", [
    "-C",
    dir,
    "-c",
    "user.name=Acme",
    "-c",
    "user.email=dev@acme.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    message,
  ]);
  return (await exec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
}
