import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase, putWorkspaceUser, syncWorkspaceMember } from "../src/db";
import { createRunnerModels } from "../src/runner-models";
import { createRunnerPlacementBrowser } from "../src/runner-placement";
import { workspaceId } from "../src/workspace";

function fixture() {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "paws-model-labels-")), "paws.db"));
  migrate(db);
  const now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "labels-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = workspaceId(),
    runnerId = workspaceId();
  db.run("INSERT INTO workspace VALUES(?,?,?,?)", [workspace, workspace, "Labels", now]);
  syncWorkspaceMember(db, {
    workspaceId: workspace,
    userId,
    role: "owner",
    active: true,
    teamIds: [],
    now,
  });
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
    [runnerId, workspace, userId, "Labels host", now, now],
  );
  db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'claude',1)", [runnerId]);
  db.run("INSERT INTO agent_model_catalog VALUES(?,?,'claude','',?,?)", [
    runnerId,
    userId,
    JSON.stringify({
      executionId: "01M5GCQ27RE0YMKT767K0P3451",
      commandId: "probe-1",
      role: "reviewer",
      stopReason: "end_turn",
      timedOut: false,
      cancelled: false,
      authRequired: false,
      agentExited: true,
      models: [
        { id: "default", name: "Default (recommended)" },
        { id: "opus", name: "Opus 5.5" },
        { id: "opus[1m]", name: "Opus", description: "Opus 5.5 (1M context)" },
      ],
      efforts: [{ id: "high", name: "High" }],
    }),
    now,
  ]);
  return { db, now, runnerId, userId, principal: { workspaceId: workspace, userId } };
}

test("the catalog lists the 1M entry next to its standard model", () => {
  const { db, principal } = fixture();
  const [catalog] = createRunnerModels({ db, work: undefined as never }).read(principal);
  expect(catalog?.models.map(({ id, name, longContext }) => ({ id, name, longContext }))).toEqual([
    { id: "opus", name: "Opus 5.5", longContext: false },
    { id: "opus[1m]", name: "Opus 5.5 · 1M context", longContext: true },
  ]);
});

test("a runner's run history labels the model it ran", async () => {
  const { db, now, runnerId, userId, principal } = fixture();
  db.run(
    "INSERT INTO runner_execution_usage(command_id,runner_id,owner_user_id,agent,model,resolved_model,role,purpose,started_at,ended_at,outcome) VALUES('run-1',?,?,'claude','opus[1m]','opus[1m]','implementer','work',?,?,'success')",
    [runnerId, userId, now - 1000, now],
  );
  const response = await createRunnerPlacementBrowser({ db })(
    new Request("http://127.0.0.1/api/runners/usage"),
    { ...principal, role: "owner", authenticatedAt: now, teamIds: [] },
  );
  const body = (await response!.json()) as {
    usage: Array<{ resolvedModel: string; modelLabel: string }>;
  };
  expect(
    body.usage.map(({ resolvedModel, modelLabel }) => ({ resolvedModel, modelLabel })),
  ).toEqual([{ resolvedModel: "opus[1m]", modelLabel: "Opus 5.5 · 1M context" }]);
});

test("a runner's history names the issue each execution worked on", async () => {
  const { db, now, runnerId, userId, principal } = fixture();
  db.run(
    "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES('item-1','del-1','issue-1','PAS-367','Parse config files','running','paws/pas-367',0,1)",
  );
  db.run(
    "INSERT INTO runner_execution_usage(command_id,runner_id,owner_user_id,item_id,role,purpose,started_at) VALUES('work-1',?,?,'item-1','implementer','work',?),('prepare-1',?,?,NULL,'implementer','prepare',?)",
    [runnerId, userId, now - 1000, runnerId, userId, now - 2000],
  );
  const response = await createRunnerPlacementBrowser({ db })(
    new Request("http://127.0.0.1/api/runners/usage"),
    { ...principal, role: "owner", authenticatedAt: now, teamIds: [] },
  );
  const body = (await response!.json()) as {
    usage: Array<{ commandId: string; identifier: string | null; title: string | null }>;
  };
  expect(
    body.usage.map(({ commandId, identifier, title }) => ({ commandId, identifier, title })),
  ).toEqual([
    { commandId: "work-1", identifier: "PAS-367", title: "Parse config files" },
    { commandId: "prepare-1", identifier: null, title: null },
  ]);
});
