import { asc } from "drizzle-orm";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { consumeWorkspaceBootstrap, putWorkspaceUser, syncWorkspaceMember } from "../../src/db";
import { startPaws } from "../../src/index";
import { initializeRunnerCoordinator } from "../../src/runner-coordinator";
import { createRunnerKey } from "../../src/runner-identity";
import {
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceId,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
} from "../../src/workspace";
import "./workspace-runtime-linear";

const root = process.env.PAWS_VERIFY_ROOT;
assert(root);
mkdirSync(root, { recursive: true, mode: 0o700 });
const certPath = join(root, "server.pem"),
  keyPath = join(root, "server.key");
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
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-config",
    "/dev/null",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ],
  { stdout: "ignore", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: root } },
);
assert.equal(generated.exitCode, 0, generated.stderr.toString());
chmodSync(keyPath, 0o600);
async function reserve() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = server.port!;
  await server.stop(true);
  return port;
}
const port = await reserve(),
  runnerPort = await reserve(),
  home = join(root, "home");
mkdirSync(join(home, "secrets"), { recursive: true, mode: 0o700 });
await initializeRunnerCoordinator(join(home, "secrets", "runner-identity"));
const origin = `https://127.0.0.1:${port}`;
const paws = await startPaws({
  ...process.env,
  PAWS_HOME: home,
  KYOTOAGENT_ROOT: home,
  HOME: home,
  PAWS_HOST: "127.0.0.1",
  PAWS_PORT: String(port),
  PAWS_PUBLIC_URL: origin,
  PAWS_PUBLIC_DASHBOARD: "1",
  PAWS_TLS_KEY_PATH: keyPath,
  PAWS_TLS_CERT_PATH: certPath,
  PAWS_RUNNER_HOST: "127.0.0.1",
  PAWS_RUNNER_PORT: String(runnerPort),
  LINEAR_MODE: "agent-session",
  LINEAR_CLIENT_ID: "client",
  LINEAR_ACCESS_TOKEN: "fixture-access",
  LINEAR_APP_USER_ID: "app",
  LINEAR_WEBHOOKS: "false",
});
await paws.ready;
const now = Date.now();
const owner = await putWorkspaceUser(paws.store, {
  id: workspaceId(),
  linearUserId: "owner",
  name: "Owner",
  email: "owner@example.invalid",
});
const workspace = await consumeWorkspaceBootstrap(paws.store, {
  id: workspaceId(),
  organizationId: "org",
  name: "Runner proof",
  userId: owner,
  tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(paws.store, "org", now)),
  now,
});
const member = await putWorkspaceUser(paws.store, {
  id: workspaceId(),
  linearUserId: "member",
  name: "Member",
  email: "member@example.invalid",
});
await syncWorkspaceMember(paws.store, {
  workspaceId: workspace.id,
  userId: member,
  role: "member",
  active: true,
  teamIds: ["team"],
  now,
});
const sessions: Record<string, string> = {};
for (const [name, userId, authenticatedAt] of [
  ["owner", owner, now],
  ["member", member, now],
  ["stale", owner, now - 2 * 24 * 60 * 60_000],
] as const) {
  const issued = await issueWorkspaceSession(paws.store, {
    userId,
    workspaceId: workspace.id,
    now: authenticatedAt,
  });
  sessions[name] = issued.token;
}
const key = await createRunnerKey(join(root, "client"));
console.log(
  JSON.stringify({
    origin,
    runnerPort,
    certPath,
    cookie: WORKSPACE_COOKIE,
    sessions,
    executionIds: [workspaceId(), workspaceId()],
    client: { csr: key.csr, key: readFileSync(key.keyPath, "utf8") },
  }),
);
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line === "snapshot") {
    console.log(
      JSON.stringify({
        snapshot: {
          runners: await paws.store.run((q) =>
            q.all(q.orm.select({ id: q.t.runner.id, status: q.t.runner.status }).from(q.t.runner)),
          ),
          commands: await paws.store.run((q) =>
            q.all(
              q.orm
                .select({ kind: q.t.runnerCommand.kind })
                .from(q.t.runnerCommand)
                .orderBy(asc(q.t.runnerCommand.ordinal)),
            ),
          ),
          audit: await paws.store.run((q) =>
            q.all(
              q.orm
                .select({ action: q.t.workspaceAccessAudit.action })
                .from(q.t.workspaceAccessAudit)
                .orderBy(asc(q.t.workspaceAccessAudit.id)),
            ),
          ),
        },
      }),
    );
  }
  if (line === "stop") break;
}
lines.close();
process.stdin.pause();
await paws.stop();
