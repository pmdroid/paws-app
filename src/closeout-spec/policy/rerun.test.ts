import { describe, expect, test } from "bun:test";
import { createFakeGitReader } from "./git";
import { loadPolicy } from "./load";
import { loadMemoryPolicy, PUBLIC_POLICY_PATH } from "./resolve";

const SKILL = ".agents/skills/review/SKILL.md";

const BASE = `specVersion: "0.1"
retry:
  attempts_per_check: 2
items:
  - id: lint
    kind: command
    gate: beforePR
    exec: ["bun", "run", "lint"]
    timeoutSeconds: 60
    ci: "lint"
  - id: review
    kind: review
    gate: beforePR
    skill: ${SKILL}
    independence: { differentSession: true, differentModel: true }
    failOn: P1
`;

const SINCE = `    since: ["bun", "scripts/affected-tests.ts", "{since}"]\n`;

const RERUN = `rerun:
  conflict:
    run: [lint, test]
    reviews: false
  ci:
    run: failed
`;

const TEST = `  - id: test
    kind: command
    gate: beforePR
    exec: ["bun", "test"]
    timeoutSeconds: 600
`;

function files(text: string, extra: Record<string, string> = {}): Map<string, Uint8Array> {
  const encode = (value: string) => new TextEncoder().encode(value);
  const map = new Map([
    [PUBLIC_POLICY_PATH, encode(text)],
    [SKILL, encode("# Review\n")],
  ]);
  for (const [path, value] of Object.entries(extra)) map.set(path, encode(value));
  return map;
}

function load(text: string, extra?: Record<string, string>) {
  return loadMemoryPolicy(files(text, extra));
}

function failure(text: string, extra?: Record<string, string>): string {
  const loaded = load(text, extra);
  if (loaded.ok) throw new Error("expected a policy error");
  return loaded.message;
}

