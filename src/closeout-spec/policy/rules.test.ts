import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createCloseoutSession } from "../session";
import type { ResolvedPolicyPresent } from "../types";
import { workspacePolicyFiles } from "../facade";
import {
  createFakeGitReader,
  loadPolicy,
  POLICY_MAX_BYTES,
  PUBLIC_POLICY_PATH,
  type PolicyLoadOutcome,
} from "./index";

const PROBE = ".agents/probes/api-contract.ts";
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("rules in the Closeout policy", () => {
  test("parsing and resolving accept rules with their defaults", () => {
    const git = createFakeGitReader({
      [PUBLIC_POLICY_PATH]: policy(
        rule("api-contract", PROBE, ['paths: ["src/server/**"]', "failOn: P1", "onFail: approve"]),
        rule("loop-owns-restart", ".agents/probes/loop.ts", [
          "failOn: P0",
          'exec: ["node", "--experimental-strip-types"]',
        ]),
      ),
      [PROBE]: "process.exit(0);\n",
      ".agents/probes/loop.ts": "process.exit(1);\n",
    });
    const loaded = present(loadPolicy({ repo: tempDir(), git, env: {} }));
    expect(loaded.rules).toEqual([
      {
        id: "api-contract",
        probe: PROBE,
        probeSha256: sha256("process.exit(0);\n"),
        exec: ["bun"],
        summary: "Summary of api-contract.",
        paths: ["src/server/**"],
        failOn: "P1",
        onFail: "approve",
      },
      {
        id: "loop-owns-restart",
        probe: ".agents/probes/loop.ts",
        probeSha256: sha256("process.exit(1);\n"),
        exec: ["node", "--experimental-strip-types"],
        summary: "Summary of loop-owns-restart.",
        failOn: "P0",
        onFail: "fix",
      },
    ]);
    expect(loaded.items).toEqual([]);
    expect(loaded.files.map((file) => file.path)).toEqual([
      PUBLIC_POLICY_PATH,
      ".agents/probes/api-contract.ts",
      ".agents/probes/loop.ts",
    ]);
  });

  test("a local policy root resolves rules from its own files", () => {
    const root = tempDir();
    writeFile(root, PUBLIC_POLICY_PATH, policy(rule("api-contract", PROBE, ["failOn: P1"])));
    writeFile(root, PROBE, "local probe\n");
    const loaded = present(
      loadPolicy({ policyRoot: root, repo: tempDir(), git: unused(), env: {} }),
    );
    expect(loaded.rules?.map((entry) => entry.probeSha256)).toEqual([sha256("local probe\n")]);
  });

  test("changing a probe's bytes changes the digest", () => {
    const git = createFakeGitReader({
      [PUBLIC_POLICY_PATH]: policy(rule("api-contract", PROBE, ["failOn: P1"])),
      [PROBE]: "process.exit(0);\n",
    });
    const repo = tempDir();
    const first = present(loadPolicy({ repo, git, env: {} }));
    expect(present(loadPolicy({ repo, git, env: {} })).digest).toBe(first.digest);
    git.put(PROBE, "process.exit(0); \n");
    expect(present(loadPolicy({ repo, git, env: {} })).digest).not.toBe(first.digest);
  });

  test("the worktree copy of a probe is not the digested file", () => {
    const committed = "committed probe\n";
    const git = createFakeGitReader({
      [PUBLIC_POLICY_PATH]: policy(rule("api-contract", PROBE, ["failOn: P1"])),
      [PROBE]: committed,
    });
    const repo = tempDir();
    const before = present(loadPolicy({ repo, git, env: {} }));
    writeFile(repo, PROBE, "process.exit(0); // edited on the branch\n");
    writeFile(
      repo,
      PUBLIC_POLICY_PATH,
      policy(
        rule("api-contract", PROBE, ["failOn: P3"]),
        rule("branch-rule", PROBE, ["failOn: P1"]),
      ),
    );
    const after = present(loadPolicy({ repo, git, env: {} }));
    expect(after.digest).toBe(before.digest);
    expect(after.rules?.map((entry) => entry.id)).toEqual(["api-contract"]);
    expect(after.files.find((file) => file.path === PROBE)?.sha256).toBe(sha256(committed));
  });

  test("a policy without rules keeps the digest it had before rules existed", () => {
    const bare = 'specVersion: "0.1"\nitems: []\n';
    const loaded = present(
      loadPolicy({
        repo: tempDir(),
        git: createFakeGitReader({ [PUBLIC_POLICY_PATH]: bare }),
        env: {},
      }),
    );
    expect(loaded.rules).toEqual([]);
    const identity = `{"files":[{"path":"${PUBLIC_POLICY_PATH}","sha256":"${sha256(bare)}"}],"items":[],"specVersion":"0.1"}`;
    expect(loaded.digest).toBe(`sha256:${sha256(identity)}`);
  });

  test("a duplicate id is rejected, against another rule or a check", () => {
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]: policy(
          rule("api-contract", PROBE, ["failOn: P1"]),
          rule("api-contract", PROBE, ["failOn: P2"]),
        ),
        [PROBE]: "probe\n",
      }),
      "duplicate requirement id api-contract",
    );
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]: `${policy(rule("lint", PROBE, ["failOn: P1"]))}items:\n  - id: lint\n    kind: command\n    gate: beforePR\n    exec: ["true"]\n    timeoutSeconds: 30\n`,
        [PROBE]: "probe\n",
      }),
      "duplicate requirement id lint",
    );
  });

  test("a missing probe is rejected", () => {
    expectBlocked(
      origin({ [PUBLIC_POLICY_PATH]: policy(rule("api-contract", PROBE, ["failOn: P1"])) }),
      `probe is missing: ${PROBE}`,
    );
    const root = tempDir();
    writeFile(root, PUBLIC_POLICY_PATH, policy(rule("api-contract", PROBE, ["failOn: P1"])));
    mkdirSync(join(root, PROBE), { recursive: true });
    expect(loadLocal(root)).toEqual({
      ok: false,
      source: "local",
      message: `probe is missing: ${PROBE}`,
    });
  });

  test("unknown fields, missing fields and bad values are rejected", () => {
    const cases: [string[], string][] = [
      [
        ["failOn: P1", "timeoutSeconds: 30"],
        "must NOT have additional properties ('timeoutSeconds' was unexpected)",
      ],
      [
        ["failOn: P1", "onFail: ignore"],
        "/rules/0/onFail must be equal to one of the allowed values",
      ],
      [["failOn: P4"], "/rules/0/failOn must be equal to one of the allowed values"],
      [[], "/rules/0 must have required property 'failOn'"],
      [["failOn: P1", "exec: []"], "/rules/0/exec must NOT have fewer than 1 items"],
    ];
    for (const [fields, message] of cases) {
      const result = origin({
        [PUBLIC_POLICY_PATH]: policy(rule("api-contract", PROBE, fields)),
        [PROBE]: "probe\n",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain(message);
    }
    const multiline = origin({
      [PUBLIC_POLICY_PATH]: `specVersion: "0.1"\nrules:\n  - id: api-contract\n    probe: ${PROBE}\n    summary: "two\\nlines"\n    failOn: P1\n`,
      [PROBE]: "probe\n",
    });
    expect(multiline.ok).toBe(false);
    if (!multiline.ok) expect(multiline.message).toContain("/rules/0/summary must match pattern");
  });

  test("rules are only allowed on the entry policy", () => {
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]:
          'specVersion: "0.1"\nimports:\n  - path: .agents/shared.yaml\n    as: shared\n',
        ".agents/shared.yaml": policy(rule("api-contract", PROBE, ["failOn: P1"])),
        [PROBE]: "probe\n",
      }),
      "rules is only allowed on the entry policy",
    );
  });

  test("a probe path that escapes the policy root is rejected", () => {
    for (const probe of ["../outside.ts", "/etc/passwd", "~/probe.ts", ".agents/../../x.ts"]) {
      expectBlocked(
        origin({ [PUBLIC_POLICY_PATH]: policy(rule("api-contract", probe, ["failOn: P1"])) }),
        `probe path is not repository-relative: ${probe}`,
      );
    }
    const parent = tempDir();
    const root = join(parent, "policy");
    writeFile(parent, "outside.ts", "outside\n");
    writeFile(
      root,
      PUBLIC_POLICY_PATH,
      policy(rule("api-contract", "../outside.ts", ["failOn: P1"])),
    );
    expect(loadLocal(root)).toEqual({
      ok: false,
      source: "local",
      message: "probe path is not repository-relative: ../outside.ts",
    });
  });

  test("a symlinked probe is rejected in git and on disk", () => {
    const git = createFakeGitReader({
      [PUBLIC_POLICY_PATH]: policy(rule("api-contract", PROBE, ["failOn: P1"])),
    });
    git.put(PROBE, "../../outside.ts", "120000");
    expectBlocked(loadPolicy({ repo: tempDir(), git, env: {} }), `probe is a symlink: ${PROBE}`);

    const parent = tempDir();
    const root = join(parent, "policy");
    writeFile(parent, "outside.ts", "outside\n");
    writeFile(root, PUBLIC_POLICY_PATH, policy(rule("api-contract", PROBE, ["failOn: P1"])));
    mkdirSync(join(root, ".agents", "probes"), { recursive: true });
    symlinkSync(join(parent, "outside.ts"), join(root, PROBE));
    expect(loadLocal(root)).toEqual({
      ok: false,
      source: "local",
      message: `probe is a symlink: ${PROBE}`,
    });

    const linkedDir = join(parent, "linked");
    writeFile(linkedDir, PUBLIC_POLICY_PATH, policy(rule("api-contract", PROBE, ["failOn: P1"])));
    mkdirSync(join(parent, "elsewhere"));
    writeFile(parent, "elsewhere/api-contract.ts", "outside\n");
    symlinkSync(join(parent, "elsewhere"), join(linkedDir, ".agents", "probes"));
    expect(loadLocal(linkedDir)).toEqual({
      ok: false,
      source: "local",
      message: `probe is a symlink: ${PROBE}`,
    });
  });

  test("a probe larger than a policy file may be is rejected", () => {
    const large = "x".repeat(POLICY_MAX_BYTES + 1);
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]: policy(rule("api-contract", PROBE, ["failOn: P1"])),
        [PROBE]: large,
      }),
      `probe is larger than ${POLICY_MAX_BYTES} bytes: ${PROBE}`,
    );
    const root = tempDir();
    writeFile(root, PUBLIC_POLICY_PATH, policy(rule("api-contract", PROBE, ["failOn: P1"])));
    writeFile(root, PROBE, large);
    expect(loadLocal(root)).toEqual({
      ok: false,
      source: "local",
      message: `probe is larger than ${POLICY_MAX_BYTES} bytes: ${PROBE}`,
    });
  });
});

