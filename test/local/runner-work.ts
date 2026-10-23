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
} from "../../src/db";
import { createRunnerControl } from "../../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../../src/runner-identity";
import { verifyRunnerCommand, type RunnerCommand } from "../../src/runner-protocol";
import { createRunnerWorkHttp, createRunnerWork } from "../../src/runner-work";
import { createRunnerHelpers } from "../../src/runner-helpers";
import { createRemoteAgentRunner } from "../../src/runner-backend";
import { createRunnerHealth } from "../../src/runner-health";
import { createRunnerResults } from "../../src/runner-results";
import { openQuestion, answerQuestion } from "../../src/questions";
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
  const bootstrap = issueWorkspaceBootstrap(db, "fixture-work", now);
  const workspace = consumeWorkspaceBootstrap(db, {
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
    role: "owner",
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
    const pending = await control.beginPairing({ name, csr: client.csr });
    return (await control.approvePairing(principal, pending.code)).runnerId;
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
    now: () => now,
  });
  const item = insertQueuedItem(db, { id: "fixture-item", now, sessionKey: "fixture-session" });
  const { run } = beginImplementRun(db, item.id, now);
  recordLinearInstallation(db, {
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
    assert.throws(() => work.assign(command), /repository access/);
    db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
      workspace.id,
      "fixture/repository",
      "fixture-team",
    ]);
    assert.throws(
      () =>
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
    saveSkill(db, { ...pin, name: "impeccable", version: "2.4.1", agents: ["claude", "codex"] });
    saveSkill(db, { ...pin, name: "claude-only", version: "1.0.0", agents: ["claude"] });
    saveSkill(db, { ...pin, name: "updating", version: "3.0.0", agents: ["codex"] });
    recordRunnerSkills(
      db,
      firstRunner,
      [
        { name: "claude-only", version: "1.0.0", sha256: pin.sha256, status: "installed" },
        { name: "impeccable", version: "2.4.1", sha256: pin.sha256, status: "installed" },
        { name: "updating", version: "3.0.0", sha256: pin.sha256, status: "pending" },
      ],
      now,
    );
    const assigned = work.assign({
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
    assert.equal(assigned.leaseUntil, now + 60_000);
    assert.deepEqual(runAgentSetup(db, run.id), {
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
    assert.equal(work.commands(firstRunner).length, 1);
    assert.equal(work.commands(secondRunner).length, 0);
    observe("durable work is signed and bound to an active Linear workspace repository", true, {
      signatureVerified: verified.ok,
      firstRunnerCommands: 1,
      secondRunnerCommands: 0,
      leaseMs: 60_000,
      unmappedAndChangedRepositoryDenied: true,
    });
    const before = await restartSnapshot(root, path, keyPath, firstRunner, now);
    assert.deepEqual(before.commands, [command.id]);
    work.acknowledge(firstRunner, command.id);
    work.acknowledge(firstRunner, command.id);
    assert.throws(() => work.acknowledge(secondRunner, command.id), /unknown/);
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
    assert.throws(() => work.issueGrant({ ...grantInput, runnerId: secondRunner }), /fenced/);
    assert.throws(() => work.issueGrant({ ...grantInput, commandId: "other" }), /changed/);
    const grant = work.issueGrant(grantInput);
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
    assert.equal(work.event(event).duplicate, false);
    assert.equal(work.event(event).duplicate, true);
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

    assert.throws(
      () => work.event({ ...event, event: { type: "progress", text: "Changed" } }),
      /changed its payload/,
    );
    assert.throws(() => work.event({ ...event, sequence: 3 }), /gap/);
    assert.throws(() => work.event({ ...event, token: "wrong", sequence: 2 }), /grant/);
    assert.throws(() => work.event({ ...event, runnerId: secondRunner, sequence: 2 }), /fenced/);
    assert.equal(work.authorize(event).command.id, command.id);
    assert.throws(() => work.authorize({ ...event, token: "wrong" }), /grant/);
    db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
      workspace.id,
      "fixture/other",
      "fixture-team",
    ]);
    db.run(
      "UPDATE work_item_repository SET repo='other',remote_url='https://github.com/fixture/other.git' WHERE item_id=?",
      [item.id],
    );
    assert.throws(() => work.authorize(event), /repository binding changed/);
    assert.throws(() => work.event({ ...event, sequence: 2 }), /repository binding changed/);
    assert.throws(() => work.issueGrant(grantInput), /repository binding changed/);
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
    assert.throws(() => work.authorize(event), /matching open question/);
    assert.equal(work.heartbeat(firstRunner).leases.length, 1);
    const question = openQuestion(db, {
      itemId: item.id,
      runId: run.id,
      sessionId: "fixture-session",
      body: "Continue the remote task?",
      now,
    });
    assert.equal(work.authorize(event).command.id, command.id);
    assert.equal(work.heartbeat(firstRunner).leases.length, 1);
    answerQuestion(db, question.id, { answer: "Yes", answeredBy: "owner", now: now + 1 });
    assert.equal(work.event(event).duplicate, true);
    assert.throws(() => work.event({ ...event, sequence: 2 }), /matching open question/);
    assert.throws(() => work.authorize(event), /matching open question/);
    assert.equal(work.heartbeat(firstRunner).leases.length, 1);
    applyWorkItemEvent(db, item.id, "answer_received");
    assert.equal(work.authorize(event).command.id, command.id);
    observe(
      "a live remote task retains its lease while its own Linear question awaits an answer",
      true,
      { matchingQuestionAllowed: true, unrelatedWaitDenied: true, answeredTaskResumed: true },
    );
    now += 90_000;
    const reattached = work.heartbeat(firstRunner);
    assert.deepEqual(reattached.fenced, []);
    assert.equal(reattached.leases[0]!.expiresAt, now + 60_000);
    now += 90_000;
    const renewedGrant = work.issueGrant(grantInput);
    assert.equal(renewedGrant.expiresAt, now + 60_000);
    assert.equal(work.authorize({ ...event, token: renewedGrant.token }).command.id, command.id);
    assert.equal(
      work.event({
        ...event,
        token: renewedGrant.token,
        sequence: 2,
        event: { type: "progress", text: "Back online" },
      }).duplicate,
      false,
    );
    observe(
      "a lease that lapsed during a control-plane outage is renewed while its run is still current",
      true,
      { heartbeatReattached: true, grantRenewedLease: true, eventAccepted: true },
    );
    now += 15_000;
    const heartbeat = work.heartbeat(firstRunner);
    assert.equal(heartbeat.leases[0]!.expiresAt, now + 60_000);
    const cap = command.expiresAt - 30_000;
    db.run("UPDATE runner_work SET lease_until=? WHERE run_id=?", [command.expiresAt, run.id]);
    now = cap;
    assert.equal(work.heartbeat(firstRunner).leases[0]!.expiresAt, command.expiresAt);
    now = command.expiresAt;
    assert.throws(() => work.issueGrant(grantInput), /command expired/);
    assert.throws(() => work.event({ ...event, sequence: 2 }), /command expired/);
    const expired = work.heartbeat(firstRunner);
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
    work.assign(secondCommand);
    assert.throws(() => work.issueGrant(grantInput), /fenced/);
    assert.equal(work.commands(firstRunner).length, 0);
    assert.equal(work.commands(secondRunner).length, 1);
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
    const currentGrant = work.issueGrant(current);
    const previousCancellationId = workspaceId();
    work.enqueue({
      id: previousCancellationId,
      type: "cancel",
      runnerId: secondRunner,
      workspaceId: workspace.id,
      runId: run.id,
      generation: 2,
      issuedAt: now,
      expiresAt: now + 60_000,
    });
    assert.throws(
      () =>
        work.event({
          ...current,
          token: currentGrant.token,
          sequence: 1,
          event: { type: "candidate", sha: "b".repeat(40) },
        }),
      /fenced/,
    );
    const cancel = work.commands(secondRunner);
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
    work.acknowledge(secondRunner, previousCancellationId);
    work.assign(third);
    const thirdGrant = work.issueGrant({ ...current, commandId: third.id, generation: 3 });
    control.setStatus(principal, secondRunner, "revoked");
    assert.throws(
      () =>
        work.event({
          ...current,
          generation: 3,
          token: thirdGrant.token,
          sequence: 1,
          event: { type: "completed" },
        }),
      /unavailable/,
    );
    assert.throws(() => work.heartbeat(secondRunner), /unavailable/);
    const replacement = { ...third, id: workspaceId(), runnerId: firstRunner, generation: 4 };
    work.assign(replacement);
    assert.equal(work.current(run.id, 4).command.id, replacement.id);
    work.finish(run.id, 4);
    for (let index = 0; index < 64; index++) {
      const blocked = insertQueuedItem(db, {
        id: `blocked-${index}`,
        now,
        sessionKey: "fixture-session",
      });
      const started = beginImplementRun(db, blocked.id, now);
      bindWorkItemRepository(db, blocked.id, repository);
      work.assign({
        ...replacement,
        id: workspaceId(),
        itemId: blocked.id,
        runId: started.run.id,
        generation: 1,
      });
      work.finish(started.run.id, 1);
      db.run("UPDATE work_item SET cancel_requested=1 WHERE id=?", [blocked.id]);
    }
    const probeId = workspaceId();
    work.enqueue({
      id: probeId,
      runnerId: firstRunner,
      workspaceId: workspace.id,
      issuedAt: now,
      expiresAt: now + 60_000,
      type: "probe",
      profile: command.profile,
    });
    assert(
      work
        .commands(firstRunner)
        .some(
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
      assert.throws(() => work.assign(waiting), /occupied/);
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
      assert.throws(() => helpers.dispatch(helperInput), /busy/);
      work.finish(winner.runId, 1);
      work.assign(waiting);
      now += 60_000;
      const released = {
        ...winner,
        id: workspaceId(),
        generation: 2,
        issuedAt: now,
        expiresAt: now + 60_000,
      };
      work.assign(released);
      assert.throws(
        () =>
          work.issueGrant({
            runnerId: firstRunner,
            runId: waiting.runId,
            commandId: waiting.id,
            generation: 1,
          }),
        /lease expired/,
      );
      const cancellationId = workspaceId();
      work.enqueue({
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
      assert.throws(() => work.assign(afterCancel), /cancellation/);
      assert.throws(() => helpers.dispatch(helperInput), /cancellation/);
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
          now: () => now,
        });
        assert.throws(() => reconstructed.assign(afterCancel), /cancellation/);
        reconstructed.acknowledge(firstRunner, cancellationId);
      } finally {
        waitingForTeardown.close();
      }
      work.assign(afterCancel);
      work.finish(waiting.runId, 2);
      control.setStatus(principal, firstRunner, "paused");
      assert.throws(
        () => work.assign({ ...afterCancel, id: workspaceId(), generation: 3 }),
        /not accepting/,
      );
      control.setStatus(principal, firstRunner, "active");
      const helper = helpers.dispatch(helperInput);
      const review = { ...afterCancel, type: "review" as const, id: workspaceId(), generation: 3 };
      assert.throws(() => work.assign(review), /occupied/);
      work.heartbeat(firstRunner, 2);
      work.assign({ ...released, id: workspaceId(), generation: 3 });
      assert.throws(() => work.assign(review), /occupied/);
      assert.throws(() => helpers.dispatch(helperInput), /busy/);
      work.finish(released.runId, 3);
      work.heartbeat(firstRunner, 1);
      helpers.finish(helper.command.id);
      work.assign(review);
      const commandCount = db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM runner_command")
        .get()!.count;
      assert.throws(
        () => work.assign({ ...released, id: workspaceId(), generation: 3 }),
        /occupied/,
      );
      assert.equal(
        db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM runner_command").get()!
          .count,
        commandCount,
      );
      work.finish(waiting.runId, 3);
      work.assign({ ...review, id: workspaceId(), generation: 4 });
      work.finish(waiting.runId, 4);
      work.assign({ ...review, id: workspaceId(), generation: 5 });
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
      assert.equal(
        db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM runner_command WHERE run_id=? AND generation=5 AND kind='cancel'",
          )
          .get(waiting.runId)!.count,
        1,
      );
      const pendingCancellation = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM runner_command WHERE run_id=? AND kind='cancel' AND acknowledged_at IS NULL ORDER BY ordinal DESC LIMIT 1",
        )
        .get(waiting.runId)!;
      try {
        assert(pendingCancellation);
        await delay(5);
        assert.equal(cancellationJoined, false);
        assert.throws(
          () => work.assign({ ...review, id: workspaceId(), generation: 6 }),
          /cancellation/,
        );
      } finally {
        work.acknowledge(firstRunner, pendingCancellation.id);
        await Promise.all([cancelTask, repeatedCancelTask]);
      }
      assert.equal(cancellationJoined, true);
      work.assign({ ...review, id: workspaceId(), generation: 6 });
      work.finish(waiting.runId, 6);
      work.assign({ ...review, id: workspaceId(), generation: 7 });
      const unacknowledged = backend.cancelItem(waiting.itemId);
      const rejected = assert.rejects(unacknowledged, /teardown is not acknowledged/);
      const expiredCancel = db
        .query<{ id: string; expiresAt: number }, [string]>(
          "SELECT id,expires_at AS expiresAt FROM runner_command WHERE run_id=? AND generation=7 AND kind='cancel' ORDER BY ordinal DESC LIMIT 1",
        )
        .get(waiting.runId)!;
      now = expiredCancel.expiresAt + 1;
      await rejected;
      assert.throws(
        () =>
          work.assign({
            ...review,
            id: workspaceId(),
            generation: 8,
            issuedAt: now,
            expiresAt: now + 60_000,
          }),
        /cancellation/,
      );
      assert.throws(() => helpers.dispatch(helperInput), /cancellation/);
      const retriedCancel = backend.cancelItem(waiting.itemId);
      const replacementCancellation = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM runner_command WHERE run_id=? AND generation=7 AND kind='cancel' ORDER BY ordinal DESC LIMIT 1",
        )
        .get(waiting.runId)!;
      assert.notEqual(replacementCancellation.id, expiredCancel.id);
      work.acknowledge(firstRunner, replacementCancellation.id);
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
      work.assign({
        ...review,
        id: workspaceId(),
        generation: 8,
        issuedAt: now,
        expiresAt: now + 60_000,
      });
      work.finish(waiting.runId, 8);
      const recoveredHelper = helpers.dispatch(helperInput);
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
      observe("Coordinator cancellation joins the persisted daemon teardown acknowledgment", true, {
        commandId: pendingCancellation.id,
        replacementDeniedBeforeAck: true,
        joinedAfterAck: cancellationJoined,
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
