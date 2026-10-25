// A real Paws with runner control and Create VM, where exe.dev and the VM bootstrap are the
// in-memory fakes. Enrollment still goes through POST /api/runner-enrollments with the token Paws
// minted, so the runner that appears is owned by the member who pressed Create VM.
// PAWS_FIXTURE_NO_EXE_DEV=1 starts it without the fakes and without an exe.dev token.
// Commands on stdin: fail-install, heartbeat, snapshot, stop.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { consumeWorkspaceBootstrap, putWorkspaceUser, syncWorkspaceMember } from "../../src/db";
import { startPaws } from "../../src/index";
import { createFakeBootstrap, createFakeExeDev } from "../../src/provisioning";
import { initializeRunnerCoordinator } from "../../src/runner-coordinator";
import { createRunnerKey } from "../../src/runner-identity";
import {
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceId,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
} from "../../src/workspace";
import { runtimeNativeFetch } from "./workspace-runtime-linear";

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
const serverCa = readFileSync(certPath, "utf8");

const exeDev = createFakeExeDev();
let hosts = 0;
const bootstrap = createFakeBootstrap({
  installPolls: 2,
  async enroll(vm, token) {
    hosts += 1;
    const key = await createRunnerKey(join(root, `host-${hosts}`));
    // The scripted Linear fetch refuses everything else, so enrollment uses the real one.
    const response = await runtimeNativeFetch(`${origin}/api/runner-enrollments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, name: vm, csr: key.csr }),
      tls: { ca: serverCa },
    });
    const body = (await response.json()) as { runnerId: string; workspaceId: string };
    assert.equal(response.status, 200, JSON.stringify(body));
    return { runnerId: body.runnerId, workspaceId: body.workspaceId };
  },
});

const paws = startPaws(
  {
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
  },
  {
    noTunnel: true,
    ...(process.env.PAWS_FIXTURE_NO_EXE_DEV === "1"
      ? {}
      : { memberVm: { exeDev, bootstrap, pollMs: 250 } }),
  },
);
await paws.ready;
const now = Date.now();
const owner = putWorkspaceUser(paws.db, {
  id: workspaceId(),
  linearUserId: "owner",
  name: "Owner",
  email: "owner@example.invalid",
});
const workspace = consumeWorkspaceBootstrap(paws.db, {
  id: workspaceId(),
  organizationId: "org",
  name: "Create VM proof",
  userId: owner,
  tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(paws.db, "org", now)),
  now,
});
const person = (name: string, role: "member" | "observer") => {
  const userId = putWorkspaceUser(paws.db, {
    id: workspaceId(),
    linearUserId: name.toLowerCase(),
    name,
    email: `${name.toLowerCase().replaceAll(" ", ".")}@example.invalid`,
  });
  syncWorkspaceMember(paws.db, {
    workspaceId: workspace.id,
    userId,
    role,
    active: true,
    teamIds: ["team"],
    now,
  });
  return userId;
};
const member = person("Ada Lovelace", "member");
const observer = person("Watcher", "observer");
const sessions = Object.fromEntries(
  (
    [
      ["member", member],
      ["observer", observer],
    ] as const
  ).map(([name, userId]) => [
    name,
    issueWorkspaceSession(paws.db, { userId, workspaceId: workspace.id, now }).token,
  ]),
);
console.log(JSON.stringify({ origin, cookie: WORKSPACE_COOKIE, sessions, member }));

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line === "fail-install") {
    bootstrap.fail("startInstall", "the runner installer exited 1");
    console.log(JSON.stringify({ done: line }));
  }
  if (line === "heartbeat") {
    paws.db.run("UPDATE runner SET last_seen_at=? WHERE owner_user_id=?", [Date.now(), member]);
    console.log(JSON.stringify({ done: line }));
  }
  if (line === "snapshot")
    console.log(
      JSON.stringify({
        snapshot: {
          vm: paws.db.query("SELECT step,failure,runner_id AS runnerId FROM member_vm").all(),
          runners: paws.db.query("SELECT id,name,owner_user_id AS ownerUserId FROM runner").all(),
          createVm: exeDev.calls.filter((call) => call.operation === "createVm").length,
          bootstrap: bootstrap.calls.map((call) => call.step),
        },
      }),
    );
  if (line === "stop") break;
}
lines.close();
process.stdin.pause();
await paws.stop();