describe("get_closeout lists rules", () => {
  test("only rules whose paths match the change, with their summaries", async () => {
    const policyRoot = tempDir();
    writeFile(
      policyRoot,
      PUBLIC_POLICY_PATH,
      policy(
        rule("api-contract", PROBE, ['paths: ["src/server/**"]', "failOn: P1"]),
        rule("migrations-append-only", ".agents/probes/migrations.ts", [
          'paths: ["src/db/**"]',
          "failOn: P0",
        ]),
        rule("loop-owns-restart", ".agents/probes/loop.ts", ["failOn: P1"]),
      ),
    );
    writeFile(policyRoot, PROBE, "probe\n");
    writeFile(policyRoot, ".agents/probes/migrations.ts", "probe\n");
    writeFile(policyRoot, ".agents/probes/loop.ts", "probe\n");
    const workspace = initRepo();
    const session = createCloseoutSession(workspace, {
      policy: async () => workspacePolicyFiles(policyRoot),
    });

    expect(JSON.parse(await session.report())).toEqual({
      required: [],
      pending: [],
      blocked: null,
      bypassed: false,
    });

    writeFile(workspace, "src/server/serve.ts", "export {};\n");
    const report = JSON.parse(await session.report()) as { rules?: unknown; pending: string[] };
    expect(report.rules).toEqual([
      {
        id: "api-contract",
        summary: "Summary of api-contract.",
        matched_paths: ["src/server/serve.ts"],
      },
      {
        id: "loop-owns-restart",
        summary: "Summary of loop-owns-restart.",
        matched_paths: ["src/server/serve.ts"],
      },
    ]);
    expect(report.pending).toEqual([]);
  });
});

