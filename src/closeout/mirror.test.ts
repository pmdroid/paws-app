import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { decideCloseoutGate, evaluateCandidate, PolicyFetchError, type Evaluation } from "./run";
import type { CodexReviewer } from "./reviewer";
import type { CloseoutMirror } from "./types";

const exec = promisify(execFile);
const TASK = "ENG-1063";
const BRANCH = "paws/eng-1063";
const SKILL = ".agents/skills/adversarial-review/SKILL.md";

describe("closeout decides from the bare mirror", () => {
  test("a policy change on main rejects from the mirror as from the worktree", async () => {
    const repo = await mirroredRepo({ ".agents/closeout.yaml": policy([pass("lint")]) });
    try {
      const head = await repo.commit({ "src/app.ts": "export {};\n" });
      await repo.pushMain({ ".agents/closeout.yaml": policy([fail("lint")]) });
      const [local, mirror] = await repo.both(head);
      expect(local.outcome).toBe("rejected");
      expect(states(mirror)).toEqual(states(local));
      expect(mirror.outcome).toBe("rejected");
    } finally {
      await repo.cleanup();
    }
  });

  test("a high-risk path needs the review from the mirror as from the worktree", async () => {
    const repo = await mirroredRepo({
      ".agents/closeout.yaml": policy([review("auth-review", ["auth/**"])]),
      [SKILL]: "Review the change.\n",
    });
    try {
      const safe = await repo.commit({ "src/app.ts": "export {};\n" });
      const [safeLocal, safeMirror] = await repo.both(safe);
      expect(safeLocal.outcome).toBe("accepted");
      expect(states(safeMirror)).toEqual(states(safeLocal));
      const risky = await repo.commit({ "auth/login.ts": "export const login = 1;\n" });
      const [local, mirror] = await repo.both(risky, "auth/login.ts:1");
      expect(local.outcome).toBe("rejected");
      expect(mirror.outcome).toBe("rejected");
      expect(states(mirror)).toEqual(states(local));
    } finally {
      await repo.cleanup();
    }
  });

  test("a paths-filtered check runs only on a matching change in the mirror", async () => {
    const repo = await mirroredRepo({
      ".agents/closeout.yaml": policy([pass("lint"), fail("docs", ["docs/**"])]),
    });
    try {
      const code = await repo.commit({ "src/app.ts": "export {};\n" });
      const [codeLocal, codeMirror] = await repo.both(code);
      expect(codeLocal.outcome).toBe("accepted");
      expect(states(codeMirror)).toEqual(states(codeLocal));
      expect(states(codeMirror)).toEqual(["lint:passed", "docs:skipped"]);
      const docs = await repo.commit({ "docs/guide.md": "# Guide\n" });
      const [docsLocal, docsMirror] = await repo.both(docs);
      expect(docsLocal.outcome).toBe("rejected");
      expect(states(docsMirror)).toEqual(states(docsLocal));
    } finally {
      await repo.cleanup();
    }
  });

  test("a moved branch blocks the mirror's decision as a moved HEAD blocks the worktree's", async () => {
    const repo = await mirroredRepo({ ".agents/closeout.yaml": policy([pass("lint")]) });
    try {
      const head = await repo.commit({ "src/app.ts": "export {};\n" });
      await repo.commit({ "src/app.ts": "export const later = 1;\n" });
      const decide = (mirror?: CloseoutMirror) =>
        decideCloseoutGate({
          worktree: repo.worktree,
          ...(mirror ? { mirror } : {}),
          taskId: TASK,
          base: repo.base,
          head,
          candidate: candidate(),
          home: repo.home,
          pawsHome: repo.pawsHome,
          reviewer: reviewer(),
          fixer: {
            async applyFix() {
              throw new Error("unexpected fix");
            },
          },
        });
      const local = await decide();
      const mirror = await decide(repo.mirror);
      expect(local.outcome).toBe("blocked");
      expect(mirror.outcome).toBe("blocked");
      expect(mirror.summary).toContain(`branch ${BRANCH} moved while closeout ran`);
    } finally {
      await repo.cleanup();
    }
  });

  test("a temporary failure fetching origin/main in the mirror is retried", async () => {
    const repo = await mirroredRepo({ ".agents/closeout.yaml": policy([pass("lint")]) });
    try {
      const head = await repo.commit({ "src/app.ts": "export {};\n" });
      await exec("git", [
        "--git-dir",
        repo.mirror.path,
        "remote",
        "set-url",
        "origin",
        "http://127.0.0.1:1/origin.git",
      ]);
      await expect(repo.evaluate(head, repo.mirror)).rejects.toBeInstanceOf(PolicyFetchError);
    } finally {
      await repo.cleanup();
    }
  });
});

