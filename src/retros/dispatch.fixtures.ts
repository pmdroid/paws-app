import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRetro, saveRetroSettingsRevision, type Db, type Q } from "../db";
import { signRunnerRetroCommand, type RunnerRetroCommand } from "../runner-protocol";
import { collectRetroDigest, createRetroDispatcher } from "./index";
import { FIXTURE_END, FIXTURE_REPO, FIXTURE_START } from "./result.fixtures";

export const keys = generateKeyPairSync("ed25519");
export const trustedKeys = new Map([["k1", keys.publicKey]]);
export const sign = (command: RunnerRetroCommand) =>
  signRunnerRetroCommand({ keyId: "k1", privateKey: keys.privateKey, command });

function seed(db: Db, ...inserts: ((q: Q) => PromiseLike<unknown>)[]): Promise<void> {
  return db.transaction(function* (q) {
    for (const insert of inserts) yield* q.exec(insert(q));
  });
}

type Store = { db: Db; close(): Promise<void> };

export function seedActivityPg(db: Db, identifier: string, answers: number) {
  const id = `item-${identifier}`;
  const [owner, repo] = FIXTURE_REPO.split("/");
  return seed(
    db,
    (q) =>
      q.orm.insert(q.t.linearSession).values({
        sessionId: `session-${identifier}`,
        issueId: `issue-${identifier}`,
        organizationId: "org",
        teamId: "team",
        createdAt: 0,
      }),
    (q) =>
      q.orm.insert(q.t.workItem).values({
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
      }),
    (q) =>
      q.orm
        .insert(q.t.workItemRepository)
        .values({ itemId: id, owner: owner!, repo: repo!, remoteUrl: "git@x" }),
    ...Array.from(
      { length: answers },
      (_, n) => (q: Q) =>
        q.orm.insert(q.t.question).values({
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
        }),
    ),
  );
}

export function addRunnerPg(
  db: Db,
  input: { id: string; owner?: string; version?: string; capacity?: number; ready?: boolean },
) {
  return seed(
    db,
    (q) =>
      q.orm.insert(q.t.runner).values({
        id: input.id,
        workspaceId: "ws",
        ownerUserId: input.owner ?? "admin",
        name: input.id,
        status: "active",
        createdAt: 0,
        lastSeenAt: 0,
      }),
    (q) =>
      q.orm
        .insert(q.t.runnerHostStatus)
        .values({ runnerId: input.id, runnerVersion: input.version ?? "0.1.63", reportedAt: 0 }),
    (q) =>
      q.orm
        .insert(q.t.runnerAgentPolicy)
        .values({ runnerId: input.id, agent: "codex", ready: input.ready === false ? 0 : 1 }),
    (q) =>
      q.orm
        .insert(q.t.runnerCapacity)
        .values({ runnerId: input.id, capacity: input.capacity ?? 1 }),
  );
}

export function seedWorkspacePg(db: Db) {
  const people = [
    ["admin", "admin"],
    ["member", "member"],
  ] as const;
  return seed(
    db,
    (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "ws", linearOrganizationId: "org", name: "ws", createdAt: 0 }),
    (q) =>
      q.orm
        .insert(q.t.workspaceRepository)
        .values({ workspaceId: "ws", repository: FIXTURE_REPO, teamId: "team" }),
    (q) =>
      q.orm.insert(q.t.workspaceUser).values(
        people.map(([id]) => ({
          id,
          linearUserId: `linear-${id}`,
          name: id,
          email: `${id}@example.test`,
        })),
      ),
    (q) =>
      q.orm.insert(q.t.workspaceMember).values(
        people.map(([userId, role]) => ({
          workspaceId: "ws",
          userId,
          role,
          source: "manual",
          active: 1,
          checkedAt: 0,
        })),
      ),
  );
}

export async function worldPg(
  stores: { open(root: string): Promise<Store>; reopen?(root: string): Promise<Store> },
  options: { activity?: boolean; retries?: number } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "paws-retro-dispatch-"));
  let store = await stores.open(root);
  const db = store.db;
  await seedWorkspacePg(db);
  if (options.activity !== false) {
    await seedActivityPg(db, "PAS-817", 4);
    await seedActivityPg(db, "PAS-843", 5);
  }
  const { revision } = await saveRetroSettingsRevision(db, {
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
  await createRetro(db, {
    id: "r1",
    workspaceId: "ws",
    windowStart: FIXTURE_START,
    windowEnd: FIXTURE_END,
    origin: "manual",
    settingsRevision: revision,
    agentProfile: { agent: "codex", model: "gpt-x", effort: null },
    now: FIXTURE_END,
  });
  const collected = await collectRetroDigest(db, {
    retroId: "r1",
    artifactRoot: root,
    now: FIXTURE_END,
  });
  if (!collected.ok) throw new Error(collected.reason);
  const clock = { now: FIXTURE_END + 10_000 };
  const open = (database: Db) =>
    createRetroDispatcher({ store: database, artifactRoot: root, sign, now: () => clock.now });
  const restart = async () => {
    await store.close();
    store = await (stores.reopen ?? stores.open)(root);
    return store.db;
  };
  const close = () => store.close();
  return { db, root, clock, open, restart, close, digestSha256: collected.digestSha256 };
}
