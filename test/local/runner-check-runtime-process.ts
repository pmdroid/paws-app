import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
import { createFakeGitHub } from "../../src/github";
import { initializeRunnerCoordinator, openRunnerCoordinator } from "../../src/runner-coordinator";
import { openRunnerDaemon, RunnerRequestError } from "../../src/runner-daemon";
import { openRunnerAuthority, startRunnerListener } from "../../src/runner-identity";
import { createRunnerWorkHttp } from "../../src/runner-work";
import { createRunnerChecks, createRunnerChecksHttp } from "../../src/runner-checks";
import { createRunnerRepositoryAccess } from "../../src/runner-repository-access";
import { runnerVerifierFingerprint } from "../../src/runner-verifier";
import { openRunnerCheckRuntime } from "../../src/runner-check-runtime";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";

const root = "/var/lib/paws-proof";
const mode = process.argv[2]!;
const read = (name: string) => readFileSync(join(root, name), "utf8");
const write = (name: string, value: unknown) => {
  const path = join(root, name);
  const temporary = `${path}.${process.pid}`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
};
const initial = JSON.parse(read("initial.json")) as {
  runnerUid: number;
  runnerGid: number;
  checkUid: number;
  checkGid: number;
  inputGid: number;
  candidate: string;
  verifierPublicKeyPem: string;
};
const fingerprint = runnerVerifierFingerprint(initial.verifierPublicKeyPem);
const daemonOptions = () => {
  const config = JSON.parse(read("config.json")) as { browserPort: number; runnerPort: number };
  return {
    root: join(root, "daemon"),
    controlPlaneUrl: `https://localhost:${config.browserPort}`,
    runnerApiUrl: `https://localhost:${config.runnerPort}`,
    serverCa: read("server.pem"),
    allowedRepositories: ["fixture/repository"],
    verifierPublicKeyPem: initial.verifierPublicKeyPem,
  };
};
async function wait(test: () => boolean, timeout = 120_000) {
  const until = Date.now() + timeout;
  while (!test()) {
    assert(Date.now() < until, "Fixture timed out");
    await Bun.sleep(30);
  }
}
if (mode === "coordinator") {
  const server = join(root, "server");
  const db = openDatabase(join(server, "paws.db"));
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
      join(root, "server.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-config",
      "/dev/null",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  assert.equal(certificate.exitCode, 0, certificate.stderr.toString());
  chmodSync(join(server, "server.key"), 0o600);
  const tls = { key: readFileSync(join(server, "server.key"), "utf8"), cert: read("server.pem") };
  const coordinator = await openRunnerCoordinator({
    db,
    root: join(server, "identity"),
    tls,
    port: 0,
    onError: () => {},
  });
  const enrollment = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    fetch: (request) => coordinator.enrollment(request),
  });
  const checks = createRunnerChecks({ db, work: coordinator.work });
  const checksHttp = createRunnerChecksHttp(checks);
  const workHttp = createRunnerWorkHttp(coordinator.work);
  const repositoryHttp = createRunnerRepositoryAccess({
    work: coordinator.work,
    github: createFakeGitHub(),
    installationForRepository: () => "fixture",
  });
  let first = "",
    second = "",
    third = "",
    fourth = "";
  let received = 0,
    duplicates = 0;
  let dispatch: (number: number) => string;
  const listener = await startRunnerListener({
    tls: { ...tls, ca: openRunnerAuthority(join(server, "identity")).certificate },
    authorize(peer) {
      try {
        coordinator.control.authenticate(peer);
        return true;
      } catch {
        return false;
      }
    },
    async fetch(request, peer) {
      const id = coordinator.control.authenticate(peer).id;
      const response =
        (await checksHttp(request, id)) ??
        (await workHttp(request, id)) ??
        (await repositoryHttp(request, id)) ??
        new Response(null, { status: 404 });
      if (new URL(request.url).pathname.endsWith("/check-result") && response.ok) {
        const receipt = (await response.clone().json()) as { duplicate: boolean };
        if (receipt.duplicate) {
          duplicates++;
          assert.equal(coordinator.work.current(run.id, 2).command.type, "check");
        } else received++;
        if (received === 1 && !second) {
          second = dispatch(2);
          write("server/lost.json", { first, second });
          return Response.json({ error: "Fixture lost receipt" }, { status: 503 });
        }
        if (received === 2 && !third) {
          third = dispatch(3);
          write("server/second.json", { received, duplicates });
        }
      }
      return response;
    },
  });
  write("config.json", { browserPort: enrollment.port, runnerPort: listener.port });
  await wait(() => existsSync(join(root, "ipc/pair.json")));
  const pairing = JSON.parse(read("ipc/pair.json")) as { code: string };
  const { runnerId } = await coordinator.control.approvePairing(
    principal,
    pairing.code,
    fingerprint,
  );
  const item = insertQueuedItem(db, { id: "check-item", now, sessionKey: "check-session" });
  const { run } = beginImplementRun(db, item.id, now);
  recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "fixture",
    appUserId: "app",
    sessionId: "check-session",
    teamId: "team",
    observedAtMs: now,
  });
  bindLinearSessionTask(db, "check-session", item.epicId, { actorId: "owner" });
  bindWorkItemRepository(db, item.id, {
    owner: "fixture",
    repo: "repository",
    remoteUrl: "https://github.com/fixture/repository.git",
  });
  db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
    workspace.id,
    "fixture/repository",
    "team",
  ]);
  const attempt = workspaceId();
  const commands: string[] = [];
  dispatch = (number) => {
    const script =
      number === 1
        ? "import pathlib;pathlib.Path('.paws-deps').mkdir();pathlib.Path('.paws-deps/retained').write_text('yes');print('setup')"
        : number === 2
          ? "import pathlib;assert pathlib.Path('.paws-deps/retained').read_text()=='yes';print('retained');raise SystemExit(7)"
          : "import os,pathlib,time;pathlib.Path('../home/held').write_text(str(os.getpid()));time.sleep(240)";
    const assigned = checks.dispatch({
      runnerId,
      runId: run.id,
      verificationAttemptId: number <= 2 ? attempt : workspaceId(),
      candidateSha: initial.candidate,
      argv: ["/usr/bin/python3", "-I", "-c", script],
      cwd: ".",
      timeoutMs: 180_000,
    });
    commands.push(assigned.input.executionId);
    write("commands.json", commands);
    return assigned.input.executionId;
  };
  first = dispatch(1);
  const timer = setInterval(() => {
    if (existsSync(join(root, "next-four")) && !fourth) {
      checks.cancel(third);
      fourth = dispatch(4);
      write("server/fourth.json", { third, fourth });
    }
  }, 50);
  process.once(
    "SIGTERM",
    () =>
      void (async () => {
        clearInterval(timer);
        const results = commands.map((id) => checks.result(id)).filter(Boolean);
        assert.equal(received, 2);
        assert.equal(duplicates, 1);
        assert.equal(results.length, 2);
        assert.equal(results[0]!.result.exitCode, 0);
        assert.equal(results[1]!.result.exitCode, 7);
        assert.match(results[1]!.result.stdout, /retained/);
        write("server/summary.json", { results, received, duplicates, commands, fingerprint });
        await listener.stop();
        await enrollment.stop(true);
        await coordinator.stop();
        db.close();
        process.exit(0);
      })(),
  );
  write("server/ready", true);
} else {
  await wait(() => existsSync(join(root, "config.json")));
  const daemon = openRunnerDaemon(daemonOptions());
  if (mode === "pair") {
    const pending = await daemon.beginPairing("Trusted check runner");
    assert.equal(pending.phase, "pending");
    assert(pending.phase === "pending");
    write("ipc/pair.json", { code: pending.code });
    while ((await daemon.pollPairing()).phase !== "paired") await Bun.sleep(50);
    daemon.close();
    process.exit(0);
  }
  const firstPulse = await daemon.heartbeat();
  const firstCommands = await daemon.pollCommands();
  console.log(
    JSON.stringify({
      mode,
      leases: firstPulse.leases,
      fenced: firstPulse.fenced,
      commands: firstCommands.commands.map((command) => ({ id: command.id, type: command.type })),
      rejected: firstCommands.rejected,
    }),
  );
  const retried = { grant: false, credential: false, repository: false };
  const publishing = () => {
    write("ipc/transient-retries.json", retried);
    write("ipc/lost-ready", true);
  };
  const runtime = await openRunnerCheckRuntime({
    root: join(root, "runtime"),
    daemon: {
      ...daemon,
      async issueRunGrant(...input) {
        const value = await daemon.issueRunGrant(...input);
        if (mode === "first" && !retried.grant) {
          retried.grant = true;
          throw new RunnerRequestError(503);
        }
        return value;
      },
      async repositoryCredential(...input) {
        const value = await daemon.repositoryCredential(...input);
        if (mode === "first" && !retried.credential) {
          retried.credential = true;
          throw new RunnerRequestError(503);
        }
        return value;
      },
      async heartbeat() {
        if (existsSync(join(root, "outage"))) return new Promise(() => {});
        return daemon.heartbeat();
      },
    },
    paths: {
      inputRoot: "/var/lib/paws-check-input",
      workRoot: "/var/lib/paws-check-attempts",
      resultRoot: "/var/lib/paws-check-results",
      ...initial,
    },
    repositoryRoot: join(root, "repositories"),
    home: join(root, "daemon"),
    verifierPublicKeyPem: initial.verifierPublicKeyPem,
    monotonic: () => performance.now() + (existsSync(join(root, "outage")) ? 60_001 : 0),
    onError: (error) => console.error(error.message),
    async networkGit(input) {
      assert.equal(input.token, "fake-installation-token");
      assert.notEqual(input.operation, "push");
      const args =
        input.operation === "clone"
          ? ["clone", "--bare", join(root, "repository.bundle"), input.dest!]
          : [
              "--git-dir",
              input.dest!,
              "fetch",
              join(root, "repository.bundle"),
              "refs/heads/*:refs/heads/*",
            ];
      const child = Bun.spawnSync(["/usr/bin/git", ...args], {
        cwd: input.cwd,
        env: input.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      assert.equal(child.exitCode, 0, child.stderr.toString());
      if (mode === "first" && input.operation === "clone" && !retried.repository) {
        retried.repository = true;
        throw new Error("Fixture lost repository clone receipt");
      }
    },
  });
  if (mode === "recover") {
    assert.equal(runtime.status().active, null);
    await runtime.stop();
    daemon.close();
    write("ipc/recovered.json", true);
    process.exit(0);
  }
  setInterval(() => {
    const active = runtime.status().active;
    if (mode === "first" && active?.phase === "publishing") publishing();
    if (mode === "second" && active?.phase === "interrupted") write("ipc/lease-stopped", active);
  }, 30);
  while (true) {
    await runtime.tick();
    if (mode === "first" && runtime.status().active?.phase === "publishing") {
      publishing();
      await new Promise(() => {});
    }
    await Bun.sleep(30);
  }
}