describe("rerun and since", () => {
  test("a valid rerun and since parse and the resolved policy carries them", async () => {
    const text = `${BASE}${TEST}${SINCE}${RERUN}`;
    const loaded = load(text);
    if (!loaded.ok || loaded.absent) throw new Error("expected a policy");
    expect(loaded.policy.unknownKeys).toEqual([]);
    expect(loaded.policy.rerun).toEqual({
      conflict: { run: ["lint", "test"], reviews: false },
      ci: { run: "failed" },
    });
    expect(loaded.policy.items.find((item) => item.id === "test")).toMatchObject({
      kind: "command",
      since: ["bun", "scripts/affected-tests.ts", "{since}"],
    });
    const git = createFakeGitReader(
      Object.fromEntries([
        [PUBLIC_POLICY_PATH, text],
        [SKILL, "#\n"],
      ]),
    );
    const resolved = await loadPolicy({ repo: "/nonexistent", git, env: {} });
    if (!resolved.ok || resolved.policy.source === "none") throw new Error("expected a policy");
    expect(resolved.policy.rerun).toEqual(loaded.policy.rerun);
    expect(resolved.warnings).toEqual([]);
  });

  test("rerun defaults reviews to true and ci.run to all", () => {
    const loaded = load(`${BASE}rerun:\n  conflict:\n    run: [lint]\n  ci: {}\n`);
    if (!loaded.ok || loaded.absent) throw new Error("expected a policy");
    expect(loaded.policy.rerun).toEqual({
      conflict: { run: ["lint"], reviews: true },
      ci: { run: "all" },
    });
  });

  test("a policy without the keys keeps its digest", () => {
    const loaded = load(BASE);
    if (!loaded.ok || loaded.absent) throw new Error("expected a policy");
    expect(loaded.policy.digest).toBe(
      "sha256:8cdcf7a819516b09866ebbc4a0efad43370fcda86e0f2bfdb060ba1ee6e054c2",
    );
    expect(loaded.policy).not.toHaveProperty("rerun");
    expect(loaded.policy.items[0]).not.toHaveProperty("since");
  });

  test("rerun and since change the digest", () => {
    const digest = (text: string) => {
      const loaded = load(text);
      if (!loaded.ok || loaded.absent) throw new Error("expected a policy");
      return loaded.policy.digest;
    };
    const base = digest(`${BASE}${TEST}`);
    expect(digest(`${BASE}${TEST}${SINCE}`)).not.toBe(base);
    expect(digest(`${BASE}${TEST}${RERUN}`)).not.toBe(base);
  });

  test("invalid rerun and since are policy errors with clear messages", () => {
    const prefix = `${PUBLIC_POLICY_PATH}: `;
    expect(failure(`${BASE}rerun:\n  conflict:\n    run: [lint, build]\n`)).toBe(
      `${prefix}rerun.conflict.run names build, which is not a check`,
    );
    expect(failure(`${BASE}rerun:\n  conflict:\n    run: [review]\n`)).toBe(
      `${prefix}rerun.conflict.run names review, which is a review check, not a command`,
    );
    expect(failure(`${BASE}rerun:\n  ci:\n    run: sometimes\n`)).toBe(
      `${prefix}/rerun/ci/run must be equal to one of the allowed values`,
    );
    expect(failure(`${BASE}rerun:\n  review:\n    run: all\n`)).toBe(
      `${prefix}/rerun has unknown key 'review'`,
    );
    expect(failure(`${BASE}rerun:\n  conflict:\n    reviews: false\n    later: 1\n`)).toBe(
      `${prefix}/rerun/conflict has unknown key 'later'`,
    );
    expect(failure(`${BASE}${SINCE}`)).toBe(
      `${prefix}/items/1/since is only allowed on kind: command items`,
    );
    expect(failure(`${BASE}${TEST}    since: ["bun", "test"]\n`)).toBe(
      `${prefix}item test: since must contain exactly one "{since}" element`,
    );
    expect(failure(`${BASE}${TEST}    since: ["{since}", "{since}"]\n`)).toBe(
      `${prefix}item test: since must contain exactly one "{since}" element`,
    );
  });

  test("rerun is only allowed on the entry policy and may name imported commands", () => {
    const shared = `specVersion: "0.1"\nitems:\n${TEST}`;
    const entry = `${BASE}imports:\n  - as: team\n    path: .agents/checks.yaml\n`;
    expect(failure(entry, { ".agents/checks.yaml": `${shared}${RERUN}` })).toBe(
      "rerun is only allowed on the entry policy",
    );
    const loaded = load(`${entry}rerun:\n  conflict:\n    run: [team/test]\n`, {
      ".agents/checks.yaml": shared,
    });
    expect(loaded.ok && !loaded.absent && loaded.policy.rerun).toEqual({
      conflict: { run: ["team/test"], reviews: true },
    });
  });

  test("select parses on a bun test command and every misuse is a policy error", () => {
    const select = `    select:\n      runner: bun\n      always: [test/a.test.ts]\n      full_on: [bun.lock]\n      max_selected: 120\n`;
    const loaded = load(`${BASE}${TEST}${select}`);
    if (!loaded.ok || loaded.absent) throw new Error("expected a policy");
    expect(loaded.policy.items[2]).toMatchObject({
      select: {
        runner: "bun",
        always: ["test/a.test.ts"],
        full_on: ["bun.lock"],
        max_selected: 120,
      },
    });
    const plain = load(`${BASE}${TEST}`);
    expect(plain.ok && !plain.absent && plain.policy.digest).not.toBe(loaded.policy.digest);
    const prefix = `${PUBLIC_POLICY_PATH}: `;
    expect(failure(`${BASE}${TEST}    select: { runner: pytest }\n`)).toBe(
      `${prefix}/items/2/select/runner must be equal to one of the allowed values`,
    );
    expect(failure(`${BASE}${TEST}${SINCE.replace("affected-tests.ts", "x")}${select}`)).toBe(
      `${prefix}item test: select cannot be used with since`,
    );
    const shape = `${prefix}item test: select runner bun needs exec to start with "bun", "test" and pass only flags, as --flag=value`;
    for (const exec of ['["bun", "run", "test"]', '["bun", "test", "test/a.test.ts"]']) {
      expect(failure(`${BASE}${TEST.replace('["bun", "test"]', exec)}${select}`)).toBe(shape);
    }
    expect(failure(`${BASE}    select: { runner: bun }\n`)).toBe(
      `${prefix}/items/1/select is only allowed on kind: command items`,
    );
  });
});
