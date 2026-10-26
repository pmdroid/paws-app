import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { createConnection } from "node:net";
import { join } from "node:path";
import {
  consumeWorkspaceBootstrap,
  putWorkspaceUser,
  syncWorkspaceMember,
  insertQueuedItem,
  recordLinearInstallation,
  bindLinearSessionTask,
  getWorkItem,
  listOutbox,
} from "../../src/db";
import type { EnvSource } from "../../src/config";
import { startPaws } from "../../src/index";
import { createRunnerKey } from "../../src/runner-identity";
import { createFakeGitHub } from "../../src/github";
import { createFakeRunnerTranscriptObjects } from "../../src/runner-transcripts";
import {
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceId,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
} from "../../src/workspace";
import { runtimeLinear, runtimeNativeFetch } from "./workspace-runtime-linear";
import { probeExecutionRuntime } from "../local/execution-runtime";

const mode = process.argv[2]!;
const enabled = mode === "enabled" || mode === "remote";
const realNow = Date.now;
let executionClockOffset = 0;
if (mode === "enabled") Date.now = () => realNow() + executionClockOffset;
const source: EnvSource = { ...process.env, PAWS_PORT: "0", PAWS_HOST: "127.0.0.1" };
if (mode === "remote") source.PAWS_EXECUTION = "remote";
if (mode === "enabled") {
  source.LINEAR_WEBHOOKS = "true";
  source.LINEAR_WEBHOOK_SECRET = "execution-runtime-webhook";
}
const observations: { name: string; passed: boolean; observed: unknown }[] = [];
const observe = (name: string, observed: unknown) =>
  observations.push({ name, passed: true, observed });
