import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  saveTaskMode,
} from "../../src/db";
import { createFakeGitHub } from "../../src/github";
import { createLocalRunnerTranscriptObjects } from "../../src/runner-transcripts";
import { initializeRunnerCoordinator, openRunnerCoordinator } from "../../src/runner-coordinator";
import { openRunnerDaemon, RunnerRequestError } from "../../src/runner-daemon";
import { createDirectWorkerSupervisor, readRunnerJob } from "../../src/runner-execution";
import { openExecutionJournal } from "../../src/runner-journal";
import { openRunnerRuntime } from "../../src/runner-runtime";
import { runRunnerCli } from "../../src/runner-cli";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";
import type { RunnerCommand } from "../../src/runner-protocol";

const [mode, ...args] = process.argv.slice(2);
if (mode === "runner") process.exit(await runRunnerCli(args));
const root = "/var/lib/paws-task-proof";
const home = "/var/lib/paws-runner";
const server = join(root, "server");
const inputPath = ".paws-linear-inputs/private [a]*!.bin";
const inputBytes = Buffer.from([0, 255, 40, 20]);
const fullPrompt = "Restored native task context 日本語 " + "x".repeat(1_048_576) + " context-tail";
const spool = {
  root: "/var/lib/paws-runner-spool",
  runnerUid: Number(args[0]),
  agentGid: Number(args[1]),
};
type Task = Extract<RunnerCommand, { type: "task" }>;
type Configuration = { browserPort: number; runnerPort: number; commands: Task[] };
const config = () => JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as Configuration;
const tls = () => ({
  key: readFileSync(join(server, "server.key"), "utf8"),
  cert: readFileSync(join(server, "server.pem"), "utf8"),
});
const daemonOptions = (configuration: Configuration) => ({
  root: home,
  controlPlaneUrl: "https://127.0.0.1:" + configuration.browserPort,
  runnerApiUrl: "https://127.0.0.1:" + configuration.runnerPort,
  serverCa: readFileSync(join(root, "server.pem"), "utf8"),
  allowedRepositories: ["fixture/repository"],
});
const objects = createLocalRunnerTranscriptObjects(join(server, "objects"));
function git(input: string[], cwd = root) {
  const child = Bun.spawnSync(["/usr/bin/git", "-c", "safe.directory=*", ...input], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(child.exitCode, 0, child.stderr.toString());
  return child.stdout.toString().trim();
}
async function coordinator(port: number) {
  const db = openDatabase(join(server, "paws.db"));
  migrate(db);
  const service = await openRunnerCoordinator({
    db,
    root: join(server, "identity"),
    tls: tls(),
    hostname: "127.0.0.1",
    port,
    transcripts: { objects, key: Buffer.alloc(32, 7) },
    repositoryAccess: { github: createFakeGitHub(), installationForRepository: () => "fixture" },
    onError: () => {},
  });
  return { db, service };
}
if (mode === "agent") {
  const script = join(root, "scripts", "current.json");
  const { executionId } = JSON.parse(readFileSync(script, "utf8"));
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "/opt/paws-runner/current/fake-agent.js",
      "/var/lib/paws-agent-tasks/" + executionId + "/agent.json",
      script,
    ],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env },
  );
  process.exit(await child.exited);
} else if (mode === "prepare") {
  mkdirSync(server, { recursive: true, mode: 0o700 });
  const certificate = Bun.spawnSync(
    [
      "openssl",
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
    { stdout: "ignore", stderr: "pipe" },
  );
  assert.equal(certificate.exitCode, 0, certificate.stderr.toString());
  writeFileSync(join(root, "server.pem"), tls().cert);
  await initializeRunnerCoordinator(join(server, "identity"));
  git(["init", "-b", "main", "origin"]);
  writeFileSync(join(root, "origin", "tracked"), "authorized source");
  git(["add", "."], join(root, "origin"));
  git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Authorized",
    ],
    join(root, "origin"),
  );
  const baseSha = git(["rev-parse", "HEAD"], join(root, "origin"));
  writeFileSync(join(root, "origin", "tracked"), "newer source");
  git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-am",
      "Newer",
    ],
    join(root, "origin"),
  );
  git(["clone", "--bare", "origin", "origin.git"]);
  const { db, service } = await coordinator(0);
  const now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "fixture@example.invalid",
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
  const browser = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: tls(),
    fetch: (request) => service.hostEnrollment(request),
  });
  const configuration: Configuration = {
    browserPort: browser.port!,
    runnerPort: service.port,
    commands: [],
  };
  const daemon = openRunnerDaemon(daemonOptions(configuration));
  const pending = service.control.createEnrollment(principal, { name: "Task runtime" });

  const paired = await daemon.enroll("Task runtime", pending.token);
  if (paired.phase !== "paired") throw new Error("Runner enrollment failed");
  service.control.setStatus(principal, paired.runnerId, "active");
  assert(paired.phase === "paired");
  db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
    workspace.id,
    "fixture/repository",
    "team",
  ]);
  for (const purpose of ["answer", "artifact"] as const)
    for (const repository of [false, true]) {
      const sessionId = "task-session-" + configuration.commands.length;
      const item = insertQueuedItem(db, {
        id: "task-item-" + configuration.commands.length,
        now,
        sessionKey: sessionId,
      });
      const { run } = beginImplementRun(db, item.id, now);
      recordLinearInstallation(db, {
        organizationId: "org",
        oauthClientId: "fixture",
        appUserId: "app",
        sessionId,
        teamId: "team",
        observedAtMs: now,
      });
      bindLinearSessionTask(db, sessionId, item.delegationId, { actorId: "owner" });
      saveTaskMode(db, item.id, purpose, 0, repository);
      const binding = {
        owner: "fixture",
        repo: "repository",
        remoteUrl: "https://github.com/fixture/repository.git",
        baseSha,
      };
      if (repository) bindWorkItemRepository(db, item.id, binding);
      const scope = service.work.scopeTask(run.id, workspace.id);
      const command: Task = {
        type: "task",
        id: workspaceId(),
        runnerId: paired.runnerId,
        workspaceId: workspace.id,
        issuedAt: now,
        expiresAt: now + 300_000,
        runId: run.id,
        itemId: item.id,
        generation: 1,
        sessionId,
        sessionGeneration: scope.sessionGeneration,
        taskModeGeneration: scope.taskModeGeneration,
        purpose,
        profile: { agent: "claude", model: "fixture-model" },
        prompt: "Complete the assigned " + purpose,
        ...(repository ? { repository: binding } : {}),
      };
      command.inputFiles = service.inputs.stage(command.id, [
        { path: inputPath, mimeType: "application/octet-stream", bytes: inputBytes },
      ]);
      command.promptContext = service.inputs.stagePrompt(command.id, fullPrompt);
      service.work.assign(command);
      configuration.commands.push(command);
    }
  writeFileSync(join(root, "config.json"), JSON.stringify(configuration));
  daemon.close();
  await browser.stop(true);
  await service.stop();
  db.close();
} else if (mode === "coordinator") {
  const { db, service } = await coordinator(config().runnerPort);
  const answered = new Set<string>();
  const timer = setInterval(() => {
    for (const command of config().commands)
      for (const { sequence, event } of service.results.events(command.runId, 1, 0)) {
        const key = command.id + ":" + sequence;
        if (answered.has(key) || (event.type !== "question" && event.type !== "artifact")) continue;
        service.results.answer({
          runId: command.runId,
          generation: 1,
          sequence,
          answer:
            event.type === "question"
              ? "Yes"
              : JSON.stringify({ url: "https://fixture.invalid/report" }),
        });
        answered.add(key);
      }
  }, 20);
  process.once(
    "SIGTERM",
    () =>
      void service.stop().then(() => {
        clearInterval(timer);
        db.close();
        process.exit(0);
      }),
  );
  writeFileSync(join(server, "ready"), "ready");
} else {
  assert.equal(mode, "runtime");
  const configuration = config();
  const daemon = openRunnerDaemon(daemonOptions(configuration));
  const workers = createDirectWorkerSupervisor({
    stateRoot: join(home, "runtime", "workers"),
    spool,
    results: {
      root: "/var/lib/paws-agent-results",
      agentUid: Number(args[0]),
      resultsGid: Number(args[3]),
    },
    taskRoot: "/var/lib/paws-agent-tasks",
  });
  const lost = {
    grant: false,
    credential: false,
    git: false,
    event: false,
    artifact: false,
    chunk: false,
    seal: false,
    result: false,
  };
  const sealed = new Set<string>();
  const started = new Set<string>();
  const runtime = await openRunnerRuntime({
    root: join(home, "runtime"),
    home,
    repositoryRoot: join(home, "repositories"),
    spool,
    results: {
      root: "/var/lib/paws-agent-results",
      agentUid: Number(args[0]),
      resultsGid: Number(args[3]),
    },
    daemon: {
      ...daemon,
      async issueRunGrant(...input) {
        const receipt = await daemon.issueRunGrant(...input);
        if (!lost.grant) {
          lost.grant = true;
          throw new RunnerRequestError(503);
        }
        return receipt;
      },
      async repositoryCredential(...input) {
        assert.equal(input[2], "read");
        const receipt = await daemon.repositoryCredential(...input);
        if (!lost.credential) {
          lost.credential = true;
          throw new RunnerRequestError(503);
        }
        return receipt;
      },
      async sendEvent(...input) {
        const receipt = await daemon.sendEvent(...input);
        if (!lost.event) {
          lost.event = true;
          throw new RunnerRequestError(503);
        }
        return receipt;
      },
      async uploadArtifact(...input) {
        const receipt = await daemon.uploadArtifact(...input);
        if (!lost.artifact) {
          lost.artifact = true;
          throw new RunnerRequestError(503);
        }
        return receipt;
      },
      async uploadTranscript(...input) {
        const receipt = await daemon.uploadTranscript(...input);
        if (!lost.chunk) {
          lost.chunk = true;
          throw new RunnerRequestError(503);
        }
        return receipt;
      },
      async finishTranscript(...input) {
        const receipt = await daemon.finishTranscript(...input);
        sealed.add(input[0]);
        if (!lost.seal) {
          lost.seal = true;
          throw new RunnerRequestError(503);
        }
        return receipt;
      },
      async postResult(...input) {
        assert(sealed.has(input[0]));
        assert.equal(input[2].candidateSha, undefined);
        assert.equal(input[2].reviewText, undefined);
        const receipt = await daemon.postResult(...input);
        if (!lost.result) {
          lost.result = true;
          throw new RunnerRequestError(503);
        }
        return receipt;
      },
    },
    broker: {
      stop: (id) => workers.stop(id),
      async start(id) {
        const job = readRunnerJob(spool, id);
        assert(job.command.type === "task");
        const cwd = "/var/lib/paws-agent-tasks/" + id;
        const steps: unknown[] = [
          { type: "terminal", command: "sh", args: ["-c", "printf report > report.txt"] },
        ];
        if (job.command.repository)
          steps.push(
            { type: "fs_read", path: cwd + "/repository/tracked" },
            { type: "fs_write", path: cwd + "/repository/tracked", content: "changed" },
          );
        steps.push({ type: "ask_team", question: "Include the report?" });
        if (job.command.purpose === "artifact")
          steps.push({ type: "publish_artifact", path: "report.txt", displayName: "Report" });
        steps.push(
          {
            type: "update",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "The " + job.command.purpose + " task is complete." },
            },
          },
          { type: "end" },
        );
        writeFileSync(
          join(root, "scripts", "current.json"),
          JSON.stringify({
            executionId: id,
            model: "fixture-model",
            steps,
            promptCapabilities: { embeddedContext: true },
          }),
        );
        const receipt = await workers.start(id);
        assert.equal(receipt.alreadyAdmitted, false);
        assert(!started.has(id));
        started.add(id);
        return receipt;
      },
    },
    async networkGit(input) {
      assert.equal(input.operation, "clone");
      assert.deepEqual(Object.keys(input.env).sort(), [
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_TERMINAL_PROMPT",
        "HOME",
        "PATH",
      ]);
      assert.equal(input.remoteUrl, "https://github.com/fixture/repository.git");
      assert.equal(input.token, "fake-installation-token");
      git(["clone", "--bare", join(root, "origin.git"), input.dest!], input.cwd);
      if (!lost.git) {
        lost.git = true;
        throw new Error("Synthetic lost Git clone response");
      }
    },
    onError: (error) => console.error(error.message),
  });
  const deadline = Date.now() + 180_000;
  while (true) {
    await runtime.tick();
    const db = openDatabase(join(home, "runtime", "executions.db"));
    const rows = db
      .query<{ phase: string }, []>("SELECT phase FROM execution ORDER BY rowid")
      .all();
    db.close();
    if (rows.length === 4 && rows.every((row) => row.phase === "complete")) break;
    assert(Date.now() < deadline, JSON.stringify(rows));
    await Bun.sleep(40);
  }
  await runtime.stop();
  daemon.close();
  const reopened = openExecutionJournal(join(home, "runtime"));
  assert.equal(reopened.executions(false).length, 4);
  reopened.close();
  assert.equal(started.size, 4);
  assert(Object.values(lost).every(Boolean));
  writeFileSync(
    join(home, "runtime", "done.json"),
    JSON.stringify({ passed: true, started: started.size, lost }),
  );
}