function states(evaluation: Evaluation): string[] {
  return (evaluation.decision?.items ?? []).map((item) => `${item.id}:${item.state}`);
}

function candidate() {
  return { session: "impl-session", model: "claude", provider: "anthropic" };
}

function reviewer(finding?: string): CodexReviewer {
  return {
    async review() {
      return {
        session: "review-session",
        model: "codex",
        provider: "openai",
        findings: finding
          ? [{ severity: "P0", location: finding, explanation: "unsafe", evidence: "line 1" }]
          : [],
      };
    },
  };
}

function command(id: string, code: number, paths?: string[]): string[] {
  return [
    `  - id: ${id}`,
    "    kind: command",
    "    gate: beforePR",
    `    exec: ["bun", "-e", "process.exit(${code})"]`,
    "    timeoutSeconds: 30",
    ...(paths ? [`    paths: [${paths.map((entry) => JSON.stringify(entry)).join(", ")}]`] : []),
  ];
}

function pass(id: string, paths?: string[]): string[] {
  return command(id, 0, paths);
}

function fail(id: string, paths?: string[]): string[] {
  return command(id, 1, paths);
}

function review(id: string, paths: string[]): string[] {
  return [
    `  - id: ${id}`,
    "    kind: review",
    "    gate: beforePR",
    `    skill: ${SKILL}`,
    "    independence:",
    "      differentSession: true",
    "      differentModel: true",
    "    failOn: P1",
    `    paths: [${paths.map((entry) => JSON.stringify(entry)).join(", ")}]`,
  ];
}

function policy(items: string[][]): string {
  return [
    'specVersion: "0.1"',
    "retry:",
    "  maxFailedAttemptsPerItem: 3",
    "  scope: task",
    "items:",
    ...items.flat(),
    "",
  ].join("\n");
}

async function mirroredRepo(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "paws-closeout-mirror-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const mirrorPath = path.join(root, "repos", "owner", "repo.git");
  const worktree = path.join(root, "worktrees", TASK);
  const home = path.join(root, "home");
  await mkdir(home);
  const git = async (cwd: string, args: string[]) =>
    (await exec("git", ["-C", cwd, ...args])).stdout.trim();
  const identity = async (dir: string) => {
    await git(dir, ["config", "user.email", "paws-test@example.com"]);
    await git(dir, ["config", "user.name", "Paws Test"]);
    await git(dir, ["config", "commit.gpgsign", "false"]);
  };
  const write = async (dir: string, entries: Record<string, string>) => {
    for (const [name, body] of Object.entries(entries)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), body);
    }
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", Object.keys(entries).join(", ")]);
    return git(dir, ["rev-parse", "HEAD"]);
  };
  await exec("git", ["init", "--bare", "-b", "main", origin]);
  await exec("git", ["clone", origin, seed]);
  await identity(seed);
  const base = await write(seed, files);
  await git(seed, ["push", "origin", "HEAD:main"]);
  await exec("git", ["clone", "--bare", origin, mirrorPath]);
  await exec("git", [
    "--git-dir",
    mirrorPath,
    "config",
    "remote.origin.fetch",
    "+refs/heads/*:refs/remotes/origin/*",
  ]);
  await exec("git", ["--git-dir", mirrorPath, "worktree", "add", "-b", BRANCH, worktree, base]);
  await identity(worktree);
  const mirror: CloseoutMirror = { path: mirrorPath, branch: BRANCH };
  let runs = 0;
  const evaluate = (head: string, from?: CloseoutMirror, finding?: string) => {
    runs += 1;
    return evaluateCandidate({
      worktree,
      ...(from ? { mirror: from } : {}),
      taskId: TASK,
      base,
      head,
      candidate: candidate(),
      home,
      pawsHome: path.join(root, `paws-${runs}`),
      reviewer: reviewer(finding),
    });
  };
  return {
    base,
    worktree,
    mirror,
    home,
    pawsHome: path.join(root, "paws"),
    evaluate,
    commit: (entries: Record<string, string>) => write(worktree, entries),
    async pushMain(entries: Record<string, string>) {
      await git(seed, ["pull", "--ff-only", "origin", "main"]);
      await write(seed, entries);
      await git(seed, ["push", "origin", "HEAD:main"]);
    },
    async both(head: string, finding?: string): Promise<[Evaluation, Evaluation]> {
      return [await evaluate(head, undefined, finding), await evaluate(head, mirror, finding)];
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
