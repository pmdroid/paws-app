import { afterAll, beforeAll, expect, test } from "bun:test";
import { currentSourceContextRecords, type ContextNamespace, type Db } from "../src/db";
import {
  createFakeContextAccess,
  createFakeProjectContextReads,
  createProjectSessionContext,
  ingestLinearProjectContext,
  type AnsweredDecision,
} from "../src/project-context";
import { ASK_TEAM_REASON, askedThroughAskTeam } from "../src/questions";
import { tempStore } from "./pglite";

const T0 = Date.parse("2026-11-17T12:00:00Z");

let db: Db;
let close: () => Promise<void>;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await tempStore());
});
afterAll(async () => {
  await close();
});

async function fixture() {
  seq++;
  const workspaceId = `org-${seq}`;
  const projectId = `project-${seq}`;
  const workItemId = `item-${seq}`;
  const answerer = { workspaceId, userId: `alice-${seq}` };
  const access = createFakeContextAccess();
  access.grant(answerer, { teamIds: ["team-a"], repositories: [], channelIds: [] });
  const reads = createFakeProjectContextReads();
  reads.projects.set(projectId, {
    id: projectId,
    name: "Exports",
    url: `https://linear.app/p/${projectId}`,
    revision: "p1",
    revisionAt: T0,
    teamIds: ["team-a"],
    content: "Exports ship as CSV.",
  });
  await ingestLinearProjectContext(db, access, reads, {
    workspaceId,
    projectId,
    requester: answerer,
    now: T0,
  });
  const namespace: ContextNamespace = {
    workspaceId,
    scopeKind: "linear_project",
    scopeId: projectId,
  };
  const service = createProjectSessionContext({ db, access, now: () => at });
  let at = T0;
  const record = (overrides: Partial<AnsweredDecision> = {}) =>
    service.recordDecision({
      organizationId: workspaceId,
      projectId,
      workItemId,
      issueIdentifier: "PAS-7",
      questionId: `question-${(at += 1000)}`,
      question: "Should exports include archived rows?",
      answer: "No, only active rows.",
      answererId: answerer.userId,
      answererName: "Alice Example",
      now: at,
      ...overrides,
    });
  const stored = () =>
    currentSourceContextRecords(db, namespace, { kind: "paws_work_item", id: workItemId }, at);
  return { record, stored };
}

test("the question and the answer are each cut to 300 characters", async () => {
  const { record, stored } = await fixture();
  await record({ question: "q".repeat(400), answer: "a".repeat(400) });
  expect((await stored())[0]!.body).toStartWith(`${"q".repeat(300)} → ${"a".repeat(300)} Reason:`);
});

test("an item outside a project records nothing", async () => {
  const { record, stored } = await fixture();
  expect(await record({ projectId: null })).toBe("outside_project");
  expect(await stored()).toEqual([]);
});

test("a refused access check rejects and stores nothing", async () => {
  const { record, stored } = await fixture();
  await expect(record({ answererId: "mallory" })).rejects.toThrow("refused");
  expect(await stored()).toEqual([]);
});

test("only questions the agent asked through ask_team are decisions", () => {
  expect(askedThroughAskTeam({ kind: "agent", reason: ASK_TEAM_REASON })).toBe(true);
  expect(askedThroughAskTeam({ kind: "repository", reason: "repository" })).toBe(false);
  expect(askedThroughAskTeam({ kind: "agent", reason: "restart" })).toBe(false);
  expect(askedThroughAskTeam({ kind: "agent", reason: "agent" })).toBe(false);
  expect(askedThroughAskTeam({ kind: "time-limit", reason: "time-limit" })).toBe(false);
  expect(askedThroughAskTeam({ kind: "link", reason: "link" })).toBe(false);
});

test("two questions that share their first 300 characters stay two decisions", async () => {
  const { record, stored } = await fixture();
  const opening = "Which export format should the nightly job use ".repeat(8);
  expect(opening.length).toBeGreaterThan(300);
  expect(await record({ question: `${opening}for invoices?`, answer: "CSV." })).toBe("stored");
  expect(await record({ question: `${opening}for refunds?`, answer: "JSON." })).toBe("stored");
  const rows = await stored();
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.supersedes)).toEqual([null, null]);
  expect(rows.map((row) => row.body.slice(300 + 3, 300 + 8)).sort()).toEqual(["CSV. ", "JSON."]);
});

test("asking a long question again corrects its own decision, not its look-alike", async () => {
  const { record, stored } = await fixture();
  const opening = "Which export format should the nightly job use ".repeat(8);
  await record({ question: `${opening}for invoices?`, answer: "CSV." });
  await record({ question: `${opening}for refunds?`, answer: "JSON." });
  const before = await stored();
  expect(await record({ question: `${opening}for refunds?`, answer: "XML." })).toBe("corrected");
  const rows = await stored();
  expect(rows).toHaveLength(2);
  const corrected = rows.find((row) => row.body.includes("XML."))!;
  const kept = rows.find((row) => row.body.includes("CSV."))!;
  expect(corrected.supersedes).toBe(before.find((row) => row.body.includes("JSON."))!.id);
  expect(kept.id).toBe(before.find((row) => row.body.includes("CSV."))!.id);
  expect(corrected.actorId).toBe(kept.actorId);
});

test("a short question asked again corrects the decision and keeps its provenance", async () => {
  const { record, stored } = await fixture();
  expect(await record({ answer: "Yes." })).toBe("stored");
  const [first] = await stored();
  expect(await record({ answer: "Yes." })).toBe("unchanged");
  expect(await record({ answer: "No." })).toBe("corrected");
  const rows = await stored();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.supersedes).toBe(first!.id);
  expect(rows[0]!.recordKey).toBe(first!.recordKey);
  expect(rows[0]!.body).toBe(
    "Should exports include archived rows? → No. Reason: Answered by Alice Example on PAS-7",
  );
});
