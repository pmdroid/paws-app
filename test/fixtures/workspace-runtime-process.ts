import { writeSecretFile } from "../../src/credentials";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { get, request } from "node:https";
import { join } from "node:path";
import {
  consumeWorkspaceBootstrap,
  openDatabase,
  type WorkspaceMember,
  putWorkspaceUser,
  workspaceMember,
  workspaceIdentityLinks,
} from "../../src/db";
import type { HealthReport } from "../../src/server";
import { startPaws } from "../../src/index";
import {
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceId,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
} from "../../src/workspace";
import { runtimeLinear, runtimeNativeFetch } from "./workspace-runtime-linear";

const mode = process.argv[2]!;
const failures: unknown[] = [];
process.on("unhandledRejection", (error) => failures.push(String(error)));
const source: Record<string, string | undefined> = {
  ...process.env,
  PAWS_PORT: "0",
  PAWS_HOST: "127.0.0.1",
};
if (mode === "no-tls") {
  let error: unknown;
  try {
    startPaws(source);
  } catch (caught) {
    error = caught;
  }
  const opened = existsSync(join(source.PAWS_HOME!, "paws.db"));
  console.log(
    JSON.stringify([
      {
        name: "public opt-in without TLS fails before opening the database or listener",
        passed: error instanceof Error && error.message.includes("TLS") && !opened,
        observed: { error: String(error), opened },
      },
    ]),
  );
  process.exit(0);
}
if (mode === "legacy") source.PAWS_HOST = "0.0.0.0";
if (mode === "public") {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null),
  });
  source.PAWS_PORT = String(reservation.port);
  source.PAWS_PUBLIC_URL = `https://127.0.0.1:${reservation.port}`;
  await reservation.stop(true);
}
const readiness = Promise.withResolvers<void>();
if (mode === "pending" || mode === "pending-stop") runtimeLinear.installation = readiness.promise;
if (mode === "public")
  writeSecretFile(
    join(source.PAWS_HOME!, "secrets", "slack-oauth.json"),
    JSON.stringify({
      accessToken: "fixture-slack-identity-token",
      refreshToken: null,
      expiresAtMs: null,
      scope: "users:read.email",
      teamId: "T123",
      botUserId: "U123",
    }),
  );
const paws = startPaws(source);
const tls = source.PAWS_PUBLIC_DASHBOARD === "1";
const origin = `${tls ? "https" : "http"}://127.0.0.1:${paws.server.port}`;
const observations: { name: string; passed: boolean; observed: unknown }[] = [];
const observe = (name: string, passed: boolean, observed: unknown) =>
  observations.push({ name, passed, observed });

async function read(path: string, body?: string, signature?: string, cookie?: string) {
  if (!tls) {
    const response = await runtimeNativeFetch(`${origin}${path}`);
    return { status: response.status, body: await response.text(), cookie: null, location: null };
  }
  return new Promise<{
    status: number;
    body: string;
    cookie: string | null;
    location: string | null;
  }>((resolve, reject) => {
    const options = {
      hostname: "127.0.0.1",
      port: paws.server.port,
      path,
      ca: readFileSync(source.PAWS_TLS_CERT_PATH!),
      rejectUnauthorized: true,
      headers: { accept: "text/html", ...(cookie ? { cookie } : {}) },
    };
    const receive = (response: import("node:http").IncomingMessage) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode!,
          body: text,
          cookie:
            response.headers["set-cookie"]?.find((entry) =>
              entry.startsWith("__Host-paws-session="),
            ) ??
            response.headers["set-cookie"]?.[0] ??
            null,
          location: response.headers.location ?? null,
        }),
      );
      response.on("error", reject);
    };
    const req =
      body === undefined
        ? get(options, receive)
        : request(
            {
              ...options,
              method: "POST",
              headers: {
                "linear-delivery": workspaceId(),
                "linear-signature": signature!,
              },
            },
            receive,
          );
    req.setTimeout(5000, () => req.destroy(new Error("Local HTTPS timed out")));
    req.on("error", reject);
    if (body !== undefined) req.end(body);
  });
}

