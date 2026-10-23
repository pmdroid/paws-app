import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:https";
import type { Socket } from "node:net";
import { join } from "node:path";
import {
  createRunnerKey,
  initializeRunnerAuthority,
  openRunnerAuthority,
  startRunnerListener,
  validateRunnerRequest,
} from "../../src/runner-identity";

type Observe = (name: string, passed: boolean, observed: unknown) => void;

export async function probeRunnerTls(root: string, observe: Observe): Promise<void> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const issuerRoot = join(root, "issuer");
  const authority = await initializeRunnerAuthority(issuerRoot);
  const client = await createRunnerKey(join(root, "client"));
  const certificate = await authority.issue(client.csr);
  const server = await serverIdentity(join(root, "server"));
  const accepted: unknown[] = [];
  const active = new Set([certificate.fingerprint]);
  let now = Date.now();
  let streamCancelled = false;
  let rejectedStreamCancelled = false;
  let authorizationCount = 0;
  let expireAtAuthorization = 0;
  let bodyAuthorized: (() => void) | undefined;
  const logged: string[] = [];
  const listener = await startRunnerListener({
    tls: { ...server, ca: authority.certificate },
    now: () => now,
    log: (line) => logged.push(line),
    authorize: async (peer) => {
      authorizationCount++;
      if (authorizationCount === expireAtAuthorization) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        now = certificate.notAfter + 1;
      }
      bodyAuthorized?.();
      bodyAuthorized = undefined;
      return active.has(peer.fingerprint);
    },
    async fetch(input, peer) {
      accepted.push({ path: new URL(input.url).pathname, peer });
      if (new URL(input.url).pathname === "/unavailable")
        return new Response(null, { status: 503 });
      if (new URL(input.url).pathname === "/slow") {
        now += 6_000;
        return new Response(null, { status: 204 });
      }
      if (new URL(input.url).pathname === "/expire-before-response") {
        now = certificate.notAfter + 1;
        return new Response(null, { status: 204 });
      }
      if (new URL(input.url).pathname === "/expire-stream-before-response") {
        now = certificate.notAfter + 1;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("must not escape"));
            },
            cancel() {
              rejectedStreamCancelled = true;
            },
          }),
        );
      }
      if (new URL(input.url).pathname === "/stream")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("assigned command"));
            },
            cancel() {
              streamCancelled = true;
            },
          }),
        );
      return Response.json({ fingerprint: peer.fingerprint, serial: peer.serial });
    },
  });
  const key = readFileSync(client.keyPath, "utf8");
  const sockets: Socket[] = [];
  const agent = new Agent({
    keepAlive: true,
    maxSockets: 1,
    ca: server.cert,
    cert: certificate.pem,
    key,
  });
  const call = (
    options: {
      cert?: string;
      key?: string;
      hostname?: string;
      headers?: Record<string, string>;
      ca?: string;
      reuse?: boolean;
      transport?: Agent;
      body?: Buffer;
      path?: string;
      beforeEnd?: () => Promise<void>;
    } = {},
  ) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          hostname: options.hostname ?? "localhost",
          port: listener.port,
          path: options.path ?? "/commands",
          method: options.body ? "POST" : "GET",
          ca: options.ca ?? server.cert,
          ...(options.cert ? { cert: options.cert } : {}),
          ...(options.key ? { key: options.key } : {}),
          headers: options.headers,
          agent: options.transport ?? (options.reuse ? agent : false),
          timeout: 1500,
        },
        (res) => {
          let body = "";
          res.on("data", (data) => {
            body += data;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error("TLS request timed out")));
      req.on("socket", (socket) => sockets.push(socket));
      req.on("error", reject);
      if (options.beforeEnd) {
        req.write(options.body?.subarray(0, 1));
        void options
          .beforeEnd()
          .then(() => req.end(options.body?.subarray(1)))
          .catch(reject);
      } else req.end(options.body);
    });
  async function denied(options: Parameters<typeof call>[0]) {
    const count = accepted.length;
    let result: unknown;
    try {
      result = await call(options);
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    assert.equal(accepted.length, count);
    return result;
  }
  try {
    const valid = await call({
      cert: certificate.pem,
      key,
      reuse: true,
      headers: { "x-runner-id": "another-runner", "x-client-cert": "forged" },
    });
    assert.equal(valid.status, 200);
    assert.equal(JSON.parse(valid.body).fingerprint, certificate.fingerprint);
    observe("mTLS authorizes the actual P-256 certificate rather than identity headers", true, {
      status: valid.status,
      fingerprint: certificate.fingerprint,
      serial: certificate.serial,
    });
    assert.equal(logged.length, 0);
    assert.equal((await call({ cert: certificate.pem, key, path: "/unavailable" })).status, 503);
    assert.equal((await call({ cert: certificate.pem, key, path: "/slow" })).status, 204);
    now = Date.now();
    assert.equal(logged.length, 2);
    assert.match(logged[0]!, /GET \/unavailable answered 503 in \d+ ms/);
    assert.match(logged[1]!, /GET \/slow answered 204 in 6\d{3} ms/);
    observe("failed and slow runner requests are logged with path, status and duration", true, {
      logged,
    });
    const missing = await denied({
      headers: { "x-client-cert": certificate.pem.replace(/\n/g, "") },
    });
    const foreign = await initializeRunnerAuthority(join(root, "foreign"));
    const untrustedCertificate = await foreign.issue(client.csr);
    const untrusted = await denied({ cert: untrustedCertificate.pem, key });
    const hostname = await denied({ cert: certificate.pem, key, hostname: "127.0.0.1" });
    const serverTrust = await denied({ cert: certificate.pem, key, ca: foreign.certificate });
    observe(
      "missing and untrusted clients, forged headers, and mismatched server identity fail closed",
      true,
      { missing, untrusted, hostname, serverTrust },
    );
    now = certificate.notAfter + 1;
    const expired = await denied({ cert: certificate.pem, key, reuse: true });
    now = Date.now();
    observe("an established connection cannot use an expired client identity", true, expired);
    const bodyStarted = Promise.withResolvers<void>();
    bodyAuthorized = bodyStarted.resolve;
    const countBeforeBody = accepted.length;
    const expiredBody = await call({
      cert: certificate.pem,
      key,
      body: Buffer.from("ab"),
      beforeEnd: async () => {
        await bodyStarted.promise;
        now = certificate.notAfter + 1;
      },
    });
    assert.equal(expiredBody.status, 403);
    assert.equal(accepted.length, countBeforeBody);
    now = Date.now();
    const expiredResponse = await call({
      cert: certificate.pem,
      key,
      path: "/expire-before-response",
    });
    assert.equal(expiredResponse.status, 403);
    now = Date.now();
    observe(
      "identity expiry during a request body or awaited handler fails before command delivery or response headers",
      true,
      {
        bodyStatus: expiredBody.status,
        emptyResponseStatus: expiredResponse.status,
        expiredBodyNotDelivered: true,
      },
    );
    const rejectedStream = await call({
      cert: certificate.pem,
      key,
      path: "/expire-stream-before-response",
    });
    assert.equal(rejectedStream.status, 403);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(rejectedStreamCancelled, true);
    now = Date.now();
    authorizationCount = 0;
    expireAtAuthorization = 2;
    const countBeforeAuthorization = accepted.length;
    const expiredAuthorization = await call({ cert: certificate.pem, key });
    assert.equal(expiredAuthorization.status, 403);
    assert.equal(accepted.length, countBeforeAuthorization);
    expireAtAuthorization = 0;
    now = Date.now();
    observe(
      "expiry during an asynchronous access check prevents handler side effects and rejected streams are cancelled",
      true,
      {
        authorizationStatus: expiredAuthorization.status,
        handlerNotCalled: true,
        rejectedStreamStatus: rejectedStream.status,
        streamCancelled: rejectedStreamCancelled,
      },
    );
    await call({ cert: certificate.pem, key, reuse: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const liveSocket = Object.values(agent.freeSockets).flat()[0];
    assert(liveSocket && !liveSocket.destroyed);
    await new Promise<void>((resolve, reject) => {
      const stream = request(
        {
          hostname: "localhost",
          port: listener.port,
          path: "/stream",
          ca: server.cert,
          cert: certificate.pem,
          key,
          agent: false,
          timeout: 1500,
        },
        (response) => {
          response.on("error", () => {});
          response.once("data", () => resolve());
        },
      );
      stream.on("error", reject);
      stream.on("timeout", () => stream.destroy(new Error("Stream timed out")));
      stream.end();
    });
    const beforeRevocation = Date.now();
    active.delete(certificate.fingerprint);
    listener.revoke(certificate.fingerprint);
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("Revocation did not close TLS socket")),
        1500,
      );
      liveSocket.once("close", () => {
        clearTimeout(deadline);
        resolve();
      });
    });
    assert(liveSocket.destroyed);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert(streamCancelled);
    observe(
      "revocation cancels a stalled response stream without waiting for another chunk",
      true,
      { cancelled: streamCancelled },
    );
    const revoked = await denied({ cert: certificate.pem, key, reuse: true });
    const reconnect = await denied({ cert: certificate.pem, key });
    observe(
      "revocation closes the existing connection and rejects reconnect within five seconds",
      Date.now() - beforeRevocation < 5000,
      {
        elapsedMs: Date.now() - beforeRevocation,
        socketDestroyed: liveSocket.destroyed,
        revoked,
        reconnect,
      },
    );
    await assert.rejects(() =>
      listener.reload({ key: "invalid private key", cert: server.cert, ca: authority.certificate }),
    );
    const rollbackCertificate = await authority.issue(client.csr);
    active.add(rollbackCertificate.fingerprint);
    const rollback = await call({ cert: rollbackCertificate.pem, key });
    assert.equal(rollback.status, 200);
    observe(
      "invalid replacement TLS material leaves the previous listener on its original port",
      true,
      { status: rollback.status, port: listener.port },
    );
    const restored = openRunnerAuthority(issuerRoot);
    const renewed = await restored.issue(client.csr);
    assert.equal(restored.fingerprint, authority.fingerprint);
    assert.notEqual(renewed.serial, certificate.serial);
    assert(
      new X509Certificate(renewed.pem).publicKey.equals(
        new X509Certificate(certificate.pem).publicKey,
      ),
    );
    const envelope = readFileSync(join(issuerRoot, "runner-authority.json"), "utf8");
    assert(!envelope.includes("PRIVATE KEY"));
    assert.equal(statSync(issuerRoot).mode & 0o777, 0o700);
    assert.equal(statSync(join(issuerRoot, "runner-authority.json")).mode & 0o777, 0o600);
    assert.equal(statSync(client.keyPath).mode & 0o777, 0o600);
    assert(!readdirSync(issuerRoot).some((file) => file.startsWith(".certificate-")));
    const invalid = client.csr.replace(/(-----BEGIN CERTIFICATE REQUEST-----\n)[A-Za-z0-9]/, "$1A");
    await assert.rejects(() => validateRunnerRequest(issuerRoot, invalid));
    await assert.rejects(() => initializeRunnerAuthority(issuerRoot));
    observe(
      "issuer reload retains its encrypted key and refuses invalid requests or replacement",
      true,
      {
        fingerprint: restored.fingerprint,
        renewedSerial: renewed.serial,
        keyMode: "0600",
        issuerMode: "0700",
      },
    );
    const contestedRoot = join(root, "concurrent-issuer");
    mkdirSync(contestedRoot, { mode: 0o700 });
    writeFileSync(join(contestedRoot, "issuer-create.lock"), "");
    const contested = await Promise.allSettled([
      initializeRunnerAuthority(contestedRoot),
      initializeRunnerAuthority(contestedRoot),
    ]);
    const created = contested.filter((result) => result.status === "fulfilled");
    assert.equal(created.length, 1);
    const winner = created[0];
    if (winner?.status !== "fulfilled") throw new Error("Issuer creation failed");
    assert.equal(openRunnerAuthority(contestedRoot).fingerprint, winner.value.fingerprint);
    observe(
      "issuer creation survives a stale legacy lock and concurrent creation cannot replace it",
      true,
      {
        created: created.length,
        rejected: contested.length - created.length,
        fingerprint: winner.value.fingerprint,
      },
    );
    const replacedServer = await serverIdentity(join(root, "replacement"));
    await listener.reload({ ...replacedServer, ca: authority.certificate });
    active.add(renewed.fingerprint);
    const reloaded = await call({ cert: renewed.pem, key, ca: replacedServer.cert });
    assert.equal(reloaded.status, 200);
    observe("server certificate reload preserves mandatory client authentication", true, {
      authenticated: reloaded.status,
      missing: await denied({ ca: replacedServer.cert }),
    });
    const oversized = await denied({
      cert: renewed.pem,
      key,
      ca: replacedServer.cert,
      body: Buffer.alloc(1024 * 1024 + 1),
    });
    observe("oversized authenticated request is stopped before command handling", true, oversized);
    const bodyAgent = new Agent({
      keepAlive: true,
      maxSockets: 1,
      ca: replacedServer.cert,
      cert: renewed.pem,
      key,
    });
    try {
      active.delete(renewed.fingerprint);
      const rejectedPost = await denied({
        cert: renewed.pem,
        key,
        ca: replacedServer.cert,
        body: Buffer.from("ignored request body"),
        transport: bodyAgent,
      });
      const rejectedSocket = sockets.at(-1)!;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert(rejectedSocket.destroyed);
      active.add(renewed.fingerprint);
      const followingPost = await call({
        cert: renewed.pem,
        key,
        ca: replacedServer.cert,
        transport: bodyAgent,
      });
      assert.equal(followingPost.status, 200);
      observe("rejecting a request body leaves subsequent authenticated requests usable", true, {
        rejectedPost,
        rejectedSocketClosed: rejectedSocket.destroyed,
        followingStatus: followingPost.status,
      });
    } finally {
      bodyAgent.destroy();
    }
    await Promise.all([
      listener.reload({ ...server, ca: authority.certificate }),
      listener.reload({ ...replacedServer, ca: authority.certificate }),
    ]);
    const afterConcurrentReload = await call({ cert: renewed.pem, key, ca: replacedServer.cert });
    assert.equal(afterConcurrentReload.status, 200);
    await Promise.all([listener.reload({ ...server, ca: authority.certificate }), listener.stop()]);
    let stoppedError = "";
    try {
      await call({ cert: renewed.pem, key });
    } catch (error) {
      stoppedError = String(error);
    }
    assert(stoppedError);
    observe(
      "concurrent certificate reloads serialize and shutdown leaves no listening socket",
      true,
      { afterConcurrentReload: afterConcurrentReload.status, stoppedError },
    );
    writeFileSync(
      join(root, "certificate-metadata.json"),
      JSON.stringify(
        {
          issuer: authority.fingerprint,
          client: { ...certificate, pem: undefined },
          renewed: { ...renewed, pem: undefined },
          keyExtendedUsages: new X509Certificate(renewed.pem).keyUsage,
          accepted,
        },
        null,
        2,
      ),
    );
  } finally {
    agent.destroy();
    await listener.stop();
  }
}

async function serverIdentity(root: string): Promise<{ key: string; cert: string }> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
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
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: { PATH: "/usr/bin:/bin", HOME: root },
    },
  );
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  assert.equal(exit, 0, error);
  return {
    key: readFileSync(join(root, "server.key"), "utf8"),
    cert: readFileSync(join(root, "server.pem"), "utf8"),
  };
}
