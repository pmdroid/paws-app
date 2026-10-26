import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  advanceLinearSessionGeneration,
  consumeWorkspaceBootstrap,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
} from "../../src/db";
import { initializeRunnerCoordinator, openRunnerCoordinator } from "../../src/runner-coordinator";
import { openRunnerDaemon } from "../../src/runner-daemon";
import { createRunnerBrokerClient, readRunnerJob } from "../../src/runner-execution";
import { openRunnerHealthRuntime } from "../../src/runner-health-runtime";
import { executeRunnerCommand } from "../../src/runner-worker";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";

const mode = process.argv[2]!;
const root = process.argv[3]!;
const server = join(root, "server");
const dbPath = join(server, "paws.db");
const tls = () => ({
  key: readFileSync(join(server, "server.key"), "utf8"),
  cert: readFileSync(join(server, "server.pem"), "utf8"),
});
type Fixture = {
  browserPort: number;
  runnerPort: number;
  commandIds: string[];
  helpers?: boolean;
  runnerId?: string;
};
const configuration = () => JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as Fixture;
function daemonOptions(config: Fixture) {
  return {
    root: join(root, "daemon"),
    controlPlaneUrl: `https://127.0.0.1:${config.browserPort}`,
    runnerApiUrl: `https://127.0.0.1:${config.runnerPort}`,
    serverCa: readFileSync(join(root, "server.pem"), "utf8"),
    allowedRepositories: [],
  };
}
if (mode === "prepare") {
  mkdirSync(server, { recursive: true, mode: 0o700 });
  await initializeRunnerCoordinator(join(server, "identity"));
  const generated = Bun.spawnSync(
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
  assert.equal(generated.exitCode, 0, generated.stderr.toString());
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
    onError: () => {},
  });
  const browser = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: tls(),
    fetch: (request) => coordinator.hostEnrollment(request),
  });
  const config: Fixture = {
    browserPort: browser.port!,
    runnerPort: coordinator.port,
    commandIds: [],
  };
  const daemon = openRunnerDaemon(daemonOptions(config));
  try {
    const pending = coordinator.control.createEnrollment(principal, {
      name: "Durable health runner",
    });

    const paired = await daemon.enroll("Durable health runner", pending.token);
    if (paired.phase !== "paired") throw new Error("Runner enrollment failed");
    coordinator.control.setStatus(principal, paired.runnerId, "active");
    assert(paired.phase === "paired");
    if (process.argv[4] === "helpers") {
      config.helpers = true;
      config.runnerId = paired.runnerId;
      recordLinearInstallation(db, {
        organizationId: "org",
        oauthClientId: "app",
        appUserId: "app-user",
        sessionId: "session",
        teamId: "team",
        observedAtMs: Date.now(),
      });
      config.commandIds.push(
        coordinator.helpers.dispatch({
          runnerId: paired.runnerId,
          sessionId: "session",
          purpose: "classify",
          profile: { agent: "claude", model: "fixture-model" },
          prompt: "Classify the fixture request",
        }).command.id,
      );
    } else {
      config.commandIds.push(
        coordinator.health.request(principal, paired.runnerId, {
          type: "probe",
          profile: { agent: "claude", model: "fixture-model" },
        }).commandId,
      );
      config.commandIds.push(
        coordinator.health.request(principal, paired.runnerId, {
          type: "login_check",
          agent: "claude",
        }).commandId,
      );
      config.commandIds.push(
        coordinator.health.request(principal, paired.runnerId, {
          type: "probe",
          profile: { agent: "claude", model: "hold" },
        }).commandId,
      );
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
    onError: () => process.exit(2),
  });
  let nextHelper: string | undefined;
  let fenced = false;
  let resumed = false;
  const advance = setInterval(() => {
    if (nextHelper && existsSync(join(server, "fence")) && !fenced) {
      advanceLinearSessionGeneration(db, "session");
      fenced = true;
      writeFileSync(join(server, "fenced"), "fenced");
    }
    if (nextHelper && fenced && existsSync(join(server, "resume")) && !resumed) {
      coordinator.helpers.finish(nextHelper);
      coordinator.helpers.dispatch({
        runnerId: config.runnerId!,
        sessionId: "session",
        purpose: "select_repository",
        profile: { agent: "claude", model: "hold" },
        prompt: "Select the current repository",
      });
      resumed = true;
    }
    if (
      !config.helpers ||
      !existsSync(join(server, "advance")) ||
      nextHelper ||
      !coordinator.helpers.result(config.commandIds[0]!)
    )
      return;
    coordinator.helpers.finish(config.commandIds[0]!);
    nextHelper = coordinator.helpers.dispatch({
      runnerId: config.runnerId!,
      sessionId: "session",
      purpose: "select_repository",
      profile: { agent: "claude", model: "hold" },
      prompt: "Select the fixture repository",
    }).command.id;
  }, 20);
  process.once(
    "SIGTERM",
    () =>
      void coordinator.stop().then(() => {
        clearInterval(advance);
        db.close();
        process.exit(0);
      }),
  );
  writeFileSync(join(server, "ready"), "ready");
} else if (mode === "worker") {
  const id = process.argv[4]!;
  const job = readRunnerJob({ root: join(root, "spool"), runnerUid: 1001, agentGid: 1002 }, id);
  assert.throws(() => readFileSync(join(root, "daemon", "identity", "state.json")));
  if (
    (job.command.type === "probe" || job.command.type === "helper") &&
    job.command.profile.model === "hold"
  ) {
    writeFileSync(join(root, "agent", "held"), String(process.pid));
    await new Promise(() => {});
  }
  const script = join(root, "agent", `${id}-script.json`);
  const agentLog = join(root, "agent", `${id}-agent.json`);
  writeFileSync(
    script,
    JSON.stringify({
      model: "fixture-model",
      steps:
        job.command.type === "helper"
          ? [
              {
                type: "fs_write",
                path: join(root, "agent", "forbidden-helper-write"),
                content: "denied",
              },
              {
                type: "update",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "fixture helper response" },
                },
              },
              { type: "end" },
            ]
          : [{ type: "hang" }],
    }),
  );
  const result = await executeRunnerCommand({
    job,
    outputDirectory: join(root, "results", id),
    workRoot: join(root, "agent", "work"),
    home: join(root, "agent"),
    resultsGid: 1003,
    launch: {
      command: process.execPath,
      args: ["--no-env-file", "/proof/fake-agent.js", agentLog, script],
      env: { PATH: "/usr/bin:/bin" },
    },
    loginCommand: async (command, args, env) => {
      assert.equal(command, "claude");
      assert.deepEqual(args, ["auth", "status"]);
      assert.equal(env.HOME, join(root, "agent"));
      return {
        exitCode: 1,
        stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }),
        stderr: "",
      };
    },
  });
  assert.equal(result.run.errorMessage, undefined, JSON.stringify(result.run));
  const calls = JSON.parse(readFileSync(agentLog, "utf8")).methods as string[];
  assert(calls.includes("initialize") && calls.includes("session/new"));
  if (job.command.type === "helper") {
    assert(calls.includes("session/prompt"));
    const recorded = JSON.parse(readFileSync(agentLog, "utf8"));
    assert.equal(recorded.fs[0].ok, false);
    assert(JSON.stringify(recorded.prompts).includes(job.command.prompt));
    assert.equal(result.text, "fixture helper response");
  } else assert(!calls.includes("session/prompt"));
} else {
  assert(mode === "first" || mode === "fence" || mode === "recover" || mode === "recover-receipt");
  const config = configuration();
  const daemon = openRunnerDaemon(daemonOptions(config));
  if (mode === "recover-receipt") {
    await daemon.pollCommands();
    const receipts = openDatabase(join(root, "daemon", "commands.db"));
    assert.equal(
      receipts
        .query<{ acknowledged: number }, []>("SELECT acknowledged FROM pending_command")
        .get()!.acknowledged,
      2,
    );
    receipts.close();
  }
  const errors: string[] = [];
  const health = await openRunnerHealthRuntime({
    root: join(root, "health"),
    daemon:
      config.helpers && mode === "first"
        ? {
            ...daemon,
            async postHelperResult(result) {
              const receipt = await daemon.postHelperResult(result);
              const journal = openDatabase(join(root, "health", "health.db"));
              const saved = journal
                .query<{ result: string }, [string]>(
                  "SELECT result FROM health_execution WHERE command_id=? AND phase='publishing'",
                )
                .get(result.commandId);
              journal.close();
              assert.deepEqual(JSON.parse(saved!.result), result);
              writeFileSync(join(root, "health", "receipt-ready.json"), JSON.stringify(receipt));
              await new Promise(() => {});
              return receipt;
            },
          }
        : daemon,
    spool: { root: join(root, "spool"), runnerUid: 1001, agentGid: 1002 },
    results: { root: join(root, "results"), agentUid: 1002, resultsGid: 1003 },
    broker: createRunnerBrokerClient({ socketPath: join(root, "broker.sock") }),
    onError: (error) => errors.push(error.message),
  });
  if (mode === "first" || mode === "fence") {
    const deadline = Date.now() + 20_000;
    while (
      config.helpers
        ? !health.status().active || health.status().active?.commandId === config.commandIds[0]
        : health.status().active?.commandId !== config.commandIds[2]
    ) {
      assert(Date.now() < deadline, JSON.stringify(errors));
      await health.tick();
      await Bun.sleep(20);
    }
    writeFileSync(join(root, "health", "crash-ready.json"), JSON.stringify(health.status().active));
    if (mode === "first") await new Promise(() => {});
    while (health.status().active) {
      assert(Date.now() < deadline, "Helper generation fence did not stop worker");
      await health.tick(false);
      await Bun.sleep(20);
    }
  }
  for (let count = 0; count < 5; count++) await health.tick();
  assert.equal(health.status().active, null);
  await health.stop();
  daemon.close();
  const journal = openDatabase(join(root, "health", "health.db"));
  const phases = journal
    .query<{ phase: string }, []>("SELECT phase FROM health_execution ORDER BY rowid")
    .all()
    .map((row) => row.phase);
  journal.close();
  assert.deepEqual(
    phases,
    config.helpers
      ? mode === "recover-receipt"
        ? ["complete"]
        : mode === "fence"
          ? ["complete", "interrupted"]
          : ["complete", "interrupted", "interrupted"]
      : ["complete", "complete", "interrupted"],
  );
  assert.equal(errors.length, mode === "fence" ? 1 : 0);
  console.log(
    JSON.stringify({
      phases,
      runtimeUid: process.getuid!(),
      interruptedExecutionStopped: true,
      errors,
    }),
  );
}
