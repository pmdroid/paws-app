import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

export async function probeRunnerWorker(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
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
    { type: "ask_team", question: "Include archived rows?", options: ["Yes", "No"] },
    { type: "end" },
  ]);
  let answeredRequest = "";
  const previousGithub = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "synthetic-checkpoint-denied";
  const candidate = await (async () => {
    try {
      return await executeRunnerCommand({
        job: first,
        repositoryBundle,
        outputDirectory: firstOutput,
        workRoot: join(root, "work"),
        home,
        resultsGid: process.getgid!(),
        launch: firstAgent.launch,
        async answer(requestId) {
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
  assert.deepEqual(fake.env, { xaiApiKey: false, ghToken: false, sshAuthSock: false, aws: false });
  assert.equal(statSync(join(firstOutput, "result.json")).mode & 0o777, 0o640);
  assert.equal(statSync(join(firstOutput, "candidate.bundle")).mode & 0o777, 0o640);
  observe(
    "actual ACP receives no repository or cloud credentials and produces bounded group-readable results",
    true,
    fake.env,
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
    {
      type: "update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "[]" } },
    },
    { type: "end" },
  ]);
  const reviewed = await executeRunnerCommand({
    job: review,
    repositoryBundle,
    outputDirectory: reviewOutput,
    workRoot: join(root, "work"),
    home,
    resultsGid: process.getgid!(),
    launch: reviewAgent.launch,
  });
  assert.equal(reviewed.reviewText, "[]");
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
    executeRunnerCommand({
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
    executeRunnerCommand({
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
    executeRunnerCommand({
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
    const cancelled = await executeRunnerCommand({
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
  const probed = await executeRunnerCommand({
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
    const checked = await executeRunnerCommand({
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
