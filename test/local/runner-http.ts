import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import {
  consumeWorkspaceBootstrap,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../../src/db";
import { createRunnerControl, createRunnerHttp } from "../../src/runner-control";
import {
  createRunnerKey,
  initializeRunnerAuthority,
  startRunnerListener,
} from "../../src/runner-identity";
import {
  issueWorkspaceBootstrap,
  workspaceId,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../../src/workspace";

export async function probeRunnerHttp(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "fixture-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const bootstrap = issueWorkspaceBootstrap(db, "fixture-http", now);
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "fixture-http",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(bootstrap),
    now,
  });
  const principal: WorkspacePrincipal = {
    workspaceId: workspace.id,
    userId,
    role: "admin",
    authenticatedAt: now,
    teamIds: [],
  };
  const memberId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "fixture-member",
    name: "Member",
    email: "member@example.invalid",
  });
  syncWorkspaceMember(db, {
    workspaceId: workspace.id,
    userId: memberId,
    role: "member",
    active: true,
    teamIds: [],
    now,
  });
  const authorityRoot = join(root, "issuer");
  const authority = await initializeRunnerAuthority(authorityRoot);
  const client = await createRunnerKey(join(root, "client"));
  const serverKey = join(root, "server.key");
  const serverCert = join(root, "server.pem");
  const openssl = Bun.spawn(
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
      serverKey,
      "-out",
      serverCert,
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
      env: { PATH: "/usr/bin:/bin", HOME: root },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  assert.equal(await openssl.exited, 0);
  const tls = { key: readFileSync(serverKey, "utf8"), cert: readFileSync(serverCert, "utf8") };
  let listener: Awaited<ReturnType<typeof startRunnerListener>> | undefined;
  const control = createRunnerControl({
    db,
    authority,
    certificateRoot: authorityRoot,
    disconnect: (fingerprint) => listener?.revoke(fingerprint),
  });
  const routes = createRunnerHttp(control);
  const browser = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    async fetch(input) {
      if (new URL(input.url).pathname === "/api/runner-enrollments")
        return routes.hostEnrollment(input);
      const selected =
        input.headers.get("x-fixture-user") === "member"
          ? { ...principal, userId: memberId }
          : principal;
      return (await routes.browser(input, selected)) ?? new Response(null, { status: 404 });
    },
  });
  try {
    const send = (path: string, body?: unknown, headers?: Record<string, string>) =>
      exchange(browser.port!, path, tls.cert, { body, headers });
    const enrollment = control.createEnrollment(principal, { name: "Linux VM" });
    const enrollmentInput = { token: enrollment.token, name: enrollment.name, csr: client.csr };
    const malformed = await send("/api/runner-enrollments", {
      ...enrollmentInput,
      command: "ignored",
    });
    const oversized = await send("/api/runner-enrollments", {
      ...enrollmentInput,
      name: "X".repeat(25_000),
    });
    const plaintext = await routes.hostEnrollment(
      new Request("http://localhost/api/runner-enrollments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(enrollmentInput),
      }),
    );
    assert.deepEqual([malformed.status, oversized.status, plaintext.status], [400, 400, 400]);
    observe("enrollment rejects unknown fields, oversized input and plaintext transport", true, {});
    const enrolled = await send("/api/runner-enrollments", enrollmentInput);
    assert.equal(enrolled.status, 200);
    assert.equal(enrolled.headers["cache-control"], "no-store");
    const identity = JSON.parse(enrolled.body) as {
      certificate: string;
      authority: string;
      runnerId: string;
      workspaceId: string;
    };
    const runnerId = identity.runnerId;
    assert.equal((await send("/api/runner-enrollments", enrollmentInput)).status, 401);
    observe("HTTPS enrollment returns an identity once with no-store", true, { runnerId });
    listener = await startRunnerListener({
      tls: { ...tls, ca: authority.certificate },
      authorize(peer) {
        try {
          control.authenticate(peer);
          return true;
        } catch {
          return false;
        }
      },
      async fetch(input, peer) {
        return (await routes.runner(input, peer)) ?? new Response(null, { status: 404 });
      },
    });
    const renewed = await exchange(listener.port, "/v1/certificate", tls.cert, {
      body: { csr: client.csr },
      certificate: identity.certificate,
      key: readFileSync(client.keyPath, "utf8"),
    });
    assert.equal(renewed.status, 200);
    const replacement = JSON.parse(renewed.body) as typeof identity;
    assert.equal(replacement.runnerId, runnerId);
    assert.equal(replacement.workspaceId, workspace.id);
    assert.notEqual(replacement.certificate, identity.certificate);
    await assert.rejects(() =>
      exchange(listener!.port, "/v1/certificate", tls.cert, { body: { csr: client.csr } }),
    );
    observe(
      "certificate renewal requires an actual mTLS identity and preserves assigned ownership",
      true,
      {
        status: renewed.status,
        runnerId,
        workspaceId: replacement.workspaceId,
        missingCertificateDenied: true,
      },
    );
    const revoked = await send(`/api/runners/${runnerId}/status`, { status: "revoked" });
    assert.equal(revoked.status, 200);
    await assert.rejects(() =>
      exchange(listener!.port, "/v1/certificate", tls.cert, {
        body: { csr: client.csr },
        certificate: replacement.certificate,
        key: readFileSync(client.keyPath, "utf8"),
      }),
    );
    assert.equal((await send("/api/runner-enrollments", enrollmentInput)).status, 401);
    observe("HTTP revocation blocks both enrolled identities and enrollment claim replay", true, {
      status: revoked.status,
      renewalDenied: true,
      claimDenied: true,
    });
  } finally {
    browser.stop(true);
    await listener?.stop();
    db.close();
  }
}

async function exchange(
  port: number,
  path: string,
  ca: string,
  options: { body?: unknown; headers?: Record<string, string>; certificate?: string; key?: string },
) {
  return new Promise<{
    status: number;
    body: string;
    headers: Record<string, string | string[] | undefined>;
  }>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const outgoing = request(
      {
        hostname: "localhost",
        port,
        path,
        ca,
        cert: options.certificate,
        key: options.key,
        agent: false,
        timeout: 3000,
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(body)),
              }),
          ...options.headers,
        },
      },
      (incoming) => {
        let text = "";
        incoming.on("data", (chunk) => (text += chunk));
        incoming.on("end", () =>
          resolve({ status: incoming.statusCode ?? 0, body: text, headers: incoming.headers }),
        );
        incoming.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.on("timeout", () => outgoing.destroy(new Error("Runner HTTP verification timeout")));
    outgoing.end(body);
  });
}
