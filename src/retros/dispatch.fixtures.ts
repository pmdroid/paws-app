import type { Database } from "bun:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRetro,
  migrate,
  openDatabase,
  orm,
  saveRetroSettingsRevision,
  schema,
  sqliteDb,
} from "../db";
import { signRunnerRetroCommand, type RunnerRetroCommand } from "../runner-protocol";
import { collectRetroDigest, createRetroDispatcher } from "./index";
import { FIXTURE_END, FIXTURE_REPO, FIXTURE_START } from "./result.fixtures";

export const keys = generateKeyPairSync("ed25519");
export const trustedKeys = new Map([["k1", keys.publicKey]]);
export const sign = (command: RunnerRetroCommand) =>
  signRunnerRetroCommand({ keyId: "k1", privateKey: keys.privateKey, command });

export function seedActivity(db: Database, identifier: string, answers: number) {
  const id = `item-${identifier}`;
  const q = orm(db);
  q.insert(schema.linearSession)
    .values({
      sessionId: `session-${identifier}`,
      issueId: `issue-${identifier}`,
      organizationId: "org",
      teamId: "team",
      createdAt: 0,
    })
    .run();
  q.insert(schema.workItem)
    .values({
      id,
      delegationId: `delegation-${identifier}`,
      linearIssueId: `issue-${identifier}`,
      linearIdentifier: identifier,
      title: `Work on ${identifier}`,
      state: "running",
      branchName: `paws/${identifier}`,
      position: 0,
      createdAt: FIXTURE_START,
      sessionKey: `session-${identifier}`,
    })
    .run();
  const [owner, repo] = FIXTURE_REPO.split("/");
  q.insert(schema.workItemRepository)
    .values({ itemId: id, owner: owner!, repo: repo!, remoteUrl: "git@x" })
    .run();
  for (let n = 0; n < answers; n += 1)
    q.insert(schema.question)
      .values({
        id: `q-${identifier}-${n}`,
        itemId: id,
        sessionId: "s",
        kind: "agent",
        reason: "push_rejected",
        body: "How do I recover?",
        status: "answered",
        answer: "Fetch and rebase.",
        answeredBy: "someone",
        createdAt: FIXTURE_START + n,
        answeredAt: FIXTURE_START + n + 1,
      })
      .run();
}

export function addRunner(
  db: Database,
  input: { id: string; owner?: string; version?: string; capacity?: number; ready?: boolean },
) {
  const q = orm(db);
  q.insert(schema.runner)
    .values({
      id: input.id,
      workspaceId: "ws",
      ownerUserId: input.owner ?? "admin",
      name: input.id,
      status: "active",
      createdAt: 0,
      lastSeenAt: 0,
    })
    .run();
  q.insert(schema.runnerHostStatus)
    .values({ runnerId: input.id, runnerVersion: input.version ?? "0.1.63", reportedAt: 0 })
    .run();
  q.insert(schema.runnerAgentPolicy)
    .values({ runnerId: input.id, agent: "codex", ready: input.ready === false ? 0 : 1 })
    .run();
  q.insert(schema.runnerCapacity)
    .values({ runnerId: input.id, capacity: input.capacity ?? 1 })
    .run();
}

export async function world(options: { activity?: boolean; retries?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "paws-retro-dispatch-"));
  const path = join(root, "paws.db");
  const db = openDatabase(path);
  migrate(db);
  const q = orm(db);
  q.insert(schema.workspace)
    .values({ id: "ws", linearOrganizationId: "org", name: "ws", createdAt: 0 })
    .run();
  q.insert(schema.workspaceRepository)
    .values({ workspaceId: "ws", repository: FIXTURE_REPO, teamId: "team" })
    .run();
  for (const [id, role] of [
    ["admin", "admin"],
    ["member", "member"],
  ] as const) {
    q.insert(schema.workspaceUser)
      .values({ id, linearUserId: `linear-${id}`, name: id, email: `${id}@example.test` })
      .run();
    q.insert(schema.workspaceMember)
      .values({ workspaceId: "ws", userId: id, role, source: "manual", active: 1, checkedAt: 0 })
      .run();
  }
  if (options.activity !== false) {
    seedActivity(db, "PAS-817", 4);
    seedActivity(db, "PAS-843", 5);
  }
  const { revision } = await saveRetroSettingsRevision(sqliteDb(db), {
    workspaceId: "ws",
    prompt: "Review {{period}} in {{repositories}}.\n\n{{digest}}",
    agentProfile: { agent: "codex", model: "gpt-x", effort: null },
    repositories: [FIXTURE_REPO],
    outputLimits: { maxItems: 5, workedWell: 3 },
    executionLimits: { activeMinutes: 15, retries: options.retries ?? 1 },
    schedule: {},
    createdBy: "admin",
    now: 1,
  });
  await createRetro(sqliteDb(db), {
    id: "r1",
    workspaceId: "ws",
    windowStart: FIXTURE_START,
    windowEnd: FIXTURE_END,
    origin: "manual",
    settingsRevision: revision,
    agentProfile: { agent: "codex", model: "gpt-x", effort: null },
    now: FIXTURE_END,
  });
  const collected = await collectRetroDigest(sqliteDb(db), {
    retroId: "r1",
    artifactRoot: root,
    now: FIXTURE_END,
  });
  if (!collected.ok) throw new Error(collected.reason);
  const clock = { now: FIXTURE_END + 10_000 };
  const open = (database: Database) =>
    createRetroDispatcher({ db: database, artifactRoot: root, sign, now: () => clock.now });
  return { db, root, path, clock, open, digestSha256: collected.digestSha256 };
}
