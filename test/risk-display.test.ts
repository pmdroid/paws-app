import { afterEach, expect, spyOn, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import { count, eq, sql } from "drizzle-orm";
import { RiskDisplayReader, riskApprovalFor } from "../src/loop";
import { createLiveStatusProvider } from "../src/dashboard";
import { loadConfigFile, readMergeSettings, type MergeSettings } from "../src/config";
import {
  insertQueuedItem,
  saveCandidateRisk,
  saveCandidatePaths,
  upsertCloseoutStep,
  finishCloseoutProgress,
  insertLinkAsk,
  recordLinkAskDecision,
  recordReviewFindings,
  saveCheckpoint,
  type Db,
  type PgDb,
} from "../src/db";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const execute = (db: Db, query: ReturnType<typeof sql>) => (db as PgDb).orm.execute(query);

const contextRows = async (db: Db) =>
  (await execute(db, sql`SELECT xmin::text, * FROM risk_auto_context ORDER BY item_id, head`)).rows;
const scenarios = ["clean", "P2", "missing security", "rules change", "off", "unreadable"] as const;
async function fixture(
  scenario: (typeof scenarios)[number] = "clean",
  publicUrl: string | null = "https://paws.example",
) {
  const { db, close: closeDb } = await tempStore();
  const now = 1_700_000_000_000;
  const item = await insertQueuedItem(db, { id: "risk-item", sessionKey: "risk-session", now });
  const identity = {
    taskId: item.id,
    base: "base",
    head: "head",
    policyDigest: "policy",
    policyPath: null,
  };
  await saveCandidateRisk(db, {
    itemId: item.id,
    head: "head",
    base: "base",
    tier: "high",
    paths: ["auth.ts"],
    classifiedAt: now,
  });
  await saveCandidatePaths(db, {
    itemId: item.id,
    head: "head",
    paths: scenario === "rules change" ? ["rules.ts"] : ["auth.ts"],
    recordedAt: now,
  });
  let settingsReads = 0;
  const settings: Pick<MergeSettings, "autoApproveHighRisk" | "repositories"> = {
    autoApproveHighRisk: scenario !== "off",
    repositories: {},
  };
  const lines: string[] = [];
  const reader = new RiskDisplayReader({
    store: db,
    configPath: "/tmp/pas934-no-config",
    readSettings: () => {
      settingsReads++;
      return settings;
    },
    publicUrl,
    journal: (line) => lines.push(line),
  });
  cleanup.push(async () => {
    reader.close();
    await closeDb();
  });
  const context = {
    ...reader.inputs(),
    policyDigest: "policy",
    policyPaths: ["rules.ts"],
  };
  await reader.remember(item.id, "head", context);
  for (const id of ["security-review", "independent-review"]) {
    if (id === "security-review" && scenario === "missing security") continue;
    await upsertCloseoutStep(
      db,
      item.id,
      identity,
      {
        id,
        kind: "review",
        state: "passed",
        command: "",
        detail: null,
        attempt: 1,
        timeoutSeconds: null,
        startedAt: now,
        finishedAt: now,
        exitCode: null,
        timedOut: false,
        timeoutReason: null,
        truncated: false,
        logPath: null,
        evidencePath: `${id}.json`,
        findings: null,
        findingSeverities: scenario === "P2" && id === "security-review" ? ["P2"] : [],
        ordinal: 0,
      },
      now,
    );
  }
  await finishCloseoutProgress(db, item.id, identity, "accepted", now);
  if (scenario === "unreadable")
    await db.run((q) =>
      q.exec(
        q.orm
          .update(q.t.candidatePaths)
          .set({ paths: {} })
          .where(eq(q.t.candidatePaths.itemId, item.id)),
      ),
    );
  const provider = createLiveStatusProvider(db, {
    env: {},
    riskApproval: async (id) => reader.read(id),
  });
  return {
    db,
    item,
    identity,
    reader,
    context,
    settings,
    lines,
    provider,
    settingsReads: () => settingsReads,
  };
}

for (const scenario of scenarios) {
  test(`item page reads stored automatic-risk evidence for ${scenario}`, async () => {
    const { item, provider } = await fixture(scenario);
    const expected = {
      clean: "Passes automatically: both reviews clean",
      P2: "Manual approval required: security review has a P2 finding",
      "missing security": "Manual approval required: security review is missing",
      "rules change": "Manual approval required: changes the risk rules",
      off: "Manual approval required: automatic approval is off",
      unreadable: "Manual approval required",
    }[scenario];
    const detail = (await provider.issue(item.id))!;
    expect(detail.issue.id).toBe(item.id);
    expect(detail.risk?.automaticApproval).toBe(expected);
  });
}

test("an in-flight old settings snapshot cannot restore automatic approval after it is disabled", async () => {
  const f = await fixture();
  f.settings.autoApproveHighRisk = false;
  f.reader.refreshSettings();
  await f.reader.remember(f.item.id, "head", f.context);
  expect((await f.provider.issue(f.item.id))?.risk?.automaticApproval).toBe(
    "Manual approval required: automatic approval is off",
  );
});

test("unrelated settings writes retain the reason and status reads do not reload config or write rows", async () => {
  const f = await fixture("P2");
  f.reader.refreshSettings();
  const reads = f.settingsReads();
  const rows = await contextRows(f.db);
  for (let i = 0; i < 3; i++) {
    expect((await f.provider.issue(f.item.id))?.risk?.automaticApproval).toContain(
      "security review has a P2 finding",
    );
    await f.reader.remember(f.item.id, "head", f.context);
  }
  expect(f.settingsReads()).toBe(reads);
  expect(await contextRows(f.db)).toEqual(rows);
});

test("changed risk settings invalidate older policy evidence", async () => {
  const f = await fixture();
  f.settings.repositories = { "acme/repo": { packages: [], highRiskPaths: ["new/**"] } };
  f.reader.refreshSettings();
  await f.reader.remember(f.item.id, "head", f.context);
  expect((await f.reader.read(f.item.id))?.detail).toContain("policy evidence is unavailable");
});

test("failed display persistence cannot reject the merge gate", async () => {
  const f = await fixture();
  await f.db.run((q) => q.exec(q.orm.delete(q.t.riskAutoContext)));
  await execute(
    f.db,
    sql`CREATE FUNCTION fail_display_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'display write failed'; END $$ LANGUAGE plpgsql`,
  );
  await execute(
    f.db,
    sql`CREATE TRIGGER fail_display_insert BEFORE INSERT ON risk_auto_context FOR EACH ROW EXECUTE FUNCTION fail_display_insert()`,
  );
  await expect(f.reader.remember(f.item.id, "head", f.context)).resolves.toBeUndefined();
  expect(
    f.lines.some(
      (line) =>
        line.includes("operation=risk-display.remember") &&
        line.includes('insert into "risk_auto_context"'),
    ),
  ).toBe(true);
  expect(
    await riskApprovalFor(f.db, {
      itemId: f.item.id,
      head: "head",
      publicUrl: "https://paws.example",
      ...f.context,
      samePatch: async () => false,
    }),
  ).toBe("approved");
  expect((await f.provider.issue(f.item.id))?.issue.id).toBe(f.item.id);
});

test("a corrupt classified-risk row does not fail the item page", async () => {
  const f = await fixture();
  await f.db.run((q) =>
    q.exec(
      q.orm
        .update(q.t.candidateRisk)
        .set({ paths: "{" })
        .where(eq(q.t.candidateRisk.itemId, f.item.id)),
    ),
  );
  const detail = (await f.provider.issue(f.item.id))!;
  expect(detail.issue.id).toBe(f.item.id);
  expect(detail.risk?.automaticApproval).toBe("Manual approval required");
});

test("display follows the lane's rebased head even while the checkpoint still names the old head", async () => {
  const f = await fixture();
  await saveCheckpoint(f.db, f.item.id, {
    phase: "merge_queue",
    wipCommit: "head",
    baseSha: "base",
  });
  await f.reader.remember(f.item.id, "rebased-head", f.context);
  const detail = (await f.provider.issue(f.item.id))!;
  expect(detail.risk?.head).toBe("rebased-head");
  expect(detail.risk?.automaticApproval).toBe("Manual approval required");
  expect(
    await f.db.run((q) => q.one(q.orm.select({ n: count() }).from(q.t.riskAutoContext))),
  ).toEqual({ n: 1 });
});

test("the disabled risk gate does not claim manual approval is required", async () => {
  const f = await fixture("off", null);
  expect((await f.provider.issue(f.item.id))?.risk?.automaticApproval).toBe(
    "Risk gate is off: approval is not required",
  );
  expect(
    await riskApprovalFor(f.db, {
      itemId: f.item.id,
      head: "head",
      publicUrl: null,
      samePatch: async () => false,
    }),
  ).toBe("not_required");
});

async function approve(f: Awaited<ReturnType<typeof fixture>>, head: string) {
  await f.db.run((q) =>
    q.exec(
      q.orm.insert(q.t.question).values({
        id: "q-risk",
        itemId: f.item.id,
        sessionId: "risk-session",
        kind: "link",
        body: "Risk",
        status: "open",
        createdAt: 1,
      }),
    ),
  );
  await insertLinkAsk(f.db, {
    questionId: "q-risk",
    itemId: f.item.id,
    kind: "risk",
    headCommit: head,
    link: "https://paws.example/risk",
    title: "Risk",
    detail: "Approve",
    answerers: ["person"],
    createdAt: 1,
  });
  await recordLinkAskDecision(f.db, "q-risk", {
    decision: "approve",
    note: null,
    decidedBy: "person",
    now: 2,
  });
}

test("a human approval overrides the automatic-approval explanation", async () => {
  const f = await fixture("off");
  await approve(f, "head");
  expect((await f.provider.issue(f.item.id))?.risk?.automaticApproval).toBe(
    "Approved: a person approved this commit",
  );
});

test("a human approval carried over by the lane is displayed as approved", async () => {
  const f = await fixture("off");
  await approve(f, "earlier-head");
  let approvedHead: string | undefined;
  let approvalKind: "exact" | "same_patch" | "fix" | undefined;
  const result = await riskApprovalFor(f.db, {
    onHumanApproval: (head, kind) => {
      approvedHead = head;
      approvalKind = kind;
    },
    itemId: f.item.id,
    head: "head",
    publicUrl: "https://paws.example",
    samePatch: async () => true,
  });
  expect(result).toBe("approved");
  await f.reader.remember(f.item.id, "head", { ...f.context, approvedHead, approvalKind });
  expect((await f.provider.issue(f.item.id))?.risk?.automaticApproval).toBe(
    "Approved: an earlier human approval carries over",
  );
  f.settings.autoApproveHighRisk = true;
  f.settings.repositories = { "acme/repo": { packages: [], highRiskPaths: ["different/**"] } };
  f.reader.refreshSettings();
  expect((await f.provider.issue(f.item.id))?.risk?.automaticApproval).toBe(
    "Approved: an earlier human approval carries over",
  );
});

test("custom review findings name the actual review", async () => {
  const f = await fixture();
  await recordReviewFindings(f.db, {
    itemId: f.item.id,
    repository: "acme/repo",
    head: "head",
    seenAt: 3,
    findings: [
      {
        review: "custom-review",
        severity: "P2",
        location: "auth.ts:1",
        text: "Unsafe access",
        bugClass: "review",
        why: "below failOn",
      },
    ],
    reviewed: [],
  });
  expect((await f.reader.read(f.item.id))?.detail).toBe(
    "Manual approval required: custom-review has a P2 finding",
  );
});

test("hand edits to config are observed outside the status read path", async () => {
  const f = await fixture();
  const home = tempHome();
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "config.toml");
  writeFileSync(path, "[merge]\nauto_approve_high_risk = true\n");
  let reads = 0;
  const reader = new RiskDisplayReader({
    store: f.db,
    configPath: path,
    publicUrl: "https://paws.example",
    readSettings: () => {
      reads++;
      return readMergeSettings(loadConfigFile(path));
    },
  });
  cleanup.push(() => reader.close());
  await reader.remember(f.item.id, "head", { ...f.context, ...reader.inputs() });
  expect((await reader.read(f.item.id))?.detail).toContain("Passes automatically");
  writeFileSync(path, "[merge]\nauto_approve_high_risk = false\n");
  await waitFor(
    async () =>
      (await reader.read(f.item.id))?.detail.includes("automatic approval is off") ?? false,
  );
  const before = reads;
  await reader.read(f.item.id);
  expect(reads).toBe(before);
});

