import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { createFakeGitHub } from "../../src/github";
import { initializeRunnerCoordinator, openRunnerCoordinator } from "../../src/runner-coordinator";
import { RunnerRequestError, openRunnerDaemon } from "../../src/runner-daemon";
import {
  createRunnerBrokerClient,
  readRunnerJob,
  readRunnerResultFile,
  runnerRepositoryBundlePath,
} from "../../src/runner-execution";
import { readRunnerAnswer } from "../../src/runner-answers";
import { openRunnerRuntime } from "../../src/runner-runtime";
import { executeRunnerCommand } from "../../src/runner-worker";
import type { WorkCommand } from "../../src/runner-journal";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";

const mode = process.argv[2]!;
const root = process.argv[3]!;
const server = join(root, "server");
const dbPath = join(server, "paws.db");
type Fixture = { browserPort: number; runnerPort: number; commands: WorkCommand[]; base: string };
const configuration = () => JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as Fixture;
const tls = () => ({
  key: readFileSync(join(server, "server.key"), "utf8"),
  cert: readFileSync(join(server, "server.pem"), "utf8"),
});
const daemonOptions = (config: Fixture) => ({
  root: join(root, "daemon"),
  controlPlaneUrl: `https://127.0.0.1:${config.browserPort}`,
  runnerApiUrl: `https://127.0.0.1:${config.runnerPort}`,
  serverCa: readFileSync(join(root, "server.pem"), "utf8"),
  allowedRepositories: ["fixture/repository"],
});
function git(args: string[], cwd = root) {
  const child = Bun.spawnSync(["/usr/bin/git", "-c", "safe.directory=*", ...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: root,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(child.exitCode, 0, child.stderr.toString());
  return child.stdout.toString().trim();
}
const transcriptObjects = {
  async write(key: string, bytes: Blob | ReadableStream<Uint8Array>) {
    const path = join(server, "objects", key);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    await Bun.write(path, await new Response(bytes).arrayBuffer());
    chmodSync(path, 0o600);
  },
  read: (key: string) => Bun.file(join(server, "objects", key)).stream(),
  uri: (key: string) => `s3://fixture-transcripts/${key}`,
};
const repositoryAccess = {
  github: createFakeGitHub(),
  installationForRepository: () => "fixture-installation",
};
if (mode === "prepare") {
  mkdirSync(server, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "origin"), { mode: 0o700 });
  git(["init", "-b", "main", "origin"]);
  writeFileSync(join(root, "origin", "base.txt"), "assigned base\n");
  git(["add", "."], join(root, "origin"));
  git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Assigned base",
    ],
    join(root, "origin"),
  );
  const base = git(["rev-parse", "HEAD"], join(root, "origin"));
  git(["clone", "--bare", "origin", "origin.git"]);
  await initializeRunnerCoordinator(join(server, "identity"));
  const certificate = Bun.spawnSync(
    [
      "/usr/bin/openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      join(server, "server.key"),
      "-out",
      join(server, "server.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-config",
      "/dev/null",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { env: { PATH: "/usr/bin:/bin", HOME: root }, stdout: "ignore", stderr: "pipe" },
  );
  assert.equal(certificate.exitCode, 0, certificate.stderr.toString());
  chmodSync(join(server, "server.key"), 0o600);
  writeFileSync(join(root, "server.pem"), tls().cert);
  const db = openDatabase(dbPath);
  migrate(db);
  const now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  const principal = {
    workspaceId: workspace.id,
    userId,
    role: "owner" as const,
    authenticatedAt: now,
    teamIds: [],
  };
  const coordinator = await openRunnerCoordinator({
    db,
    root: join(server, "identity"),
    tls: tls(),
    hostname: "127.0.0.1",
    port: 0,
    repositoryAccess,
    transcriptObjects,
    onError: () => {},
  });
  const browser = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: tls(),
    fetch: (request) => coordinator.enrollment(request),
  });
  const config: Fixture = {
    browserPort: browser.port!,
    runnerPort: coordinator.port,
    commands: [],
    base,
  };
  const daemon = openRunnerDaemon(daemonOptions(config));
  try {
    const pending = await daemon.beginPairing("Run and review runner");
    assert(pending.phase === "pending");
    await coordinator.control.approvePairing(principal, pending.code);
    const paired = await daemon.pollPairing();
    assert(paired.phase === "paired");
    db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
      workspace.id,
      "fixture/repository",
      "team",
    ]);
    for (const [index, type] of ["run", "review", "run", "run"].entries()) {
      const session = `session-${index}`;
      const item = insertQueuedItem(db, { id: `item-${index}`, now, sessionKey: session });
      const { run } = beginImplementRun(db, item.id, now);
      recordLinearInstallation(db, {
        organizationId: "org",
        oauthClientId: "fixture",
        appUserId: "app",
        sessionId: session,
        teamId: "team",
        observedAtMs: now,
      });
      bindLinearSessionTask(db, session, item.epicId, { actorId: "owner" });
      const repository = {
        owner: "fixture",
        repo: "repository",
        remoteUrl: "https://github.com/fixture/repository.git",
        baseSha: base,
      };
      bindWorkItemRepository(db, item.id, repository);
      const command: WorkCommand = {
        type: type as "run" | "review",
        id: workspaceId(),
        runnerId: paired.runnerId,
        workspaceId: workspace.id,
        issuedAt: now,
        expiresAt: now + 300_000,
        runId: run.id,
        itemId: item.id,
        generation: 1,
        repository,
        profile: { agent: "claude", model: index < 2 ? "fixture-model" : "hold" },
        prompt: "Execute the assigned fixture",
      };
      coordinator.work.assign(command);
      config.commands.push(command);
    }
    writeFileSync(join(root, "fixture.json"), JSON.stringify(config));
  } finally {
    daemon.close();
    await browser.stop(true);
    await coordinator.stop();
    db.close();
  }
} else if (mode === "coordinator") {
  const config = configuration();
  const db = openDatabase(dbPath);
  const coordinator = await openRunnerCoordinator({
    db,
    root: join(server, "identity"),
    tls: tls(),
    hostname: "127.0.0.1",
    port: config.runnerPort,
    repositoryAccess,
    transcriptObjects,
    onError: () => process.exit(2),
  });
  const answered = new Set<string>();
  const timer = setInterval(async () => {
    for (const command of config.commands.slice(0, 2)) {
      for (const { sequence, event } of coordinator.results.events(command.runId, 1, 0)) {
        const key = `${command.id}:${sequence}`;
        if (answered.has(key) || (event.type !== "question" && event.type !== "artifact")) continue;
        if (event.type === "artifact") {
          assert.equal(
            Buffer.from(
              await coordinator.artifacts
                .snapshot(command.runId, 1, event.artifact)
                .bytes.arrayBuffer(),
            ).toString(),
            "assigned base\n",
          );
        }
        coordinator.results.answer({
          runId: command.runId,
          generation: 1,
          sequence,
          answer:
            event.type === "question"
              ? "Yes"
              : JSON.stringify({ url: `https://linear.app/artifact/${event.artifact.id}` }),
        });
        answered.add(key);
      }
    }
  }, 20);
  process.once(
    "SIGTERM",
    () =>
      void coordinator.stop().then(() => {
        clearInterval(timer);
        db.close();
        process.exit(0);
      }),
  );
  writeFileSync(join(server, "ready"), "ready");
} else if (mode === "reader") {
  const cases = JSON.parse(readFileSync(join(root, "reader-cases.json"), "utf8")) as {
    executionId: string;
    valid: `artifact-${string}.bytes`;
    rejected: `artifact-${string}.bytes`[];
  };
  const options = { root: join(root, "results"), agentUid: 1002, resultsGid: 1003 };
  assert.equal(
    readRunnerResultFile(options, cases.executionId, cases.valid).toString(),
    "assigned base\n",
  );
  for (const name of cases.rejected)
    assert.throws(() => readRunnerResultFile(options, cases.executionId, name));
  console.log(JSON.stringify({ artifactReaderRejections: cases.rejected.length }));
} else if (mode === "worker") {
  const id = process.argv[4]!;
  const spool = { root: join(root, "spool"), runnerUid: 1001, agentGid: 1002 };
  const job = readRunnerJob(spool, id);
  assert(job.command.type === "run" || job.command.type === "review");
  assert.throws(() => readFileSync(join(root, "daemon", "identity", "state.json")));
  if (job.command.profile.model === "hold") {
    writeFileSync(join(root, "results", id, "held"), String(process.pid));
    await new Promise(() => {});
  }
  const script = join(root, "agent", `${id}-script.json`);
  const agentLog = join(root, "agent", `${id}-agent.json`);
  const steps = [
    { type: "fs_write", path: "implemented.txt", content: "candidate\n" },
    { type: "ask_team", question: "Include archived rows?", options: ["Yes", "No"] },
    { type: "publish_artifact", path: "base.txt", displayName: "Evidence" },
    {
      type: "update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "[]" } },
    },
    ...(job.command.type === "run"
      ? Array.from({ length: 350 }, (_, index) => ({
          type: "update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "x".repeat(30_000) + `raw-tail-${index}` },
          },
        }))
      : []),
    { type: "end" },
  ];
  writeFileSync(script, JSON.stringify({ model: "fixture-model", steps }));
  const result = await executeRunnerCommand({
    job,
    repositoryBundle: runnerRepositoryBundlePath(spool, id),
    outputDirectory: join(root, "results", id),
    workRoot: join(root, "agent", "work"),
    home: join(root, "agent"),
    resultsGid: 1003,
    launch: {
      command: process.execPath,
      args: ["--no-env-file", "/proof/fake-agent.js", agentLog, script],
      env: { PATH: "/usr/bin:/bin" },
    },
    async answer(requestId, signal) {
      while (true) {
        signal.throwIfAborted();
        const answer = readRunnerAnswer(spool, id, requestId);
        if (answer) return { answer: answer.answer };
        await Bun.sleep(20);
      }
    },
  });
  assert.equal(result.run.errorMessage, undefined, JSON.stringify(result));
  const calls = JSON.parse(readFileSync(agentLog, "utf8"));
  assert.equal(calls.artifact.ok, true);
  assert.equal(calls.askTeam.text, "Yes");
  if (job.command.type === "review") {
    assert.equal(calls.fs[0].ok, false);
    assert.equal(result.reviewText, "[]");
    assert.equal(result.candidateSha, undefined);
  }
} else {
  assert(mode === "first" || mode === "recover");
  const config = configuration();
  const daemon = openRunnerDaemon(daemonOptions(config));
  let offset = 0;
  let outage = false;
  let release: (() => void) | undefined;
  const disconnected = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lost = { event: false, artifact: false, result: false, chunk: false, seal: false };
  const failureCase = readFileSync(join(root, "failure-case"), "utf8");
  const failed = { grant: false, credential: false, push: false };
  const sealed = new Set<string>();
  const runtime = await openRunnerRuntime({
    root: join(root, "runtime"),
    daemon: {
      ...daemon,
      async issueRunGrant(...input) {
        const value = await daemon.issueRunGrant(...input);
        if (["all", "grant"].includes(failureCase) && !failed.grant) {
          failed.grant = true;
          console.error("Injected real grant receipt loss");
          throw new RunnerRequestError(503);
        }
        return value;
      },
      async repositoryCredential(...input) {
        const value = await daemon.repositoryCredential(...input);
        if (
          ["all", "credential"].includes(failureCase) &&
          input[2] === "write" &&
          !failed.credential
        ) {
          failed.credential = true;
          console.error("Injected real write credential receipt loss");
          throw new RunnerRequestError(503);
        }
        return value;
      },
      async sendEvent(input, token) {
        if (failureCase === "permanent" && input.runId === config.commands[0]!.runId) {
          throw new RunnerRequestError(404);
        }
        const receipt = await daemon.sendEvent(input, token);
        if (!lost.event) {
          lost.event = true;
          throw new Error("Fixture lost event receipt");
        }
        return receipt;
      },
      async uploadArtifact(runId, chunk, token) {
        const receipt = await daemon.uploadArtifact(runId, chunk, token);
        if (!lost.artifact) {
          lost.artifact = true;
          throw new Error("Fixture lost artifact receipt");
        }
        return receipt;
      },
      async uploadTranscript(runId, chunk, token) {
        const receipt = await daemon.uploadTranscript(runId, chunk, token);
        if (!lost.chunk) {
          lost.chunk = true;
          throw new RunnerRequestError(503);
        }
        return receipt;
      },
      async finishTranscript(runId, finish, token) {
        const receipt = await daemon.finishTranscript(runId, finish, token);
        sealed.add(runId);
        if (!lost.seal) {
          lost.seal = true;
          throw new RunnerRequestError(503);
        }
        return receipt;
      },
      async postResult(runId, generation, result, token) {
        assert(sealed.has(runId), "Terminal result preceded sealed transcript");
        const receipt = await daemon.postResult(runId, generation, result, token);
        if (!lost.result) {
          lost.result = true;
          throw new Error("Fixture lost result receipt");
        }
        return receipt;
      },
      async heartbeat() {
        if (outage) {
          await disconnected;
          throw new Error("Fixture outage");
        }
        return daemon.heartbeat();
      },
    },
    spool: { root: join(root, "spool"), runnerUid: 1001, agentGid: 1002 },
    results: { root: join(root, "results"), agentUid: 1002, resultsGid: 1003 },
    repositoryRoot: join(root, "repositories"),
    home: join(root, "daemon"),
    broker: createRunnerBrokerClient({ socketPath: join(root, "broker.sock") }),
    monotonic: () => performance.now() + offset,
    onError: (error) => console.error(error.message),
    async networkGit(input) {
      assert.equal(input.remoteUrl, "https://github.com/fixture/repository.git");
      assert.equal(input.token, "fake-installation-token");
      if (input.operation === "clone")
        git(["clone", "--bare", join(root, "origin.git"), input.dest!], input.cwd);
      else if (input.operation === "fetch")
        git(
          [
            "--git-dir",
            input.dest!,
            "fetch",
            join(root, "origin.git"),
            "refs/heads/*:refs/heads/*",
          ],
          input.cwd,
        );
      else {
        assert.match(input.refspec!, /^[a-f0-9]{40}:refs\/heads\/paws\//);
        git(["push", join(root, "origin.git"), input.refspec!], input.cwd);
        if (["all", "push"].includes(failureCase) && !failed.push) {
          failed.push = true;
          console.error("Injected real candidate push receipt loss");
          throw new Error("Fixture Git connection lost after push");
        }
      }
    },
  });
  if (mode === "first") {
    const deadline = Date.now() + 25_000;
    while (runtime.status().active?.commandId !== config.commands[2]!.id) {
      assert(Date.now() < deadline, JSON.stringify(runtime.status()));
      await runtime.tick();
      await Bun.sleep(20);
    }
    while (!readable(join(root, "results", runtime.status().active!.executionId, "held")))
      await Bun.sleep(20);
    assert.deepEqual(lost, { event: true, artifact: true, result: true, chunk: true, seal: true });
    outage = true;
    offset = 60_001;
    const hung = runtime.tick();
    await Bun.sleep(600);
    writeFileSync(
      join(root, "runtime", "lease-expired.json"),
      JSON.stringify(runtime.status().active),
    );
    release!();
    outage = false;
    await hung;
    while (runtime.status().active?.commandId !== config.commands[3]!.id) {
      assert(Date.now() < deadline);
      await runtime.tick();
      await Bun.sleep(20);
    }
    while (!readable(join(root, "results", runtime.status().active!.executionId, "held")))
      await Bun.sleep(20);
    writeFileSync(
      join(root, "runtime", "crash-ready.json"),
      JSON.stringify(runtime.status().active),
    );
    await new Promise(() => {});
  }
  for (let count = 0; count < 5; count++) await runtime.tick();
  assert.equal(runtime.status().active, null);
  await runtime.stop();
  daemon.close();
  const journal = openDatabase(join(root, "runtime", "executions.db"));
  const phases = journal
    .query<{ phase: string }, []>("SELECT phase FROM execution ORDER BY rowid")
    .all()
    .map((row) => row.phase);
  journal.close();
  assert.deepEqual(phases, [
    failureCase === "permanent" ? "interrupted" : "complete",
    "complete",
    "interrupted",
    "interrupted",
  ]);
  console.log(JSON.stringify({ phases, recovered: true }));
}
function readable(path: string) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
