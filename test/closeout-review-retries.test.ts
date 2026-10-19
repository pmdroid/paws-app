import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  addReview,
  decision,
  digest,
  policyFixBudget,
  run,
  validate,
  type Finding,
} from "../src/closeout-spec";

const skill = ".agents/skills/review/SKILL.md";
const candidate = { session: "implementer", model: "implementer", provider: "fixture" };
const producer = { session: "reviewer", model: "reviewer", provider: "fixture" };
const finding = (location: string, severity: Finding["severity"] = "P1"): Finding => ({
  location,
  severity,
  explanation: "Observed regression",
  evidence: "Reproduced in fixture",
});

function fixture(cap: unknown = 12, scope = "task", extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "paws-review-retry-"));
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  const evidenceDir = join(root, "evidence");
  const home = join(root, "home");
  mkdirSync(home);
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--bare", "-b", "main", origin);
  git("clone", origin, repo);
  git("-C", repo, "config", "user.name", "Retry Fixture");
  git("-C", repo, "config", "user.email", "retry@example.invalid");
  git("-C", repo, "config", "commit.gpgsign", "false");
  mkdirSync(join(repo, ".agents/skills/review"), { recursive: true });
  writeFileSync(join(repo, skill), "Review this fixture.");
  const policy = {
    specVersion: "0.1",
    retry: {
      maxFailedAttemptsPerItem: 3,
      scope,
      ...(cap === undefined || cap === "absent" ? {} : { maxFailedReviewAttempts: cap }),
    },
    items: [
      {
        id: "review",
        kind: "review",
        gate: "beforePR",
        skill,
        independence: { differentSession: true, differentModel: true },
        failOn: "P1",
      },
    ],
    ...extra,
  };
  writeFileSync(join(repo, ".agents/closeout.yaml"), JSON.stringify(policy));
  git("-C", repo, "add", ".");
  git("-C", repo, "commit", "-m", "Policy fixture");
  git("-C", repo, "push", "origin", "HEAD:main");
  const base = git("-C", repo, "rev-parse", "HEAD");
  let head = base;
  let calls = 0;
  const input = () => ({
    repo,
    base,
    head,
    evidenceDir,
    home,
    task: "stable-task",
    candidate,
    gate: "beforePR" as const,
  });
  return {
    root,
    repo,
    home,
    policy,
    input,
    get calls() {
      return calls;
    },
    async review(findings: Finding[], identity = producer) {
      return addReview({
        ...input(),
        itemId: "review",
        reviewer: {
          async review() {
            calls += 1;
            return { producer: identity, findings, artifacts: [] };
          },
        },
      });
    },
    next() {
      writeFileSync(join(repo, "change.txt"), `${head}\n`);
      git("-C", repo, "add", "change.txt");
      git("-C", repo, "commit", "-m", "Next candidate");
      head = git("-C", repo, "rev-parse", "HEAD");
    },
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("review caps validate through the origin loader and participate in the draft digest", () => {
  for (const cap of [0, 100001, 2, 3.5, null, "12"]) {
    const fx = fixture(cap);
    try {
      expect(validate(fx.repo, fx.home).ok).toBe(false);
    } finally {
      fx.close();
    }
  }
  for (const cap of [3, 100000]) {
    const fx = fixture(cap);
    try {
      expect(validate(fx.repo, fx.home).ok).toBe(true);
    } finally {
      fx.close();
    }
  }
  const fx = fixture();
  try {
    const active = validate(fx.repo, fx.home);
    expect(active.ok).toBe(true);
    const before = digest(fx.repo);
    fx.policy.retry.maxFailedReviewAttempts = 13;
    writeFileSync(join(fx.repo, ".agents/closeout.yaml"), JSON.stringify(fx.policy));
    expect(digest(fx.repo)).not.toEqual(before);
    expect(validate(fx.repo, fx.home)).toEqual(active);
    expect(policyFixBudget(fx.repo, fx.home)).toBe(11);
  } finally {
    fx.close();
  }
});

test("new findings exceed the ordinary budget across commits and sessions", async () => {
  const fx = fixture();
  try {
    for (let round = 0; round < 5; round += 1) {
      const result = await fx.review([finding(`src/file-${round}.ts:12:4`)]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.record.attempt).toBe(1);
      const observed = await decision(fx.input());
      expect(observed.decision).toBe("rejected");
      expect(observed.items[0]?.state).toBe("failed");
      fx.next();
    }
    expect((await fx.review([])).ok).toBe(true);
    expect((await decision(fx.input())).decision).toBe("accepted");
  } finally {
    fx.close();
  }
});

test("line drift, duplicate keys and nonconsecutive repeats exhaust cumulatively", async () => {
  const fx = fixture();
  try {
    for (const locations of [
      ["src/a.ts:12", "src/a.ts:40:7"],
      ["src/b.ts"],
      [" src/a.ts "],
      [],
      ["src/a.ts:99:1"],
    ]) {
      expect((await fx.review(locations.map((location) => finding(location)))).ok).toBe(true);
      fx.next();
    }
    const result = await decision(fx.input());
    expect(result.decision).toBe("blocked");
    expect(result.items[0]?.state).toBe("exhausted");
    expect(result.items[0]?.message).toContain("src/a.ts failed in 3 of 3");
    const calls = fx.calls;
    expect((await fx.review([])).ok).toBe(false);
    expect(fx.calls).toBe(calls);
    expect(
      (await decision({ ...fx.input(), candidate: { ...candidate, session: "new-session" } }))
        .items[0]?.state,
    ).toBe("exhausted");
  } finally {
    fx.close();
  }
});

test("failOn filters keys and clean independence failures spend no budget", async () => {
  const fx = fixture(3);
  try {
    expect((await fx.review([], candidate)).ok).toBe(true);
    expect((await decision(fx.input())).items[0]?.state).toBe("independence");
    expect((await fx.review([finding("src/note.ts", "P2")])).ok).toBe(true);
    for (let round = 0; round < 2; round += 1) {
      expect(
        (
          await fx.review(
            [finding("src/note.ts", "P2"), finding(`src/fail-${round}.ts`)],
            candidate,
          )
        ).ok,
      ).toBe(true);
      expect((await decision(fx.input())).items[0]?.state).toBe("failed");
    }
    expect((await fx.review([finding("src/last.ts")], candidate)).ok).toBe(true);
    const exhausted = await decision(fx.input());
    expect(exhausted.decision).toBe("blocked");
    expect(exhausted.items[0]?.message).toContain("3 of 3 allowed failed review attempts");
    expect((await fx.review([])).ok).toBe(false);
  } finally {
    fx.close();
  }
});

test("distinct keys exhaust at the total cap and concurrent clean intake cannot escape", async () => {
  const fx = fixture(4);
  try {
    for (let round = 0; round < 3; round += 1)
      expect((await fx.review([finding(`src/${round}.ts`)])).ok).toBe(true);
    const failing = fx.review([finding("src/last.ts")]);
    const cleanIntake = addReview({
      ...fx.input(),
      itemId: "review",
      reviewer: {
        async review() {
          await failing;
          return { producer, findings: [], artifacts: [] };
        },
      },
    });
    const [last, clean] = await Promise.all([failing, cleanIntake]);
    expect(last.ok).toBe(true);
    expect(clean.ok).toBe(false);
    expect((await decision(fx.input())).items[0]?.message).toContain(
      "4 of 4 allowed failed review attempts",
    );
  } finally {
    fx.close();
  }
});

test("candidate budgets do not follow commits while legacy reviews still exhaust globally", async () => {
  for (const scope of ["candidate", "task"]) {
    const fx = fixture("absent", scope);
    try {
      for (let round = 0; round < 3; round += 1)
        expect((await fx.review([finding(`src/${round}.ts`)])).ok).toBe(true);
      expect((await decision(fx.input())).items[0]?.state).toBe("exhausted");
      fx.next();
      expect((await decision(fx.input())).items[0]?.state).toBe(
        scope === "task" ? "exhausted" : "stale",
      );
    } finally {
      fx.close();
    }
  }
  const fx = fixture(3, "candidate");
  try {
    for (let round = 0; round < 3; round += 1)
      expect((await fx.review([finding("src/a.ts")])).ok).toBe(true);
    expect((await decision(fx.input())).items[0]?.state).toBe("exhausted");
    fx.next();
    expect((await fx.review([])).ok).toBe(true);
    expect((await decision(fx.input())).decision).toBe("accepted");
  } finally {
    fx.close();
  }
});

test("commands and setup retain the ordinary limit with progress-aware reviews", async () => {
  for (const kind of ["command", "setup"]) {
    const command = {
      id: "fail",
      exec: [process.execPath, "-e", "process.exit(1)"],
      timeoutSeconds: 10,
    };
    const fx = fixture(
      12,
      "task",
      kind === "setup" ? { setup: [command] } : { items: [{ ...command, kind, gate: "beforePR" }] },
    );
    try {
      for (let round = 0; round < 3; round += 1) {
        const result = await run({ ...fx.input(), pawsHome: join(fx.root, "paws") });
        expect(result.items.find((item) => item.id === "fail")?.state).toBe(
          round === 2 ? "exhausted" : "failed",
        );
      }
      const before = readFileSync(join(fx.repo, ".agents/closeout.yaml"), "utf8");
      expect((await run({ ...fx.input(), pawsHome: join(fx.root, "paws") })).decision).toBe(
        "blocked",
      );
      expect(readFileSync(join(fx.repo, ".agents/closeout.yaml"), "utf8")).toBe(before);
    } finally {
      fx.close();
    }
  }
});

test("policies without retry leave failed review attempts unlimited", async () => {
  const fx = fixture(12, "task", { retry: undefined });
  try {
    expect(policyFixBudget(fx.repo, fx.home)).toBeNull();
    for (let round = 0; round < 5; round += 1) {
      expect((await fx.review([finding("src/same.ts")])).ok).toBe(true);
      expect((await decision(fx.input())).items[0]?.state).toBe("failed");
    }
    expect((await fx.review([])).ok).toBe(true);
    expect((await decision(fx.input())).decision).toBe("accepted");
  } finally {
    fx.close();
  }
});

test("exhausted reviews prevent further setup and command execution", async () => {
  const fx = fixture(12, "task", {
    setup: [{ id: "prepare", exec: ["true"], timeoutSeconds: 10 }],
  });
  try {
    for (let round = 0; round < 3; round += 1) {
      expect((await fx.review([finding("src/repeat.ts")])).ok).toBe(true);
    }
    let executed = false;
    const observed = await run({
      ...fx.input(),
      pawsHome: join(fx.root, "paws"),
      commandRunner: {
        async runLogged() {
          executed = true;
          throw new Error("Exhausted review must prevent commands");
        },
      },
    });
    expect(observed.decision).toBe("blocked");
    expect(observed.items.find((item) => item.id === "review")?.state).toBe("exhausted");
    expect(executed).toBe(false);
  } finally {
    fx.close();
  }
});
