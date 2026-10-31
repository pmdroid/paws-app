import { afterEach, expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RiskDisplayReader, riskApprovalFor } from "../src/loop";
import { createLiveStatusProvider } from "../src/web";
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
} from "../src/db";
import { tempDb, tempHome } from "./helpers";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const scenarios = ["clean", "P2", "missing security", "rules change", "off", "unreadable"] as const;
function fixture(
  scenario: (typeof scenarios)[number] = "clean",
  publicUrl: string | null = "https://paws.example",
) {
  const db = tempDb();
  const now = 1_700_000_000_000;
  const item = insertQueuedItem(db, { id: "risk-item", sessionKey: "risk-session", now });
  const identity = {
    taskId: item.id,
    base: "base",
    head: "head",
    policyDigest: "policy",
    policyPath: null,
  };
  saveCandidateRisk(db, {
    itemId: item.id,
    head: "head",
    base: "base",
    tier: "high",
    paths: ["auth.ts"],
    classifiedAt: now,
  });
  saveCandidatePaths(db, {
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
    db,
    configPath: "/tmp/pas934-no-config",
    readSettings: () => {
      settingsReads++;
      return settings;
    },
    publicUrl,
    journal: (line) => lines.push(line),
  });
  cleanup.push(() => {
    reader.close();
    db.close();
  });
  const context = {
    ...reader.inputs(),
    policyDigest: "policy",
    policyPaths: ["rules.ts"],
  };
  reader.remember(item.id, "head", context);
  for (const id of ["security-review", "independent-review"]) {
    if (id === "security-review" && scenario === "missing security") continue;
    upsertCloseoutStep(
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
  finishCloseoutProgress(db, item.id, identity, "accepted", now);
  if (scenario === "unreadable")
    db.run("UPDATE candidate_paths SET paths = '{}' WHERE item_id = ?", [item.id]);
  const provider = createLiveStatusProvider(db, { env: {}, riskApproval: (id) => reader.read(id) });
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
  test(`item page reads stored automatic-risk evidence for ${scenario}`, () => {
    const { item, provider } = fixture(scenario);
    const expected = {
      clean: "Passes automatically: both reviews clean",
      P2: "Manual approval required: security review has a P2 finding",
      "missing security": "Manual approval required: security review is missing",
      "rules change": "Manual approval required: changes the risk rules",
      off: "Manual approval required: automatic approval is off",
      unreadable: "Manual approval required",
    }[scenario];
    const detail = provider.item(item.id)!;
    expect(detail.id).toBe(item.id);
    expect(detail.risk?.automaticApproval).toBe(expected);
  });
}

test("an in-flight old settings snapshot cannot restore automatic approval after it is disabled", () => {
  const f = fixture();
  f.settings.autoApproveHighRisk = false;
  f.reader.refreshSettings();
  f.reader.remember(f.item.id, "head", f.context);
  expect(f.provider.item(f.item.id)?.risk?.automaticApproval).toBe(
    "Manual approval required: automatic approval is off",
  );
});

test("unrelated settings writes retain the reason and status reads do not reload config or write rows", () => {
  const f = fixture("P2");
  f.reader.refreshSettings();
  const reads = f.settingsReads();
  const changes = f.db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
  for (let i = 0; i < 3; i++) {
    expect(f.provider.item(f.item.id)?.risk?.automaticApproval).toContain(
      "security review has a P2 finding",
    );
    f.reader.remember(f.item.id, "head", f.context);
  }
  expect(f.settingsReads()).toBe(reads);
  expect(f.db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n).toBe(changes);
});

test("changed risk settings invalidate older policy evidence", () => {
  const f = fixture();
  f.settings.repositories = { "acme/repo": { packages: [], highRiskPaths: ["new/**"] } };
  f.reader.refreshSettings();
  f.reader.remember(f.item.id, "head", f.context);
  expect(f.reader.read(f.item.id)?.detail).toContain("policy evidence is unavailable");
});

test("failed display persistence cannot reject the merge gate", async () => {
  const f = fixture();
  f.db.run("DELETE FROM risk_auto_context");
  f.db.run(
    "CREATE TRIGGER fail_display_insert BEFORE INSERT ON risk_auto_context BEGIN SELECT RAISE(FAIL, 'display write failed'); END",
  );
  expect(() => f.reader.remember(f.item.id, "head", f.context)).not.toThrow();
  expect(f.lines.some((line) => line.includes("display write failed"))).toBe(true);
  expect(
    await riskApprovalFor(f.db, {
      itemId: f.item.id,
      head: "head",
      publicUrl: "https://paws.example",
      ...f.context,
      samePatch: async () => false,
    }),
  ).toBe("approved");
  expect(f.provider.item(f.item.id)?.id).toBe(f.item.id);
});

test("a corrupt classified-risk row does not fail the item page", () => {
  const f = fixture();
  f.db.run("PRAGMA ignore_check_constraints=ON");
  f.db.run("UPDATE candidate_risk SET paths = '{' WHERE item_id = ?", [f.item.id]);
  const detail = f.provider.item(f.item.id)!;
  expect(detail.id).toBe(f.item.id);
  expect(detail.risk?.automaticApproval).toBe("Manual approval required");
});

test("display follows the lane's rebased head even while the checkpoint still names the old head", () => {
  const f = fixture();
  saveCheckpoint(f.db, f.item.id, { phase: "merge_queue", wipCommit: "head", baseSha: "base" });
  f.reader.remember(f.item.id, "rebased-head", f.context);
  const detail = f.provider.item(f.item.id)!;
  expect(detail.risk?.head).toBe("rebased-head");
  expect(detail.risk?.automaticApproval).toBe("Manual approval required");
  expect(
    f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM risk_auto_context").get()!.n,
  ).toBe(1);
});

test("the disabled risk gate does not claim manual approval is required", async () => {
  const f = fixture("off", null);
  expect(f.provider.item(f.item.id)?.risk?.automaticApproval).toBe(
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

function approve(f: ReturnType<typeof fixture>, head: string) {
  f.db.run(
    "INSERT INTO question (id, item_id, session_id, kind, body, status, created_at) VALUES ('q-risk', ?, 'risk-session', 'link', 'Risk', 'open', 1)",
    [f.item.id],
  );
  insertLinkAsk(f.db, {
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
  recordLinkAskDecision(f.db, "q-risk", {
    decision: "approve",
    note: null,
    decidedBy: "person",
    now: 2,
  });
}

test("a human approval overrides the automatic-approval explanation", () => {
  const f = fixture("off");
  approve(f, "head");
  expect(f.provider.item(f.item.id)?.risk?.automaticApproval).toBe(
    "Approved: a person approved this commit",
  );
});

test("a human approval carried over by the lane is displayed as approved", async () => {
  const f = fixture("off");
  approve(f, "earlier-head");
  let approvedHead: string | undefined;
  const result = await riskApprovalFor(f.db, {
    onHumanApproval: (head) => {
      approvedHead = head;
    },
    itemId: f.item.id,
    head: "head",
    publicUrl: "https://paws.example",
    samePatch: async () => true,
  });
  expect(result).toBe("approved");
  f.reader.remember(f.item.id, "head", { ...f.context, approvedHead });
  expect(f.provider.item(f.item.id)?.risk?.automaticApproval).toBe(
    "Approved: an earlier human approval carries over",
  );
});

test("custom review findings name the actual review", () => {
  const f = fixture();
  recordReviewFindings(f.db, {
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
  expect(f.reader.read(f.item.id)?.detail).toBe(
    "Manual approval required: custom-review has a P2 finding",
  );
});

test("hand edits to config are observed outside the status read path", async () => {
  const f = fixture();
  const home = tempHome();
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "config.toml");
  writeFileSync(path, "[merge]\nauto_approve_high_risk = true\n");
  let reads = 0;
  const reader = new RiskDisplayReader({
    db: f.db,
    configPath: path,
    publicUrl: "https://paws.example",
    readSettings: () => {
      reads++;
      return readMergeSettings(loadConfigFile(path));
    },
  });
  cleanup.push(() => reader.close());
  reader.remember(f.item.id, "head", { ...f.context, ...reader.inputs() });
  expect(reader.read(f.item.id)?.detail).toContain("Passes automatically");
  writeFileSync(path, "[merge]\nauto_approve_high_risk = false\n");
  await waitFor(
    () => reader.read(f.item.id)?.detail.includes("automatic approval is off") ?? false,
  );
  const before = reads;
  reader.read(f.item.id);
  expect(reads).toBe(before);
});

test("policy file edits invalidate display evidence, including across a reader restart", async () => {
  const f = fixture();
  const home = tempHome();
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "rules.ts");
  writeFileSync(path, "old rules");
  f.reader.remember(f.item.id, "head", {
    ...f.context,
    policyFiles: f.reader.observeFiles([path]),
  });
  expect(f.reader.read(f.item.id)?.detail).toContain("Passes automatically");
  writeFileSync(path, "new rules");
  await waitFor(
    () => f.reader.read(f.item.id)?.detail.includes("policy evidence is unavailable") ?? false,
  );
  f.reader.close();
  const restarted = new RiskDisplayReader({
    db: f.db,
    configPath: "/tmp/pas934-no-config",
    publicUrl: "https://paws.example",
    readSettings: () => f.settings,
  });
  cleanup.push(() => restarted.close());
  expect(restarted.read(f.item.id)?.detail).toContain("policy evidence is unavailable");
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(25);
  expect(predicate()).toBe(true);
}

test("a failing human-approval display observer cannot reject an approved head", async () => {
  const f = fixture("off");
  approve(f, "head");
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