function permissionPayload() {
  return JSON.stringify({
    type: "PermissionChange",
    action: "teamAccessChanged",
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    createdAt: new Date().toISOString(),
    webhookTimestamp: Date.now(),
    canAccessAllPublicTeams: true,
    addedTeamIds: [],
    removedTeamIds: [],
  });
}

function createOwner() {
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
    name: "Local workspace",
    userId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(paws.db, "org", now)),
    now,
  });
  const issued = issueWorkspaceSession(paws.db, { userId, workspaceId: workspace.id, now });
  return { userId, workspace, issued };
}

try {
  const health = await read("/health");
  const healthReport = JSON.parse(health.body) as HealthReport;
  if (mode === "pending-stop") {
    const { userId, workspace } = createOwner();
    runtimeLinear.active = false;
    const payload = permissionPayload();
    const accepted = await read(
      "/webhooks/linear",
      payload,
      createHmac("sha256", "fixture-webhook").update(payload).digest("hex"),
    );
    let stopped = false;
    const stopping = paws.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(10);
    const waited = !stopped;
    readiness.resolve();
    await stopping;
    const db = openDatabase(paws.paths.db);
    const member = workspaceMember(db, workspace.id, userId);
    const sessions = db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM workspace_session")
      .get()!.count;
    const handled = db.query<{ handled: number }, []>("SELECT handled FROM inbox_event").get()!;
    db.close();
    observe(
      "shutdown joins an accepted permission change awaiting installation before closing workspace access",
      accepted.status === 200 &&
        waited &&
        runtimeLinear.reads === 1 &&
        member?.active === false &&
        sessions === 0 &&
        handled.handled === 1 &&
        failures.length === 0,
      {
        status: accepted.status,
        waited,
        reads: runtimeLinear.reads,
        memberActive: member?.active,
        sessions,
        handled: handled.handled,
        unhandled: failures,
      },
    );
    console.log(JSON.stringify(observations));
    process.exit(0);
  }
  if (mode === "pending") {
    const body = permissionPayload();
    const signature = createHmac("sha256", source.LINEAR_WEBHOOK_SECRET!)
      .update(body)
      .digest("hex");
    let signedStatus: number | null = null;
    let unsignedStatus: number | null = null;
    let protectedStatus: number | null = null;
    const requests = Promise.all([
      read("/webhooks/linear", body, signature).then((response) => {
        signedStatus = response.status;
      }),
      read("/webhooks/linear", body, "invalid").then((response) => {
        unsignedStatus = response.status;
      }),
      read("/api/status").then((response) => {
        protectedStatus = response.status;
      }),
    ]);
    await Promise.race([requests, Bun.sleep(1000)]);
    const beforeReady = { signedStatus, unsignedStatus, protectedStatus };
    readiness.resolve();
    await requests;
    const persisted = paws.db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM inbox_event")
      .get()!.count;
    observe(
      "pending installation keeps signed webhooks live and protected APIs closed",
      beforeReady.signedStatus === 200 &&
        beforeReady.unsignedStatus === 401 &&
        beforeReady.protectedStatus === 503 &&
        persisted === 1,
      { beforeReady, persisted },
    );
  }
  const status = await read("/api/status");
  observe(
    mode === "legacy"
      ? "public URL alone retains local dashboard behavior"
      : "public opt-in protects production API over verified HTTPS",
    health.status === (mode === "legacy" ? 200 : 503) &&
      JSON.stringify(healthReport.failedChecks) ===
        JSON.stringify(mode === "legacy" ? [] : ["linearWebhook"]) &&
      paws.server.hostname === "127.0.0.1" &&
      status.status === (mode === "legacy" ? 200 : mode === "failed" ? 503 : 401),
    {
      health: health.status,
      healthReport,
      status: status.status,
      hostname: paws.server.hostname,
      tls,
    },
  );
  if (mode === "public") {
    const { userId, workspace, issued } = createOwner();
    const begin = await read("/auth/linear");
    const redirect = new URL(begin.location!);
    const callback = await read(
      `/auth/linear/callback?state=${encodeURIComponent(redirect.searchParams.get("state")!)}&code=owner`,
      undefined,
      undefined,
      begin.cookie!.split(";")[0],
    );
    const signedIn = await read(
      "/api/auth/session",
      undefined,
      undefined,
      callback.cookie!.split(";")[0],
    );
    const identity = JSON.parse(signedIn.body) as {
      userId?: string;
      workspaceId?: string;
      role?: string;
    };
    observe(
      "production HTTPS composition completes Linear sign-in and serves the verified workspace identity",
      begin.status === 303 &&
        callback.status === 303 &&
        signedIn.status === 200 &&
        identity.userId === userId &&
        identity.workspaceId === workspace.id &&
        identity.role === "owner",
      {
        begin: begin.status,
        callback: callback.status,
        session: signedIn.status,
        principal: {
          userId: identity.userId,
          workspaceId: identity.workspaceId,
          role: identity.role,
        },
      },
    );
    let failedRoute;
    paws.db.exec("ALTER TABLE work_item RENAME TO runtime_fault_item");
    try {
      failedRoute = await read("/api/status", undefined, undefined, callback.cookie!.split(";")[0]);
    } finally {
      paws.db.exec("ALTER TABLE runtime_fault_item RENAME TO work_item");
    }
    const recovered = await read(
      "/api/status",
      undefined,
      undefined,
      callback.cookie!.split(";")[0],
    );
    const detailsVisible =
      failedRoute.body.includes("no such table") || failedRoute.body.includes("workspace-scope.ts");
    observe(
      "manual public startup hides route error details and recovers after a database fault",
      failedRoute.status === 500 && !detailsVisible && recovered.status === 200,
      { failed: failedRoute.status, detailsVisible, recovered: recovered.status },
    );
    const link = workspaceIdentityLinks(paws.db, workspace.id).find(
      (value) => value.userId === userId && value.provider === "slack",
    );
    observe(
      "production startup resolves installed Slack identity after browser sign-in",
      runtimeLinear.slackReads === 1 &&
        link?.externalId === "U456" &&
        link.installationId === "T123" &&
        link.method === "email" &&
        link.status === "linked",
      { reads: runtimeLinear.slackReads, link },
    );
    runtimeLinear.active = false;
    const payload = permissionPayload();
    const priorReads = runtimeLinear.reads;
    const bad = await read("/webhooks/linear", payload, "bad");
    const before = runtimeLinear.reads;
    const good = await read(
      "/webhooks/linear",
      payload,
      createHmac("sha256", "fixture-webhook").update(payload).digest("hex"),
    );
    let member: WorkspaceMember | null = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      member = workspaceMember(paws.db, workspace.id, userId);
      if (member?.active === false) break;
      await Bun.sleep(5);
    }
    const remaining = paws.db
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM workspace_session WHERE token_hash=?",
      )
      .get(workspaceTokenHash(issued.token))!.count;
    observe(
      "only verified permission delivery refreshes membership and revokes durable sessions",
      bad.status === 401 &&
        before === priorReads &&
        runtimeLinear.reads === priorReads + 1 &&
        good.status === 200 &&
        member?.active === false &&
        remaining === 0,
      {
        bad: bad.status,
        good: good.status,
        before,
        reads: runtimeLinear.reads,
        member,
        remaining,
        cookieName: WORKSPACE_COOKIE,
      },
    );
  }
  await Bun.sleep(10);
  observe(
    "installation failure is handled without an unhandled rejection",
    failures.length === 0,
    failures,
  );
} finally {
  readiness.resolve();
  await paws.stop();
}
console.log(JSON.stringify(observations));
process.exit(0);
