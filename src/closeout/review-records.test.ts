import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewRecord } from "../closeout-spec";
import { evidencePath, reviewRecordsAt } from "./run";

test("automatic approval reads findings only from the accepted policy, base and head", async () => {
  const home = await mkdtemp(join(tmpdir(), "paws-risk-evidence-"));
  const task = "risk-task";
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  const policyDigest = `sha256:${"c".repeat(64)}`;
  const record: ReviewRecord = {
    specVersion: "0.1",
    recordType: "review",
    task,
    itemId: "security-review",
    base,
    head,
    policyDigest,
    attempt: 1,
    evaluator: { name: "paws", version: "0.1" },
    producer: { session: "reviewer", model: "other", provider: "codex" },
    findings: [],
    artifacts: [],
  };
  try {
    for (const entry of [
      record,
      {
        ...record,
        policyDigest: `sha256:${"d".repeat(64)}`,
        findings: [
          {
            severity: "P2",
            location: "src/auth.ts",
            explanation: "Other policy",
            evidence: "seen",
          },
        ],
      },
      { ...record, base: "e".repeat(40), attempt: 2 },
      { ...record, head: "f".repeat(40) },
    ]) {
      const folder = join(
        evidencePath(task, home),
        "evidence",
        entry.policyDigest.slice(7),
        entry.head,
        entry.itemId,
      );
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, `${entry.attempt}.json`), JSON.stringify(entry));
    }
    expect(await reviewRecordsAt(task, head, home, { base, policyDigest })).toEqual([
      { itemId: "security-review", attempt: 1, findings: [] },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
