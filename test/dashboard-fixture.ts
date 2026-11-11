import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWorkItemEvent,
  beginImplementRun,
  enterMergeQueue,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
  sqliteDb,
} from "../src/db";
import { createEvidenceStore } from "../src/evidence";
import type { LinearUsage } from "../src/linear";
import { handleQuestionAnswer, type QuestionAnswer } from "../src/questions";
import { startServer } from "../src/server";
import { screenshotPng } from "./png";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";

const PNG = screenshotPng(320, 200, [{ x: 40, y: 40, width: 240, height: 120, rgb: 0x7c3aed }]);

export type DashboardFixture = Awaited<ReturnType<typeof startDashboardFixture>>;

export async function startDashboardFixture(
  options: { linearUsage?: () => Promise<LinearUsage> } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "paws-dashboard-fixture-"));
  const db = openDatabase(join(home, "paws.sqlite"));
  migrate(db);
  db.run(
    "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('workspace','org','Workspace',0)",
  );
  await putWorkspaceUser(sqliteDb(db), {
    id: "member",
    linearUserId: "member",
    name: "Member",
    email: "m@x.test",
  });
  let teamIds = ["team"];
  const sync = async () =>
    await syncWorkspaceMember(sqliteDb(db), {
      workspaceId: "workspace",
      userId: "member",
      role: "member",
      active: true,
      teamIds,
      now: Date.now(),
    });
  await sync();
  const evidenceDir = join(home, "evidence");
  const store = createEvidenceStore({ db, root: evidenceDir });
  const answers: Parameters<QuestionAnswer>[0][] = [];
  const runs: Record<string, string> = {};
  const evidence: Record<string, string> = {};
  for (const [item, session, team] of [
    ["PAS-1", "session-mine", "team"],
    ["PAS-2", "session-other", "other-team"],
  ] as const) {
    db.run(
      `INSERT INTO linear_session (session_id, organization_id, oauth_client_id, app_user_id, team_id,
        installation_observed_at, created_at) VALUES (?, 'org', 'fixture', 'app', ?, 1, 0)`,
      [session, team],
    );
    await insertQueuedItem(db, {
      id: item,
      sessionKey: session,
      title: `Fixture ${item}`,
      now: Date.now(),
    });
    runs[item] = (await beginImplementRun(sqliteDb(db), item, Date.now())).run.id;
    await applyWorkItemEvent(sqliteDb(db), item, "blocking_question");
    db.run(
      "INSERT INTO question (id, item_id, session_id, body, status, created_at) VALUES (?, ?, ?, 'Which way?', 'open', 1)",
      [`q-${item}`, item, session],
    );
    const saved = await store.save({
      itemId: item,
      runId: runs[item],
      checkId: "visual-proof",
      attempt: 1,
      displayName: `${item}.png`,
      headCommit: "c".repeat(40),
      source: new Blob([PNG]),
    });
    evidence[item] = saved.id;
  }
  for (const [item, session] of [
    ["PAS-3", "session-mine"],
    ["PAS-4", "session-other"],
  ] as const) {
    await insertQueuedItem(db, {
      id: item,
      sessionKey: session,
      title: `Fixture ${item}`,
      now: Date.now(),
    });
    const head = (await beginImplementRun(sqliteDb(db), item, Date.now())).run.id
      .padEnd(40, "0")
      .slice(0, 40);
    await enterMergeQueue(sqliteDb(db), item, {
      phase: "merge_queue",
      baseSha: head,
      wipCommit: head,
    });
  }
  const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const access = createWorkspaceAccess({
    db,
    publicUrl: origin,
    clientId: "fixture",
    installedOrganization: { id: "org", name: "Workspace" },
    memberships: {
      installation: async () => ({ id: "org", name: "Workspace" }),
      member: async (organizationId, userId) => ({
        organizationId,
        userId,
        active: true,
        guest: false,
        admin: false,
        teamIds,
      }),
    },
  });
  const server = startServer({
    port,
    hostname: "127.0.0.1",
    db,
    workspaceAccess: access,
    evidenceDir,
    questionAnswers: (request, principal, sessionIds) =>
      handleQuestionAnswer(request, {
        db,
        principal,
        sessionIds,
        submit: async (input) => (answers.push(input), "answered"),
      }),
    ...options,
  });
  const session = await issueWorkspaceSession(db, {
    workspaceId: "workspace",
    userId: "member",
    now: Date.now(),
  });
  return {
    db,
    origin,
    runs,
    evidence,
    answers,
    csrfToken: session.session.csrfToken,
    cookie: `${WORKSPACE_COOKIE}=${session.token}`,
    sessionToken: session.token,
    fill: (path: string) =>
      path
        .replaceAll("{run}", runs["PAS-1"]!)
        .replaceAll("{evidence}", evidence["PAS-1"]!)
        .replaceAll("{hidden-evidence}", evidence["PAS-2"]!),
    async revoke() {
      teamIds = ["other-team"];
      await sync();
    },
    async close() {
      await server.stop(true);
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
