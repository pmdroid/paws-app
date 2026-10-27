import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  createCloseoutSession,
  PROBE_TIMEOUT_SECONDS,
  probeArgv,
  trustedPolicyFiles,
  workspacePolicyFiles,
  type CloseoutProgress,
  type ResolvedRule,
} from "../closeout-spec";
import type { CodexReviewer } from "./reviewer";
import { evaluateCandidate, runCloseoutGate } from "./run";
import { loggedSessionProbe, sessionProbeResult } from "./session-report";

const exec = promisify(execFile);
const TASK = "PAS-789";
const PROBE = ".agents/probes/rule.ts";

const POLICY = [
  'specVersion: "0.1"',
  "items: []",
  "rules:",
  "  - id: probe-rule",
  "    summary: The probe's rule holds.",
  `    probe: ${PROBE}`,
  "    failOn: P1",
  "",
].join("\n");

/** Prints what it was given and how it ran, then runs `body`. */
function probe(body: string): string {
  return [
    "const args = process.argv.slice(2);",
    "const arg = (name: string) => args[args.indexOf(name) + 1] ?? '';",
    "console.log(JSON.stringify({ self: process.argv[1], cwd: process.cwd(), home: process.env.HOME, tmp: process.env.TMPDIR, paws: process.env.PAWS_HOME ?? null, base: arg('--base'), head: arg('--head'), repo: arg('--repo') }));",
    body,
    "",
  ].join("\n");
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("rule probes", () => {
  test("a probe that exits 0 against a clean candidate at the expected head passes", async () => {
    const repo = await candidateRepo(probe("process.exit(0);"));
    const output = captured();
    const result = await evaluateRepo(repo, output.progress);

    expect(result.outcome).toBe("accepted");
    expect(result.decision?.items).toContainEqual(
      expect.objectContaining({ id: "probe-rule", kind: "rule", state: "passed" }),
    );
    const seen = JSON.parse(output.stdout().trim().split("\n")[0]!) as Record<string, string>;
    expect(seen.base).toBe(repo.base);
    expect(seen.head).toBe(repo.head);
    expect(seen.repo).not.toBe(repo.dir);
    for (const where of [seen.self, seen.cwd, seen.home, seen.tmp]) {
      expect(where!.startsWith(seen.repo!)).toBe(false);
      expect(where!.startsWith(repo.dir)).toBe(false);
      expect(where!.startsWith(repo.pawsHome)).toBe(false);
    }
    expect(seen.home).not.toBe(process.env.HOME);
    expect(seen.paws).toBeNull();
  });

  test("a probe that exits 1 fails its rule and the finding carries the output", async () => {
    const repo = await candidateRepo(
      probe("console.error('removed field Task.title'); process.exit(1);"),
    );
    const summaries: string[] = [];
    const result = await runCloseoutGate({
      worktree: repo.dir,
      taskId: TASK,
      base: repo.base,
      head: repo.head,
      candidate: candidate(),
      home: repo.home,
      pawsHome: repo.pawsHome,
      reviewer: noReviewer(),
      maxFixAttempts: 1,
      fixer: {
        async applyFix(request) {
          summaries.push(request.summary);
          return { ok: false, reason: "stop" };
        },
      },
    });

    expect(result.outcome).not.toBe("accepted");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("probe-rule (rule): failed — probe exited 1; P1 finding");
    expect(summaries[0]).toContain("removed field Task.title");
  });

  test("replacing the worktree copy of the probe still runs the policy bytes", async () => {
    const repo = await candidateRepo(probe("console.log('policy bytes'); process.exit(1);"), {
      [PROBE]: "console.log('candidate bytes'); process.exit(0);\n",
    });
    const output = captured();
    const result = await evaluateRepo(repo, output.progress);

    expect(result.outcome).toBe("rejected");
    expect(output.stdout()).toContain("policy bytes");
    expect(output.stdout()).not.toContain("candidate bytes");
  });

  test("a probe that dirties the tree fails the rule", async () => {
    const repo = await candidateRepo(
      probe("await Bun.write(arg('--repo') + '/stray.txt', 'x'); process.exit(0);"),
    );
    const result = await evaluateRepo(repo);

    expect(result.decision?.items).toContainEqual(
      expect.objectContaining({
        id: "probe-rule",
        state: "failed",
        message: expect.stringContaining("probe left the worktree dirty"),
      }),
    );
  });

  test("a probe that moves HEAD fails the rule", async () => {
    const repo = await candidateRepo(
      probe(
        "Bun.spawnSync(['git', '-C', arg('--repo'), 'checkout', '-q', '--detach', 'HEAD~1']); process.exit(0);",
      ),
    );
    const result = await evaluateRepo(repo);

    expect(result.decision?.items).toContainEqual(
      expect.objectContaining({
        id: "probe-rule",
        state: "failed",
        message: expect.stringContaining("probe moved HEAD"),
      }),
    );
  });

  test("an implementer run_closeout of a rule id records no pass", async () => {
    const repo = await candidateRepo(probe("process.exit(0);"));
    const session = createCloseoutSession(repo.dir, {
      policy: async () => workspacePolicyFiles(repo.dir),
    });

    const ran = await session.run("probe-rule");
    expect(ran).toContain("is not a check this session runs");
    const report = JSON.parse(await session.report()) as {
      rules: { id: string; summary: string; matched_paths: string[]; result?: unknown }[];
    };
    expect(report.rules).toEqual([
      { id: "probe-rule", summary: "The probe's rule holds.", matched_paths: ["src/a.ts"] },
    ]);
  });

  test("a runner's stored result counts only when hash, argv, head and timeout match", async () => {
    const policyProbe = probe("console.log('policy bytes'); process.exit(1);");
    const repo = await candidateRepo(policyProbe, {
      [PROBE]: "console.log('candidate bytes'); process.exit(0);\n",
    });
    const session = createCloseoutSession(repo.dir, {
      policy: async () => trustedPolicyFiles(repo.dir, repo.home),
    });
    const report = await session.report({ probes: true });
    const rule = policyRule(sha256(policyProbe));
    const request = {
      rule,
      bytes: undefined,
      base: repo.base,
      head: repo.head,
      checkout: repo.dir,
      argv: probeArgv(rule, repo.base, repo.head),
      timeoutSeconds: PROBE_TIMEOUT_SECONDS,
      logFile: path.join(repo.root, "probe.log"),
      artifactPath: "logs/probe.log",
    };

    const result = loggedSessionProbe(report, request);
    expect(result).toMatchObject({ exitCode: 1, probeSha256: rule.probeSha256, dirty: false });
    expect(sessionProbeResult(report, request)?.stdout).toContain("policy bytes");
    for (const changed of [
      { rule: policyRule(sha256("other bytes")) },
      { head: repo.base },
      { argv: [...request.argv.slice(0, -1), repo.dir] },
      { timeoutSeconds: PROBE_TIMEOUT_SECONDS + 1 },
    ])
      expect(sessionProbeResult(report, { ...request, ...changed })).toBeUndefined();
  });
});

function policyRule(probeSha256: string): ResolvedRule {
  return {
    id: "probe-rule",
    probe: PROBE,
    probeSha256,
    exec: ["bun"],
    summary: "The probe's rule holds.",
    failOn: "P1",
    onFail: "fix",
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function candidate() {
  return { session: "impl-session", model: "claude", provider: "anthropic" };
}

function noReviewer(): CodexReviewer {
  return {
    async review() {
      throw new Error("reviewer should not be called");
    },
  };
}

function captured(): { progress: CloseoutProgress; stdout: () => string } {
  let stdout = "";
  return {
    progress: {
      begin() {},
      step() {},
      output(_identity, stepId, stream, text) {
        if (stepId === "probe-rule" && stream === "stdout") stdout += text;
      },
      finish() {},
    },
    stdout: () => stdout,
  };
}

type Repo = {
  root: string;
  dir: string;
  base: string;
  head: string;
  home: string;
  pawsHome: string;
};

function evaluateRepo(repo: Repo, progress?: CloseoutProgress) {
  return evaluateCandidate({
    worktree: repo.dir,
    taskId: TASK,
    base: repo.base,
    head: repo.head,
    candidate: candidate(),
    home: repo.home,
    pawsHome: repo.pawsHome,
    reviewer: noReviewer(),
    ...(progress ? { progress } : {}),
  });
}

/**
 * `origin/main` holds the policy and `probeSource`. The candidate commit on top changes
 * `src/a.ts` and writes `candidateFiles`.
 */
async function candidateRepo(
  probeSource: string,
  candidateFiles: Record<string, string> = {},
): Promise<Repo> {
  const root = await mkdtemp(path.join(tmpdir(), "paws-rule-probe-"));
  roots.push(root);
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
  const write = async (files: Record<string, string>) => {
    for (const [name, body] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), body);
    }
    await exec("git", ["-C", dir, "add", "."]);
  };
  await write({ ".agents/closeout.yaml": POLICY, [PROBE]: probeSource, "src/a.ts": "a\n" });
  await exec("git", ["-C", dir, "commit", "-qm", "main"]);
  await exec("git", ["-C", dir, "push", "-q", "origin", "HEAD:main"]);
  await exec("git", ["-C", dir, "fetch", "-q", "origin"]);
  const base = (await exec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  await write({ "src/a.ts": "b\n", ...candidateFiles });
  await exec("git", ["-C", dir, "commit", "-qm", "candidate"]);
  const head = (await exec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  return { root, dir, base, head, home, pawsHome };
}
