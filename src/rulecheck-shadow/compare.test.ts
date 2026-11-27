import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareReceipts,
  formatShadowReport,
  parseRulecheckReceipt,
  readCloseoutReceipt,
  type RulecheckReceipt,
  type ShadowSide,
} from ".";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const NEXT = "c".repeat(40);
const BASE_DIGEST = `sha256:${"1".repeat(64)}`;
const PROPOSED_DIGEST = `sha256:${"2".repeat(64)}`;
const FINDING =
  "config/app.toml:2:1: [config/no-legacy-mode] Remove legacy_mode or set it to false.";

type Phase = RulecheckReceipt["phases"][string];

function receipt(
  overrides: {
    candidate?: string;
    phases?: Record<string, Partial<Phase> | null>;
    tools?: object;
  } = {},
): RulecheckReceipt {
  const phase = (policySha: string, policyDigest: string | null): Phase => ({
    policySha,
    policyDigest,
    outcome: "pass",
  });
  const phases: Record<string, Phase> = {
    "base-build": phase(BASE, null),
    "base-validate": phase(BASE, BASE_DIGEST),
    "base-check": phase(BASE, BASE_DIGEST),
    "proposed-build": phase(HEAD, null),
    "proposed-validate": phase(HEAD, PROPOSED_DIGEST),
    "proposed-test": phase(HEAD, PROPOSED_DIGEST),
    "proposed-check": phase(HEAD, PROPOSED_DIGEST),
  };
  for (const [name, change] of Object.entries(overrides.phases ?? {})) {
    if (change === null) delete phases[name];
    else phases[name] = { ...(phases[name] ?? phase(HEAD, PROPOSED_DIGEST)), ...change };
  }
  const outcomes = Object.values(phases).map((entry) => entry.outcome);
  return {
    version: 1,
    baseSha: BASE,
    candidateSha: overrides.candidate ?? HEAD,
    tools: {
      sourceSha: null,
      node: "v24.17.0",
      git: "git version 2.50.0",
      builder: "rulecheck-build 0.1.0",
      evaluator: "rulecheck 0.1.0",
      ...overrides.tools,
    },
    phases,
    effectivePolicyDiff: { baseDigest: BASE_DIGEST, proposedDigest: PROPOSED_DIGEST, changes: [] },
    outcome: outcomes.includes("error")
      ? "error"
      : outcomes.includes("violation")
        ? "violation"
        : "pass",
  };
}

const side = (value: RulecheckReceipt, source: string): ShadowSide => ({ receipt: value, source });

