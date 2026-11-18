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
