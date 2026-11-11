// A real Paws with runner control and Create VM, where exe.dev and the VM bootstrap are the
// in-memory fakes. Enrollment still goes through POST /api/runner-enrollments with the token Paws
// minted, so the runner that appears is owned by the member who pressed Create VM.
// PAWS_FIXTURE_NO_EXE_DEV=1 starts it without the fakes and without an exe.dev token.
// Commands on stdin: fail-install, heartbeat, snapshot, stop.
import assert from "node:assert/strict";
import { and, desc, eq, isNull } from "drizzle-orm";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  consumeWorkspaceBootstrap,
  insertRun,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../../src/db";
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

const paws = await startPaws(
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
    ...(process.env.PAWS_FIXTURE_NO_EXE_DEV === "1"
      ? {}
      : { memberVm: { exeDev, bootstrap, pollMs: 250 } }),
  },
);
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
  name: "Create VM proof",
  userId: owner,
  tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(paws.store, "org", now)),
  now,
});
const person = async (name: string, role: "member" | "admin") => {
  const userId = await putWorkspaceUser(paws.store, {
    id: workspaceId(),
    linearUserId: name.toLowerCase(),
    name,
    email: `${name.toLowerCase().replaceAll(" ", ".")}@example.invalid`,
  });
  await syncWorkspaceMember(paws.store, {
    workspaceId: workspace.id,
    userId,
    role,
    active: true,
    teamIds: ["team"],
    now,
  });
  return userId;
};
const member = await person("Ada Lovelace", "member");
const admin = await person("Alan Turing", "admin");
const sessions: Record<string, string> = {};
for (const [name, userId] of [
  ["member", member],
  ["admin", admin],
] as const)
  sessions[name] = (
    await issueWorkspaceSession(paws.store, { userId, workspaceId: workspace.id, now })
  ).token;
console.log(JSON.stringify({ origin, cookie: WORKSPACE_COOKIE, sessions, member }));

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line === "fail-install") {
    bootstrap.fail("startInstall", "the runner installer exited 1");
    console.log(JSON.stringify({ done: line }));
  }
  if (line === "heartbeat") {
    await paws.store.run((q) =>
      q.exec(
        q.orm
          .update(q.t.runner)
          .set({ lastSeenAt: Date.now() })
          .where(eq(q.t.runner.ownerUserId, member)),
      ),
    );
    console.log(JSON.stringify({ done: line }));
  }
  if (line === "task") {
    const runner = (await paws.store.run((q) =>
      q.one(
        q.orm
          .select({ id: q.t.runner.id })
          .from(q.t.runner)
          .where(and(eq(q.t.runner.ownerUserId, member), isNull(q.t.runner.revokedAt)))
          .orderBy(desc(q.t.runner.createdAt)),
      ),
    ))!;
    const at = Date.now();
    await paws.store.run((q) =>
      q.exec(
        q.orm.insert(q.t.workItem).values({
          id: "fixture-item",
          delegationId: "fixture-delegation",
          linearIssueId: "fixture-issue",
          linearIdentifier: "PAS-901",
          title: "Fix the login redirect",
          state: "running",
          branchName: "paws/pas-901",
          position: 0,
          createdAt: at,
        }),
      ),
    );
    const run = await insertRun(paws.store, {
      itemId: "fixture-item",
      now: at,
      status: "active",
    });
    await paws.store.run((q) =>
      q.exec(
        q.orm.insert(q.t.runnerWork).values({
          runId: run.id,
          runnerId: runner.id,
          workspaceId: workspace.id,
          generation: 1,
          runnerFence: 0,
          commandId: "fixture-command",
          leaseUntil: at + 3_600_000,
          lastSequence: 0,
        }),
      ),
    );
    console.log(JSON.stringify({ done: line }));
  }
  if (line === "snapshot")
    console.log(
      JSON.stringify({
        snapshot: {
          vm: await paws.store.run((q) =>
            q.all(
              q.orm
                .select({
                  vmName: q.t.memberVm.vmName,
                  step: q.t.memberVm.step,
                  failure: q.t.memberVm.failure,
                  runnerId: q.t.memberVm.runnerId,
                  deleteStep: q.t.memberVm.deleteStep,
                  deleteFailure: q.t.memberVm.deleteFailure,
                })
                .from(q.t.memberVm),
            ),
          ),
          runners: await paws.store.run((q) =>
            q.all(
              q.orm
                .select({
                  id: q.t.runner.id,
                  name: q.t.runner.name,
                  status: q.t.runner.status,
                  ownerUserId: q.t.runner.ownerUserId,
                })
                .from(q.t.runner),
            ),
          ),
          exeDev: [...exeDev.vms.keys()],
          deleteVm: exeDev.calls.filter((call) => call.operation === "deleteVm").length,
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
