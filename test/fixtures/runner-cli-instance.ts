import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consumeWorkspaceBootstrap, migrate, openDatabase, putWorkspaceUser } from "../../src/db";
import { initializeRunnerCoordinator, openRunnerCoordinator } from "../../src/runner-coordinator";
import { publishRunnerJob } from "../../src/runner-execution";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";

const root = "/state/server";
if (process.argv[2] === "job") {
  const now = Date.now();
  publishRunnerJob(
    { root: "/var/lib/paws-runner-spool", runnerUid: 17001, agentGid: 17002 },
    {
      executionId: process.argv[3] ?? "01J00000000000000000000001",
      command: {
        type: "probe",
        id: "fixture-command",
        runnerId: "fixture-runner",
        workspaceId: "fixture-workspace",
        issuedAt: now,
        expiresAt: now + 60_000,
        profile: { agent: "claude", model: null },
      },
    },
  );
} else {
  const key = join(root, "server.key");
  const cert = join(root, "server.pem");
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
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-config",
      "/dev/null",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { env: { PATH: "/usr/bin:/bin", HOME: root }, stdout: "ignore", stderr: "pipe" },
  );
  assert.equal(generated.exitCode, 0, generated.stderr.toString());
  chmodSync(key, 0o600);
  const tls = { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
  const db = openDatabase(join(root, "paws.db"));
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
  const identity = join(root, "identity");
  await initializeRunnerCoordinator(identity);
  const coordinator = await openRunnerCoordinator({
    db,
    root: identity,
    tls,
    hostname: "127.0.0.1",
    port: 0,
    onError(error) {
      throw error;
    },
  });
  let enrollmentRequests = 0;
  const browser = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture/count") return Response.json({ enrollmentRequests });
      if (path === "/api/runner-pairings") {
        enrollmentRequests++;
        return coordinator.enrollment(request);
      }
      return (await coordinator.browser(request, principal)) ?? new Response(null, { status: 404 });
    },
  });
  const config = {
    controlPlaneUrl: `https://localhost:${browser.port}`,
    runnerApiUrl: `https://localhost:${coordinator.port}`,
    serverCa: tls.cert,
    allowedRepositories: [],
  };
  writeFileSync(join(root, "ready.json"), JSON.stringify(config));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await browser.stop(true);
    await coordinator.stop();
    db.close();
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}
