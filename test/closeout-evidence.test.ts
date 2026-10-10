import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import type { AnySchema, ValidateFunction } from "ajv/dist/2020";
import type { CommandRecord, DecisionDocument, ReviewRecord } from "../src/closeout-spec";
import { createEvidenceStore, evidenceRoot } from "../src/closeout-spec/evidence";
import { renderCloseoutEvidence } from "../src/closeout/report";

const BASE_A = "a".repeat(40);
const BASE_B = "b".repeat(40);
const HEAD = "c".repeat(40);
const HEX = "d".repeat(64);
const DIGEST = `sha256:${HEX}`;

const schemaUrl = new URL("../src/closeout-spec/schema/evidence.schema.json", import.meta.url);

describe("closeout evidence store", () => {
  test("round trip matches the reference layout and evidence.schema.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "paws-evidence-"));
    try {
      const home = join(root, "home");
      const evidence = evidenceRoot({ owner: "pmdroid", repo: "paws-app", home });
      expect(evidence).toBe(join(home, "closeout", "pmdroid", "paws-app"));
      expect(() => evidenceRoot({ owner: "..", repo: "paws-app", home })).toThrow(/owner/);

      const store = createEvidenceStore({ root: evidence });
      expect(await store.load()).toEqual({ records: [] });

      const attempt = await store.nextAttempt({
        policyDigest: DIGEST,
        head: HEAD,
        itemId: "quality/typecheck",
      });
      expect(attempt).toBe(1);
      const log = "STDOUT\nok\nSTDERR\n";
      const artifact = await store.writeLog({
        policyDigest: DIGEST,
        head: HEAD,
        itemId: "quality/typecheck",
        attempt,
        body: log,
      });
      expect(artifact.path).toBe(`logs/${HEX}/${HEAD}/quality/typecheck/1.log`);
      expect(artifact.sha256).toBe(sha256(log));

      const record = command({
        itemId: "quality/typecheck",
        base: BASE_A,
        attempt,
        artifacts: [artifact],
      });
      await store.add(record);

      const file = join(evidence, "evidence", HEX, HEAD, "quality", "typecheck", "1.json");
      const logFile = join(evidence, "logs", HEX, HEAD, "quality", "typecheck", "1.log");
      expect(await readFile(logFile, "utf8")).toBe(log);
      const validate = compileEvidenceSchema();
      const onDisk: unknown = JSON.parse(await readFile(file, "utf8"));
      expect(validate(onDisk)).toBe(true);

      const loaded = await store.load();
      expect(loaded.invalid).toBeUndefined();
      expect(loaded.records).toEqual([record]);
      expect(validate(loaded.records[0])).toBe(true);
      expect(await readdir(join(evidence, "evidence", HEX, HEAD, "quality", "typecheck"))).toEqual([
        "1.json",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a schema-invalid file is invalid evidence and is not dropped quietly", async () => {
    const root = await mkdtemp(join(tmpdir(), "paws-evidence-"));
    try {
      const store = createEvidenceStore({ root });
      await store.add(command({ itemId: "typecheck", base: BASE_A, attempt: 1 }));
      await store.add(command({ itemId: "lint", base: BASE_A, attempt: 1 }));
      const corrupt = join(root, "evidence", HEX, HEAD, "typecheck", "1.json");
      await writeFile(corrupt, "{not json\n");

      const loaded = await store.load();
      expect(loaded.invalid?.path).toBe(`evidence/${HEX}/${HEAD}/typecheck/1.json`);
      expect(loaded.invalid?.message).toContain("invalid");
      expect(loaded.records.map((record) => record.itemId)).toEqual(["lint"]);
      expect(loaded.records.some((record) => record.itemId === "typecheck")).toBe(false);

      const extra = join(root, "evidence", HEX, HEAD, "lint", "1.json");
      const parsed = JSON.parse(await readFile(extra, "utf8")) as Record<string, unknown>;
      parsed.extra = true;
      await writeFile(extra, `${JSON.stringify(parsed)}\n`);
      const both = await store.load();
      expect(both.invalid).toBeDefined();
      expect(both.records).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("attempts increment across bases and tasks and never overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "paws-evidence-"));
    try {
      const store = createEvidenceStore({ root });
      const first = command({ itemId: "typecheck", base: BASE_A, task: "task-a", attempt: 1 });
      const second = command({ itemId: "typecheck", base: BASE_B, task: "task-b", attempt: 1 });
      await store.add(first);
      const file = join(root, "evidence", HEX, HEAD, "typecheck", "1.json");
      const before = await readFile(file, "utf8");

      await store.add(second);
      expect(await readFile(file, "utf8")).toBe(before);
      expect(JSON.parse(before)).toMatchObject({ base: BASE_A, task: "task-a", attempt: 1 });

      const nextFile = join(root, "evidence", HEX, HEAD, "typecheck", "2.json");
      const storedSecond = JSON.parse(await readFile(nextFile, "utf8")) as CommandRecord;
      expect(storedSecond.attempt).toBe(2);
      expect(storedSecond.base).toBe(BASE_B);
      expect(storedSecond.task).toBe("task-b");

      const loaded = await store.load();
      expect(loaded.invalid).toBeUndefined();
      expect(loaded.records.map((record) => record.attempt).sort()).toEqual([1, 2]);

      await expect(
        store.add(command({ itemId: "typecheck", base: BASE_A, task: "task-a", attempt: 1 })),
      ).rejects.toThrow(/duplicate evidence attempt 1/);
      expect(await readFile(file, "utf8")).toBe(before);
      expect((await readdir(join(root, "evidence", HEX, HEAD, "typecheck"))).sort()).toEqual([
        "1.json",
        "2.json",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("more than 16 artifacts is rejected before a record is written", async () => {
    const root = await mkdtemp(join(tmpdir(), "paws-evidence-"));
    try {
      const store = createEvidenceStore({ root });
      const artifacts = Array.from({ length: 17 }, (_, index) => ({
        path: `logs/extra-${index}.log`,
        sha256: "e".repeat(64),
      }));
      await expect(
        store.add(command({ itemId: "typecheck", base: BASE_A, attempt: 1, artifacts })),
      ).rejects.toThrow(/invalid|must NOT have more than 16/i);
      expect(await store.load()).toEqual({ records: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("closeout evidence rendering", () => {
  test("snapshots accepted, rejected, and blocked decisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "paws-evidence-"));
    try {
      const store = createEvidenceStore({ root });
      const passedLog = "STDOUT\nexited 0\nSTDERR\n";
      const passedArtifact = await store.writeLog({
        policyDigest: DIGEST,
        head: HEAD,
        itemId: "typecheck",
        attempt: 1,
        body: passedLog,
      });
      await store.add(
        command({
          itemId: "typecheck",
          base: BASE_A,
          attempt: 1,
          exitCode: 0,
          artifacts: [passedArtifact],
        }),
      );
      await store.add(
        review({ itemId: "adversarial-review", base: BASE_A, attempt: 1, findings: [] }),
      );
      const acceptedRecords = (await store.load()).records;
      const accepted = await renderCloseoutEvidence({
        decision: decision({
          decision: "accepted",
          message: "requirements passed",
          items: [
            { id: "docs", kind: "command", state: "skipped", message: "no changed path matches" },
            { id: "typecheck", kind: "command", state: "passed", message: "exited 0", attempt: 1 },
            {
              id: "adversarial-review",
              kind: "review",
              state: "passed",
              message: "review findings satisfy the policy",
              attempt: 1,
            },
          ],
        }),
        records: acceptedRecords,
        root,
      });
      expect(accepted).toBe(
        [
          "Closeout: accepted",
          `Base: ${BASE_A}`,
          `Head: ${HEAD}`,
          `Policy: ${DIGEST}`,
          "Message: requirements passed",
          "Items:",
          "- typecheck (command): passed attempt 1 — exited 0",
          `  log: [${passedArtifact.path}](${passedArtifact.path})`,
          "- adversarial-review (review): passed attempt 1 — review findings satisfy the policy",
        ].join("\n"),
      );
      expect(accepted).not.toContain("docs");
      expect(accepted).not.toContain("skipped");

      const failedLog = "STDOUT\nSTDERR\nboom\n";
      const failedRoot = await mkdtemp(join(tmpdir(), "paws-evidence-"));
      try {
        const failedStore = createEvidenceStore({ root: failedRoot });
        const failedArtifact = await failedStore.writeLog({
          policyDigest: DIGEST,
          head: HEAD,
          itemId: "typecheck",
          attempt: 1,
          body: failedLog,
        });
        await failedStore.add(
          command({
            itemId: "typecheck",
            base: BASE_A,
            attempt: 1,
            exitCode: 1,
            artifacts: [failedArtifact],
          }),
        );
        await failedStore.add(
          review({
            itemId: "adversarial-review",
            base: BASE_A,
            attempt: 1,
            findings: [
              {
                severity: "P1",
                location: "src/export.ts",
                explanation: "The export drops a column.",
                evidence: "The function returns rows without the archived flag.",
              },
            ],
          }),
        );
        const rejected = await renderCloseoutEvidence({
          decision: decision({
            decision: "rejected",
            message: "command exited 1",
            items: [
              {
                id: "typecheck",
                kind: "command",
                state: "failed",
                message: "command exited 1",
                attempt: 1,
              },
              {
                id: "adversarial-review",
                kind: "review",
                state: "failed",
                message: "finding at P1 meets failOn P1",
                attempt: 1,
              },
            ],
          }),
          records: (await failedStore.load()).records,
          root: failedRoot,
        });
        expect(rejected).toBe(
          [
            "Closeout: rejected",
            `Base: ${BASE_A}`,
            `Head: ${HEAD}`,
            `Policy: ${DIGEST}`,
            "Message: command exited 1",
            "Items:",
            "- typecheck (command): failed attempt 1 — command exited 1",
            `  log: [${failedArtifact.path}](${failedArtifact.path})`,
            "- adversarial-review (review): failed attempt 1 — finding at P1 meets failOn P1",
          ].join("\n"),
        );

        await writeFile(join(failedRoot, failedArtifact.path), "tampered\n");
        const mismatched = await renderCloseoutEvidence({
          decision: decision({
            decision: "rejected",
            message: "command exited 1",
            items: [
              {
                id: "typecheck",
                kind: "command",
                state: "failed",
                message: "command exited 1",
                attempt: 1,
              },
            ],
          }),
          records: (await failedStore.load()).records,
          root: failedRoot,
        });
        expect(mismatched).toContain(`log: ${failedArtifact.path} (hash mismatch)`);
        expect(mismatched).not.toContain(`[${failedArtifact.path}]`);
      } finally {
        await rm(failedRoot, { recursive: true, force: true });
      }

      const blocked = await renderCloseoutEvidence({
        decision: decision({
          decision: "blocked",
          message: "adversarial-review has no evidence",
          items: [
            { id: "typecheck", kind: "command", state: "passed", message: "exited 0", attempt: 1 },
            {
              id: "adversarial-review",
              kind: "review",
              state: "missing",
              message: "no evidence for this candidate and policy",
            },
          ],
        }),
        records: acceptedRecords,
        root,
      });
      expect(blocked).toBe(
        [
          "Closeout: blocked",
          `Base: ${BASE_A}`,
          `Head: ${HEAD}`,
          `Policy: ${DIGEST}`,
          "Message: adversarial-review has no evidence",
          "Items:",
          "- typecheck (command): passed attempt 1 — exited 0",
          `  log: [${passedArtifact.path}](${passedArtifact.path})`,
          "- adversarial-review (review): missing — no evidence for this candidate and policy",
        ].join("\n"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function compileEvidenceSchema(): ValidateFunction {
  const schema = JSON.parse(readSchema()) as AnySchema;
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}

function readSchema(): string {
  return readFileSync(schemaUrl, "utf8");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function command(input: {
  itemId: string;
  base: string;
  attempt: number;
  task?: string;
  exitCode?: number | null;
  artifacts?: CommandRecord["artifacts"];
}): CommandRecord {
  const record: CommandRecord = {
    specVersion: "0.1",
    recordType: "command",
    itemId: input.itemId,
    base: input.base,
    head: HEAD,
    policyDigest: DIGEST,
    attempt: input.attempt,
    evaluator: { name: "paws", version: "0.1" },
    producer: { name: "paws", version: "0.1" },
    exec: {
      argv: ["bun", "test"],
      exitCode: input.exitCode ?? 0,
      timedOut: false,
      dirty: false,
      headMoved: false,
      durationMs: 4,
      truncated: false,
    },
    artifacts: input.artifacts ?? [],
  };
  if (input.task !== undefined) record.task = input.task;
  return record;
}

function review(input: {
  itemId: string;
  base: string;
  attempt: number;
  findings: ReviewRecord["findings"];
}): ReviewRecord {
  return {
    specVersion: "0.1",
    recordType: "review",
    itemId: input.itemId,
    base: input.base,
    head: HEAD,
    policyDigest: DIGEST,
    attempt: input.attempt,
    evaluator: { name: "paws", version: "0.1" },
    producer: { session: "reviewer", model: "other", provider: "codex" },
    findings: input.findings,
    artifacts: [],
  };
}

function decision(input: {
  decision: DecisionDocument["decision"];
  message: string;
  items: DecisionDocument["items"];
}): DecisionDocument {
  return {
    specVersion: "0.1",
    decision: input.decision,
    gate: "beforePR",
    base: BASE_A,
    head: HEAD,
    message: input.message,
    candidate: { task: "ENG-3", session: "implementer", model: "claude", provider: "anthropic" },
    policy: { path: ".agents/closeout.yaml", digest: DIGEST, absent: false },
    items: input.items,
    warnings: [],
  };
}