describe("compareReceipts", () => {
  test("agrees when both receipts judge the same head with the same policy and tools", () => {
    const result = compareReceipts({
      head: HEAD,
      ci: side(receipt(), "ci"),
      paws: side(receipt(), "paws"),
    });
    expect(result.status).toBe("agree");
    expect(result.authoritative).toBe("closeout");
    expect(result.enforced).toBe(false);
    expect(result.mismatches).toEqual([]);
    expect(result.ci.verdict).toBe("pass");
  });

  test("agrees on the same violation and shows its remediation as a code failure", () => {
    const violating = { "base-check": { outcome: "violation" as const, stdout: `${FINDING}\n` } };
    const result = compareReceipts({
      head: HEAD,
      ci: side(receipt({ phases: violating }), "ci"),
      paws: side(receipt({ phases: violating }), "paws"),
    });
    expect(result.status).toBe("agree");
    expect(result.paws.verdict).toBe("violation");
    const [failure] = result.paws.failures;
    expect(failure?.kind).toBe("code");
    expect(failure?.findings).toEqual([
      {
        path: "config/app.toml",
        line: 2,
        column: 1,
        rule: "config/no-legacy-mode",
        message: "Remove legacy_mode or set it to false.",
      },
    ]);
    expect(failure?.remediation).toContain("cannot clear it");
    expect(failure?.remediation).toContain("config/app.toml:2:1 [config/no-legacy-mode]");
  });

  test("names a rule file that does not build as configuration, not code", () => {
    const broken = receipt({
      phases: {
        "proposed-build": {
          outcome: "error",
          stderr: "broken.rule.ts:1:1: Expected the SDK marker import.",
        },
        "proposed-validate": null,
        "proposed-test": null,
        "proposed-check": null,
      },
    });
    const result = compareReceipts({
      head: HEAD,
      ci: side(broken, "ci"),
      paws: side(broken, "paws"),
    });
    expect(result.status).toBe("agree");
    expect(result.ci.verdict).toBe("cannot-judge");
    expect(result.ci.failures.map((entry) => entry.kind)).toEqual(["configuration"]);
    expect(result.ci.failures[0]?.remediation).toContain("not a finding in the code");
  });

  test("separates evaluator errors and failing fixtures from code findings", () => {
    const value = receipt({
      phases: {
        "proposed-test": { outcome: "violation", stdout: "fixture 2 failed" },
        "proposed-check": { outcome: "error", stderr: "src: scoped path is a directory" },
      },
    });
    const kinds = compareReceipts({
      head: HEAD,
      ci: side(value, "ci"),
      paws: side(value, "paws"),
    }).ci.failures.map((entry) => [entry.phase, entry.kind]);
    expect(kinds).toEqual([
      ["proposed-test", "fixtures"],
      ["proposed-check", "evaluator"],
    ]);
  });

  test("disagrees on outcome, policy commit, digest and tool version", () => {
    const paws = receipt({
      tools: { evaluator: "rulecheck 0.2.0" },
      phases: {
        "base-check": { outcome: "violation", stdout: FINDING },
        "proposed-validate": { policyDigest: BASE_DIGEST },
        "proposed-test": { policySha: NEXT },
      },
    });
    const result = compareReceipts({
      head: HEAD,
      ci: side(receipt(), "ci"),
      paws: side(paws, "paws"),
    });
    expect(result.status).toBe("disagree");
    expect(result.mismatches).toEqual([
      "Tool evaluator differs: CI rulecheck 0.1.0, Paws rulecheck 0.2.0.",
      "Phase base-check outcome differs: CI pass, Paws violation.",
      `Phase proposed-validate policy digest differs: CI ${PROPOSED_DIGEST}, Paws ${BASE_DIGEST}.`,
      `Phase proposed-test read policy from different commits: CI ${HEAD}, Paws ${NEXT}.`,
      "Outcome differs: CI pass, Paws violation.",
    ]);
  });

  test("notes a different Node.js version and the CI-only owner review without disagreeing", () => {
    const ci = receipt({
      phases: { "proposed-owner-review": { outcome: "violation", owner: "o" } },
    });
    const result = compareReceipts({
      head: HEAD,
      ci: side(ci, "ci"),
      paws: side(receipt({ tools: { node: "v24.18.0" } }), "paws"),
    });
    expect(result.status).toBe("agree");
    expect(result.notes).toHaveLength(2);
    expect(result.ci.outcome).toBe("violation");
    expect(result.ci.failures[0]?.kind).toBe("owner-review");
  });

  test("a new head invalidates both earlier receipts", () => {
    const result = compareReceipts({
      head: NEXT,
      ci: side(receipt(), "ci"),
      paws: side(receipt(), "paws"),
    });
    expect(result.status).toBe("incomplete");
    expect(result.gaps).toEqual([
      `CI receipt is for ${HEAD}, not head ${NEXT}. A new head needs a new receipt.`,
      `Paws receipt is for ${HEAD}, not head ${NEXT}. A new head needs a new receipt.`,
    ]);
    expect(result.ci.verdict).toBeNull();
    expect(result.mismatches).toEqual([]);
  });

  test("a merge-group head needs its own CI result", () => {
    const result = compareReceipts({
      head: NEXT,
      ci: side(receipt(), "ci"),
      paws: side(receipt({ candidate: NEXT }), "paws"),
      mergeGroup: { pullHead: HEAD },
    });
    expect(result.status).toBe("incomplete");
    expect(result.gaps).toEqual([
      `Merge-group head ${NEXT} needs its own CI result; the CI receipt is for pull request head ${HEAD}.`,
    ]);
  });

  test("a receipt missing a required phase is not comparable", () => {
    const result = compareReceipts({
      head: HEAD,
      ci: side(receipt({ phases: { "proposed-test": null } }), "ci"),
      paws: side(receipt(), "paws"),
    });
    expect(result.status).toBe("incomplete");
    expect(result.gaps).toEqual(["CI receipt lacks required phases: proposed-test."]);
  });

  test("the report says Closeout stays in charge", () => {
    const report = formatShadowReport(
      compareReceipts({
        head: HEAD,
        ci: { receipt: null, source: "ci", reason: "no artifact" },
        paws: side(receipt(), "paws"),
      }),
    );
    expect(report).toContain("Not comparable yet");
    expect(report).toContain("Closeout's decision stands");
    expect(report).toContain(`CI has no receipt for ${HEAD}: no artifact`);
  });
});

