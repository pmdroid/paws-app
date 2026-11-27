import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShadow } from "./rulecheck-shadow";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const DIGEST = `sha256:${"1".repeat(64)}`;

function receipt(candidateSha: string) {
  const pass = (policySha: string, policyDigest: string | null) => ({
    policySha,
    policyDigest,
    outcome: "pass",
  });
  return {
    version: 1,
    baseSha: BASE,
    candidateSha,
    tools: { sourceSha: null, node: "v24.17.0", git: "git", builder: "b 1", evaluator: "e 1" },
    phases: {
      "base-build": pass(BASE, null),
      "base-validate": pass(BASE, DIGEST),
      "base-check": pass(BASE, DIGEST),
      "proposed-build": pass(candidateSha, null),
      "proposed-validate": pass(candidateSha, DIGEST),
      "proposed-test": pass(candidateSha, DIGEST),
      "proposed-check": pass(candidateSha, DIGEST),
    },
    effectivePolicyDiff: null,
    outcome: "pass",
  };
}

test("compares two receipt files and exits by status", () => {
  const dir = mkdtempSync(join(tmpdir(), "rulecheck-shadow-cli-"));
  try {
    const ci = join(dir, "ci.json");
    const paws = join(dir, "paws.json");
    writeFileSync(ci, JSON.stringify(receipt(HEAD)));
    writeFileSync(paws, JSON.stringify(receipt(HEAD)));
    const agreed = runShadow(["--head", HEAD, "--ci", ci, "--paws", paws]);
    expect(agreed.exitCode).toBe(0);
    expect(agreed.output).toContain("CI and Paws agree");

    const merge = "c".repeat(40);
    const json = runShadow([
      "--head",
      merge,
      "--ci",
      ci,
      "--paws",
      paws,
      "--merge-group",
      "--pull-head",
      HEAD,
      "--json",
    ]);
    expect(json.exitCode).toBe(2);
    expect(JSON.parse(json.output).gaps[0]).toContain("needs its own CI result");

    expect(runShadow(["--head", HEAD, "--ci", ci]).exitCode).toBe(64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