test("policy file edits invalidate display evidence, including across a reader restart", async () => {
  const f = await fixture();
  const home = tempHome();
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "rules.ts");
  writeFileSync(path, "old rules");
  await f.reader.remember(f.item.id, "head", {
    ...f.context,
    policyFiles: f.reader.observeFiles([path]),
  });
  expect((await f.reader.read(f.item.id))?.detail).toContain("Passes automatically");
  writeFileSync(path, "new rules");
  await waitFor(
    async () =>
      (await f.reader.read(f.item.id))?.detail.includes("policy evidence is unavailable") ?? false,
  );
  f.reader.close();
  const restarted = new RiskDisplayReader({
    store: f.db,
    configPath: "/tmp/pas934-no-config",
    publicUrl: "https://paws.example",
    readSettings: () => f.settings,
  });
  cleanup.push(() => restarted.close());
  expect((await restarted.read(f.item.id))?.detail).toContain("policy evidence is unavailable");
});

test("filesystem events invalidate policy evidence while stat polling is delayed", async () => {
  const watchFile = fs.watchFile;
  const polling = spyOn(fs, "watchFile").mockImplementation((...args: unknown[]): fs.StatWatcher =>
    Reflect.apply(watchFile, fs, [args[0], { persistent: false, interval: 60_000 }, args.at(-1)]),
  );
  try {
    const f = await fixture();
    const home = tempHome();
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const path = join(home, "rules.ts");
    writeFileSync(path, "old rules");
    await f.reader.remember(f.item.id, "head", {
      ...f.context,
      policyFiles: f.reader.observeFiles([path]),
    });
    expect((await f.reader.read(f.item.id))?.detail).toContain("Passes automatically");
    writeFileSync(path, "new rules");
    await waitFor(
      async () =>
        (await f.reader.read(f.item.id))?.detail.includes("policy evidence is unavailable") ??
        false,
    );
  } finally {
    polling.mockRestore();
  }
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!(await predicate()) && Date.now() < deadline) await Bun.sleep(25);
  expect(await predicate()).toBe(true);
}

test("a failing human-approval display observer cannot reject an approved head", async () => {
  const f = await fixture("off");
  await approve(f, "head");
  expect(
    await riskApprovalFor(f.db, {
      itemId: f.item.id,
      head: "head",
      publicUrl: "https://paws.example",
      samePatch: async () => false,
      onHumanApproval: () => {
        throw new Error("display failed");
      },
      journal: (line) => f.lines.push(line),
    }),
  ).toBe("approved");
  expect(f.lines.some((line) => line.includes("display failed"))).toBe(true);
});