describe("parseRulecheckReceipt", () => {
  test("rejects text that is not evidence v1", () => {
    expect(parseRulecheckReceipt("nope")).toEqual({ ok: false, reason: "the receipt is not JSON" });
    const parsed = parseRulecheckReceipt(JSON.stringify({ ...receipt(), version: 2 }));
    expect(parsed.ok).toBe(false);
  });
});

describe("readCloseoutReceipt", () => {
  function evidence(
    record: Record<string, unknown>,
    log: string,
  ): { dir: string; [Symbol.dispose](): void } {
    const dir = mkdtempSync(join(tmpdir(), "rulecheck-shadow-"));
    const relative = `logs/${"d".repeat(64)}/${HEAD}/rulecheck/1.log`;
    const folder = join(dir, "evidence", "d".repeat(64), HEAD, "rulecheck");
    mkdirSync(folder, { recursive: true });
    mkdirSync(join(dir, "logs", "d".repeat(64), HEAD, "rulecheck"), { recursive: true });
    writeFileSync(join(dir, relative), log);
    writeFileSync(
      join(folder, "1.json"),
      JSON.stringify({
        recordType: "command",
        itemId: "rulecheck",
        head: HEAD,
        attempt: 1,
        exec: { exitCode: 0, timedOut: false, headMoved: false, truncated: false },
        artifacts: [{ path: relative, sha256: "0".repeat(64) }],
        ...record,
      }),
    );
    return { dir, [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }) };
  }
  const log = `STDOUT\n${JSON.stringify(receipt(), null, 2)}\n\nSTDERR\n`;

  test("reads the receipt from the command's log", () => {
    using store = evidence({}, log);
    const read = readCloseoutReceipt({ evidenceDir: store.dir, itemId: "rulecheck", head: HEAD });
    expect(read.receipt?.candidateSha).toBe(HEAD);
    expect(read.receipt === null ? [] : read.gaps).toEqual([]);
  });

  test("refuses a result Closeout took from CI", () => {
    using store = evidence({ ci: { run: null, checks: [] } }, log);
    const read = readCloseoutReceipt({ evidenceDir: store.dir, itemId: "rulecheck", head: HEAD });
    expect(read.receipt).toBeNull();
    expect(read.receipt === null && read.reason).toContain("not an independent receipt");
  });

  test("has no receipt for a head Closeout has not run", () => {
    using store = evidence({}, log);
    const read = readCloseoutReceipt({ evidenceDir: store.dir, itemId: "rulecheck", head: NEXT });
    expect(read.receipt).toBeNull();
  });

  test("flags an exit code that does not match the receipt", () => {
    using store = evidence(
      { exec: { exitCode: 1, timedOut: false, headMoved: false, truncated: false } },
      log,
    );
    const read = readCloseoutReceipt({ evidenceDir: store.dir, itemId: "rulecheck", head: HEAD });
    const result = compareReceipts({ head: HEAD, ci: side(receipt(), "ci"), paws: read });
    expect(result.status).toBe("incomplete");
    expect(result.gaps).toEqual(["Paws: Rulecheck exited 1, but the receipt's outcome is pass."]);
  });

  test("takes Rulecheck's exit from the shadow wrapper, which always exits 0", () => {
    const violating = receipt({
      phases: { "base-check": { outcome: "violation", stdout: FINDING } },
    });
    using store = evidence(
      {},
      `STDOUT\n${JSON.stringify(violating, null, 2)}\n\nSTDERR\nrulecheck-exit=1\n`,
    );
    const read = readCloseoutReceipt({ evidenceDir: store.dir, itemId: "rulecheck", head: HEAD });
    const result = compareReceipts({ head: HEAD, ci: side(violating, "ci"), paws: read });
    expect(result.status).toBe("agree");
    expect(result.paws.failures[0]?.kind).toBe("code");
  });
});
