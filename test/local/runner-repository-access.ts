import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
} from "../../src/db";
import {
  assertScopedToken,
  createFakeGitHub,
  MAX_TOKEN_TTL_MS,
  TOKEN_TTL_SKEW_MS,
} from "../../src/github";
import { createRunnerControl } from "../../src/runner-control";
import {
  createRunnerKey,
  initializeRunnerAuthority,
  startRunnerListener,
} from "../../src/runner-identity";
import type { RunnerCommand } from "../../src/runner-protocol";
import { createRunnerRepositoryAccess } from "../../src/runner-repository-access";
import { createRunnerWork } from "../../src/runner-work";
import {
  issueWorkspaceBootstrap,
  workspaceId,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../../src/workspace";

export async function probeRunnerRepositoryAccess(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  let now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "fixture-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const bootstrap = issueWorkspaceBootstrap(db, "fixture-repository", now);
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "fixture-repository",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(bootstrap),
    now,
  });
  const principal: WorkspacePrincipal = {
    workspaceId: workspace.id,
    userId,
    role: "owner",
    authenticatedAt: now,
    teamIds: [],
  };
  db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
    workspace.id,
    "fixture/repository",
    "fixture-team",
  ]);
  const authorityRoot = join(root, "issuer");
  const authority = await initializeRunnerAuthority(authorityRoot);
  const client = await createRunnerKey(join(root, "client"));
  const control = createRunnerControl({
    db,
    authority,
    certificateRoot: authorityRoot,
    now: () => now,
    disconnect() {},
  });
  const pending = await control.beginPairing({ name: "Repository VM", csr: client.csr });
  const { runnerId } = await control.approvePairing(principal, pending.code);
  now = Date.now();
  const identity = control.claimPairing(pending.id, pending.claim);
  assert.equal(identity.status, "approved");
  if (identity.status !== "approved") throw new Error("Pairing was not approved");
  const certificate = identity.certificate;
  const reviewPairing = await control.beginPairing({ name: "Review VM", csr: client.csr });
  const reviewRunnerId = (await control.approvePairing(principal, reviewPairing.code)).runnerId;
  now = Date.now();
  const reviewIdentity = control.claimPairing(reviewPairing.id, reviewPairing.claim);
  assert.equal(reviewIdentity.status, "approved");
  if (reviewIdentity.status !== "approved") throw new Error("Review pairing was not approved");
  const reviewCertificate = reviewIdentity.certificate;
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    now: () => now,
  });
  const github = createFakeGitHub();
  const originalMint = github.mintInstallationToken;
  let beforeMint: (() => void) | undefined;
  let returnedRepository = "fixture/repository";
  let tokenLifetime = 60_000;
  github.mintInstallationToken = async (input) => {
    const minted = await originalMint(input);
    beforeMint?.();
    return { ...minted, repository: returnedRepository, expiresAt: now + tokenLifetime };
  };
  let installation: string | null = "fixture-installation";
  const bot = { appId: "99", login: "paws-test[bot]", id: 88 };
  let currentBot = bot;
  const endpoint = createRunnerRepositoryAccess({
    checkpointBot: async () => currentBot,
    work,
    github,
    now: () => now,
    installationForRepository(repository) {
      assert.equal(repository, "fixture/repository");
      return installation;
    },
  });
  function assigned(type: "run" | "review" = "run", targetRunner = runnerId, bindBot = true) {
    const sessionId = workspaceId();
    const item = insertQueuedItem(db, {
      id: workspaceId(),
      now,
      sessionKey: sessionId,
    });
    const { run } = beginImplementRun(db, item.id, now);
    recordLinearInstallation(db, {
      organizationId: "fixture-repository",
      oauthClientId: "fixture-app",
      appUserId: "fixture-app-user",
      sessionId,
      teamId: "fixture-team",
      observedAtMs: now,
    });
    bindLinearSessionTask(db, sessionId, item.delegationId, { actorId: "fixture-owner" });
    const repository = {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
      baseSha: "a".repeat(40),
    };
    bindWorkItemRepository(db, item.id, repository);
    const command: Extract<RunnerCommand, { type: "run" | "review" }> = {
      id: workspaceId(),
      runnerId: targetRunner,
      workspaceId: workspace.id,
      issuedAt: now,
      expiresAt: now + 300_000,
      type,
      ...(type === "run" && bindBot ? { checkpointBot: bot } : {}),
      runId: run.id,
      itemId: item.id,
      generation: 1,
      repository,
      profile: { agent: "codex", model: "scripted" },
      prompt: "Use the assigned repository.",
    };
    work.assign(command);
    const grant = work.issueGrant({
      runnerId: targetRunner,
      runId: run.id,
      commandId: command.id,
      generation: 1,
    });
    return { item, command, grant };
  }
  const tls = await serverIdentity(root);
  let listener: Awaited<ReturnType<typeof startRunnerListener>> | undefined;
  try {
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
        return (
          (await endpoint(input, control.authenticate(peer).id)) ??
          new Response(null, { status: 404 })
        );
      },
    });
    async function exchange(
      assignment: ReturnType<typeof assigned>,
      mode: "read" | "write",
      options: { token?: string; body?: unknown; certificate?: boolean } = {},
    ) {
      return send(
        listener!.port,
        tls.cert,
        `/v1/runs/${assignment.command.runId}/repository-credential`,
        {
          key: options.certificate === false ? undefined : readFileSync(client.keyPath, "utf8"),
          cert:
            options.certificate === false
              ? undefined
              : assignment.command.runnerId === reviewRunnerId
                ? reviewCertificate
                : certificate,
          body: options.body ?? { generation: 1, access: mode },
          token: options.token ?? assignment.grant.token,
        },
      );
    }
    const first = assigned();
    const read = await exchange(first, "read");
    assert.equal(read.status, 200);
    assert.deepEqual(JSON.parse(read.body), {
      token: "fake-installation-token",
      expiresAt: now + 60_000,
      remoteUrl: first.command.repository.remoteUrl,
      branch: null,
    });
    assert.equal(read.cacheControl, "no-store");
    const write = await exchange(first, "write");
    assert.equal(write.status, 200);
    assert.equal(JSON.parse(write.body).branch, first.item.branchName);
    assert.deepEqual(
      github.minted.map(({ access, ...binding }) => ({ access, ...binding })),
      [
        {
          access: "read",
          repository: "fixture/repository",
          installationId: "fixture-installation",
        },
        {
          access: "write",
          repository: "fixture/repository",
          installationId: "fixture-installation",
        },
      ],
    );
    observe(
      "mTLS run grants mint repository-scoped read/write credentials and canonical publication branch",
      true,
      {
        readStatus: read.status,
        writeStatus: write.status,
        repository: first.command.repository.remoteUrl,
        branch: first.item.branchName,
        cacheControl: read.cacheControl,
      },
    );
    for (const changed of [
      { ...bot, appId: "100" },
      { ...bot, id: 89 },
      { ...bot, login: "another[bot]" },
    ]) {
      currentBot = changed;
      const before = github.minted.length;
      assert.equal((await exchange(first, "write")).status, 403);
      assert.equal(github.minted.length, before);
    }
    currentBot = bot;
    beforeMint = () => {
      currentBot = { ...bot, id: 89 };
    };
    const changedBot = await exchange(first, "write");
    assert.equal(changedBot.status, 403);
    assert(!changedBot.body.includes("fake-installation-token"));
    beforeMint = undefined;
    currentBot = bot;
    const review = assigned("review", reviewRunnerId);
    assert.equal((await exchange(review, "read")).status, 200);
    const mintedBefore = github.minted.length;
    assert.equal((await exchange(review, "write")).status, 403);
    assert.equal((await exchange(first, "read", { token: "x".repeat(43) })).status, 403);
    assert.equal(
      (await exchange(first, "read", { body: { generation: 2, access: "read" } })).status,
      409,
    );
    assert.equal(
      (
        await exchange(first, "read", {
          body: { generation: 1, access: "read", repository: "other" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await exchange(first, "read", {
          body: { generation: 1, access: "read", padding: "x".repeat(4096) },
        })
      ).status,
      403,
    );
    await assert.rejects(exchange(first, "read", { certificate: false }));
    assert.equal(github.minted.length, mintedBefore);
    work.finish(review.command.runId, review.command.generation);
    observe(
      "certificate, separate grant, generation and strict body fences run before minting; review is read-only",
      true,
      {
        forbiddenMintCount: github.minted.length - mintedBefore,
        missingCertificateDenied: true,
        reviewWriteDenied: true,
      },
    );
    installation = null;
    assert.equal((await exchange(first, "read")).status, 403);
    installation = "fixture-installation";
    for (const [repository, lifetime] of [
      ["fixture/other", 60_000],
      ["fixture/repository", 0],
      ["fixture/repository", MAX_TOKEN_TTL_MS + TOKEN_TTL_SKEW_MS + 1],
    ] as const) {
      returnedRepository = repository;
      tokenLifetime = lifetime;
      const response = await exchange(first, "read");
      assert.equal(response.status, 403);
      assert(!response.body.includes("fake-installation-token"));
    }
    returnedRepository = "fixture/repository";
    tokenLifetime = MAX_TOKEN_TTL_MS + 15_000;
    const provider = assertScopedToken(
      {
        token: "fake-installation-token",
        expires_at: new Date(now + tokenLifetime).toISOString(),
        repository_selection: "selected",
        repositories: [{ name: "repository", full_name: "fixture/repository" }],
        permissions: { contents: "read", metadata: "read" },
      },
      "fixture",
      "repository",
      new Date(now),
      "read",
    );
    assert.equal(provider.expiresAt.getTime(), now + tokenLifetime);
    const skew = await exchange(first, "read");
    assert.equal(skew.status, 200);
    assert.equal(JSON.parse(skew.body).expiresAt, now + MAX_TOKEN_TTL_MS);
    assert(JSON.parse(skew.body).expiresAt <= provider.expiresAt.getTime());
    tokenLifetime = 60_000;
    observe(
      "valid provider clock skew is accepted with conservative one-hour runner expiry",
      true,
      {
        providerLifetime: MAX_TOKEN_TTL_MS + 15_000,
        runnerLifetime: MAX_TOKEN_TTL_MS,
        status: skew.status,
      },
    );
    observe(
      "missing installation, mismatched minted repository and invalid token expiry return no credential",
      true,
      {
        invalidCredentialResponses: 3,
        missingInstallationDenied: true,
      },
    );
    work.finish(first.command.runId, first.command.generation);
    const unbound = assigned("run", runnerId, false);
    assert.equal((await exchange(unbound, "read")).status, 200);
    assert.equal((await exchange(unbound, "write")).status, 403);
    work.finish(unbound.command.runId, unbound.command.generation);
    const changedInstallation = assigned();
    beforeMint = () => {
      installation = "different-installation";
    };
    assert.equal((await exchange(changedInstallation, "write")).status, 403);
    beforeMint = undefined;
    installation = "fixture-installation";
    work.finish(changedInstallation.command.runId, changedInstallation.command.generation);
    const scenarios: [string, (entry: ReturnType<typeof assigned>) => void][] = [
      [
        "cancelled",
        ({ item }) => {
          db.run("UPDATE work_item SET cancel_requested=1 WHERE id=?", [item.id]);
        },
      ],
      [
        "changed branch",
        ({ item }) => {
          db.run("UPDATE work_item SET branch_name='paws/changed' WHERE id=?", [item.id]);
        },
      ],
      [
        "changed repository",
        ({ item }) => {
          db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
            workspace.id,
            "other/other",
            "fixture-team",
          ]);
          db.run(
            "UPDATE work_item_repository SET owner='other',repo='other',remote_url='https://github.com/other/other.git' WHERE item_id=?",
            [item.id],
          );
        },
      ],
      [
        "replaced generation",
        ({ command }) => {
          work.finish(command.runId, command.generation);
          work.assign({ ...command, id: workspaceId(), generation: 2 });
        },
      ],
      [
        "expired lease",
        () => {
          now += 60_001;
        },
      ],
    ];
    const fenced: string[] = [];
    for (const [name, change] of scenarios) {
      const entry = assigned();
      let changed = false;
      beforeMint = () => {
        change(entry);
        changed = true;
      };
      const response = await exchange(entry, "read");
      beforeMint = undefined;
      assert(changed, `Mutation did not complete: ${name}`);
      assert([403, 409].includes(response.status), `${name}: ${response.status}`);
      assert(!response.body.includes("fake-installation-token"));
      fenced.push(name);
      const current = db
        .query<{ generation: number }, [string]>(
          "SELECT generation FROM runner_work WHERE run_id=?",
        )
        .get(entry.command.runId)!;
      work.finish(entry.command.runId, current.generation);
    }
    observe(
      "authorization is rechecked after asynchronous token minting without releasing stale credentials",
      true,
      { fenced },
    );
    const revoked = assigned();
    beforeMint = () =>
      control.setStatus({ ...principal, authenticatedAt: now }, runnerId, "revoked");
    const denied = await exchange(revoked, "read");
    assert.equal(denied.status, 403);
    assert(!denied.body.includes("fake-installation-token"));
    const persisted = JSON.stringify(db.query("SELECT * FROM runner_work_grant").all());
    assert(!persisted.includes("fake-installation-token"));
    assert(!persisted.includes(revoked.grant.token));
    observe(
      "revocation during minting denies delivery and SQLite retains only run-grant hashes",
      true,
      {
        status: denied.status,
        rawCredentialsPersisted: false,
      },
    );
  } finally {
    await listener?.stop();
    db.close();
  }
}

