import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import {
  beginImplementRun,
  applyWorkItemEvent,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  recordRunnerSkills,
  runAgentSetup,
  saveSkill,
  sqliteDb,
} from "../../src/db";
import { createRunnerControl } from "../../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../../src/runner-identity";
import {
  RUNNER_LEASE_GRACE_MS,
  verifyRunnerCommand,
  type RunnerCommand,
} from "../../src/runner-protocol";
import {
  recoverRunnerWorkStall,
  createRunnerWorkHttp,
  createRunnerWork,
} from "../../src/runner-work";
import { createRunnerHelpers } from "../../src/runner-helpers";
import { createRemoteAgentRunner } from "../../src/runner-backend";
import { createRunnerHealth } from "../../src/runner-health";
import { createRunnerResults } from "../../src/runner-results";
import { openQuestion } from "../../src/questions";
import { answerQuestion } from "../questions";
import {
  issueWorkspaceBootstrap,
  workspaceId,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../../src/workspace";

export async function probeRunnerWork(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, "paws.sqlite");
  const db = openDatabase(path);
  migrate(db);
  let now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const bootstrap = await issueWorkspaceBootstrap(db, "fixture-work", now);
  const workspace = await consumeWorkspaceBootstrap(sqliteDb(db), {
    id: workspaceId(),
    organizationId: "fixture-work",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(bootstrap),
    now,
  });
  const principal: WorkspacePrincipal = {
    workspaceId: workspace.id,
    userId,
    role: "admin",
    authenticatedAt: now,
    teamIds: [],
  };
  const issuer = join(root, "issuer");
  const authority = await initializeRunnerAuthority(issuer);
  const control = createRunnerControl({
    db,
    authority,
    certificateRoot: issuer,
    disconnect() {},
    now: () => now,
  });
  const client = await createRunnerKey(join(root, "client"));
  async function paired(name: string) {
    const pending = { name, csr: client.csr };
    const { runnerId } = await control.enroll({
      ...pending,
      token: (await control.createEnrollment(principal, pending)).token,
    });
    await control.setStatus(principal, runnerId, "active");
    return runnerId;
  }
  const firstRunner = await paired("First VM");
  const secondRunner = await paired("Second VM");
  const keys = generateKeyPairSync("ed25519");
  const keyPath = join(root, "fixture-signing.pem");
  writeFileSync(keyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: keys.privateKey,
    eventKey: Buffer.alloc(32, 7),
    now: () => now,
  });
  const confirmStopped = async (
    runnerId: string,
    command: { runId: string; generation: number; id: string },
  ) =>
    await work.heartbeat(
      runnerId,
      1,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      [{ runId: command.runId, generation: command.generation, commandId: command.id }],
    );
  const item = insertQueuedItem(db, { id: "fixture-item", now, sessionKey: "fixture-session" });
  const { run } = beginImplementRun(db, item.id, now);
  await recordLinearInstallation(sqliteDb(db), {
    organizationId: "fixture-work",
    oauthClientId: "fixture-app",
    appUserId: "fixture-app-user",
    sessionId: "fixture-session",
    teamId: "fixture-team",
    observedAtMs: now,
  });
  bindLinearSessionTask(db, "fixture-session", item.delegationId, { actorId: "owner" });
  const repository = {
    owner: "fixture",
    repo: "repository",
    remoteUrl: "https://github.com/fixture/repository.git",
    baseSha: "a".repeat(40),
  };
  bindWorkItemRepository(db, item.id, repository);
  const command: Extract<RunnerCommand, { type: "run" }> = {
    id: workspaceId(),
    runnerId: firstRunner,
    workspaceId: workspace.id,
    issuedAt: now,
    expiresAt: now + 5 * 60_000,
    type: "run",
    runId: run.id,
    itemId: item.id,
    generation: 1,
    repository,
    profile: { agent: "codex", model: "scripted" },
    prompt: "Update the fixture.",
  };
  try {
    await assert.rejects(work.assign(command), /repository access/);
    db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
      workspace.id,
      "fixture/repository",
      "fixture-team",
    ]);
    await assert.rejects(
      work.assign({
        ...command,
        repository: {
          ...repository,
          repo: "other",
          remoteUrl: "https://github.com/fixture/other.git",
        },
      }),
      /repository or task changed/,
    );
    const pin = {
      source: { kind: "npm" as const, package: "impeccable" },
      sha256: "a".repeat(64),
      sizeBytes: 4,
      updatedAt: now,
    };
    await saveSkill(sqliteDb(db), {
      ...pin,
      name: "impeccable",
      version: "2.4.1",
      agents: ["claude", "codex"],
    });
    await saveSkill(sqliteDb(db), {
      ...pin,
      name: "claude-only",
      version: "1.0.0",
      agents: ["claude"],
    });
    await saveSkill(sqliteDb(db), {
      ...pin,
      name: "updating",
      version: "3.0.0",
      agents: ["codex"],
    });
    await recordRunnerSkills(
      sqliteDb(db),
      firstRunner,
      [
        { name: "claude-only", version: "1.0.0", sha256: pin.sha256, status: "installed" },
        { name: "impeccable", version: "2.4.1", sha256: pin.sha256, status: "installed" },
        { name: "updating", version: "3.0.0", sha256: pin.sha256, status: "pending" },
      ],
      now,
    );
    assert.equal(
      (await control.list(principal, [])).find((runner) => runner.id === firstRunner)?.hasRunWork,
      false,
    );
    const assigned = await work.assign({
      ...command,
      hooks: [
        {
          id: workspaceId(),
          event: "after_edit",
          matcher: null,
          command: "bun run fmt",
          timeoutSeconds: 60,
          agents: ["codex"],
          skill: null,
        },
      ],
    });
    assert.equal(
      (await control.list(principal, [])).find((runner) => runner.id === firstRunner)?.hasRunWork,
      true,
    );
    assert.equal(assigned.leaseUntil, now + 60_000);
    assert.deepEqual(await runAgentSetup(sqliteDb(db), run.id), {
      runnerId: firstRunner,
      skills: [
        { name: "impeccable", version: "2.4.1", status: "installed" },
        { name: "updating", version: "3.0.0", status: "pending" },
      ],
      hooks: [
        { name: "Paws Closeout", event: "stop" },
        { name: "bun run fmt", event: "after_edit" },
      ],
      recordedAt: now,
    });
    const verified = verifyRunnerCommand(assigned.envelope, {
      trustedKeys: new Map([["fixture", keys.publicKey]]),
      runnerId: firstRunner,
      workspaceId: workspace.id,
      now,
      allowedRepositories: ["fixture/repository"],
      claimCommand: () => true,
    });
    assert(verified.ok);
    assert.equal((await work.commands(firstRunner)).length, 1);
    assert.equal((await work.commands(secondRunner)).length, 0);
    observe("durable work is signed and bound to an active Linear workspace repository", true, {
      signatureVerified: verified.ok,
      firstRunnerCommands: 1,
      secondRunnerCommands: 0,
      leaseMs: 60_000,
      unmappedAndChangedRepositoryDenied: true,
    });
    const before = await restartSnapshot(root, path, keyPath, firstRunner, now);
    assert.deepEqual(before.commands, [command.id]);
    await work.acknowledge(firstRunner, command.id);
    await work.acknowledge(firstRunner, command.id);
    await assert.rejects(work.acknowledge(secondRunner, command.id), /unknown/);
    const after = await restartSnapshot(root, path, keyPath, firstRunner, now);
    assert.deepEqual(after.commands, []);
    observe(
      "command delivery survives process restart and acknowledgments are durable and idempotent",
      true,
      {
        before: before.commands,
        after: after.commands,
        duplicateAcknowledgmentAccepted: true,
        wrongRunnerDenied: true,
      },
    );
    const grantInput = {
      runnerId: firstRunner,
      runId: run.id,
      commandId: command.id,
      generation: 1,
    };
    await assert.rejects(work.issueGrant({ ...grantInput, runnerId: secondRunner }), /fenced/);
    await assert.rejects(work.issueGrant({ ...grantInput, commandId: "other" }), /changed/);
    const grant = await work.issueGrant(grantInput);
    const beforeStall = now;
    now = command.expiresAt + 1000;
    const stallMs = now - beforeStall;
    await recoverRunnerWorkStall(sqliteDb(db), beforeStall, stallMs);
    const extended = db
      .query<{ expires_at: number }, []>("SELECT expires_at FROM runner_work_grant")
      .get()!;
    assert.equal(extended.expires_at, grant.expiresAt + stallMs);
    await work.event({
      ...grantInput,
      token: grant.token,
      sequence: 1,
      event: { type: "progress", text: "Working" },
    });
    assert.deepEqual((await work.heartbeat(firstRunner)).fenced, []);
    // Restore this fixture's delivery deadline for its later normal-expiry assertions.
    db.run("UPDATE runner_command SET expires_at=? WHERE id=?", [command.expiresAt, command.id]);
    now = beforeStall;
    const stored = db
      .query<{ token_hash: string }, []>("SELECT token_hash FROM runner_work_grant")
      .get()!;
    assert.notEqual(stored.token_hash, grant.token);
    const event = {
      ...grantInput,
      token: grant.token,
      sequence: 1,
      event: { type: "progress" as const, text: "Working" },
    };
    assert.equal((await work.event(event)).duplicate, true);
    assert.equal((await work.event(event)).duplicate, true);
    const http = createRunnerWorkHttp(work);
    const request = (route: string, body: unknown, token?: string) =>
      new Request(`https://runner.invalid${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    const httpEvent = { runId: run.id, generation: 1, sequence: 1, event: event.event };
    assert.equal(
      (await http(request("/v1/events", httpEvent, grant.token), firstRunner))!.status,
      200,
    );
    assert.equal((await http(request("/v1/events", httpEvent, "bad"), firstRunner))!.status, 403);
    assert.equal(
      (await http(
        request(`/v1/runs/${run.id}/grant`, {
          ...grantInput,
          runnerId: undefined,
          runId: undefined,
          generation: 2,
        }),
        firstRunner,
      ))!.status,
      409,
    );
    assert.equal((await http(request("/v1/heartbeat", {}), firstRunner))!.status, 200);
    let pulls = 0;
    let cancelled = false;
    const oversized = new Request("https://runner.invalid/v1/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream(
        {
          pull(controller) {
            if (++pulls <= 3) controller.enqueue(new Uint8Array(40_000));
            else controller.close();
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    });
    assert.equal((await http(oversized, firstRunner))!.status, 403);
    assert.equal(pulls, 2);
    assert.equal(cancelled, true);

    await assert.rejects(
      work.event({ ...event, event: { type: "progress", text: "Changed" } }),
      /changed its payload/,
    );
    await assert.rejects(work.event({ ...event, sequence: 3 }), /gap/);
    await assert.rejects(work.event({ ...event, token: "wrong", sequence: 2 }), /grant/);
    await assert.rejects(work.event({ ...event, runnerId: secondRunner, sequence: 2 }), /fenced/);
    assert.equal((await work.authorizeAsync(event)).command.id, command.id);
    await assert.rejects(work.authorizeAsync({ ...event, token: "wrong" }), /grant/);
    db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
      workspace.id,
      "fixture/other",
      "fixture-team",
    ]);
    db.run(
      "UPDATE work_item_repository SET repo='other',remote_url='https://github.com/fixture/other.git' WHERE item_id=?",
      [item.id],
    );
    await assert.rejects(work.authorizeAsync(event), /repository binding changed/);
    await assert.rejects(work.event({ ...event, sequence: 2 }), /repository binding changed/);
    await assert.rejects(work.issueGrant(grantInput), /repository binding changed/);
    db.run("UPDATE work_item_repository SET repo=?,remote_url=? WHERE item_id=?", [
      repository.repo,
      repository.remoteUrl,
      item.id,
    ]);
    observe(
      "repository credentials and events remain bound to the exact assigned repository after configuration changes",
      true,
      { changedBindingDenied: true, wrongGrantDenied: true },
    );
    observe(
      "run grants are separate hash-only credentials and events reject cross-runner, changed replay and sequence gaps",
      true,
      {
        hashOnly: true,
        duplicateAccepted: true,
        changedReplayDenied: true,
        gapDenied: true,
        wrongRunnerDenied: true,
      },
    );
    applyWorkItemEvent(db, item.id, "blocking_question");
    await assert.rejects(work.authorizeAsync(event), /matching open question/);
    assert.equal((await work.heartbeat(firstRunner)).leases.length, 1);
    const question = await openQuestion(db, {
      itemId: item.id,
      runId: run.id,
      sessionId: "fixture-session",
      body: "Continue the remote task?",
      now,
    });
    assert.equal((await work.authorizeAsync(event)).command.id, command.id);
    assert.equal((await work.heartbeat(firstRunner)).leases.length, 1);
    await answerQuestion(db, question.id, { answer: "Yes", answeredBy: "owner", now: now + 1 });
    assert.equal((await work.event(event)).duplicate, true);
    await assert.rejects(work.event({ ...event, sequence: 2 }), /matching open question/);
    await assert.rejects(work.authorizeAsync(event), /matching open question/);
    assert.equal((await work.heartbeat(firstRunner)).leases.length, 1);
    applyWorkItemEvent(db, item.id, "answer_received");
    assert.equal((await work.authorizeAsync(event)).command.id, command.id);
    observe(
      "a live remote task retains its lease while its own Linear question awaits an answer",
      true,
      { matchingQuestionAllowed: true, unrelatedWaitDenied: true, answeredTaskResumed: true },
    );
    now += 90_000;
    const reattached = await work.heartbeat(firstRunner);
    assert.deepEqual(reattached.fenced, []);
    assert.equal(reattached.leases[0]!.expiresAt, now + 60_000);
    now += 90_000;
    const renewedGrant = await work.issueGrant(grantInput);
    assert.equal(renewedGrant.expiresAt, now + 60_000);
    assert.equal(
      (await work.authorizeAsync({ ...event, token: renewedGrant.token })).command.id,
      command.id,
    );
    assert.equal(
      (
        await work.event({
          ...event,
          token: renewedGrant.token,
          sequence: 2,
          event: { type: "progress", text: "Back online" },
        })
      ).duplicate,
      false,
    );
    observe(
      "a lease that lapsed during a control-plane outage is renewed while its run is still current",
      true,
      { heartbeatReattached: true, grantRenewedLease: true, eventAccepted: true },
    );
    now += 15_000;
    const heartbeat = await work.heartbeat(firstRunner);
    assert.equal(heartbeat.leases[0]!.expiresAt, now + 60_000);
    const cap = command.expiresAt - 30_000;
    db.run("UPDATE runner_work SET lease_until=? WHERE run_id=?", [command.expiresAt, run.id]);
    now = cap;
    assert.equal((await work.heartbeat(firstRunner)).leases[0]!.expiresAt, command.expiresAt);
    now = command.expiresAt;
    await assert.rejects(work.issueGrant(grantInput), /command expired/);
    await assert.rejects(work.event({ ...event, sequence: 2 }), /command expired/);
    const expired = await work.heartbeat(firstRunner);
    assert.deepEqual(expired.leases, []);
    assert.equal(expired.fenced[0]!.generation, 1);
    const secondCommand = {
      ...command,
      id: workspaceId(),
      runnerId: secondRunner,
      generation: 2,
      issuedAt: now,
      expiresAt: now + 5 * 60_000,
    };
    await confirmStopped(firstRunner, command);
    await work.assign(secondCommand);
    await assert.rejects(work.issueGrant(grantInput), /fenced/);
    assert.equal((await work.commands(firstRunner)).length, 0);
    assert.equal((await work.commands(secondRunner)).length, 1);
    observe(
      "expired leases cannot be revived and reassignment fences the previous generation",
      true,
      {
        leaseExpiredAt: now,
        previousGeneration: 1,
        currentGeneration: 2,
        oldRunnerDenied: true,
        heartbeatDidNotRevive: true,
      },
    );
    const current = {
      runnerId: secondRunner,
      runId: run.id,
      commandId: secondCommand.id,
      generation: 2,
    };
    const currentGrant = await work.issueGrant(current);
    const previousCancellationId = workspaceId();
    await work.enqueue({
      id: previousCancellationId,
      type: "cancel",
      runnerId: secondRunner,
      workspaceId: workspace.id,
      runId: run.id,
      generation: 2,
      issuedAt: now,
      expiresAt: now + 60_000,
    });
    await assert.rejects(
      work.event({
        ...current,
        token: currentGrant.token,
        sequence: 1,
        event: { type: "candidate", sha: "b".repeat(40) },
      }),
      /fenced/,
    );
    const cancel = await work.commands(secondRunner);
    assert.equal(cancel.length, 1);
    assert.equal(
      JSON.parse(Buffer.from(cancel[0]!.payload, "base64url").toString("utf8")).type,
      "cancel",
    );
    observe("durable cancellation revokes grants before delivering the stop command", true, {
      lateCandidateDenied: true,
      cancelCommandPersisted: true,
      originalRunState: db
        .query<{ state: string }, [string]>("SELECT state FROM work_item WHERE id=?")
        .get(item.id)!.state,
    });
    const third = { ...secondCommand, id: workspaceId(), generation: 3 };
    await work.acknowledge(secondRunner, previousCancellationId);
    await confirmStopped(secondRunner, secondCommand);
    await work.assign(third);
    const thirdGrant = await work.issueGrant({ ...current, commandId: third.id, generation: 3 });
    await control.setStatus(principal, secondRunner, "revoked");
    await assert.rejects(
      work.event({
        ...current,
        generation: 3,
        token: thirdGrant.token,
        sequence: 1,
        event: { type: "completed" },
      }),
      /unavailable/,
    );
    await assert.rejects(work.heartbeat(secondRunner), /unavailable/);
    const replacement = { ...third, id: workspaceId(), runnerId: firstRunner, generation: 4 };
    await work.assign(replacement);
    assert.equal((await work.currentAsync(run.id, 4)).command.id, replacement.id);
    await work.finish(run.id, 4);
    for (let index = 0; index < 64; index++) {
      const blocked = insertQueuedItem(db, {
        id: `blocked-${index}`,
        now,
        sessionKey: "fixture-session",
      });
      const started = beginImplementRun(db, blocked.id, now);
      bindWorkItemRepository(db, blocked.id, repository);
      await work.assign({
        ...replacement,
        id: workspaceId(),
        itemId: blocked.id,
        runId: started.run.id,
        generation: 1,
      });
      await work.finish(started.run.id, 1);
      db.run("UPDATE work_item SET cancel_requested=1 WHERE id=?", [blocked.id]);
    }
    const probeId = workspaceId();
    await work.enqueue({
      id: probeId,
      runnerId: firstRunner,
      workspaceId: workspace.id,
      issuedAt: now,
      expiresAt: now + 60_000,
      type: "probe",
      profile: command.profile,
    });
    assert(
      (await work.commands(firstRunner)).some(
        (envelope) =>
          JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")).id === probeId,
      ),
    );
    observe(
      "runner revocation fences current work independently of an otherwise valid run grant",
      true,
      { revokedRunnerDenied: true, completionDenied: true, heartbeatDenied: true },
    );
    const contenders = Array.from({ length: 2 }, (_, index) => {
      const queued = insertQueuedItem(db, {
        id: `capacity-${index}`,
        now,
        sessionKey: "fixture-session",
      });
      const started = beginImplementRun(db, queued.id, now);
      bindWorkItemRepository(db, queued.id, repository);
      return {
        ...replacement,
        id: workspaceId(),
        itemId: queued.id,
        runId: started.run.id,
        generation: 1,
      };
    });
    const barrier = join(root, "capacity-start");
    const children = contenders.map((value, index) => {
      const commandPath = join(root, `capacity-${index}.json`);
      writeFileSync(commandPath, JSON.stringify(value), { mode: 0o600 });
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          join(import.meta.dir, "../fixtures/runner-capacity-claim.ts"),
          path,
          keyPath,
          commandPath,
          barrier,
          String(now),
        ],
        {
          env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, TMPDIR: root },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      return { child, commandPath };
    });
    const deadline = performance.now() + 10_000;
    try {
      while (!children.every(({ commandPath }) => existsSync(`${commandPath}.ready`))) {
        assert(
          performance.now() < deadline,
          "Independent admission processes did not reach the barrier",
        );
        await delay(5);
      }
      writeFileSync(barrier, "start");
      const claims = await Promise.all(
        children.map(async ({ child }) => {
          const [exit, output, error] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          assert.equal(exit, 0, error);
          return JSON.parse(output) as { accepted: boolean; commandId: string; error?: string };
        }),
      );
      writeFileSync(join(root, "capacity-claims.json"), JSON.stringify(claims, null, 2));
      assert.equal(claims.filter((value) => value.accepted).length, 1, JSON.stringify(claims));
      assert.match(claims.find((value) => !value.accepted)!.error!, /occupied/);
      const winner = contenders.find((value) =>
        claims.some((claim) => claim.accepted && claim.commandId === value.id),
      )!;
      const waiting = contenders.find((value) => value.id !== winner.id)!;
      assert.equal(
        db
          .query<{ count: number }, [string, string]>(
            "SELECT COUNT(*) AS count FROM runner_command WHERE id IN (?,?)",
          )
          .get(contenders[0]!.id, contenders[1]!.id)!.count,
        1,
      );
      assert.equal(
        db
          .query<{ count: number }, [string, string]>(
            "SELECT COUNT(*) AS count FROM runner_work WHERE run_id IN (?,?)",
          )
          .get(contenders[0]!.runId, contenders[1]!.runId)!.count,
        1,
      );
      await assert.rejects(work.assign(waiting), /occupied/);
      const helpers = createRunnerHelpers({
        db,
        keyId: "fixture",
        privateKey: keys.privateKey,
        now: () => now,
      });
      const helperInput = {
        runnerId: firstRunner,
        sessionId: "fixture-session",
        purpose: "classify" as const,
        profile: command.profile,
        prompt: "Classify this request.",
      };
      await assert.rejects(helpers.dispatch(helperInput), /busy/);
      await work.finish(winner.runId, 1);
      await work.assign(waiting);
      // The runner keeps the slot through the lease grace, so the next assignment waits it out.
      now += 60_000 + RUNNER_LEASE_GRACE_MS;
      const released = {
        ...winner,
        id: workspaceId(),
        generation: 2,
        issuedAt: now,
        expiresAt: now + 60_000,
      };
      await work.assign(released);
      await assert.rejects(
        work.issueGrant({
          runnerId: firstRunner,
          runId: waiting.runId,
          commandId: waiting.id,
          generation: 1,
        }),
        /lease expired/,
      );
      const cancellationId = workspaceId();
      await work.enqueue({
        id: cancellationId,
        type: "cancel",
        runnerId: firstRunner,
        workspaceId: workspace.id,
        runId: released.runId,
        generation: 2,
        issuedAt: now,
        expiresAt: now + 60_000,
      });
      const afterCancel = {
        ...waiting,
        id: workspaceId(),
        generation: 2,
        issuedAt: now,
        expiresAt: now + 60_000,
      };
      const commandsBeforeTeardown = db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM runner_command")
        .get()!.count;
      await assert.rejects(work.assign(afterCancel), /(?:cancellation|free slot)/);
      await assert.rejects(helpers.dispatch(helperInput), /(?:cancellation|free slot|busy)/);
      assert.equal(
        db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM runner_command").get()!
          .count,
        commandsBeforeTeardown,
      );
      const waitingForTeardown = openDatabase(path);
      try {
        const reconstructed = createRunnerWork({
          db: waitingForTeardown,
          keyId: "fixture",
          privateKey: keys.privateKey,
          eventKey: Buffer.alloc(32, 7),
          now: () => now,
        });
        await assert.rejects(reconstructed.assign(afterCancel), /(?:cancellation|free slot)/);
        await reconstructed.acknowledge(firstRunner, cancellationId);
      } finally {
        waitingForTeardown.close();
      }
      await confirmStopped(firstRunner, released);
      await confirmStopped(firstRunner, waiting);
      await work.assign(afterCancel);
      await work.finish(waiting.runId, 2);
      await control.setStatus(principal, firstRunner, "paused");
      await assert.rejects(
        work.assign({ ...afterCancel, id: workspaceId(), generation: 3 }),
        /not accepting/,
      );
      await control.setStatus(principal, firstRunner, "active");
      const helper = await helpers.dispatch(helperInput);
      const review = { ...afterCancel, type: "review" as const, id: workspaceId(), generation: 3 };
      await assert.rejects(work.assign(review), /occupied/);
      await work.heartbeat(firstRunner, 2);
      await work.assign({ ...released, id: workspaceId(), generation: 3 });
      await assert.rejects(work.assign(review), /occupied/);
      await assert.rejects(helpers.dispatch(helperInput), /busy/);
      await work.finish(released.runId, 3);
      await work.heartbeat(firstRunner, 1);
      helpers.finish(helper.command.id);
      await work.assign(review);
      const commandCount = db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM runner_command")
        .get()!.count;
      await assert.rejects(
        work.assign({ ...released, id: workspaceId(), generation: 3 }),
        /occupied/,
      );
      assert.equal(
        db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM runner_command").get()!
          .count,
        commandCount,
      );
      await work.finish(waiting.runId, 3);
      await work.assign({ ...review, id: workspaceId(), generation: 4 });
      await work.finish(waiting.runId, 4);
      await work.assign({ ...review, id: workspaceId(), generation: 5 });
      const backend = createRemoteAgentRunner({
        db,
        work,
        health: createRunnerHealth({ db, work, now: () => now }),
        results: createRunnerResults({ db, work, now: () => now }),
        now: () => now,
        pollIntervalMs: 1,
        async fetchCandidate() {
          throw new Error("Cancellation cannot publish candidates");
        },
      });
      let cancellationJoined = false;
      const cancelTask = backend.cancelItem(waiting.itemId).then(() => {
        cancellationJoined = true;
      });
      const repeatedCancelTask = backend.cancelItem(waiting.itemId);
      let retriedAfterReceipt: Promise<void> | undefined;
      const until = async (ready: () => boolean) => {
        for (let tick = 0; tick < 100 && !ready(); tick++) await delay(1);
      };
      const cancels = () =>
        db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM runner_command WHERE run_id=? AND generation=5 AND kind='cancel'",
          )
          .get(waiting.runId)!.count;
      // Cancellation reads the store before it sends the command.
      await until(() => cancels() > 0);
      assert.equal(cancels(), 1);
      const pendingCancellation = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM runner_command WHERE run_id=? AND kind='cancel' AND acknowledged_at IS NULL ORDER BY ordinal DESC LIMIT 1",
        )
        .get(waiting.runId)!;
      try {
        assert(pendingCancellation);
        await delay(5);
        assert.equal(cancellationJoined, false);
        await assert.rejects(
          work.assign({ ...review, id: workspaceId(), generation: 6 }),
          /(?:cancellation|free slot)/,
        );
        await work.acknowledge(firstRunner, pendingCancellation.id);
        let retryJoined = false;
        retriedAfterReceipt = backend.cancelItem(waiting.itemId).then(() => {
          retryJoined = true;
        });
        await delay(5);
        assert.equal(cancellationJoined, false, "a receipt acknowledgement is not termination");
        assert.equal(retryJoined, false, "a retry after receipt still waits for termination");
        await assert.rejects(
          work.assign({ ...review, id: workspaceId(), generation: 6 }),
          /(?:cancellation|free slot)/,
        );
      } finally {
        await confirmStopped(firstRunner, { ...review, id: pendingCancellation.id, generation: 5 });
        await Promise.all([cancelTask, repeatedCancelTask, retriedAfterReceipt]);
      }
      assert.equal(cancellationJoined, true);
      await work.assign({ ...review, id: workspaceId(), generation: 6 });
      await work.finish(waiting.runId, 6);
      await work.assign({ ...review, id: workspaceId(), generation: 7 });
      const unacknowledged = backend.cancelItem(waiting.itemId);
      const rejected = assert.rejects(unacknowledged, /free slot/);
      const latestCancel = () =>
        db
          .query<{ id: string; expiresAt: number }, [string]>(
            "SELECT id,expires_at AS expiresAt FROM runner_command WHERE run_id=? AND generation=7 AND kind='cancel' ORDER BY ordinal DESC LIMIT 1",
          )
          .get(waiting.runId);
      await until(() => latestCancel() !== null);
      const expiredCancel = latestCancel()!;
      now = expiredCancel.expiresAt + 1;
      await rejected;
      await assert.rejects(
        work.assign({
          ...review,
          id: workspaceId(),
          generation: 8,
          issuedAt: now,
          expiresAt: now + 60_000,
        }),
        /(?:cancellation|free slot)/,
      );
      await assert.rejects(helpers.dispatch(helperInput), /(?:cancellation|free slot|busy)/);
      const retriedCancel = backend.cancelItem(waiting.itemId);
      await until(() => latestCancel()?.id !== expiredCancel.id);
      const replacementCancellation = latestCancel()!;
      assert.notEqual(replacementCancellation.id, expiredCancel.id);
      await work.acknowledge(firstRunner, replacementCancellation.id);
      await confirmStopped(firstRunner, {
        ...review,
        id: replacementCancellation.id,
        generation: 7,
      });
      await retriedCancel;
      assert.equal(
        db
          .query<{ acknowledgedAt: number | null }, [string]>(
            "SELECT acknowledged_at AS acknowledgedAt FROM runner_command WHERE id=?",
          )
          .get(expiredCancel.id)!.acknowledgedAt,
        null,
      );
      await backend.cancelItem(waiting.itemId);
      await work.assign({
        ...review,
        id: workspaceId(),
        generation: 8,
        issuedAt: now,
        expiresAt: now + 60_000,
      });
      await work.finish(waiting.runId, 8);
      const recoveredHelper = await helpers.dispatch(helperInput);
      helpers.finish(recoveredHelper.command.id);
      observe(
        "Expired cancellation recovery joins a fresh signed command without fabricating the older acknowledgement",
        true,
        {
          oldAcknowledgement: null,
          latestAcknowledged: true,
          workAdmitted: true,
          helperAdmitted: true,
        },
      );
      observe(
        "Expired unacknowledged teardown rejects cancellation and keeps admission closed",
        true,
        { acknowledgement: false, replacementDenied: true, helperDenied: true },
      );
      observe("Coordinator cancellation joins the confirmed termination, not the receipt", true, {
        commandId: pendingCancellation.id,
        replacementDeniedBeforeTermination: true,
        joinedAfterTermination: cancellationJoined,
        repeatedCancellationUsesOneCommand: true,
      });
      observe(
        "independent control planes atomically admit one run per runner and release finished, expired and cancelled slots",
        true,
        {
          claims,
          queuedCommands: 1,
          assignments: 1,
          finishReleased: true,
          expiryReleased: true,
          expiredGrantFenced: true,
          cancellationReleased: true,
          cancellationTeardownAcknowledged: true,
          cancellationRestartGuarded: true,
          pausedDenied: true,
          helperMutualExclusion: true,
          checkCapacityEnforced: true,
          reviewUsesReleasedSlot: true,
        },
      );
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    }
  } finally {
    db.close();
  }
}

async function restartSnapshot(
  root: string,
  path: string,
  keyPath: string,
  runnerId: string,
  now: number,
): Promise<{ commands: string[] }> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "../fixtures/runner-work-restart.ts"),
      path,
      keyPath,
      runnerId,
      String(now),
    ],
    {
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, TMPDIR: root },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [exit, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(exit, 0, error);
    return JSON.parse(output);
  } finally {
    clearTimeout(timeout);
  }
}
