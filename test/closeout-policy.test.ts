import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  anyPathMatches,
  canonicalJson,
  createFakeGitReader,
  GLOBAL_POLICY_CODE,
  loadPolicy,
  NO_CLOSEOUT_POLICY,
  pathsMatch,
  policyCanonicalJson,
  PUBLIC_POLICY_PATH,
  type FakeGitReader,
  type PolicyLoadOutcome,
} from "../src/closeout-spec/policy";
import type { ResolvedPolicyPresent } from "../src/closeout-spec";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("canonical policy JSON", () => {
  test("sorts object keys by UTF-16 code unit and keeps array order", () => {
    expect(canonicalJson({ b: [2, 1], a: { d: true, c: "x/y" } })).toBe(
      '{"a":{"c":"x/y","d":true},"b":[2,1]}',
    );
  });

  test("orders keys by UTF-16 code units, including astral characters", () => {
    const text = canonicalJson({ "\u{1F600}": 1, a: 2, "\u{E000}": 3 });
    const ascii = text.indexOf('"a"');
    const emoji = text.indexOf('"\u{1F600}"');
    const privateUse = text.indexOf('"\u{E000}"');
    expect(ascii).toBeGreaterThanOrEqual(0);
    expect(ascii).toBeLessThan(emoji);
    expect(emoji).toBeLessThan(privateUse);
  });

  test("rejects numbers that are not safe integers", () => {
    expect(() => canonicalJson(1.5)).toThrow("canonical JSON only accepts safe integers");
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(
      "canonical JSON only accepts safe integers",
    );
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(9_007_199_254_740_991)).toBe("9007199254740991");
  });
});

describe("path matcher", () => {
  test("matches prefixes, single-segment wildcards, and double star", () => {
    expect(pathsMatch("apps/engine/**", "apps/engine/main.ts")).toBe(true);
    expect(pathsMatch("apps/engine/**", "apps/engine/src/main.ts")).toBe(true);
    expect(pathsMatch("apps/engine/**", "apps/engine")).toBe(true);
    expect(pathsMatch("apps/engine/**", "apps/frontend/main.ts")).toBe(false);
    expect(pathsMatch("apps/engine/**", "apps/engine-extra/main.ts")).toBe(false);
    expect(pathsMatch("apps/engine/", "apps/engine/main.ts")).toBe(true);
    expect(pathsMatch("apps/engine/", "apps/engine")).toBe(false);
    expect(pathsMatch("apps/engine/", "apps/engine-extra/main.ts")).toBe(false);
    expect(pathsMatch("*.ts", "main.ts")).toBe(true);
    expect(pathsMatch("*.ts", "src/main.ts")).toBe(false);
    expect(pathsMatch("**/*.ts", "src/main.ts")).toBe(true);
    expect(pathsMatch("**/*.ts", "main.ts")).toBe(true);
    expect(pathsMatch("a?c", "abc")).toBe(true);
    expect(pathsMatch("a?c", "ac")).toBe(false);
    expect(pathsMatch("*", "a/b")).toBe(false);
    expect(pathsMatch("a/**/b", "a/b")).toBe(true);
    expect(pathsMatch("a/**/b", "a/x/y/b")).toBe(true);
    expect(anyPathMatches(["apps/engine/", "docs/**"], ["apps/engine/main.ts"])).toBe(true);
    expect(anyPathMatches(["apps/engine/"], ["README.md"])).toBe(false);
  });
});

describe("local policy override", () => {
  test("loads without fetching origin and snapshots imported skills with their digest", () => {
    const root = tempDir();
    mkdirSync(join(root, ".agents/skills/review/references"), { recursive: true });
    writeFileSync(
      join(root, PUBLIC_POLICY_PATH),
      'specVersion: "0.1"\nimports: [{as: local, path: .agents/checks.yaml}]\n',
    );
    writeFileSync(
      join(root, ".agents/checks.yaml"),
      'specVersion: "0.1"\nitems: [{id: review, kind: review, gate: beforePR, skill: .agents/skills/review/SKILL.md, independence: {differentSession: true, differentModel: true}, failOn: P1}]\n',
    );
    const skillPath = ".agents/skills/review/SKILL.md";
    writeFileSync(join(root, skillPath), "Trusted local review instructions");
    const git = createFakeGitReader();
    const first = loadPolicy({ repo: "/missing/repo", git, policyRoot: root });
    expect(first.ok).toBe(true);
    if (!first.ok || first.policy.source === "none") throw new Error("expected policy");
    expect(first.policy.source).toBe("local");
    expect(first.policy.items[0]?.id).toBe("local/review");
    expect(first.policy.entryPath).toBe(join(root, PUBLIC_POLICY_PATH));
    expect(git.calls).toHaveLength(0);
    writeFileSync(join(root, skillPath), "Changed local review instructions");
    expect(new TextDecoder().decode(first.policy.skillFiles?.get(skillPath))).toBe(
      "Trusted local review instructions",
    );
    const second = loadPolicy({ repo: "/missing/repo", git, policyRoot: root });
    expect(second.ok && second.policy.digest).not.toBe(first.policy.digest);
  });

  test("configured missing and malformed local policies block without fallback", () => {
    const root = tempDir();
    const git = createFakeGitReader();
    expect(loadPolicy({ repo: "/missing/repo", git, policyRoot: root })).toMatchObject({
      ok: false,
      source: "local",
    });
    mkdirSync(join(root, ".agents"));
    writeFileSync(join(root, PUBLIC_POLICY_PATH), "specVersion: invalid\n");
    expect(loadPolicy({ repo: "/missing/repo", git, policyRoot: root })).toMatchObject({
      ok: false,
      source: "local",
    });
    expect(loadPolicy({ repo: "/missing/repo", git, policyRoot: "" })).toMatchObject({
      ok: false,
      source: "local",
    });
    expect(git.calls).toHaveLength(0);
  });
});