async function serverIdentity(root: string) {
  const keyPath = join(root, "server-key.pem");
  const certPath = join(root, "server-cert.pem");
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
      keyPath,
      "-out",
      certPath,
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
      stderr: "pipe",
    },
  );
  const error = await new Response(child.stderr).text();
  assert.equal(await child.exited, 0, error);
  return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
}

async function send(
  port: number,
  ca: string,
  path: string,
  input: { key?: string; cert?: string; body: unknown; token: string },
) {
  return new Promise<{ status: number; body: string; cacheControl: string | undefined }>(
    (resolve, reject) => {
      const body = JSON.stringify(input.body);
      const outgoing = request(
        {
          hostname: "localhost",
          port,
          path,
          ca,
          key: input.key,
          cert: input.cert,
          agent: false,
          timeout: 3000,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
            authorization: `Bearer ${input.token}`,
          },
        },
        (incoming) => {
          let text = "";
          incoming.on("data", (chunk) => {
            text += chunk;
          });
          incoming.on("end", () =>
            resolve({
              status: incoming.statusCode ?? 0,
              body: text,
              cacheControl: incoming.headers["cache-control"],
            }),
          );
          incoming.on("error", reject);
        },
      );
      outgoing.on("error", reject);
      outgoing.on("timeout", () => outgoing.destroy(new Error("Repository verification timeout")));
      outgoing.end(body);
    },
  );
}
