import type { Database } from "bun:sqlite";
import {
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  getWorkItem,
  insertQueuedItem,
  putWorkspaceUser,
  recordLinearInstallation,
  recordRunnerCapacity,
  recordRunnerRepositories,
  type RunnerHostRefusal,
  storeOf,
  type Db,
} from "../src/db";
import { eq } from "drizzle-orm";
import { seed } from "./dialects";
import { itemRunnerVerdictsSteps } from "../src/runner-placement";
import { dispatch } from "../src/scheduler";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { workspaceAdmission } from "./fake-workspace";
export const REPOSITORY = "pmdroid/paws-app";
export const NOW = 1_800_000_000_000;

export async function workspaceWithRunners(source: Database | Db) {
  const db = storeOf(source);
  const userId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", NOW)),
    now: NOW,
  });
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspaceRepository)
      .values({ workspaceId: workspace.id, repository: REPOSITORY, teamId: "team" }),
  );
  const pair = async (name: string, slots: number, repositories: string[] | null) => {
    const id = workspaceId();
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.runner).values({
          id,
          workspaceId: workspace.id,
          ownerUserId: userId,
          name,
          status: "active",
          createdAt: NOW,
          lastSeenAt: NOW,
        }),
      (q) => q.orm.insert(q.t.runnerPolicy).values({ runnerId: id }),
      (q) =>
        q.orm.insert(q.t.runnerAgentPolicy).values({ runnerId: id, agent: "claude", ready: 1 }),
    );
    await recordRunnerCapacity(db, id, slots, undefined, undefined, NOW);
    await recordRunnerRepositories(db, id, repositories, NOW);
    return id;
  };
  const queue = async (id: string) => {
    const [owner, repo] = REPOSITORY.split("/") as [string, string];
    const sessionKey = `session-${id}`;
    await insertQueuedItem(db, { id, now: NOW, sessionKey });
    await bindWorkItemRepository(db, id, {
      owner,
      repo,
      remoteUrl: `https://github.com/${REPOSITORY}.git`,
    });
    await recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "app",
      appUserId: "app-user",
      sessionId: sessionKey,
      teamId: "team",
      observedAtMs: NOW,
    });
    const delegationId = (await getWorkItem(db, id))!.delegationId;
    await bindLinearSessionTask(db, sessionKey, delegationId, { actorId: "owner" });
    await seed(db, (q) =>
      q.orm.update(q.t.workItem).set({ ownerUserId: userId }).where(eq(q.t.workItem.id, id)),
    );
  };
  const pass = (reported: RunnerHostRefusal[][] = []) =>
    dispatch(db, {
      now: NOW,
      admission: workspaceAdmission(source),
      itemRunners: (q, itemId) =>
        itemRunnerVerdictsSteps(q, db, { itemId, agent: "claude", now: NOW }),
      onRunnerHostRefusals: (refusals) => reported.push([...refusals]),
    });
  return { pair, queue, pass, workspace, userId };
}