describe("policy errors", () => {
  test("duplicate keys", () => {
    const { result } = origin({
      [PUBLIC_POLICY_PATH]: 'specVersion: "0.1"\nspecVersion: "0.1"\n',
    });
    expectBlocked(result, "repo", ".agents/closeout.yaml: duplicated mapping key");
  });

  test("invalid YAML", () => {
    const { result } = origin({ [PUBLIC_POLICY_PATH]: "items: [\n" });
    expectBlocked(result, "repo", ".agents/closeout.yaml: invalid YAML");
  });

  test("unknown field", () => {
    const { result } = origin({ [PUBLIC_POLICY_PATH]: 'specVersion: "0.1"\nnope: true\n' });
    expectBlocked(
      result,
      "repo",
      ".agents/closeout.yaml: / must NOT have additional properties ('nope' was unexpected)",
    );
  });

  test("specVersion must be the string 0.1", () => {
    const quoted = origin({ [PUBLIC_POLICY_PATH]: 'specVersion: "0.9"\n' });
    expectBlocked(
      quoted.result,
      "repo",
      ".agents/closeout.yaml: /specVersion must be equal to constant",
    );
    const unquoted = origin({ [PUBLIC_POLICY_PATH]: "specVersion: 0.1\n" });
    expectBlocked(
      unquoted.result,
      "repo",
      ".agents/closeout.yaml: /specVersion must be equal to constant",
    );
    const renamed = origin({ [PUBLIC_POLICY_PATH]: "version: 1\nitems: []\n" });
    expectBlocked(
      renamed.result,
      "repo",
      ".agents/closeout.yaml: / must have required property 'specVersion'",
    );
  });

  test("malformed item and unknown kind", () => {
    const malformed = origin({
      [PUBLIC_POLICY_PATH]:
        'specVersion: "0.1"\nitems:\n  - id: check\n    kind: nope\n    gate: beforePR\n',
    });
    expectBlocked(
      malformed.result,
      "repo",
      ".agents/closeout.yaml: /items/0 must match exactly one schema in oneOf",
    );
    const unknown = origin({
      [PUBLIC_POLICY_PATH]:
        'specVersion: "0.1"\nitems:\n  - id: ci\n    kind: ci\n    gate: beforePR\n',
    });
    expectBlocked(
      unknown.result,
      "repo",
      ".agents/closeout.yaml: /items/0 must match exactly one schema in oneOf",
    );
  });

  test("id and import name regex", () => {
    const id = origin({
      [PUBLIC_POLICY_PATH]:
        'specVersion: "0.1"\nitems:\n  - id: Bad\n    kind: command\n    gate: beforePR\n    exec: ["true"]\n    timeoutSeconds: 30\n',
    });
    expectBlocked(
      id.result,
      "repo",
      '.agents/closeout.yaml: /items/0/id must match pattern "^[a-z][a-z0-9]*(-[a-z0-9]+)*$"',
    );
    const imported = origin({
      [PUBLIC_POLICY_PATH]:
        'specVersion: "0.1"\nimports:\n  - path: .agents/closeout/child.yaml\n    as: Bad\n',
    });
    expectBlocked(
      imported.result,
      "repo",
      '.agents/closeout.yaml: /imports/0/as must match pattern "^[a-z][a-z0-9]*(-[a-z0-9]+)*$"',
    );
  });

  test("setup bounds and entry-only setup", () => {
    const empty = origin({ [PUBLIC_POLICY_PATH]: 'specVersion: "0.1"\nsetup: []\n' });
    expectBlocked(
      empty.result,
      "repo",
      ".agents/closeout.yaml: /setup must NOT have fewer than 1 items",
    );
    const steps = Array.from({ length: 33 }, (_, index) => stepYaml(`s${index}`)).join("\n");
    const tooMany = origin({
      [PUBLIC_POLICY_PATH]: `specVersion: "0.1"\nsetup:\n${steps}\n`,
    });
    expectBlocked(
      tooMany.result,
      "repo",
      ".agents/closeout.yaml: /setup must NOT have more than 32 items",
    );
    const { result } = origin({
      [PUBLIC_POLICY_PATH]:
        'specVersion: "0.1"\nimports:\n  - path: .agents/closeout/extra.yaml\n    as: extra\n',
      ".agents/closeout/extra.yaml":
        'specVersion: "0.1"\nsetup:\n  - id: js\n    exec: ["true"]\n    timeoutSeconds: 30\n',
    });
    expectBlocked(result, "repo", "setup is only allowed on the entry policy");
  });

  test("retry bounds and entry-only retry", () => {
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]:
          'specVersion: "0.1"\nretry:\n  maxFailedAttemptsPerItem: 0\n  scope: task\n',
      }).result,
      "repo",
      ".agents/closeout.yaml: /retry/maxFailedAttemptsPerItem must be >= 1",
    );
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]:
          'specVersion: "0.1"\nretry:\n  maxFailedAttemptsPerItem: 100001\n  scope: task\n',
      }).result,
      "repo",
      ".agents/closeout.yaml: /retry/maxFailedAttemptsPerItem must be <= 100000",
    );
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]:
          'specVersion: "0.1"\nretry:\n  maxFailedAttemptsPerItem: 1\n  scope: session\n',
      }).result,
      "repo",
      ".agents/closeout.yaml: /retry/scope must be equal to one of the allowed values",
    );
    expectBlocked(
      origin({ [PUBLIC_POLICY_PATH]: 'specVersion: "0.1"\nretry:\n  scope: task\n' }).result,
      "repo",
      ".agents/closeout.yaml: /retry must have required property 'maxFailedAttemptsPerItem'",
    );
    const { result } = origin({
      [PUBLIC_POLICY_PATH]:
        'specVersion: "0.1"\nimports:\n  - path: .agents/closeout/child.yaml\n    as: child\n',
      ".agents/closeout/child.yaml":
        'specVersion: "0.1"\nretry:\n  maxFailedAttemptsPerItem: 2\n  scope: task\n',
    });
    expectBlocked(result, "repo", "retry is only allowed on the entry policy");
  });

  test("the review cap is entry-only and absent fields preserve canonical identity", () => {
    const text = 'specVersion: "0.1"\nretry:\n  maxFailedAttemptsPerItem: 3\n  scope: task\n';
    const legacy = present(origin({ [PUBLIC_POLICY_PATH]: text }).result);
    const capped = present(
      origin({ [PUBLIC_POLICY_PATH]: text + "  maxFailedReviewAttempts: 12\n" }).result,
    );
    expect(legacy.digest).toBe(
      "sha256:57b6d478e6a18c6877982e4a7d37b0c01219b4b27fdc87e540f45917a6dcb977",
    );
    expect(policyCanonicalJson(legacy)).not.toContain("maxFailedReviewAttempts");
    expect(policyCanonicalJson(capped)).toContain('"maxFailedReviewAttempts":12');
    const withoutCap = { ...capped, files: legacy.files, retry: legacy.retry };
    expect(policyCanonicalJson(withoutCap)).toBe(policyCanonicalJson(legacy));
    const imported = origin({
      [PUBLIC_POLICY_PATH]:
        'specVersion: "0.1"\nimports:\n  - path: .agents/child.yaml\n    as: child\n',
      ".agents/child.yaml": text + "  maxFailedReviewAttempts: 12\n",
    });
    expectBlocked(imported.result, "repo", "retry is only allowed on the entry policy");
  });

  test("import escape, missing file, cycle, and duplicate name", () => {
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]:
          'specVersion: "0.1"\nimports:\n  - path: ../secret.yaml\n    as: secret\n',
      }).result,
      "repo",
      "import path is not repository-relative: ../secret.yaml",
    );
    for (const path of ["/etc/passwd", "~/.agents/closeout.yaml", "a\\b.yaml", "a//b.yaml", "."]) {
      expectBlocked(
        origin({
          [PUBLIC_POLICY_PATH]: `specVersion: "0.1"\nimports:\n  - path: ${JSON.stringify(path)}\n    as: secret\n`,
        }).result,
        "repo",
        `import path is not repository-relative: ${path}`,
      );
    }
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]:
          'specVersion: "0.1"\nimports:\n  - path: .agents/closeout/missing.yaml\n    as: missing\n',
      }).result,
      "repo",
      "import is missing: .agents/closeout/missing.yaml",
    );
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]:
          'specVersion: "0.1"\nimports:\n  - path: .agents/closeout/a.yaml\n    as: a\n',
        ".agents/closeout/a.yaml":
          'specVersion: "0.1"\nimports:\n  - path: .agents/closeout/b.yaml\n    as: b\n',
        ".agents/closeout/b.yaml":
          'specVersion: "0.1"\nimports:\n  - path: .agents/closeout/a.yaml\n    as: a\n',
      }).result,
      "repo",
      "import cycle: .agents/closeout.yaml -> .agents/closeout/a.yaml -> .agents/closeout/b.yaml -> .agents/closeout/a.yaml",
    );
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]:
          'specVersion: "0.1"\nimports:\n  - path: .agents/closeout/quality.yaml\n    as: quality\n  - path: .agents/closeout/other.yaml\n    as: quality\n',
        ".agents/closeout/quality.yaml": commandPolicy("typecheck"),
      }).result,
      "repo",
      "duplicate import name quality in .agents/closeout.yaml",
    );
  });

  test("duplicate qualified id and setup id collision", () => {
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]:
          'specVersion: "0.1"\nimports:\n  - path: .agents/closeout/quality.yaml\n    as: quality\n',
        ".agents/closeout/quality.yaml": `${commandPolicy("typecheck").trimEnd()}\n${commandItem("typecheck")}\n`,
      }).result,
      "repo",
      "duplicate requirement id quality/typecheck",
    );
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]: `specVersion: "0.1"\nsetup:\n${stepYaml("markdown")}\nitems:\n${commandItem("markdown")}\n`,
      }).result,
      "repo",
      "duplicate requirement id markdown",
    );
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]: `specVersion: "0.1"\nsetup:\n${stepYaml("js")}\n${stepYaml("js")}\n`,
      }).result,
      "repo",
      "duplicate requirement id js",
    );
  });

  test("path patterns", () => {
    for (const pattern of [
      "../secret",
      "/etc/passwd",
      "!secret",
      "a\\b",
      "C:/windows",
      "a/../b",
      "a//b",
      ".",
      "..",
    ]) {
      expectBlocked(
        origin({
          [PUBLIC_POLICY_PATH]: `specVersion: "0.1"\nitems:\n${commandItem("engine", `    paths: [${JSON.stringify(pattern)}]\n`)}\n`,
        }).result,
        "repo",
        `path pattern is invalid: ${pattern}`,
      );
    }
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]:
          'specVersion: "0.1"\nitems:\n  - id: engine\n    kind: command\n    gate: beforePR\n    exec: ["true"]\n    timeoutSeconds: 30\n    paths: []\n',
      }).result,
      "repo",
      ".agents/closeout.yaml: /items/0/paths must NOT have fewer than 1 items",
    );
    const many = Array.from({ length: 101 }, (_, index) => `"p${index}"`).join(", ");
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]: `specVersion: "0.1"\nitems:\n  - id: engine\n    kind: command\n    gate: beforePR\n    exec: ["true"]\n    timeoutSeconds: 30\n    paths: [${many}]\n`,
      }).result,
      "repo",
      ".agents/closeout.yaml: /items/0/paths must NOT have more than 100 items",
    );
  });

  test("review skill path, missing skill, symlink, and non-file", () => {
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]: reviewPolicy(".agents/skills/look/readme.md"),
        ".agents/skills/look/readme.md": "notes\n",
      }).result,
      "repo",
      "skill path is not a repository SKILL.md: .agents/skills/look/readme.md",
    );
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]: reviewPolicy("../SKILL.md"),
      }).result,
      "repo",
      "skill path is not a repository SKILL.md: ../SKILL.md",
    );
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]: reviewPolicy("SKILL.md"),
      }).result,
      "repo",
      "skill path is not a repository SKILL.md: SKILL.md",
    );
    expectBlocked(
      origin({
        [PUBLIC_POLICY_PATH]: reviewPolicy(".agents/skills/missing/SKILL.md"),
      }).result,
      "repo",
      "skill is missing: .agents/skills/missing/SKILL.md",
    );

    const broken = createFakeGitReader({
      [PUBLIC_POLICY_PATH]: reviewPolicy(".agents/skills/look/SKILL.md"),
      ".agents/skills/look/SKILL.md": "look\n",
    });
    broken.put(".agents/skills/look/references/rubric.md", "target", "120000");
    expectBlocked(
      loadPolicy({ repo: tempDir(), git: broken, env: {} }),
      "repo",
      "skill link is broken: .agents/skills/look/references/rubric.md",
    );

    const gitlink = createFakeGitReader({
      [PUBLIC_POLICY_PATH]: reviewPolicy(".agents/skills/look/SKILL.md"),
      ".agents/skills/look/SKILL.md": "look\n",
    });
    gitlink.put(".agents/skills/look/asset.bin", "x", "160000");
    expectBlocked(
      loadPolicy({ repo: tempDir(), git: gitlink, env: {} }),
      "repo",
      "skill path is not a file: .agents/skills/look/asset.bin",
    );

    const entryLink = createFakeGitReader();
    entryLink.put(PUBLIC_POLICY_PATH, "nowhere.yaml", "120000");
    expectBlocked(
      loadPolicy({ repo: tempDir(), git: entryLink, env: {} }),
      "repo",
      "skill link is broken: .agents/closeout.yaml",
    );
  });

  test("symlinks in the origin tree are followed and keep the linked path", () => {
    const git = createFakeGitReader({
      [PUBLIC_POLICY_PATH]: reviewPolicy(".agents/skills/look/SKILL.md"),
      ".agents/skills/look/SKILL.md": "look\n",
      ".agents/skills/look/AGENTS.md": "rules\n",
    });
    git.put(".agents/skills/look/CLAUDE.md", "AGENTS.md", "120000");
    git.put(".agents/skills/look/references/nested.md", "../AGENTS.md", "120000");
    const policy = present(loadPolicy({ repo: tempDir(), git, env: {} }));
    expect(policy.files.map((file) => file.path)).toEqual([
      ".agents/closeout.yaml",
      ".agents/skills/look/AGENTS.md",
      ".agents/skills/look/CLAUDE.md",
      ".agents/skills/look/SKILL.md",
      ".agents/skills/look/references/nested.md",
    ]);
    expect(policy.files[2]?.sha256).toBe(sha256("rules\n"));
    expect(policy.files[4]?.sha256).toBe(sha256("rules\n"));
    expect(new TextDecoder().decode(policy.skillFiles?.get(".agents/skills/look/CLAUDE.md"))).toBe(
      "rules\n",
    );

    const entry = createFakeGitReader({
      ".agents/policy.yaml": reviewPolicy(".agents/skills/look/SKILL.md"),
      ".agents/skills/look/SKILL.md": "look\n",
    });
    entry.put(PUBLIC_POLICY_PATH, "policy.yaml", "120000");
    expect(present(loadPolicy({ repo: tempDir(), git: entry, env: {} })).entryPath).toBe(
      PUBLIC_POLICY_PATH,
    );

    const loop = createFakeGitReader({
      [PUBLIC_POLICY_PATH]: reviewPolicy(".agents/skills/look/SKILL.md"),
      ".agents/skills/look/SKILL.md": "look\n",
    });
    loop.put(".agents/skills/look/a.md", "b.md", "120000");
    loop.put(".agents/skills/look/b.md", "a.md", "120000");
    expectBlocked(
      loadPolicy({ repo: tempDir(), git: loop, env: {} }),
      "repo",
      "skill link loops: .agents/skills/look/a.md",
    );
  });

  test("an in-tree link whose target the commit lacks is broken, never read from the checkout", () => {
    const git = createFakeGitReader({
      ".agents/skills/look/SKILL.md": "look\n",
    });
    git.put(PUBLIC_POLICY_PATH, "policy.yaml", "120000");
    const repo = tempDir();
    writeRepoFile(repo, ".agents/policy.yaml", reviewPolicy(".agents/skills/look/SKILL.md"));
    expectBlocked(
      loadPolicy({ repo, git, env: {} }),
      "repo",
      "skill link is broken: .agents/closeout.yaml",
    );
  });

  test("a link to the repository root and root-level links stay in the commit", () => {
    const toRoot = createFakeGitReader({
      [PUBLIC_POLICY_PATH]: reviewPolicy(".agents/skills/look/SKILL.md"),
      "look/SKILL.md": "root look\n",
    });
    toRoot.put(".agents/skills", "..", "120000");
    const repo = tempDir();
    writeRepoFile(repo, "look/SKILL.md", "checkout look\n");
    const viaRoot = present(loadPolicy({ repo, git: toRoot, env: {} }));
    expect(viaRoot.files.map((file) => file.path)).toEqual([
      ".agents/closeout.yaml",
      ".agents/skills/look/SKILL.md",
    ]);
    expect(viaRoot.files[1]?.sha256).toBe(sha256("root look\n"));

    const chain = createFakeGitReader({
      [PUBLIC_POLICY_PATH]: reviewPolicy(".agents/skills/look/SKILL.md"),
      ".agents/skills/look/SKILL.md": "look\n",
      "source.md": "committed source\n",
    });
    chain.put("rubric.md", "source.md", "120000");
    chain.put(".agents/skills/look/references/rubric.md", "../../../../rubric.md", "120000");
    const chained = present(loadPolicy({ repo: tempDir(), git: chain, env: {} }));
    expect(chained.files.map((file) => file.path)).toContain(
      ".agents/skills/look/references/rubric.md",
    );
    expect(chained.files.find((file) => file.path.endsWith("references/rubric.md"))?.sha256).toBe(
      sha256("committed source\n"),
    );
  });

  test("an absolute link into the repository resolves in the commit, one outside it on disk", () => {
    const repo = tempDir();
    const git = createFakeGitReader({
      ".agents/policy.yaml": reviewPolicy(".agents/skills/look/SKILL.md"),
      ".agents/skills/look/SKILL.md": "look\n",
    });
    git.put(PUBLIC_POLICY_PATH, join(repo, ".agents/policy.yaml"), "120000");
    writeRepoFile(repo, ".agents/policy.yaml", commandPolicy("checkout"));
    const policy = present(loadPolicy({ repo, git, env: {} }));
    expect(policy.items.map((item) => item.id)).toEqual(["look"]);
    expect(policy.files[0]?.sha256).toBe(sha256(reviewPolicy(".agents/skills/look/SKILL.md")));

    const outside = tempDir();
    writeRepoFile(outside, "policy.yaml", commandPolicy("disk"));
    const away = createFakeGitReader({ ".agents/skills/look/SKILL.md": "look\n" });
    away.put(PUBLIC_POLICY_PATH, join(outside, "policy.yaml"), "120000");
    const fromDisk = present(loadPolicy({ repo: tempDir(), git: away, env: {} }));
    expect(fromDisk.items.map((item) => item.id)).toEqual(["disk"]);
  });

  test("a dot-dot after a linked directory climbs from the directory the link resolves to", () => {
    const git = createFakeGitReader({
      [PUBLIC_POLICY_PATH]: reviewPolicy(".agents/skills/look/SKILL.md"),
      ".agents/skills/look/SKILL.md": "look\n",
      "shared/rubric.md": "shared rubric\n",
      "shared/sub/note.md": "note\n",
    });
    git.put(".agents/skills/look/ref", "../../../shared/sub", "120000");
    git.put(".agents/skills/look/example.md", "ref/../rubric.md", "120000");
    const repo = tempDir();
    writeRepoFile(repo, ".agents/skills/look/rubric.md", "checkout rubric\n");
    const policy = present(loadPolicy({ repo, git, env: {} }));
    expect(policy.files.map((file) => file.path)).toEqual([
      ".agents/closeout.yaml",
      ".agents/skills/look/SKILL.md",
      ".agents/skills/look/example.md",
      ".agents/skills/look/ref/note.md",
    ]);
    expect(policy.files[2]?.sha256).toBe(sha256("shared rubric\n"));
  });

  test("a skill reached through a linked directory loads from the commit", () => {
    const git = createFakeGitReader({
      [PUBLIC_POLICY_PATH]: reviewPolicy(".agents/skills/look/SKILL.md"),
      "shared/look/SKILL.md": "shared look\n",
      "shared/look/references/rubric.md": "shared rubric\n",
    });
    git.put(".agents/skills/look", "../../shared/look", "120000");
    const policy = present(loadPolicy({ repo: tempDir(), git, env: {} }));
    expect(policy.files.map((file) => file.path)).toEqual([
      ".agents/closeout.yaml",
      ".agents/skills/look/SKILL.md",
      ".agents/skills/look/references/rubric.md",
    ]);
    expect(policy.files[1]?.sha256).toBe(sha256("shared look\n"));
  });

  test("unreadable git blobs", () => {
    const listed = createFakeGitReader({ [PUBLIC_POLICY_PATH]: 'specVersion: "0.1"\n' });
    listed.listError = "fatal: not a git repository";
    expectBlocked(
      loadPolicy({ repo: tempDir(), git: listed, env: {} }),
      "repo",
      "could not read the policy file",
    );

    const reader = createFakeGitReader({ [PUBLIC_POLICY_PATH]: 'specVersion: "0.1"\n' });
    reader.readError = "fatal: bad object";
    expectBlocked(
      loadPolicy({ repo: tempDir(), git: reader, env: {} }),
      "repo",
      "could not read the policy file",
    );
  });

  test("an empty existing file is blocked", () => {
    expectBlocked(
      origin({ [PUBLIC_POLICY_PATH]: "" }).result,
      "repo",
      ".agents/closeout.yaml: / must be object",
    );
  });

  test("YAML 1.2 keeps yes as a string", () => {
    const { result } = origin({
      [PUBLIC_POLICY_PATH]: `specVersion: "0.1"
items:
  - id: look
    kind: review
    gate: beforePR
    skill: .agents/skills/look/SKILL.md
    independence:
      differentSession: yes
      differentModel: false
    failOn: P1
`,
      ".agents/skills/look/SKILL.md": "look\n",
    });
    expectBlocked(
      result,
      "repo",
      ".agents/closeout.yaml: /items/0/independence/differentSession must be boolean",
    );
  });
});

