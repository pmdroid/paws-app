import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
} from "../../src/db";
import { createRunnerControl } from "../../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../../src/runner-identity";
import {
  verifyRunnerCommand,
  RunnerResultSchema,
  type RunnerCommand,
  type RunnerResult,
} from "../../src/runner-protocol";
import { createRunnerResults } from "../../src/runner-results";
import { createRunnerWork } from "../../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";

type Observe = (name: string, passed: boolean, observed: unknown) => void;
export async function probeRunnerResults(root: string, observe: Observe) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  try {
    const now = Date.now();
    const userId = putWorkspaceUser(db, {
      id: workspaceId(),
      linearUserId: "owner",
      name: "Owner",
      email: "owner@example.invalid",
    });
    const bootstrap = issueWorkspaceBootstrap(db, "fixture-org", now);
    const workspace = consumeWorkspaceBootstrap(db, {
      id: workspaceId(),
      organizationId: "fixture-org",
      name: "Fixture",
      userId,
      tokenHash: workspaceTokenHash(bootstrap),
      now,
    });
    const authorityRoot = join(root, "issuer");
    const authority = await initializeRunnerAuthority(authorityRoot);
    const control = createRunnerControl({
      db,
      authority,
      certificateRoot: authorityRoot,
      disconnect() {},
    });
    const client = await createRunnerKey(join(root, "client"));
    const pending = { name: "Result channel proof", csr: client.csr };
    const runnerId = (
      await control.enroll({
        ...pending,
        token: control.createEnrollment(
          { workspaceId: workspace.id, userId, role: "owner", authenticatedAt: now, teamIds: [] },
          pending,
        ).token,
      })
    ).runnerId;
    db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
    const item = insertQueuedItem(db, { id: "result-item", now, sessionKey: "result-session" });
    const { run } = beginImplementRun(db, item.id, now);
    recordLinearInstallation(db, {
      organizationId: "fixture-org",
      oauthClientId: "fixture",
      appUserId: "app",
      sessionId: "result-session",
      teamId: "team",
      observedAtMs: now,
    });
    bindLinearSessionTask(db, "result-session", item.delegationId, { actorId: "owner" });
    const repository = {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
      baseSha: "a".repeat(40),
    };
    bindWorkItemRepository(db, item.id, repository);
    db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
      workspace.id,
      "fixture/repository",
      "team",
    ]);
    const keys = generateKeyPairSync("ed25519");
    const work = createRunnerWork({ db, keyId: "fixture", privateKey: keys.privateKey });
    const results = createRunnerResults({ db, work });
    let generation = 0;
    function verify(envelope: unknown) {
      const verified = verifyRunnerCommand(envelope, {
        trustedKeys: new Map([["fixture", createPublicKey(keys.privateKey)]]),
        runnerId,
        workspaceId: workspace.id,
        now: Date.now(),
        allowedRepositories: ["fixture/repository"],
        claimCommand: () => true,
      });
      assert(verified.ok);
      return verified.command;
    }
    for (const type of ["run", "review"] as const) {
      const command: Extract<RunnerCommand, { type: "run" | "review" }> = {
        type,
        id: workspaceId(),
        runnerId,
        workspaceId: workspace.id,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 300000,
        runId: run.id,
        itemId: item.id,
        generation: ++generation,
        repository,
        profile: { agent: "codex", model: "scripted" },
        prompt: "Result fixture",
      };
      const assignment = work.assign(command);
      assert.equal(verify(assignment.envelope).type, type);
      const access = {
        runnerId,
        runId: run.id,
        generation,
        token: work.issueGrant({ runnerId, runId: run.id, commandId: command.id, generation })
          .token,
      };
      const result: RunnerResult = {
        executionId: workspaceId(),
        commandId: command.id,
        role: type === "run" ? "implementer" : "reviewer",
        stopReason: "end_turn",
        timedOut: false,
        cancelled: false,
        authRequired: false,
        agentExited: true,
        ...(type === "run" ? { candidateSha: "b".repeat(40) } : { reviewText: "[]" }),
      };
      if (type === "review") {
        assert.equal(
          RunnerResultSchema.safeParse({ ...result, reviewText: "界".repeat(400000) }).success,
          false,
        );
        assert.equal(
          RunnerResultSchema.safeParse({ ...result, reviewText: "\u0000".repeat(180000) }).success,
          false,
        );
        assert(
          RunnerResultSchema.safeParse({ ...result, reviewText: "\u0000".repeat(150000) }).success,
        );
        result.reviewText = "界".repeat(300000);
        assert(RunnerResultSchema.safeParse(result).success);
      }
      const request = (body: unknown, token = access.token) =>
        new Request(`https://runner.invalid/v1/runs/${run.id}/result`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      const first = await results.fetch(request({ generation, result }), runnerId);
      assert.equal(first!.status, 200);
      assert.deepEqual(await first!.json(), { duplicate: false });
      const replay = await results.fetch(request({ generation, result }), runnerId);
      assert.deepEqual(await replay!.json(), { duplicate: true });
      assert.deepEqual(results.read(run.id, generation, command.id), result);
      assert.equal(
        (await results.fetch(
          request({ generation, result: { ...result, sessionId: "changed" } }),
          runnerId,
        ))!.status,
        403,
      );
      assert.equal(
        (await results.fetch(request({ generation, result }, "a".repeat(43)), runnerId))!.status,
        403,
      );
      assert.equal(
        (await results.fetch(request({ generation: generation + 1, result }), runnerId))!.status,
        409,
      );
      assert.equal(
        (await results.fetch(
          request({
            generation,
            result: { ...result, role: type === "run" ? "reviewer" : "implementer" },
          }),
          runnerId,
        ))!.status,
        403,
      );
      work.event({ ...access, sequence: 1, event: { type: "progress", text: "Working" } });
      work.event({
        ...access,
        sequence: 2,
        event: { type: "question", text: "Which fixture?", options: ["A", "B"] },
      });
      assert.equal(results.events(run.id, generation, 1).length, 1);
      assert.throws(
        () => results.answer({ runId: run.id, generation, sequence: 1, answer: "A" }),
        /unavailable/,
      );
      results.answer({ runId: run.id, generation, sequence: 2, answer: "A" });
      results.answer({ runId: run.id, generation, sequence: 2, answer: "A" });
      assert.throws(
        () => results.answer({ runId: run.id, generation, sequence: 2, answer: "B" }),
        /immutable/,
      );
      const answers = await results.fetch(
        new Request(`https://runner.invalid/v1/runs/${run.id}/answers`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${access.token}` },
          body: JSON.stringify({ generation, after: 0 }),
        }),
        runnerId,
      );
      assert.equal(answers!.status, 200);
      assert.deepEqual(await answers!.json(), { answers: [{ sequence: 2, answer: "A" }] });
      assert.deepEqual(results.answers({ ...access, after: 2 }), []);
      work.event({
        ...access,
        sequence: 3,
        event: { type: "question", text: "Older question", options: ["A"] },
      });
      work.event({
        ...access,
        sequence: 4,
        event: { type: "question", text: "Newer question", options: ["B"] },
      });
      results.answer({ runId: run.id, generation, sequence: 4, answer: "B" });
      assert.deepEqual(results.answers({ ...access, after: 2 }), []);
      results.answer({ runId: run.id, generation, sequence: 3, answer: "A" });
      assert.deepEqual(results.answers({ ...access, after: 2 }), [
        { sequence: 3, answer: "A" },
        { sequence: 4, answer: "B" },
      ]);
      assert.deepEqual(results.answers({ ...access, after: 4 }), []);
      if (type === "run") {
        assert.equal(results.deliverFollowUp(item.id, "Also cover the empty state"), false);
        db.run(
          "INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,?,?)",
          [runnerId, "0.1.11", Date.now()],
        );
        assert.equal(results.deliverFollowUp(item.id, "Also cover the empty state"), false);
        db.run("UPDATE runner_host_status SET runner_version='0.1.12' WHERE runner_id=?", [
          runnerId,
        ]);
        assert.equal(results.deliverFollowUp(item.id, "Also cover the empty state"), true);
        const followUps = await results.fetch(
          new Request(`https://runner.invalid/v1/runs/${run.id}/follow-ups`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${access.token}`,
            },
            body: JSON.stringify({ generation, after: 0 }),
          }),
          runnerId,
        );
        assert.equal(followUps!.status, 200);
        assert.deepEqual(await followUps!.json(), {
          followUps: [{ sequence: 1, body: "Also cover the empty state" }],
        });
        assert.deepEqual(results.followUps({ ...access, after: 1 }), []);
      }
      let pulls = 0;
      let cancelled = false;
      const oversized = new Request(`https://runner.invalid/v1/runs/${run.id}/result`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${access.token}` },
        body: new ReadableStream(
          {
            pull(controller) {
              pulls += 1;
              controller.enqueue(new Uint8Array(600000));
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        duplex: "half",
      });
      assert.equal((await results.fetch(oversized, runnerId))!.status, 403);
      assert.equal(pulls, 2);
      assert(cancelled);
      observe(
        `${type} results and question answers retain exact replay with scoped grants and bounded requests`,
        true,
        {
          first: 200,
          replay: true,
          changedReplay: 403,
          wrongGrant: 403,
          staleGeneration: 409,
          wrongRole: 403,
          questionAnswers: [{ sequence: 2, answer: "A" }],
          outOfOrderAnswersDeliveredInQuestionOrder: true,
          ...(type === "review" ? { unicodeReviewBytes: 900000, escapedSizeChecked: true } : {}),
          oversized: { status: 403, pulls, cancelled },
        },
      );
      work.finish(run.id, generation);
    }
    db.close();
    const reopened = openDatabase(join(root, "paws.sqlite"));
    try {
      assert.equal(
        reopened.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM runner_result").get()!
          .count,
        2,
      );
      assert.equal(
        reopened
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM runner_question_answer")
          .get()!.count,
        6,
      );
      observe("result and answer receipts persist after SQLite reopen", true, {
        results: 2,
        answers: 6,
      });
    } finally {
      reopened.close();
    }
  } finally {
    db.close();
  }
}
