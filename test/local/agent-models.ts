import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { and, count as total, desc, eq } from "drizzle-orm";
import { openPawsStore, putWorkspaceUser, syncWorkspaceMember, type Q } from "../../src/db";
import { runAgent } from "../../src/acp";
import { createRunnerWork } from "../../src/runner-work";
import { createRunnerHealth } from "../../src/runner-health";
import { createRunnerModels } from "../../src/runner-models";
import { RunnerCommandSchema, verifyRunnerCommand } from "../../src/runner-protocol";
import { workspaceId } from "../../src/workspace";
import { copyMigratedPglite } from "../pglite";

export async function probeAgentModels(
  root: string,
  observe: (name: string, passed: boolean, value: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const pgliteDir = join(root, "pglite");
  await copyMigratedPglite(pgliteDir);
  let open = await openPawsStore({ url: null, pgliteDir });
  let db = open.store;
  const exec = (query: (q: Q) => PromiseLike<unknown>) => db.run((q) => q.exec(query(q)));
  let now = Date.now();
  const userId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "models-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const otherUser = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "models-other",
    name: "Other",
    email: "other@example.invalid",
  });
  const workspace = workspaceId(),
    runnerId = workspaceId(),
    otherWorkspace = workspaceId();
  for (const id of [workspace, otherWorkspace])
    await exec((q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id, linearOrganizationId: id, name: "Models", createdAt: now }),
    );
  for (const [workspaceKey, user] of [
    [workspace, userId],
    [workspace, otherUser],
    [otherWorkspace, userId],
  ])
    await syncWorkspaceMember(db, {
      workspaceId: workspaceKey!,
      userId: user!,
      role: "admin",
      active: true,
      teamIds: [],
      now,
    });
  await exec((q) =>
    q.orm.insert(q.t.runner).values({
      id: runnerId,
      workspaceId: workspace,
      ownerUserId: userId,
      name: "Models host",
      status: "active",
      createdAt: now,
      lastSeenAt: now,
    }),
  );
  await exec((q) =>
    q.orm.insert(q.t.runnerAgentPolicy).values({ runnerId, agent: "codex", ready: 1 }),
  );
  const policy = (set: { cooldownUntil?: number; authExpired?: number }) =>
    exec((q) =>
      q.orm
        .update(q.t.runnerAgentPolicy)
        .set(set)
        .where(eq(q.t.runnerAgentPolicy.runnerId, runnerId)),
    );
  const seen = (lastSeenAt: number) =>
    exec((q) => q.orm.update(q.t.runner).set({ lastSeenAt }).where(eq(q.t.runner.id, runnerId)));
  const key = generateKeyPairSync("ed25519");
  const work = () =>
    createRunnerWork({
      store: db,
      keyId: "models-proof",
      privateKey: key.privateKey,
      eventKey: Buffer.alloc(32, 7),
      now: () => now,
    });
  const health = () => createRunnerHealth({ store: db, work: work(), now: () => now });
  let catalog = createRunnerModels({ store: db, work: work(), now: () => now });
  const principal = { workspaceId: workspace, userId };
  const count = async () =>
    (await db.run((q) => q.one(q.orm.select({ total: total() }).from(q.t.runnerCommand))))!.total;
  const latest = async () => {
    const row = await db.run((q) =>
      q.one(
        q.orm
          .select({ envelope: q.t.runnerCommand.envelope })
          .from(q.t.runnerCommand)
          .orderBy(desc(q.t.runnerCommand.ordinal))
          .limit(1),
      ),
    );
    const envelope = row!.envelope as { payload: string };
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
    const command = await latest();
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
    assert.equal(await count(), 0);
    observe("cached HTTP reads do not dispatch ACP", true, { commands: await count() });
    await catalog.refresh();
    assert.equal(await count(), 1);
    await catalog.refresh();
    assert.equal(await count(), 1);
    observe("background discovery queues one signed member probe", true, {
      commands: await count(),
    });
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
    const specific = await latest();
    assert.equal(specific.type === "probe" && specific.profile.model, "model-b");
    await complete();
    await catalog.refresh();
    assert.deepEqual(
      (await catalog.read(principal))[0]!.models
        .find((model) => model.id === "model-b")!
        .efforts!.map((choice) => choice.id),
      ["medium", "xhigh"],
    );
    assert.equal(await count(), 2);
    observe("effort options belong to the selected model", true, await catalog.read(principal));
    const before = await catalog.read(principal);
    await open.close();
    open = await openPawsStore({ url: null, pgliteDir });
    db = open.store;
    catalog = createRunnerModels({ store: db, work: work(), now: () => now });
    assert.deepEqual(await catalog.read(principal), before);
    observe("catalog survives process storage reopen", true, { models: before[0]!.models.length });
    assert.deepEqual(await catalog.read({ workspaceId: workspace, userId: otherUser }), []);
    assert.deepEqual(await catalog.read({ workspaceId: otherWorkspace, userId }), []);
    observe("catalog reads are scoped to workspace and signed-in member", true, {});
    await seen(0);
    await policy({ cooldownUntil: now + 60_000 });
    assert.deepEqual(await catalog.read(principal), before);
    await catalog.refresh();
    assert.equal(await count(), 2);
    observe("offline and cooling hosts retain cached choices", true, {});
    now += 6 * 60 * 60_000 + 1;
    await seen(now);
    await exec((q) =>
      q.orm.insert(q.t.linearSession).values({
        sessionId: "models-busy",
        issueId: "issue",
        organizationId: "org",
        appUserId: "app",
        creatorId: "owner",
        generation: 0,
        createdAt: now,
      }),
    );
    await exec((q) =>
      q.orm.insert(q.t.runnerHelper).values({
        id: "models-busy",
        runnerId,
        workspaceId: workspace,
        sessionId: "models-busy",
        sessionGeneration: 0,
        runnerFence: 0,
        envelope: {},
        expiresAt: now + 60_000,
      }),
    );
    await catalog.refresh();
    assert.equal(await count(), 2);
    observe("background discovery yields to active runner work", true, {});
    await exec((q) =>
      q.orm
        .update(q.t.runnerHelper)
        .set({ endedAt: now })
        .where(eq(q.t.runnerHelper.id, "models-busy")),
    );
    await catalog.refresh();
    assert.equal(await count(), 3);
    await complete(true);
    await catalog.refresh();
    assert.deepEqual(await catalog.read(principal), before);
    const afterFailure = await count();
    await catalog.refresh();
    assert.equal(await count(), afterFailure);
    observe("failed refresh preserves last good cache and backs off", true, {});
    await policy({ authExpired: 1 });
    assert.deepEqual(await catalog.read(principal), []);
    const beforeDisconnected = await count();
    await catalog.refresh();
    assert.equal(await count(), beforeDisconnected);
    observe("disconnected agent accounts cannot supply new or cached choices", true, {});
    await policy({ authExpired: 0 });
    await exec((q) =>
      q.orm
        .update(q.t.workspaceMember)
        .set({ active: 0, checkedAt: now + 1 })
        .where(
          and(
            eq(q.t.workspaceMember.workspaceId, workspace),
            eq(q.t.workspaceMember.userId, userId),
          ),
        ),
    );
    assert.equal(
      (await catalog.browser(new Request("http://localhost/api/runners/models"), principal))!
        .status,
      403,
    );
    observe("membership revocation denies cached catalog", true, {});
  } finally {
    await open.close();
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
