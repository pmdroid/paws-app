import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:https";
import { join } from "node:path";
import {
  consumeWorkspaceBootstrap,
  getRunner,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../../src/db";
import {
  createRunnerControl,
  createRunnerHttp,
  RunnerEnrollmentDenied,
} from "../../src/runner-control";
import { openRunnerDaemon } from "../../src/runner-daemon";
import {
  createRunnerKey,
  describeRunnerCertificate,
  initializeRunnerAuthority,
} from "../../src/runner-identity";
import {
  issueWorkspaceBootstrap,
  workspaceId,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../../src/workspace";

async function makeServerIdentity(root: string) {
  const child = Bun.spawn(
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
      "server.key",
      "-out",
      "server.pem",
      "-days",
      "1",
      "-sha256",
      "-subj",
      "/CN=localhost",
      "-config",
      "/dev/null",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    {
      cwd: root,
      env: { PATH: "/usr/bin:/bin", HOME: root },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  assert.equal(await child.exited, 0);
}

export async function probeRunnerEnrollment(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const authorityRoot = join(root, "issuer");
  const authority = await initializeRunnerAuthority(authorityRoot);
  let now = Date.now();
  const ownerUserId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "enroll-owner",
    name: "Fixture owner",
    email: "enroll-owner@example.invalid",
  });
  const bootstrap = issueWorkspaceBootstrap(db, "enroll-org", now);
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "enroll-org",
    name: "enroll-org",
    userId: ownerUserId,
    tokenHash: workspaceTokenHash(bootstrap),
    now,
  });
  function person(name: string, active = true) {
    const userId = putWorkspaceUser(db, {
      id: workspaceId(),
      linearUserId: `enroll-${name}`,
      name,
      email: `${name}@example.invalid`,
    });
    syncWorkspaceMember(db, {
      workspaceId: workspace.id,
      userId,
      role: "member",
      active,
      teamIds: [],
      now,
    });
    const principal: WorkspacePrincipal = {
      workspaceId: workspace.id,
      userId,
      role: "member",
      authenticatedAt: now,
      teamIds: [],
    };
    return principal;
  }
  const member = person("member");
  const inactive = person("inactive", false);
  const control = createRunnerControl({
    db,
    authority,
    certificateRoot: authorityRoot,
    disconnect: () => {},
    now: () => now,
  });
  const http = createRunnerHttp(control, {
    hostConfig: () => ({
      controlPlaneUrl: "https://paws.example.invalid",
      runnerApiUrl: "https://paws.example.invalid:8788",
      allowedRepositories: ["local/fixture"],
    }),
  });
  const runners = () =>
    db.query<{ count: number }, []>("SELECT count(*) AS count FROM runner").get()!.count;
  const post = (path: string, body: unknown) =>
    new Request(`https://paws.example.invalid${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.throws(
      () => control.createEnrollment(inactive, { name: "inactive-host" }),
      /Active workspace membership/,
    );
    const minted = await http.browser(
      post("/api/runners/enrollments", { name: "member-host" }),
      member,
    );
    assert.equal(minted?.status, 200);
    const issued = (await minted!.json()) as {
      token: string;
      expiresAt: number;
      config: { runnerApiUrl: string };
    };
    assert.equal(issued.expiresAt, now + 10 * 60_000);
    assert.equal(issued.config.runnerApiUrl, "https://paws.example.invalid:8788");
    const stored = db
      .query<{ token_hash: string }, []>("SELECT token_hash FROM runner_enrollment")
      .all();
    assert.deepEqual(stored, [{ token_hash: workspaceTokenHash(issued.token) }]);
    observe("any active member mints a ten-minute token and only its hash is stored", true, {
      inactiveDenied: true,
      hashesOnly: true,
    });

    const host = await createRunnerKey(join(root, "host"));
    const enrolled = await http.hostEnrollment(
      post("/api/runner-enrollments", { token: issued.token, name: "member-host", csr: host.csr }),
    );
    assert.equal(enrolled.status, 200);
    const identity = (await enrolled.json()) as {
      status: string;
      runnerId: string;
      workspaceId: string;
      certificate: string;
      authority: string;
    };
    assert.deepEqual(Object.keys(identity).sort(), [
      "authority",
      "certificate",
      "runnerId",
      "status",
      "workspaceId",
    ]);
    assert.equal(identity.status, "approved");
    assert.equal(identity.workspaceId, workspace.id);
    assert.equal(identity.authority, authority.certificate);
    const peer = describeRunnerCertificate(identity.certificate);
    assert.equal(control.authenticate(peer).id, identity.runnerId);
    assert.equal(getRunner(db, identity.runnerId)!.ownerUserId, member.userId);
    assert.equal(getRunner(db, identity.runnerId)!.name, "member-host");
    assert.equal(getRunner(db, identity.runnerId)!.status, "paused");
    observe(
      "one POST with token, name and CSR returns the identity of a member-owned runner",
      true,
      {
        runnerId: identity.runnerId,
      },
    );

    const replay = await http.hostEnrollment(
      post("/api/runner-enrollments", { token: issued.token, name: "again", csr: host.csr }),
    );
    assert.equal(replay.status, 401);
    const unknown = await http.hostEnrollment(
      post("/api/runner-enrollments", { token: "x".repeat(43), name: "again", csr: host.csr }),
    );
    assert.equal(unknown.status, 401);
    const expiring = control.createEnrollment(member, { name: "late" });
    now = expiring.expiresAt;
    await assert.rejects(
      () => control.enroll({ token: expiring.token, name: "late", csr: host.csr }),
      RunnerEnrollmentDenied,
    );
    now = Date.now();
    assert.equal(runners(), 1);
    observe("a used, unknown or expired token answers 401 and creates nothing", true, {
      replay: replay.status,
      unknown: unknown.status,
      runners: runners(),
    });

    const leaving = control.createEnrollment(member, { name: "leaving" });
    syncWorkspaceMember(db, {
      workspaceId: workspace.id,
      userId: member.userId,
      role: "member",
      active: false,
      teamIds: [],
      now: now + 3,
    });
    await assert.rejects(
      () => control.enroll({ token: leaving.token, name: "leaving", csr: host.csr }),
      RunnerEnrollmentDenied,
    );
    assert.equal(runners(), 1);
    observe("a token whose member became inactive before use is refused", true, {
      runners: runners(),
    });

    const audit = db
      .query<{ user_id: string; action: string; subject: string }, [string]>(
        "SELECT user_id,action,subject FROM workspace_access_audit WHERE workspace_id=? AND action LIKE 'runner.%' ORDER BY id",
      )
      .all(workspace.id);
    assert.deepEqual(
      audit.filter((row) => row.action === "runner.paired"),
      [{ user_id: member.userId, action: "runner.paired", subject: identity.runnerId }],
    );
    const everything = JSON.stringify(
      db
        .query("SELECT * FROM workspace_access_audit")
        .all()
        .concat(db.query("SELECT * FROM runner_enrollment").all()),
    );
    for (const token of [issued.token, expiring.token, leaving.token])
      assert(!everything.includes(token));
    observe("runner.paired names the member and no audit or enrollment row holds a token", true, {
      audited: audit.length,
    });
  } finally {
    db.close();
  }
}

/** `enroll` on the daemon posts once, stores the identity, and is a no-op once paired. */
export async function probeDaemonEnrollment(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const authority = await initializeRunnerAuthority(join(root, "issuer"));
  await makeServerIdentity(root);
  const tls = {
    key: readFileSync(join(root, "server.key"), "utf8"),
    cert: readFileSync(join(root, "server.pem"), "utf8"),
  };
  const signing = generateKeyPairSync("ed25519");
  const publicKeyPem = signing.publicKey.export({ type: "spki", format: "pem" }).toString();
  const token = "t".repeat(43);
  const bodies: { url: string | undefined; body: Record<string, unknown> }[] = [];
  const server = createServer(tls, async (incoming, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    bodies.push({ url: incoming.url, body });
    if (body.token !== token) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    const certificate = await authority.issue(String(body.csr));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        status: "approved",
        runnerId: "runner-enrolled",
        workspaceId: "workspace-enrolled",
        certificate: certificate.pem,
        authority: authority.certificate,
        signingKeys: [{ keyId: "coordinator", publicKeyPem }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const open = () =>
    openRunnerDaemon({
      root: join(root, "daemon"),
      controlPlaneUrl: `https://localhost:${address.port}`,
      runnerApiUrl: `https://localhost:${address.port + 1}`,
      serverCa: tls.cert,
      allowedRepositories: ["local/fixture"],
    });
  try {
    let daemon = open();
    await assert.rejects(() => daemon.enroll("fixture-host", "w".repeat(43)));
    assert.equal(daemon.status().phase, "unpaired");
    const status = await daemon.enroll("fixture-host", token);
    assert.equal(status.phase, "paired");
    if (status.phase !== "paired") throw new Error("Enrollment did not pair");
    assert.equal(status.runnerId, "runner-enrolled");
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1]!.url, "/api/runner-enrollments");
    assert.deepEqual(Object.keys(bodies[1]!.body).sort(), ["csr", "name", "token"]);
    assert.equal(bodies[0]!.body.csr, bodies[1]!.body.csr);
    observe("the daemon enrolls in one POST with its token, name and CSR", true, {
      requests: bodies.length,
    });
    daemon.close();
    daemon = open();
    const again = await daemon.enroll("fixture-host", "");
    assert.equal(again.phase, "paired");
    assert.equal(bodies.length, 2);
    daemon.close();
    observe(
      "enroll on an already paired daemon returns its identity without contacting Paws",
      true,
      {
        requests: bodies.length,
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