describe("resolved policy and digest", () => {
  test("resolves imports depth-first and keeps setup off the item list", () => {
    const { result } = origin({
      [PUBLIC_POLICY_PATH]: `specVersion: "0.1"
description: Requires Bun.
retry:
  maxFailedAttemptsPerItem: 5
  scope: task
setup:
${stepYaml("js")}
${stepYaml("worker", '    paths: ["apps/worker/**"]\n')}
imports:
  - path: .agents/closeout/a.yaml
    as: a
  - path: .agents/closeout/b.yaml
    as: b
items:
${commandItem("top")}
`,
      ".agents/closeout/a.yaml": `specVersion: "0.1"
imports:
  - path: .agents/closeout/c.yaml
    as: c
items:
${commandItem("mid")}
`,
      ".agents/closeout/c.yaml": commandPolicy("deep"),
      ".agents/closeout/b.yaml": commandPolicy("side"),
    });
    const policy = present(result);
    expect(policy.items.map((item) => item.id)).toEqual(["a/c/deep", "a/mid", "b/side", "top"]);
    expect(policy.setup.map((step) => step.id)).toEqual(["js", "worker"]);
    expect(policy.setup[0]).toEqual({
      id: "js",
      kind: "setup",
      gate: "beforePR",
      exec: ["true"],
      timeoutSeconds: 30,
    });
    expect(policy.setup[1]?.paths).toEqual(["apps/worker/**"]);
    expect(policy.retry).toEqual({ maxFailedAttemptsPerItem: 5, scope: "task" });
    expect(policy.items[0]?.paths).toBeUndefined();
    expect(policy.files.map((file) => file.path)).toEqual([
      ".agents/closeout.yaml",
      ".agents/closeout/a.yaml",
      ".agents/closeout/b.yaml",
      ".agents/closeout/c.yaml",
    ]);
    const json = policyCanonicalJson(policy);
    expect(json.includes(" ")).toBe(false);
    expect(json.includes("\n")).toBe(false);
    expect(json.indexOf('"files"')).toBeLessThan(json.indexOf('"items"'));
    expect(json.indexOf('"items"')).toBeLessThan(json.indexOf('"retry"'));
    expect(json.indexOf('"retry"')).toBeLessThan(json.indexOf('"setup"'));
    expect(json.indexOf('"setup"')).toBeLessThan(json.indexOf('"specVersion"'));
    expect(json.indexOf('"exec"')).toBeLessThan(json.indexOf('"gate"'));
    expect(json.indexOf('"gate"')).toBeLessThan(json.indexOf('"id"'));
    expect(json.indexOf('"kind"')).toBeLessThan(json.indexOf('"timeoutSeconds"'));
    expect(policy.digest).toBe(`sha256:${createHash("sha256").update(json, "utf8").digest("hex")}`);
    expect(policy.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("identical inputs produce the same digest", () => {
    const files = {
      [PUBLIC_POLICY_PATH]: commandPolicy("typecheck"),
      ".agents/closeout/z.yaml": commandPolicy("lint"),
    };
    const first = present(origin(files).result);
    const second = present(
      origin({
        ".agents/closeout/z.yaml": commandPolicy("lint"),
        [PUBLIC_POLICY_PATH]: commandPolicy("typecheck"),
      }).result,
    );
    expect(first.digest).toBe(second.digest);

    const git = createFakeGitReader(files);
    const repo = tempDir();
    const again = loadPolicy({ repo, git, env: {} });
    const twice = loadPolicy({ repo, git, env: {} });
    expect(present(again).digest).toBe(first.digest);
    expect(present(twice).digest).toBe(first.digest);
  });

  test("a newline in a skill references file changes the digest", () => {
    const rubric = "Review the change.\n";
    const skill = "Follow references/rubric.md\n";
    const files = {
      [PUBLIC_POLICY_PATH]: reviewPolicy(".agents/skills/adversarial-review/SKILL.md"),
      ".agents/skills/adversarial-review/SKILL.md": skill,
      ".agents/skills/adversarial-review/references/rubric.md": rubric,
      ".agents/skills/adversarial-review/.keep": "keep\n",
    };
    const git = createFakeGitReader(files);
    const repo = tempDir();
    const before = present(loadPolicy({ repo, git, env: {} }));
    expect(before.files.map((file) => file.path)).toEqual([
      ".agents/closeout.yaml",
      ".agents/skills/adversarial-review/.keep",
      ".agents/skills/adversarial-review/SKILL.md",
      ".agents/skills/adversarial-review/references/rubric.md",
    ]);
    expect(before.files.map((file) => file.sha256)).toEqual([
      sha256(files[PUBLIC_POLICY_PATH]),
      sha256("keep\n"),
      sha256(skill),
      sha256(rubric),
    ]);

    git.put(".agents/skills/adversarial-review/references/rubric.md", `${rubric}\n`);
    const after = present(loadPolicy({ repo, git, env: {} }));
    expect(after.digest).not.toBe(before.digest);
    expect(after.files.find((file) => file.path.endsWith("references/rubric.md"))?.sha256).toBe(
      sha256(`${rubric}\n`),
    );
    expect(after.files.find((file) => file.path.endsWith("SKILL.md"))?.sha256).toBe(
      before.files.find((file) => file.path.endsWith("SKILL.md"))?.sha256,
    );
    const json = policyCanonicalJson(before);
    expect(json.includes('"paths"')).toBe(false);
    expect(json.indexOf('"differentModel"')).toBeLessThan(json.indexOf('"differentSession"'));
    expect(json.indexOf('"failOn"')).toBeLessThan(json.indexOf('"skill"'));
  });

  test("description and retry change the digest and paths are stored in order", () => {
    const plain = present(origin({ [PUBLIC_POLICY_PATH]: 'specVersion: "0.1"\n' }).result);
    const described = present(
      origin({ [PUBLIC_POLICY_PATH]: 'specVersion: "0.1"\ndescription: Requires Bun.\n' }).result,
    );
    expect(plain.items).toEqual([]);
    expect(plain.setup).toEqual([]);
    expect(plain.retry).toBeUndefined();
    expect(policyCanonicalJson(plain).includes('"setup"')).toBe(false);
    expect(policyCanonicalJson(plain).includes('"retry"')).toBe(false);
    expect(described.digest).not.toBe(plain.digest);

    const retry = present(
      origin({
        [PUBLIC_POLICY_PATH]:
          'specVersion: "0.1"\nretry:\n  maxFailedAttemptsPerItem: 2\n  scope: candidate\n',
      }).result,
    );
    expect(policyCanonicalJson(retry)).toContain(
      '"retry":{"maxFailedAttemptsPerItem":2,"scope":"candidate"}',
    );
    expect(retry.digest).not.toBe(plain.digest);

    const scoped = present(
      origin({
        [PUBLIC_POLICY_PATH]: `specVersion: "0.1"\nitems:\n${commandItem("engine", '    paths: ["src/**", "apps/engine/"]\n')}\n`,
      }).result,
    );
    expect(scoped.items[0]?.paths).toEqual(["src/**", "apps/engine/"]);
    expect(policyCanonicalJson(scoped)).toContain('"paths":["src/**","apps/engine/"]');
  });

  test("an executable policy file still loads", () => {
    const git = createFakeGitReader();
    git.put(PUBLIC_POLICY_PATH, commandPolicy("typecheck"), "100755");
    const policy = present(loadPolicy({ repo: tempDir(), git, env: {} }));
    expect(policy.items.map((item) => item.id)).toEqual(["typecheck"]);
  });
});

describe("origin/main source", () => {
  test("work tree edits do not change the policy from origin/main", () => {
    const committed = reviewPolicy(".agents/skills/look/SKILL.md");
    const skill = "remote skill\n";
    const git = createFakeGitReader({
      [PUBLIC_POLICY_PATH]: committed,
      ".agents/skills/look/SKILL.md": skill,
    });
    const repo = tempDir();
    writeRepoFile(repo, PUBLIC_POLICY_PATH, commandPolicy("local-only"));
    writeRepoFile(repo, ".agents/skills/look/SKILL.md", "local skill\n");

    const first = present(loadPolicy({ repo, git, env: {} }));
    expect(first.source).toBe("repo");
    expect(first.entryPath).toBe(".agents/closeout.yaml");
    expect(first.items.map((item) => item.id)).toEqual(["look"]);
    expect(first.files.find((file) => file.path.endsWith("SKILL.md"))?.sha256).toBe(sha256(skill));
    expect(git.calls[0]).toBe(`fetch ${repo}`);
    expect(git.calls[1]).toBe(`ls-remote ${repo}`);

    writeRepoFile(repo, PUBLIC_POLICY_PATH, commandPolicy("changed-again"));
    writeRepoFile(repo, ".agents/skills/look/SKILL.md", "still local\n");
    const second = present(loadPolicy({ repo, git, env: {} }));
    expect(second.digest).toBe(first.digest);

    git.put(".agents/skills/look/SKILL.md", "remote skill changed\n");
    const third = present(loadPolicy({ repo, git, env: {} }));
    expect(third.digest).not.toBe(first.digest);
  });

  test("a mismatching second answer blocks and does not read the global file", () => {
    const home = tempDir();
    writeRepoFile(home, PUBLIC_POLICY_PATH, commandPolicy("global-check"));
    const git = createFakeGitReader({ [PUBLIC_POLICY_PATH]: commandPolicy("remote-check") });
    git.remoteStdout = `${"b".repeat(40)}\trefs/heads/main\n`;
    const repo = tempDir();
    const result = loadPolicy({ repo, git, home, env: {} });
    expectBlocked(result, "repo", "origin/main is unavailable");
    expect(git.calls.map((call) => call.split(" ")[0])).toEqual(["fetch", "ls-remote"]);
  });

  test("an empty second answer and a failed fetch or ls-remote block", () => {
    const home = tempDir();
    writeRepoFile(home, PUBLIC_POLICY_PATH, commandPolicy("global-check"));
    const repo = tempDir();

    const mismatch = createFakeGitReader({ [PUBLIC_POLICY_PATH]: commandPolicy("remote-check") });
    mismatch.remoteStdout = "";
    expectBlocked(
      loadPolicy({ repo, git: mismatch, home, env: {} }),
      "repo",
      "origin/main is unavailable",
    );

    const fetchFailed = createFakeGitReader();
    fetchFailed.fetchError = "fatal: 'origin' does not appear to be a git repository";
    expectBlocked(
      loadPolicy({ repo, git: fetchFailed, home, env: {} }),
      "repo",
      "origin/main is unavailable: fatal: 'origin' does not appear to be a git repository",
    );
    expect(fetchFailed.calls.map((call) => call.split(" ")[0])).toEqual(["fetch"]);

    const fetchQuiet = createFakeGitReader();
    fetchQuiet.fetchError = "";
    expectBlocked(
      loadPolicy({ repo, git: fetchQuiet, home, env: {} }),
      "repo",
      "origin/main is unavailable",
    );

    const remoteFailed = createFakeGitReader();
    remoteFailed.remoteError = "fatal: Could not read from remote repository.";
    expectBlocked(
      loadPolicy({ repo, git: remoteFailed, home, env: {} }),
      "repo",
      "origin/main is unavailable: fatal: Could not read from remote repository.",
    );
  });

  test("uppercase ls-remote output confirms the fetched commit", () => {
    const git = createFakeGitReader({ [PUBLIC_POLICY_PATH]: 'specVersion: "0.1"\n' });
    git.remoteStdout = `${"A".repeat(40)}\trefs/heads/main\n`;
    const policy = present(loadPolicy({ repo: tempDir(), git, env: {} }));
    expect(policy.source).toBe("repo");
  });

  test("a committed empty policy is still a policy", () => {
    const home = tempDir();
    writeRepoFile(home, PUBLIC_POLICY_PATH, commandPolicy("global-check"));
    const result = loadPolicy({
      repo: tempDir(),
      git: createFakeGitReader({ [PUBLIC_POLICY_PATH]: 'specVersion: "0.1"\n' }),
      home,
      env: {},
    });
    const policy = present(result);
    expect(policy.source).toBe("repo");
    expect(policy.items).toEqual([]);
    expect(result.ok && result.warnings).toEqual([]);
  });

  test("a broken remote policy does not fall back to the home file", () => {
    const home = tempDir();
    writeRepoFile(home, PUBLIC_POLICY_PATH, commandPolicy("global-check"));
    const result = loadPolicy({
      repo: tempDir(),
      git: createFakeGitReader({
        [PUBLIC_POLICY_PATH]: 'specVersion: "0.1"\nspecVersion: "0.1"\n',
      }),
      home,
      env: {},
    });
    expectBlocked(result, "repo", ".agents/closeout.yaml: duplicated mapping key");
  });

  test("global fallback names the home file and resolves imports from home", () => {
    const home = tempDir();
    const repo = tempDir();
    writeRepoFile(
      home,
      PUBLIC_POLICY_PATH,
      `specVersion: "0.1"
imports:
  - path: .agents/closeout/quality.yaml
    as: quality
items:
${commandItem("local-draft")}
`,
    );
    writeRepoFile(home, ".agents/closeout/quality.yaml", commandPolicy("global-check"));
    writeRepoFile(home, ".agents/skills/look/SKILL.md", "home skill\n");
    writeRepoFile(repo, ".agents/closeout/quality.yaml", commandPolicy("repo-check"));
    writeRepoFile(repo, ".agents/skills/look/SKILL.md", "repo skill\n");

    const git = createFakeGitReader();
    const result = loadPolicy({ repo, git, home, env: {} });
    const policy = present(result);
    expect(policy.source).toBe("global");
    expect(policy.entryPath).toBe("~/.agents/closeout.yaml");
    expect(policy.items.map((item) => item.id)).toEqual(["quality/global-check", "local-draft"]);
    expect(policy.files.map((file) => file.path)).toEqual([
      ".agents/closeout.yaml",
      ".agents/closeout/quality.yaml",
    ]);
    expect(result.ok && result.warnings).toEqual([
      {
        code: GLOBAL_POLICY_CODE,
        message: "Using ~/.agents/closeout.yaml because origin/main has no closeout policy.",
      },
    ]);
    expect(git.calls[0]).toBe(`fetch ${repo}`);
    expect(git.calls[1]).toBe(`ls-remote ${repo}`);
  });

  test("a global skill directory is hashed from home", () => {
    const home = tempDir();
    writeRepoFile(home, PUBLIC_POLICY_PATH, reviewPolicy(".agents/skills/look/SKILL.md"));
    writeRepoFile(home, ".agents/skills/look/SKILL.md", "home skill\n");
    writeRepoFile(home, ".agents/skills/look/references/rubric.md", "home rubric\n");
    const policy = present(
      loadPolicy({ repo: tempDir(), git: createFakeGitReader(), home, env: {} }),
    );
    expect(policy.source).toBe("global");
    expect(policy.files.map((file) => file.path)).toEqual([
      ".agents/closeout.yaml",
      ".agents/skills/look/SKILL.md",
      ".agents/skills/look/references/rubric.md",
    ]);
    expect(policy.files[2]?.sha256).toBe(sha256("home rubric\n"));
  });

  test("global skill symlinks are followed, broken links and loops are errors", () => {
    const home = tempDir();
    writeRepoFile(home, PUBLIC_POLICY_PATH, reviewPolicy(".agents/skills/look/SKILL.md"));
    writeRepoFile(home, ".agents/skills/look/SKILL.md", "look\n");
    writeRepoFile(home, ".agents/skills/look/AGENTS.md", "rules\n");
    symlinkSync("AGENTS.md", join(home, ".agents/skills/look/CLAUDE.md"));
    const shared = tempDir();
    writeRepoFile(shared, "rubric.md", "shared rubric\n");
    symlinkSync(shared, join(home, ".agents/skills/look/references"));
    const policy = present(
      loadPolicy({ repo: tempDir(), git: createFakeGitReader(), home, env: {} }),
    );
    expect(policy.files.map((file) => file.path)).toEqual([
      ".agents/closeout.yaml",
      ".agents/skills/look/AGENTS.md",
      ".agents/skills/look/CLAUDE.md",
      ".agents/skills/look/SKILL.md",
      ".agents/skills/look/references/rubric.md",
    ]);
    expect(policy.files[2]?.sha256).toBe(sha256("rules\n"));
    expect(policy.files[4]?.sha256).toBe(sha256("shared rubric\n"));

    symlinkSync("references", join(home, ".agents/skills/look/references-copy"));
    const aliased = present(
      loadPolicy({ repo: tempDir(), git: createFakeGitReader(), home, env: {} }),
    );
    expect(aliased.files.map((file) => file.path)).toContain(
      ".agents/skills/look/references-copy/rubric.md",
    );
    rmSync(join(home, ".agents/skills/look/references-copy"));

    const link = join(home, ".agents/skills/look/references-more/extra.md");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync("missing-target", link);
    expectBlocked(
      loadPolicy({ repo: tempDir(), git: createFakeGitReader(), home, env: {} }),
      "global",
      `skill link is broken: ${link}`,
    );
    rmSync(link);

    symlinkSync("..", join(home, ".agents/skills/look/loop"));
    expectBlocked(
      loadPolicy({ repo: tempDir(), git: createFakeGitReader(), home, env: {} }),
      "global",
      `skill link loops: ${join(home, ".agents/skills/look/loop")}`,
    );
  });

  test("an invalid global file is blocked", () => {
    const home = tempDir();
    writeRepoFile(home, PUBLIC_POLICY_PATH, 'specVersion: "0.9"\n');
    const result = loadPolicy({ repo: tempDir(), git: createFakeGitReader(), home, env: {} });
    expectBlocked(
      result,
      "global",
      ".agents/closeout.yaml: /specVersion must be equal to constant",
    );
    if (!result.ok) expect(result.message.includes(NO_CLOSEOUT_POLICY)).toBe(false);
  });

  test("no closeout policy when the remote entry and the home file are absent", () => {
    const result = loadPolicy({
      repo: tempDir(),
      git: createFakeGitReader(),
      home: tempDir(),
      env: {},
    });
    expect(result).toEqual({
      ok: true,
      warnings: [],
      policy: {
        source: "none",
        digest: null,
        entryPath: null,
        setup: [],
        items: [],
        files: [],
      },
    });
    expect(NO_CLOSEOUT_POLICY).toBe("no closeout policy");
  });

  test("HOME unset and a missing home directory are blocked", () => {
    expectBlocked(
      loadPolicy({ repo: tempDir(), git: createFakeGitReader(), env: {} }),
      "global",
      "HOME is unset",
    );
    expectBlocked(
      loadPolicy({
        repo: tempDir(),
        git: createFakeGitReader(),
        home: join(tempDir(), "missing"),
        env: {},
      }),
      "global",
      "policy root is not a directory",
    );
  });
});

function origin(files: Record<string, string>): {
  result: PolicyLoadOutcome;
  git: FakeGitReader;
  repo: string;
} {
  const git = createFakeGitReader(files);
  const repo = tempDir();
  return { git, repo, result: loadPolicy({ repo, git, env: {} }) };
}

function present(result: PolicyLoadOutcome): ResolvedPolicyPresent {
  if (!result.ok || result.policy.source === "none") {
    throw new Error("expected a present policy");
  }
  return result.policy;
}

function expectBlocked(
  result: PolicyLoadOutcome,
  source: "repo" | "global",
  message: string,
): void {
  expect(result).toEqual({ ok: false, source, message });
}

function commandPolicy(id: string): string {
  return `specVersion: "0.1"\nitems:\n${commandItem(id)}\n`;
}

function commandItem(id: string, extra = ""): string {
  return `  - id: ${id}
    kind: command
    gate: beforePR
    exec: ["true"]
    timeoutSeconds: 30
${extra}`.trimEnd();
}

function stepYaml(id: string, extra = ""): string {
  return `  - id: ${id}
    exec: ["true"]
    timeoutSeconds: 30
${extra}`.trimEnd();
}

function reviewPolicy(skill: string): string {
  return `specVersion: "0.1"
items:
  - id: look
    kind: review
    gate: beforePR
    skill: ${skill}
    independence:
      differentSession: false
      differentModel: false
    failOn: P1
`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paws-closeout-"));
  temps.push(dir);
  return dir;
}

function writeRepoFile(root: string, path: string, contents: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}
