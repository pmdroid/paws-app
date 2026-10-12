import { fileURLToPath } from "node:url";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consumeWorkspaceBootstrap, migrate, openDatabase, putWorkspaceUser } from "../../src/db";
import { startServer } from "../../src/server";
import {
  createWorkspaceAccess,
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceId,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
  type WorkspaceAccess,
} from "../../src/workspace";

type Observe = (name: string, passed: boolean, observed: unknown) => void;

export async function probeWorkspaceRuntime(root: string, observe: Observe) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  await probeWorkspaceHttpDrain(join(root, "http-drain.db"), observe);
  const key = join(root, "local.key");
  const cert = join(root, "local.crt");
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
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { env: { PATH: "/usr/bin:/bin", HOME: root } },
  );
  if (certificate.exitCode !== 0) throw new Error("Local TLS fixture generation failed.");
  chmodSync(key, 0o600);
  for (const mode of ["legacy", "public", "pending", "pending-stop", "failed", "no-tls"] as const) {
    const home = join(root, mode);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "test/fixtures/workspace-runtime-process.ts", mode],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        env: {
          PATH: process.env.PATH,
          HOME: home,
          KYOTOAGENT_ROOT: home,
          PAWS_HOME: home,
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-paws-verification-bus",
          PAWS_PUBLIC_URL: "https://localhost",
          ...(mode === "legacy"
            ? {}
            : {
                PAWS_PUBLIC_DASHBOARD: "1",
                ...(mode === "no-tls" ? {} : { PAWS_TLS_KEY_PATH: key, PAWS_TLS_CERT_PATH: cert }),
                LINEAR_MODE: "agent-session",
                LINEAR_CLIENT_ID: "client",
                LINEAR_ACCESS_TOKEN: "fixture-access",
                LINEAR_APP_USER_ID: "app",
                LINEAR_WEBHOOKS: "true",
                LINEAR_WEBHOOK_SECRET: "fixture-webhook",
              }),
          ...(mode === "failed" ? { PAWS_VERIFY_INSTALL_FAIL: "1" } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timeout = setTimeout(() => child.kill(), 15_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      writeFileSync(join(root, `${mode}.log`), stdout + stderr);
      if (code !== 0) throw new Error(`Runtime ${mode} fixture exited ${code}: ${stderr}`);
      const observations = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
        name: string;
        passed: boolean;
        observed: unknown;
      }[];
      for (const value of observations) observe(value.name, value.passed, value.observed);
    } finally {
      clearTimeout(timeout);
      child.kill();
      await child.exited;
    }
  }
  for (const mode of ["operator", "unverified"] as const) {
    const home = join(root, mode);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const bootstrap = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        "./test/fixtures/workspace-runtime-linear.ts",
        "src/index.ts",
        "workspace",
        "bootstrap",
      ],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        env: {
          PATH: process.env.PATH,
          HOME: home,
          PAWS_HOME: home,
          KYOTOAGENT_ROOT: home,
          LINEAR_MODE: "agent-session",
          LINEAR_CLIENT_ID: "client",
          LINEAR_ACCESS_TOKEN: "fixture-access",
          ...(mode === "unverified" ? { PAWS_VERIFY_INSTALL_USER: "1" } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, errors, code] = await Promise.all([
      new Response(bootstrap.stdout).text(),
      new Response(bootstrap.stderr).text(),
      bootstrap.exited,
    ]);
    const db = openDatabase(join(home, "paws.db"));
    const grant = output.match(/minutes\): ([A-Za-z0-9_-]{43})/u)?.[1];
    const stored =
      grant === undefined
        ? null
        : db
            .query<{ organization_id: string }, [string]>(
              "SELECT organization_id FROM workspace_bootstrap WHERE token_hash=?",
            )
            .get(workspaceTokenHash(grant));
    const count = db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM workspace_bootstrap")
      .get()!.count;
    observe(
      mode === "operator"
        ? "operator CLI issues a hashed single-use grant for the verified installed organization"
        : "operator CLI rejects a human credential without issuing a grant",
      mode === "operator"
        ? code === 0 &&
            stored?.organization_id === "org" &&
            output.includes("Local workspace (org)")
        : code === 1 && count === 0,
      { code, organization: stored?.organization_id, count, errors },
    );
    db.close();
  }
}

async function probeWorkspaceHttpDrain(path: string, observe: Observe) {
  const db = openDatabase(path);
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
    name: "Workspace",
    userId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  const session = issueWorkspaceSession(db, { userId, workspaceId: workspace.id, now });
  const ready = Promise.withResolvers<WorkspaceAccess>();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let readCompleted = false;
  let error: string | null = null;
  const server = startServer({
    hostname: "127.0.0.1",
    port: 0,
    db,
    webhooks: false,
    workspaceAccess: ready.promise,
    runnerControl: async () => {
      entered.resolve();
      await gate.promise;
      try {
        db.query("SELECT id FROM workspace WHERE id=?").get(workspace.id);
        readCompleted = true;
      } catch (caught) {
        error = String(caught);
      }
      return Response.json({ readCompleted });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const access = createWorkspaceAccess({
    db,
    publicUrl: origin,
    clientId: "client",
    installedOrganization: { id: "org", name: "Workspace" },
    memberships: {
      async installation() {
        return { id: "org", name: "Workspace" };
      },
      async member(organizationId, linearUserId) {
        return {
          organizationId,
          userId: linearUserId,
          active: true,
          guest: false,
          admin: false,
          teamIds: [],
        };
      },
    },
  });
  ready.resolve(access);
  const response = fetch(`${origin}/api/runners/drain-proof`, {
    headers: { cookie: `${WORKSPACE_COOKIE}=${session.token}` },
  }).catch(() => null);
  await entered.promise;
  let stopped = false;
  const stopping = Promise.all([server.stop(true), access.stop()]).then(() => {
    db.close();
    stopped = true;
  });
  await Bun.sleep(10);
  const waited = !stopped;
  gate.resolve();
  await Promise.all([stopping, response]);
  observe(
    "HTTP shutdown joins an already authenticated async callback before SQLite closes",
    waited && stopped && readCompleted && error === null,
    { waited, stopped, readCompleted, error },
  );
}
