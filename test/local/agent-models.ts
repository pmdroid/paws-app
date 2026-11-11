import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
  sqliteDb,
} from "../../src/db";
import { runAgent } from "../../src/acp";
import { createRunnerWork } from "../../src/runner-work";
import { createRunnerHealth } from "../../src/runner-health";
import { createRunnerModels } from "../../src/runner-models";
import { RunnerCommandSchema, verifyRunnerCommand } from "../../src/runner-protocol";
import { workspaceId } from "../../src/workspace";

export async function probeAgentModels(
  root: string,
  observe: (name: string, passed: boolean, value: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, "paws.db");
  let db = openDatabase(path);
  migrate(db);
  let now = Date.now();
  const userId = await putWorkspaceUser(sqliteDb(db), {
    id: workspaceId(),
    linearUserId: "models-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const otherUser = await putWorkspaceUser(sqliteDb(db), {
    id: workspaceId(),
    linearUserId: "models-other",
    name: "Other",
    email: "other@example.invalid",
  });
  const workspace = workspaceId(),
    runnerId = workspaceId(),
    otherWorkspace = workspaceId();
  for (const id of [workspace, otherWorkspace])
    db.run("INSERT INTO workspace VALUES(?,?,?,?)", [id, id, "Models", now]);
  for (const [workspaceKey, user] of [
    [workspace, userId],
    [workspace, otherUser],
    [otherWorkspace, userId],
  ])
    await syncWorkspaceMember(sqliteDb(db), {
      workspaceId: workspaceKey!,
      userId: user!,
      role: "admin",
      active: true,
      teamIds: [],
      now,
    });
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
    [runnerId, workspace, userId, "Models host", now, now],
  );
  db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'codex',1)", [runnerId]);
  const key = generateKeyPairSync("ed25519");
  const work = () =>
    createRunnerWork({
      store: sqliteDb(db),
      keyId: "models-proof",
      privateKey: key.privateKey,
      eventKey: Buffer.alloc(32, 7),
      now: () => now,
    });
  const health = () => createRunnerHealth({ store: sqliteDb(db), work: work(), now: () => now });
  let catalog = createRunnerModels({ store: sqliteDb(db), work: work(), now: () => now });
  const principal = { workspaceId: workspace, userId };
  const count = () =>
    (db.query("SELECT COUNT(*) AS total FROM runner_command").get() as { total: number }).total;
  const latest = () => {
    const row = db
      .query("SELECT envelope FROM runner_command ORDER BY ordinal DESC LIMIT 1")
      .get() as { envelope: string };
    const envelope = JSON.parse(row.envelope);
    const verified = verifyRunnerCommand(envelope, {
      trustedKeys: new Map([["models-proof", key.publicKey]]),
      allowedRepositories: [],
      claimCommand: () => true,
      runnerId,
      workspaceId: workspace,
      now,
    });
    assert.equal(verified.ok, true);
    return RunnerCommandSchema.parse(
      JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")),
    );
  };
  async function complete(fail = false) {
    const command = latest();
    assert.equal(command.type, "probe");
    if (command.type !== "probe") throw Error("Expected model probe");
    const script = join(root, `${command.id}.script.json`),
      trace = join(root, `${command.id}.trace.json`);
    writeFileSync(
      script,
      JSON.stringify({
        model: "model-a",
        models: ["model-a", "model-b"],
        modelEfforts: { "model-a": ["low", "high"], "model-b": ["medium", "xhigh"] },
        steps: [{ type: "end" }],
      }),
    );
    const result = await runAgent({
      role: "implementer",
      profile: command.profile,
      itemId: "MODEL-1",
      runId: command.id,
      worktreePath: root,
      pawsRoot: join(root, "paws"),
      home: root,
      command: process.execPath,
      args: [
        new URL("../../src/acp/testing/fake-agent.ts", import.meta.url).pathname,
        trace,
        script,
      ],
      prepareOnly: true,
      readOnly: true,
      checkpoint: false,
      prompt: "",
    });
    const methods = JSON.parse(readFileSync(trace, "utf8")).methods;
    assert.equal(methods.includes("session/prompt"), false);
    assert.equal(result.agentExited, true);
    await health().submit(runnerId, {
      executionId: workspaceId(),
      commandId: command.id,
      role: result.role,
      stopReason: fail ? "error" : result.stopReason,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      authRequired: fail,
      agentExited: result.agentExited,
      sessionId: result.sessionId,
      identity: result.identity,
      models: result.models,
      effort: result.effort,
      efforts: result.efforts,
    });
    return command;
  }
  try {
    const empty = await catalog.browser(
      new Request("http://localhost/api/runners/models"),
      principal,
    );
    assert.deepEqual(await empty!.json(), { catalogs: [] });
    assert.equal(count(), 0);
    observe("cached HTTP reads do not dispatch ACP", true, { commands: count() });
    await catalog.refresh();
    assert.equal(count(), 1);
    await catalog.refresh();
    assert.equal(count(), 1);
    observe("background discovery queues one signed member probe", true, { commands: count() });
    await complete();
    await catalog.refresh();
    assert.equal((await catalog.read(principal))[0]!.models.length, 2);
    assert.deepEqual(
      (await catalog.read(principal))[0]!.efforts.map((choice) => choice.id),
      ["low", "high"],
    );
    observe(
      "ACP models and default effort are cached without prompting",
      true,
      await catalog.read(principal),
    );
    const specific = latest();
    assert.equal(specific.type === "probe" && specific.profile.model, "model-b");
    await complete();
    await catalog.refresh();
    assert.deepEqual(
      (await catalog.read(principal))[0]!.models
        .find((model) => model.id === "model-b")!
        .efforts!.map((choice) => choice.id),
      ["medium", "xhigh"],
    );
    assert.equal(count(), 2);
    observe("effort options belong to the selected model", true, await catalog.read(principal));
    const before = await catalog.read(principal);
    db.close();
    db = openDatabase(path);
    catalog = createRunnerModels({ store: sqliteDb(db), work: work(), now: () => now });
    assert.deepEqual(await catalog.read(principal), before);
    observe("catalog survives process storage reopen", true, { models: before[0]!.models.length });
    assert.deepEqual(await catalog.read({ workspaceId: workspace, userId: otherUser }), []);
    assert.deepEqual(await catalog.read({ workspaceId: otherWorkspace, userId }), []);
    observe("catalog reads are scoped to workspace and signed-in member", true, {});
    db.run("UPDATE runner SET last_seen_at=0 WHERE id=?", [runnerId]);
    db.run("UPDATE runner_agent_policy SET cooldown_until=? WHERE runner_id=?", [
      now + 60_000,
      runnerId,
    ]);
    assert.deepEqual(await catalog.read(principal), before);
    await catalog.refresh();
    assert.equal(count(), 2);
    observe("offline and cooling hosts retain cached choices", true, {});
    now += 6 * 60 * 60_000 + 1;
    db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [now, runnerId]);
    db.run(
      "INSERT INTO linear_session(session_id,issue_id,organization_id,app_user_id,creator_id,generation,created_at) VALUES('models-busy','issue','org','app','owner',0,?)",
      [now],
    );
    db.run(
      "INSERT INTO runner_helper(id,runner_id,workspace_id,session_id,session_generation,runner_fence,envelope,expires_at) VALUES('models-busy',?,?,'models-busy',0,0,'{}',?)",
      [runnerId, workspace, now + 60_000],
    );
    await catalog.refresh();
    assert.equal(count(), 2);
    observe("background discovery yields to active runner work", true, {});
    db.run("UPDATE runner_helper SET ended_at=? WHERE id='models-busy'", [now]);
    await catalog.refresh();
    assert.equal(count(), 3);
    await complete(true);
    await catalog.refresh();
    assert.deepEqual(await catalog.read(principal), before);
    const afterFailure = count();
    await catalog.refresh();
    assert.equal(count(), afterFailure);
    observe("failed refresh preserves last good cache and backs off", true, {});
    db.run("UPDATE runner_agent_policy SET auth_expired=1 WHERE runner_id=?", [runnerId]);
    assert.deepEqual(await catalog.read(principal), []);
    const beforeDisconnected = count();
    await catalog.refresh();
    assert.equal(count(), beforeDisconnected);
    observe("disconnected agent accounts cannot supply new or cached choices", true, {});
    db.run("UPDATE runner_agent_policy SET auth_expired=0 WHERE runner_id=?", [runnerId]);
    db.run("UPDATE workspace_member SET active=0,checked_at=? WHERE workspace_id=? AND user_id=?", [
      now + 1,
      workspace,
      userId,
    ]);
    assert.equal(
      (await catalog.browser(new Request("http://localhost/api/runners/models"), principal))!
        .status,
      403,
    );
    observe("membership revocation denies cached catalog", true, {});
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const root = process.argv[2]
    ? resolve(process.argv[2])
    : mkdtempSync(join(tmpdir(), "paws-agent-models-"));
  const observations: unknown[] = [];
  await probeAgentModels(root, (name, passed, value) => observations.push({ name, passed, value }));
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2) + "\n");
  console.log(JSON.stringify({ root, observations }, null, 2));
}
