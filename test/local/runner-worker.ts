import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../../src/acp";
import { publishRunnerAnswer, readRunnerAnswer } from "../../src/runner-answers";
import { publishRunnerJob, type RunnerJob, type RunnerSpool } from "../../src/runner-execution";
import { executeRunnerCommand } from "../../src/runner-worker";
import { RunnerArtifactSchema } from "../../src/runner-protocol";

export async function probeRunnerWorker(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
  execute: typeof executeRunnerCommand = executeRunnerCommand,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const home = join(root, "home");
  const repository = join(root, "repository");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(repository, { mode: 0o700 });
  const gitEnv = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const invoke = (args: string[]) => git(args, { env: gitEnv });
  await invoke(["init", "-b", "main", repository]);
  writeFileSync(join(repository, "base.txt"), "exact assigned base\n");
  await invoke(["-C", repository, "add", "."]);
  await invoke(["-C", repository, "commit", "-m", "base"]);
  const baseSha = (await invoke(["-C", repository, "rev-parse", "HEAD"])).trim();
  writeFileSync(join(repository, "later.txt"), "must not enter assigned checkout\n");
  await invoke(["-C", repository, "add", "."]);
  await invoke(["-C", repository, "commit", "-m", "later"]);
  const repositoryBundle = join(root, "repository.bundle");
  await invoke(["-C", repository, "bundle", "create", repositoryBundle, "--all"]);
  chmodSync(repositoryBundle, 0o600);
  const now = Date.now();
  function job(index: number, type: "run" | "review" = "run"): RunnerJob {
    return {
      executionId: `01J0000000000000000000000${index}`,
      command: {
        id: randomUUID(),
        runnerId: "runner",
        workspaceId: "workspace",
        issuedAt: now,
        expiresAt: now + 60_000,
        type,
        runId: randomUUID(),
        itemId: randomUUID(),
        generation: 1,
        repository: {
          owner: "fixture",
          repo: "repo",
          remoteUrl: "https://github.com/fixture/repo.git",
          baseSha,
        },
        profile: { agent: "claude", model: "fixture-model" },
        prompt: "Implement the assigned task.",
      },
    };
  }
  const spool: RunnerSpool = {
    root: join(root, "spool"),
    runnerUid: process.getuid!(),
    agentGid: process.getgid!(),
  };
  mkdirSync(spool.root, { mode: 0o750 });
  chmodSync(spool.root, 0o750);
  function launch(index: number, steps: unknown[]) {
    const script = join(root, `script-${index}.json`);
    const result = join(root, `agent-${index}.json`);
    writeFileSync(script, JSON.stringify({ model: "fixture-model", steps }));
    return {
      result,
      launch: {
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../../src/acp/testing/fake-agent.ts", import.meta.url)),
          result,
          script,
        ],
        env: {
          ...gitEnv,
          GH_TOKEN: "synthetic-denied",
          SSH_AUTH_SOCK: "/synthetic-denied",
          AWS_ACCESS_KEY_ID: "synthetic-denied",
        },
      },
    };
  }
  function output(index: number) {
    const path = join(root, `output-${index}`);
    mkdirSync(path, { mode: 0o750 });
    return path;
  }
  const first = job(1);
  publishRunnerJob(spool, first, { repositoryBundle });
  const firstOutput = output(1);
  const checkpointEnvironment = join(root, "checkpoint-env.json");
  const monitor = fileURLToPath(new URL("../fixtures/runner-checkpoint-env.py", import.meta.url));
  const firstAgent = launch(1, [
    ...Array.from({ length: 3 }, () => ({
      type: "update",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "x".repeat(200_000) },
      },
    })),
    {
      type: "fs_write",
      path: ".git/config",
      content: `[core]\nrepositoryformatversion = 0\nbare = false\nhooksPath = /dev/null\nfsmonitor = /usr/bin/python3 ${monitor} ${checkpointEnvironment}\n`,
    },
    { type: "fs_write", path: "implemented.txt", content: "candidate\n" },
    { type: "fs_write", path: "report.txt", content: "actual worker artifact\n" },
    { type: "publish_artifact", path: "report.txt", displayName: "Report", attachToIssue: true },
    { type: "ask_team", question: "Include archived rows?", options: ["Yes", "No"] },
    { type: "end" },
  ]);
  let answeredRequest = "";
  const snapshots: { id: string; path: string; attachToIssue: boolean }[] = [];
  function artifactAnswer(directory: string, requestId: string) {
    const record = readFileSync(join(directory, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((event) => event.type === "artifact" && event.requestId === requestId);
    if (!record) return null;
    const artifact = RunnerArtifactSchema.parse(record.artifact);
    assert.equal(artifact.id, requestId);
    const path = join(directory, `artifact-${artifact.id}.bytes`);
    const bytes = readFileSync(path);
    assert.equal(bytes.length, artifact.sizeBytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
    const info = statSync(path);
    assert.equal(info.uid, process.getuid!());
    assert.equal(info.gid, process.getgid!());
    assert.equal(info.mode & 0o777, 0o640);
    snapshots.push(artifact);
    return JSON.stringify({ url: `https://linear.app/artifact/${artifact.id}` });
  }
  const previousGithub = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "synthetic-checkpoint-denied";
  const candidate = await (async () => {
    try {
      return await execute({
        job: first,
        repositoryBundle,
        outputDirectory: firstOutput,
        workRoot: join(root, "work"),
        home,
        resultsGid: process.getgid!(),
        launch: firstAgent.launch,
        async answer(requestId) {
          const publication = artifactAnswer(firstOutput, requestId);
          if (publication) {
            writeFileSync(
              join(root, "work", first.executionId, "report.txt"),
              "changed after snapshot\n",
            );
            publishRunnerAnswer(spool, first.executionId, { requestId, answer: publication });
            return readRunnerAnswer(spool, first.executionId, requestId)!;
          }
          answeredRequest = requestId;
          assert.equal(readRunnerAnswer(spool, first.executionId, requestId), null);
          publishRunnerAnswer(spool, first.executionId, { requestId, answer: "Yes" });
          publishRunnerAnswer(spool, first.executionId, { requestId, answer: "Yes" });
          assert.throws(
            () => publishRunnerAnswer(spool, first.executionId, { requestId, answer: "No" }),
            /immutable/,
          );
          return readRunnerAnswer(spool, first.executionId, requestId)!;
        },
      });
    } finally {
      if (previousGithub === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousGithub;
    }
  })();
  assert.equal(JSON.parse(readFileSync(checkpointEnvironment, "utf8")).github, false);
  assert.equal(candidate.run.stopReason, "end_turn");
  assert(candidate.candidateSha && candidate.candidateSha !== baseSha);
  const acquired = join(root, "acquired");
  await invoke(["clone", repository, acquired]);
  await invoke(["-C", acquired, "fetch", join(firstOutput, "candidate.bundle"), "HEAD"]);
  assert.equal(
    (await invoke(["-C", acquired, "rev-parse", "FETCH_HEAD"])).trim(),
    candidate.candidateSha,
  );
  await invoke(["-C", acquired, "merge-base", "--is-ancestor", baseSha, candidate.candidateSha]);
  assert.equal(
    await invoke(["-C", acquired, "show", `${candidate.candidateSha}:implemented.txt`]),
    "candidate\n",
  );
  await assert.rejects(invoke(["-C", acquired, "show", `${candidate.candidateSha}:later.txt`]));
  observe(
    "worker checks out the exact assigned base and returns a real Git candidate bundle",
    true,
    { baseSha, candidateSha: candidate.candidateSha },
  );
  const fake = JSON.parse(readFileSync(firstAgent.result, "utf8"));
  assert.equal(fake.artifact.ok, true);
  assert.equal(snapshots[0]?.path, "report.txt");
  assert.equal(snapshots[0]?.attachToIssue, true);
  assert.equal(
    readFileSync(join(firstOutput, `artifact-${snapshots[0]!.id}.bytes`), "utf8"),
    "actual worker artifact\n",
  );
  observe(
    "actual run ACP snapshots artifact bytes before receiving its request-bound publication URL",
    true,
    { artifact: snapshots[0], response: fake.artifact.text },
  );
  assert.deepEqual(fake.env, { xaiApiKey: false, ghToken: false, sshAuthSock: false, aws: false });
  assert.equal(statSync(join(firstOutput, "result.json")).mode & 0o777, 0o640);
  assert.equal(statSync(join(firstOutput, "candidate.bundle")).mode & 0o777, 0o640);
  observe(
    "actual ACP receives no repository or cloud credentials and produces bounded group-readable results",
    true,
    fake.env,
  );
  const retainedJournal = readFileSync(join(firstOutput, "events.jsonl"));
  const retainedResult = readFileSync(join(firstOutput, "result.json"));
  await assert.rejects(
    execute({
      job: first,
      repositoryBundle,
      outputDirectory: firstOutput,
      workRoot: join(root, "work"),
      home,
      resultsGid: process.getgid!(),
      launch: firstAgent.launch,
    }),
    /EEXIST|already exists/,
  );
  assert.deepEqual(readFileSync(join(firstOutput, "events.jsonl")), retainedJournal);
  assert.deepEqual(readFileSync(join(firstOutput, "result.json")), retainedResult);
  const resultOnlyOutput = output(31);
  writeFileSync(join(resultOnlyOutput, "result.json"), "retained result\n");
  const resultOnlyAgent = launch(30, [{ type: "end" }]);
  await assert.rejects(
    execute({
      job: job(3),
      repositoryBundle,
      outputDirectory: resultOnlyOutput,
      workRoot: join(root, "work"),
      home,
      resultsGid: process.getgid!(),
      launch: resultOnlyAgent.launch,
    }),
    /Runner result already exists/,
  );
  assert.equal(readFileSync(join(resultOnlyOutput, "result.json"), "utf8"), "retained result\n");
  assert.throws(() => readFileSync(join(resultOnlyOutput, ".worker-claim")), { code: "ENOENT" });
  const claimOnlyOutput = output(32);
  writeFileSync(join(claimOnlyOutput, ".worker-claim"), "consumed execution\n");
  await assert.rejects(
    execute({
      job: job(3),
      repositoryBundle,
      outputDirectory: claimOnlyOutput,
      workRoot: join(root, "work"),
      home,
      resultsGid: process.getgid!(),
      launch: resultOnlyAgent.launch,
    }),
    /EEXIST/,
  );
  assert.equal(
    readFileSync(join(claimOnlyOutput, ".worker-claim"), "utf8"),
    "consumed execution\n",
  );
  assert.throws(() => readFileSync(join(claimOnlyOutput, "events.jsonl")), { code: "ENOENT" });
  const legacyOutput = output(30);
  writeFileSync(join(legacyOutput, "events.jsonl"), "retained journal\n");
  await assert.rejects(
    execute({
      job: job(1),
      repositoryBundle,
      outputDirectory: legacyOutput,
      workRoot: join(root, "work"),
      home,
      resultsGid: process.getgid!(),
      launch: firstAgent.launch,
    }),
    /Runner journal already exists/,
  );
  assert.equal(readFileSync(join(legacyOutput, "events.jsonl"), "utf8"), "retained journal\n");
  assert.throws(() => readFileSync(join(legacyOutput, ".worker-claim")), { code: "ENOENT" });
  observe(
    "permanent worker claims reject duplicate execution and preserve existing journals and final results",
    true,
    { duplicateDenied: true, legacyJournalPreserved: true, legacyResultPreserved: true },
  );
  assert.equal(fake.askTeam.ok, true);
  assert.match(fake.askTeam.text, /Yes/);
  const journal = readFileSync(join(firstOutput, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(journal.some((event) => event.type === "question" && event.requestId === answeredRequest));
  assert.equal(readRunnerAnswer(spool, first.executionId, randomUUID()), null);
  observe(
    "genuine ACP ask_team resumes only from its immutable request-bound daemon answer",
    true,
    { requestId: answeredRequest, answer: "Yes" },
  );
  const wrongId = randomUUID();
  const answerDirectory = join(spool.root, first.executionId, "answers");
  symlinkSync(join(answerDirectory, answeredRequest), join(answerDirectory, wrongId));
  assert.throws(() => readRunnerAnswer(spool, first.executionId, wrongId));
  const linkedId = randomUUID();
  mkdirSync(join(answerDirectory, linkedId), { mode: 0o750 });
  linkSync(
    join(answerDirectory, answeredRequest, "answer.json"),
    join(answerDirectory, linkedId, "answer.json"),
  );
  assert.throws(() => readRunnerAnswer(spool, first.executionId, linkedId), /Unsafe/);
  observe("answer files reject symlinks, hardlinks, replacement and unrelated request IDs", true, {
    symlinkDenied: true,
    hardlinkDenied: true,
  });
  const review = job(2, "review");
  const reviewOutput = output(2);
  const reviewAgent = launch(2, [
    { type: "fs_write", path: "base.txt", content: "illegal change\n" },
    { type: "publish_artifact", path: "base.txt", displayName: "Review evidence" },
    {
      type: "update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "[]" } },
    },
    { type: "end" },
  ]);
  const reviewed = await execute({
    job: review,
    repositoryBundle,
    outputDirectory: reviewOutput,
    workRoot: join(root, "work"),
    home,
    resultsGid: process.getgid!(),
    launch: reviewAgent.launch,
    async answer(requestId) {
      const answer = artifactAnswer(reviewOutput, requestId);
      assert(answer);
      return { answer };
    },
  });
  assert.equal(reviewed.reviewText, "[]");
  assert.equal(JSON.parse(readFileSync(reviewAgent.result, "utf8")).artifact.ok, true);
  assert.equal(snapshots[1]?.path, "base.txt");
  assert.equal(snapshots[1]?.attachToIssue, false);
  assert.equal(
    readFileSync(join(reviewOutput, `artifact-${snapshots[1]!.id}.bytes`), "utf8"),
    "exact assigned base\n",
  );
  observe(
    "read-only review ACP publishes assigned evidence without changing the repository",
    true,
    { artifact: snapshots[1] },
  );
  assert.equal(reviewed.candidateSha, undefined);
  assert.equal(JSON.parse(readFileSync(reviewAgent.result, "utf8")).fs[0].ok, false);
  assert.equal(
    readFileSync(join(root, "work", review.executionId, "base.txt"), "utf8"),
    "exact assigned base\n",
  );
  observe(
    "remote review uses real read-only ACP and returns review text without publishing a candidate",
    true,
    { reviewText: reviewed.reviewText, writeDenied: true },
  );
  for (const [index, receipt] of [
    [6, "{}"],
    [7, JSON.stringify({ url: "file:///private/report" })],
  ] as const) {
    const invalidOutput = output(index + 100);
    const invalidJob = job(index, "review");
    invalidJob.executionId = invalidJob.executionId.slice(0, -1) + (index === 6 ? "A" : "B");
    const invalidAgent = launch(index + 100, [
      { type: "publish_artifact", path: "base.txt" },
      { type: "end" },
    ]);
    await execute({
      job: invalidJob,
      repositoryBundle,
      outputDirectory: invalidOutput,
      workRoot: join(root, "work"),
      home,
      resultsGid: process.getgid!(),
      launch: invalidAgent.launch,
      async answer(requestId) {
        assert(artifactAnswer(invalidOutput, requestId));
        return { answer: receipt };
      },
    });
    const publication = JSON.parse(readFileSync(invalidAgent.result, "utf8")).artifact;
    assert.equal(publication.ok, false);
    assert.match(publication.error, /artifact/);
    assert.equal(publication.text, undefined);
  }
  observe("artifact tools reject malformed and non-HTTPS publication receipts", true, {
    denied: 2,
  });
  const waitingOutput = output(10);
  const waitingAgent = launch(10, [
    { type: "publish_artifact", path: "base.txt" },
    { type: "end" },
  ]);
  const waitingAbort = new AbortController();
  const waiting = await execute({
    job: job(0),
    repositoryBundle,
    outputDirectory: waitingOutput,
    workRoot: join(root, "work"),
    home,
    resultsGid: process.getgid!(),
    launch: waitingAgent.launch,
    signal: waitingAbort.signal,
    async answer(requestId) {
      const answer = artifactAnswer(waitingOutput, requestId);
      assert(answer);
      waitingAbort.abort();
      return { answer };
    },
  });
  assert.equal(waiting.run.cancelled, true);
  assert.equal(waiting.run.agentExited, true);
  assert.equal(waiting.candidateSha, undefined);
  observe(
    "cancelling artifact publication joins the ACP process without publishing a candidate",
    true,
    { cancelled: waiting.run.cancelled, agentExited: waiting.run.agentExited },
  );
  const chunk = {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "x".repeat(200_000) },
  };
  const oversizedAgent = launch(8, [
    { type: "update", update: chunk },
    { type: "update", update: chunk },
    { type: "end", updatesAfterResponse: [chunk] },
  ]);
  const oversizedOutput = output(8);
  await assert.rejects(
    execute({
      job: job(8, "review"),
      repositoryBundle,
      outputDirectory: oversizedOutput,
      workRoot: join(root, "work"),
      home,
      resultsGid: process.getgid!(),
      launch: oversizedAgent.launch,
    }),
    /Runner response exceeds size limit/,
  );
  assert.throws(() => readFileSync(join(oversizedOutput, "result.json")));
  const journalLimitAgent = launch(9, [
    { type: "update", update: chunk },
    {
      type: "end",
      updatesAfterResponse: [{ ...chunk, content: { type: "text", text: "x".repeat(400_000) } }],
    },
  ]);
  const journalLimitOutput = output(9);
  await assert.rejects(
    execute({
      job: job(9, "review"),
      repositoryBundle,
      outputDirectory: journalLimitOutput,
      workRoot: join(root, "work"),
      home,
      resultsGid: process.getgid!(),
      launch: journalLimitAgent.launch,
    }),
    /Runner (response|event journal) exceeds size limit/,
  );
  assert.throws(() => readFileSync(join(journalLimitOutput, "result.json")));
  const missing = job(3);
  if (missing.command.type !== "run") throw new Error("Expected run");
  missing.command.repository.baseSha = "f".repeat(40);
  const missingAgent = launch(3, [{ type: "end" }]);
  await assert.rejects(
    execute({
      job: missing,
      repositoryBundle,
      outputDirectory: output(3),
      workRoot: join(root, "work"),
      home,
      resultsGid: process.getgid!(),
      launch: missingAgent.launch,
    }),
  );
  assert.throws(() => readFileSync(missingAgent.result));
  observe(
    "missing assigned base fails before starting an agent instead of falling back to main",
    true,
    { agentStarted: false },
  );
  const abort = new AbortController();
  const cancelledAgent = launch(4, [{ type: "hang" }]);
  const cancelOutput = output(4);
  const timer = setTimeout(() => abort.abort(), 150);
  try {
    const cancelled = await execute({
      job: job(4),
      repositoryBundle,
      outputDirectory: cancelOutput,
      workRoot: join(root, "work"),
      home,
      resultsGid: process.getgid!(),
      launch: cancelledAgent.launch,
      signal: abort.signal,
    });
    assert.equal(cancelled.run.cancelled, true);
    assert.equal(cancelled.run.agentExited, true);
    assert.equal(cancelled.candidateSha, undefined);
    assert.throws(() => readFileSync(join(cancelOutput, "candidate.bundle")));
    observe(
      "cancellation waits for the actual ACP process to exit and publishes no candidate",
      true,
      { cancelled: cancelled.run.cancelled, agentExited: cancelled.run.agentExited },
    );
  } finally {
    clearTimeout(timer);
  }
  const probe = job(5);
  probe.command = {
    id: randomUUID(),
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: now,
    expiresAt: now + 60_000,
    type: "probe",
    profile: { agent: "claude", model: "fixture-model" },
  };
  const probeAgent = launch(5, [{ type: "hang" }]);
  const probed = await execute({
    job: probe,
    outputDirectory: output(5),
    workRoot: join(root, "work"),
    home,
    resultsGid: process.getgid!(),
    launch: probeAgent.launch,
  });
  assert.equal(probed.run.stopReason, "end_turn");
  assert.equal(probed.run.identity?.model, "fixture-model");
  const probeCalls = JSON.parse(readFileSync(probeAgent.result, "utf8")).methods as string[];
  assert(probeCalls.includes("initialize") && probeCalls.includes("session/new"));
  assert(!probeCalls.includes("session/prompt"));
  assert.equal(probed.candidateSha, undefined);
  observe(
    "connection probe initializes the real ACP adapter and confirms its model without starting a task",
    true,
    { model: probed.run.identity?.model, prompted: false },
  );
  const loginChecks: { agent: string; authenticated: boolean; method: string }[] = [];
  for (const [index, agent, authenticated] of [
    [6, "claude", true],
    [7, "codex", false],
  ] as const) {
    const loginJob = job(index);
    loginJob.command = {
      id: randomUUID(),
      runnerId: "runner",
      workspaceId: "workspace",
      issuedAt: now,
      expiresAt: now + 60_000,
      type: "login_check",
      agent,
    };
    const loginAgent = launch(index, [{ type: "hang" }]);
    const loginOutput = output(index);
    const secret = "synthetic-provider-status-token";
    const checked = await execute({
      job: loginJob,
      outputDirectory: loginOutput,
      workRoot: join(root, "work"),
      home,
      resultsGid: process.getgid!(),
      launch: loginAgent.launch,
      async loginCommand(command, args, env) {
        assert.equal(command, agent);
        assert.deepEqual(args, agent === "claude" ? ["auth", "status"] : ["login", "status"]);
        assert.equal(env.HOME, home);
        assert.equal(env.GH_TOKEN, undefined);
        assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
        return {
          exitCode: authenticated ? 0 : 1,
          stdout: JSON.stringify({ authMethod: "claude.ai", token: secret }),
          stderr: secret,
        };
      },
    });
    assert.equal(checked.login?.authenticated, authenticated);
    assert.equal(checked.login?.method, authenticated ? "subscription" : "none");
    assert.equal(
      checked.login?.command,
      agent === "claude" ? "claude auth login" : "codex login --device-auth",
    );
    assert(!readFileSync(join(loginOutput, "result.json"), "utf8").includes(secret));
    assert(!readFileSync(join(loginOutput, "events.jsonl"), "utf8").includes(secret));
    loginChecks.push({ agent, authenticated, method: checked.login!.method });
  }
  observe(
    "login health distinguishes an initialized adapter from provider authentication without copying credential output",
    true,
    loginChecks,
  );
}