function policy(...rules: string[]): string {
  return `specVersion: "0.1"\nrules:\n${rules.join("\n")}\n`;
}

function rule(id: string, probe: string, fields: string[]): string {
  return [`  - id: ${id}`, `    probe: ${probe}`, `    summary: Summary of ${id}.`]
    .concat(fields.map((field) => `    ${field}`))
    .join("\n");
}

function origin(files: Record<string, string>): PolicyLoadOutcome {
  return loadPolicy({ repo: tempDir(), git: createFakeGitReader(files), env: {} });
}

function loadLocal(root: string): PolicyLoadOutcome {
  return loadPolicy({ policyRoot: root, repo: tempDir(), git: unused(), env: {} });
}

function unused() {
  const git = createFakeGitReader();
  git.listError = "the local policy root does not read git";
  return git;
}

function present(result: PolicyLoadOutcome): ResolvedPolicyPresent {
  if (!result.ok || result.policy.source === "none") {
    throw new Error(`expected a present policy: ${JSON.stringify(result)}`);
  }
  return result.policy;
}

function expectBlocked(result: PolicyLoadOutcome, message: string): void {
  expect(result).toEqual({ ok: false, source: "repo", message });
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paws-closeout-rules-"));
  temps.push(dir);
  return dir;
}

function writeFile(root: string, path: string, contents: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function initRepo(): string {
  const root = tempDir();
  const run = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  writeFileSync(join(root, "README.md"), "hello\n");
  run(["add", "README.md"]);
  run(["commit", "-m", "init"]);
  run(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return root;
}
