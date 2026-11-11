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
  sqliteDb,
} from "../src/db";
import { itemRunnerVerdictsSteps } from "../src/runner-placement";
import { dispatch } from "../src/scheduler";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { workspaceAdmission } from "./fake-workspace";
export const REPOSITORY = "pmdroid/paws-app";
export const NOW = 1_800_000_000_000;

export async function workspaceWithRunners(db: Database) {
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(sqliteDb(db), {
    id: workspaceId(),
    organizationId: "org",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", NOW)),
    now: NOW,
  });
  db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [workspace.id, REPOSITORY, "team"]);
  const pair = async (name: string, slots: number, repositories: string[] | null) => {
    const id = workspaceId();
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
      [id, workspace.id, userId, name, NOW, NOW],
    );
    db.run("INSERT INTO runner_policy(runner_id) VALUES(?)", [id]);
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'claude',1)", [id]);
    recordRunnerCapacity(db, id, slots, undefined, undefined, NOW);
    await recordRunnerRepositories(sqliteDb(db), id, repositories, NOW);
    return id;
  };
  const queue = async (id: string) => {
    const [owner, repo] = REPOSITORY.split("/") as [string, string];
    const sessionKey = `session-${id}`;
    insertQueuedItem(db, { id, now: NOW, sessionKey });
    bindWorkItemRepository(db, id, {
      owner,
      repo,
      remoteUrl: `https://github.com/${REPOSITORY}.git`,
    });
    await recordLinearInstallation(sqliteDb(db), {
      organizationId: "org",
      oauthClientId: "app",
      appUserId: "app-user",
      sessionId: sessionKey,
      teamId: "team",
      observedAtMs: NOW,
    });
    const delegationId = getWorkItem(db, id)!.delegationId;
    bindLinearSessionTask(db, sessionKey, delegationId, { actorId: "owner" });
    db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [userId, id]);
  };
  const pass = (reported: RunnerHostRefusal[][] = []) =>
    dispatch(db, {
      now: NOW,
      admission: workspaceAdmission(db),
      itemRunners: (q, itemId) =>
        itemRunnerVerdictsSteps(q, sqliteDb(db), { itemId, agent: "claude", now: NOW }),
      onRunnerHostRefusals: (refusals) => reported.push([...refusals]),
    });
  return { pair, queue, pass, workspace, userId };
}