const root = source.PAWS_HOME!;
const localAgent = join(root, "local-agent-launched");
if (mode === "remote") {
  const sentinel = join(root, "forbidden-local-agent.ts");
  writeFileSync(
    sentinel,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(localAgent)}, "launched"); process.exit(1);`,
  );
  process.env.PAWS_CODEX_ACP = `${process.execPath} ${sentinel}`;
}
if (mode === "invalid-execution") {
  source.PAWS_EXECUTION = "local";
  assert.throws(() => startPaws(source), /remote runner/);
  source.PAWS_EXECUTION = "remtoe";
  assert.throws(() => startPaws(source), /PAWS_EXECUTION must be remote/);
  assert(!existsSync(join(root, "paws.db")));
  observe("local and unknown execution modes fail before opening production state", {
    databaseOpened: false,
  });
  console.log(JSON.stringify(observations));
  process.exit(0);
}
const ca = readFileSync(source.PAWS_TLS_CERT_PATH!, "utf8");
async function reserve() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = server.port!;
  await server.stop(true);
  return port;
}
// Keep the browser listener bound while identities initialize and runner startup begins.
// Closing a port probe here lets another parallel test or the runner claim the port.
const browserServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls: { key: readFileSync(source.PAWS_TLS_KEY_PATH!, "utf8"), cert: ca },
  fetch: () => new Response(null, { status: 503 }),
});
const browserPort = browserServer.port!;
const runnerPort = await reserve();
source.PAWS_PORT = String(browserPort);
source.PAWS_PUBLIC_URL = `https://127.0.0.1:${browserPort}`;
if (mode !== "disabled") {
  source.PAWS_RUNNER_HOST = "127.0.0.1";
  source.PAWS_RUNNER_PORT = String(runnerPort);
}
if (mode === "transcripts-later") {
  source.GITHUB_AUTH = "app";
  source.GITHUB_APP_ID = "99";
  source.GITHUB_APP_INSTALLATION_ID = "1";
  source.GITHUB_APP_PRIVATE_KEY_PATH = source.PAWS_TLS_KEY_PATH;
  const paws = startPaws(source, { noTunnel: true, server: browserServer });
  try {
    const health = await runtimeNativeFetch(`https://127.0.0.1:${browserPort}/health`, {
      tls: { ca },
    });
    assert.equal(health.status, 200);
  } finally {
    await paws.stop();
  }
  observe(
    "runner and GitHub App configuration serves the dashboard with default local transcripts",
    { health: 200 },
  );
  console.log(JSON.stringify(observations));
  process.exit(0);
}
if (mode === "invalid") {
  source.PAWS_RUNNER_HOST = "https://invalid.example/path";
  assert.throws(() => startPaws(source, { noTunnel: true }), /hostname or IP/);
  assert(!existsSync(join(root, "paws.db")));
  observe("invalid runner hostname fails before opening production state", {
    databaseOpened: false,
  });
  console.log(JSON.stringify(observations));
  process.exit(0);
}
if (enabled || mode === "pending") {
  async function initialize() {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "src/index.ts", "runner-authority", "init"],
      { env: source, stdout: "pipe", stderr: "pipe" },
    );
    const [exit, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exit, output, error };
  }
  const first = await initialize();
  assert.equal(first.exit, 0, first.error);
  const identity = join(root, "secrets", "runner-identity");
  const hashes = () =>
    ["runner-authority.json", "runner-command-key.pem", ".envelope-key"].map((name) =>
      createHash("sha256")
        .update(readFileSync(join(identity, name)))
        .digest("hex"),
    );
  const before = hashes();
  assert.equal((await initialize()).exit, 1);
  assert.deepEqual(hashes(), before);
  observe(
    "normal CLI initializes protected runner identities and preserves them on repeated init",
    { firstExit: 0, duplicateExit: 1, identitiesUnchanged: true },
  );
}
const pending = Promise.withResolvers<void>();
if (mode === "pending") runtimeLinear.installation = pending.promise;
if (mode === "remote") {
  const config = join(root, "secrets", "runner-transcript-storage.json");
  writeFileSync(config, "invalid", { mode: 0o600 });
  assert.throws(
    () =>
      startPaws(source, {
        runnerRepositoryAccess: {
          github: createFakeGitHub(),
          installationForRepository: () => "fixture-installation",
        },
      }),
    /configuration is missing or invalid/,
  );
  assert(!existsSync(join(root, "paws.db")));
  rmSync(config);
}
const paws = startPaws(source, {
  noTunnel: true,
  server: browserServer,
  ...(enabled
    ? {
        runnerRepositoryAccess: {
          github: createFakeGitHub(),
          installationForRepository: () => "fixture-installation",
        },
        ...(mode === "remote"
          ? {}
          : { runnerTranscriptObjects: createFakeRunnerTranscriptObjects() }),
      }
    : {}),
});
let stopped = false;
async function call<T = Record<string, unknown>>(
  port: number,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  peer?: { cert: string; key: string },
) {
  return await new Promise<{ status: number; body: T }>((resolve, reject) => {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    const input = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        ca,
        ...peer,
        minVersion: "TLSv1.3",
        agent: false,
        method: bytes ? "POST" : "GET",
        headers: {
          ...(bytes
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(bytes)),
              }
            : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          try {
            resolve({
              status: response.statusCode!,
              body: (text
                ? response.headers["content-type"]?.startsWith("application/json")
                  ? JSON.parse(text)
                  : { text }
                : {}) as T,
            });
          } catch (error) {
            reject(error);
          }
        });
        response.on("error", reject);
      },
    );
    input.setTimeout(5000, () => input.destroy(new Error("Local runner HTTPS timed out")));
    input.once("error", reject);
    input.end(bytes);
  });
}
async function closed(port: number) {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}
try {
  if (mode === "missing") {
    await assert.rejects(paws.ready, /authority|identity|invalid/);
    assert.equal((await call(browserPort, "/api/runners")).status, 503);
    assert(await closed(runnerPort));
    observe("missing initialized runner identity keeps normal startup and APIs unready", {
      readyRejected: true,
      apiStatus: 503,
      runnerListenerClosed: true,
    });
  } else if (mode === "pending") {
    assert.equal((await call(browserPort, "/api/runners")).status, 503);
    const stopping = paws.stop();
    pending.resolve();
    await stopping;
    stopped = true;
    await assert.rejects(paws.ready, /stopping/);
    observe("shutdown during pending workspace readiness joins the runner startup", {
      pendingApiStatus: 503,
      readinessRejected: true,
    });
  } else {
    await paws.ready;
    const now = Date.now();
    const userId = putWorkspaceUser(paws.db, {
      id: workspaceId(),
      linearUserId: "owner",
      name: "Owner",
      email: "owner@example.invalid",
    });
    const workspace = consumeWorkspaceBootstrap(paws.db, {
      id: workspaceId(),
      organizationId: "org",
      name: "Fixture",
      userId,
      tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(paws.db, "org", now)),
      now,
    });
    const issued = issueWorkspaceSession(paws.db, { userId, workspaceId: workspace.id, now });
    const headers = {
      cookie: `${WORKSPACE_COOKIE}=${issued.token}`,
      origin: source.PAWS_PUBLIC_URL!,
      "x-paws-csrf": issued.session.csrfToken,
    };
    if (mode === "disabled") {
      assert(await closed(runnerPort));
      assert(!existsSync(join(root, "secrets", "runner-identity")));
      assert.equal((await call(browserPort, "/api/runners")).status, 401);
      const setup = await call(browserPort, "/api/runners", undefined, headers);
      assert.equal(setup.status, 200);
      assert.deepEqual(setup.body, { runners: [], setupRequired: true, workspaceReady: true });
      observe("normal startup keeps runner control disabled when no hostname is configured", {
        authorityCreated: false,
        runnerListenerClosed: true,
        apiStatus: 200,
        setupRequired: true,
        anonymousStatus: 401,
      });
    } else {
      assert.equal((await call(browserPort, "/api/runners")).status, 401);
      const key = await createRunnerKey(join(root, "client"));
      const enrollPath = "/api/runners/enrollments";
      assert.equal(
        (
          await call(
            browserPort,
            enrollPath,
            { name: "Startup runner" },
            { cookie: headers.cookie, origin: headers.origin },
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await call(
            browserPort,
            enrollPath,
            { name: "Startup runner" },
            { ...headers, origin: "https://foreign.invalid" },
          )
        ).status,
        403,
      );
      const enrollment = await call<{ token: string; name: string }>(
        browserPort,
        enrollPath,
        { name: "Startup runner" },
        headers,
      );
      assert.equal(enrollment.status, 200);
      const claimed = await call<{ certificate: string; runnerId: string; signingKeys: unknown[] }>(
        browserPort,
        "/api/runner-enrollments",
        {
          token: enrollment.body.token,
          name: enrollment.body.name,
          csr: key.csr,
        },
      );
      assert.equal(claimed.status, 200);
      assert(claimed.body.certificate && claimed.body.signingKeys.length === 1);
      const peer = {
        cert: claimed.body.certificate as string,
        key: readFileSync(key.keyPath, "utf8"),
      };
      observe(
        "normal Paws HTTPS enrollment enforces sessions, Origin and CSRF before advertising public signer",
        {
          anonymousAdminStatus: 401,
          missingCsrfStatus: 403,
          foreignOriginStatus: 403,
          approved: true,
        },
      );
      const memberId = putWorkspaceUser(paws.db, {
        id: workspaceId(),
        linearUserId: "member",
        name: "Member",
        email: "member@example.invalid",
      });
      syncWorkspaceMember(paws.db, {
        workspaceId: workspace.id,
        userId: memberId,
        role: "member",
        active: true,
        teamIds: [],
        now,
      });
      const memberSession = issueWorkspaceSession(paws.db, {
        userId: memberId,
        workspaceId: workspace.id,
        now,
      });
      const memberHeaders = {
        ...headers,
        cookie: `${WORKSPACE_COOKIE}=${memberSession.token}`,
        "x-paws-csrf": memberSession.session.csrfToken,
      };
      const healthPath = `/api/runners/${claimed.body.runnerId}/health`;
      for (const path of ["repository-credential", "artifacts", "transcript/chunks"]) {
        assert.equal(
          (
            await call(
              runnerPort,
              `/v1/runs/unknown/${path}`,
              {},
              { authorization: `Bearer ${"A".repeat(43)}` },
              peer,
            )
          ).status,
          403,
        );
      }
      const healthInput = { type: "probe", profile: { agent: "codex", model: null } };
      assert.equal((await call(browserPort, healthPath, healthInput, memberHeaders)).status, 403);
      const health = await call<{ commandId: string }>(
        browserPort,
        healthPath,
        healthInput,
        headers,
      );
      assert.equal(health.status, 200);
      assert.equal((await call(runnerPort, "/v1/heartbeat", {}, {}, peer)).status, 200);
      const commands = await call<{ commands: unknown[] }>(
        runnerPort,
        "/v1/commands",
        undefined,
        {},
        peer,
      );
      assert.equal(commands.body.commands.length, 1);
      const healthResult = {
        executionId: workspaceId(),
        commandId: health.body.commandId,
        role: "implementer",
        stopReason: "end_turn",
        timedOut: false,
        cancelled: false,
        authRequired: false,
        agentExited: true,
        models: [{ id: "scripted", name: "Scripted" }],
      };
      assert.equal((await call(runnerPort, "/v1/health", healthResult, {}, peer)).status, 200);
      const healthRead = await call<{ checks: { result: unknown }[] }>(
        browserPort,
        healthPath,
        undefined,
        memberHeaders,
      );
      assert.equal(healthRead.status, 200);
      assert.deepEqual(healthRead.body.checks[0]!.result, healthResult);
      observe(
        "normal runner monitoring composes persisted roles with actual mTLS heartbeat and health",
        { memberMutationStatus: 403, memberReadStatus: 200, healthPersisted: true },
      );
      if (mode === "enabled") {
        assert.equal(
          (
            await call(
              browserPort,
              `/api/runners/${claimed.body.runnerId}/policy`,
              undefined,
              headers,
            )
          ).status,
          200,
        );
        observe("Production Paws startup wires the host sharing policy route", {
          hostPolicy: true,
        });
        const controlled = insertQueuedItem(paws.db, {
          id: "startup-controlled",
          sessionKey: "startup-controlled-session",
          now,
        });
        recordLinearInstallation(paws.db, {
          sessionId: controlled.sessionKey!,
          organizationId: "org",
          teamId: "team",
          oauthClientId: "client",
          appUserId: "app",
          observedAtMs: now,
        });
        bindLinearSessionTask(paws.db, controlled.sessionKey!, controlled.delegationId);
        const available = await call<{ available: boolean; actions: string[] }>(
          browserPort,
          `/api/execution-controls?itemId=${controlled.id}`,
          undefined,
          headers,
        );
        assert.equal(available.status, 200);
        assert(available.body.available && available.body.actions.includes("stop"));
        const stopResult = await call(
          browserPort,
          "/api/execution-controls",
          {
            itemId: controlled.id,
            action: "stop",
          },
          headers,
        );
        assert.equal(stopResult.status, 200);
        assert.equal(getWorkItem(paws.db, controlled.id)?.state, "cancelled");
        assert(
          listOutbox(paws.db, controlled.sessionKey!).some(
            (row) =>
              row.delivery === "stop" &&
              (row.payload as { body?: string }).body?.startsWith("Stopped from Paws. ") === true,
          ),
        );
        observe(
          "Production Paws startup exposes scoped selected-item Stop through its actual orchestrator",
          {
            available: true,
            cancelled: true,
            origin: "Paws",
          },
        );
      }
      if (mode === "remote") {
        assert(!existsSync(localAgent), "remote startup must not launch a local ACP adapter");
        observe("remote startup does not launch a local agent from agent settings", {
          localAgentLaunched: false,
        });
      }
      const renewed = await call(runnerPort, "/v1/certificate", { csr: key.csr }, {}, peer);
      assert.equal(renewed.status, 200);
      assert.deepEqual(renewed.body.signingKeys, claimed.body.signingKeys);
      assert.equal(
        (
          await call(
            browserPort,
            `/api/runners/${claimed.body.runnerId}/status`,
            { status: "revoked" },
            headers,
          )
        ).status,
        200,
      );
      let denied = false;
      try {
        denied = (await call(runnerPort, "/v1/heartbeat", {}, {}, peer)).status === 403;
      } catch {
        denied = true;
      }
      assert(denied);
      observe("normal startup supports mTLS renewal and authenticated administrative revocation", {
        signerPreserved: true,
        revokedRunnerDenied: true,
      });
      if (mode === "enabled")
        await probeExecutionRuntime({
          db: paws.db,
          workspaceId: workspace.id,
          secret: source.LINEAR_WEBHOOK_SECRET!,
          catchUp: () => paws.catchUp(),
          post: (body, eventHeaders) => call(browserPort, "/webhooks/linear", body, eventHeaders),
          advance(ms) {
            executionClockOffset += ms;
          },
          observe,
        });
    }
  }
} finally {
  if (!stopped) await paws.stop();
}
assert(await closed(browserPort));
assert(await closed(runnerPort));
observe("normal shutdown closes both owned HTTPS listeners", {
  mode,
  browserClosed: true,
  runnerClosed: true,
});
console.log(JSON.stringify(observations));
