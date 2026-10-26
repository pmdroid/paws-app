import { generateKeyPairSync } from "node:crypto";
import { systemClock } from "../src/core";
import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  ensureBareMirror,
  executeItem,
  git,
  prepareRepositorySnapshot,
  runAgent,
} from "../src/acp";
import { createGitHubTokenProvider } from "../src/auth";
import {
  attachOrchestrator,
  createRepositoryGit,
  FakeGitHubIntegration,
  LinearTaskAccess,
} from "../src/loop";
import {
  createFakeLinearAccessReads,
  createFakeLinearIssueLifecycle,
  createFakeTracker,
} from "../src/linear";
import {
  bindLinearSessionTask,
  ensureLinearSession,
  getWorkItem,
  insertQueuedItem,
  JobLoop,
  OutboxDispatcher,
  saveTaskMode,
  recordLinearInstallation,
} from "../src/db";
import { tempDb, tempHome } from "./helpers";
import { workspaceAdmission, workspaceDispatch } from "./fake-workspace";

const token = "synthetic-host-git-token";

test("host credentials reach real host clone and fetch without reaching repository or ACP", async () => {
  const home = tempHome();
  const provider = { token: async () => token };
  const source = join(home, "source");
  const bare = join(home, "private.git");
  const cert = join(home, "cert.pem");
  const key = join(home, "key.pem");
  await mkdir(source);
  await git(["init", "-b", "main", source]);
  await writeFile(join(source, "README.md"), "Initial source\n");
  await git(["-C", source, "add", "README.md"]);
  const commit = async () =>
    git([
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-am",
      "Source",
    ]);
  await commit();
  await git(["clone", "--bare", source, bare]);
  await git(["--git-dir", bare, "update-server-info"]);
  const certificate = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await certificate.exited).toBe(0);
  let accepted = 0;
  let refused = 0;
  const credential = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(cert), key: Bun.file(key) },
    async fetch(request) {
      if (request.headers.get("authorization") !== credential) {
        refused++;
        return new Response("Sign in", {
          status: 401,
          headers: { "www-authenticate": "Basic realm=private" },
        });
      }
      accepted++;
      const path = resolve(home, `.${new URL(request.url).pathname}`);
      if (!path.startsWith(`${bare}${sep}`)) return new Response(null, { status: 404 });
      const file = Bun.file(path);
      return (await file.exists())
        ? new Response(file, { headers: { "content-type": "application/octet-stream" } })
        : new Response(null, { status: 404 });
    },
  });
  const remoteUrl = `https://127.0.0.1:${server.port}/private.git`;
  const env = { ...process.env, GIT_SSL_CAINFO: cert, GIT_TERMINAL_PROMPT: "0" };
  const controller = new AbortController();
  let assertions = 0;
  const networkGit = createRepositoryGit({
    remoteUrl,
    token: () => provider.token(),
    signal: controller.signal,
    assert: async () => {
      assertions++;
    },
    onCleanupFailure: () => {
      throw new Error("Unverified Git cleanup");
    },
    env,
  });
  try {
    await expect(
      git(["clone", "--bare", remoteUrl, join(home, "denied.git")], {
        env,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(refused).toBeGreaterThan(0);
    const pawsRoot = join(home, "paws");
    const mirror = await ensureBareMirror({
      remoteUrl,
      owner: "acme",
      repo: "private",
      pawsRoot,
      networkGit,
    });
    expect((await git(["--git-dir", mirror.path, "show", "origin/main:README.md"])).trim()).toBe(
      "Initial source",
    );
    await writeFile(join(source, "README.md"), "Updated source\n");
    await commit();
    await git(["-C", source, "push", bare, "main"]);
    await git(["--git-dir", bare, "update-server-info"]);
    await ensureBareMirror({ remoteUrl, owner: "acme", repo: "private", pawsRoot, networkGit });
    expect((await git(["--git-dir", mirror.path, "show", "origin/main:README.md"])).trim()).toBe(
      "Updated source",
    );
    const snapshot = await prepareRepositorySnapshot({
      owner: "acme",
      repo: "private",
      remoteUrl,
      workspace: join(home, "task"),
      signal: controller.signal,
      networkGit,
    });
    expect(await readFile(join(snapshot.path, "README.md"), "utf8")).toBe("Updated source\n");
    const config = await readFile(join(mirror.path, "config"), "utf8");
    expect(config).toContain(remoteUrl);
    expect(config).not.toContain(token);
    expect(config).not.toContain(credential);
    expect(process.env.GIT_CONFIG_VALUE_4).toBeUndefined();
    const trace = join(home, "agent.json");
    const script = join(home, "agent-script.json");
    const wrapper = join(home, "fake-agent.ts");
    const leaked = join(home, "agent-env.json");
    await writeFile(script, JSON.stringify({ steps: [{ type: "end" }] }));
    await writeFile(
      wrapper,
      `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(leaked)},JSON.stringify({leaked:JSON.stringify(process.env).includes(${JSON.stringify(token)})||JSON.stringify(process.argv).includes(${JSON.stringify(token)})}));await import(${JSON.stringify(resolve(import.meta.dir, "../src/acp/testing/fake-agent.ts"))});`,
    );
    const result = await runAgent({
      role: "implementer",
      itemId: "task",
      runId: "run",
      worktreePath: snapshot.path,
      pawsRoot,
      home,
      prompt: "Read the private snapshot",
      readOnly: true,
      checkpoint: false,
      command: process.execPath,
      args: [wrapper, trace, script],
      signal: controller.signal,
    });
    expect(result.stopReason).toBe("end_turn");
    const executed = await executeItem({
      owner: "acme",
      repo: "private",
      remoteUrl,
      networkGit,
      itemId: "code-task",
      runId: "code-run",
      pawsRoot: join(home, "code-paws"),
      home,
      prompt: "Read source",
      command: process.execPath,
      args: [wrapper, trace, script],
      signal: controller.signal,
      checkpoint: false,
    });
    expect(executed.run.stopReason).toBe("end_turn");
    expect(await readFile(join(executed.worktreePath, "README.md"), "utf8")).toBe(
      "Updated source\n",
    );
    expect(JSON.parse(await readFile(leaked, "utf8"))).toEqual({ leaked: false });
    const db = tempDb();
    const orchestratedRoot = join(home, "orchestrated-paws");
    const item = insertQueuedItem(db, { id: "repository-answer", sessionKey: "host-git-session" });
    ensureLinearSession(db, {
      sessionId: item.sessionKey!,
      issueId: item.linearIssueId,
      now: Date.now(),
    });
    bindLinearSessionTask(db, item.sessionKey!, item.delegationId, { actorId: "human" });
    saveTaskMode(db, item.id, "answer", 0, true);
    const installation = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
    recordLinearInstallation(db, {
      ...installation,
      sessionId: item.sessionKey!,
      teamId: "team",
      observedAtMs: Date.now(),
    });
    const access = createFakeLinearAccessReads({
      installation,
      sessions: [
        {
          ...installation,
          sessionId: item.sessionKey!,
          issueId: item.linearIssueId,
          teamId: "team",
        },
      ],
      teams: ["team"],
    });
    const lifecycle = createFakeLinearIssueLifecycle({
      id: item.linearIssueId,
      teamId: "team",
      stateType: "completed",
      delegateId: "app",
      assigneeId: "human",
    });
    const tracker = createFakeTracker();
    const jobs = new JobLoop(db, systemClock);
    const outbox = new OutboxDispatcher(db, systemClock);
    let checkedReads = 0;
    const priorCa = process.env.GIT_SSL_CAINFO;
    process.env.GIT_SSL_CAINFO = cert;
    const orchestrator = attachOrchestrator({
      db,
      admission: workspaceAdmission(db),
      jobs,
      outbox,
      tracker,
      pawsRoot: orchestratedRoot,
      home,
      linearTaskModes: true,
      repositories: [{ owner: "acme", repo: "private", remoteUrl }],
      linearAccess: new LinearTaskAccess(db, {
        access: access.adapter,
        lifecycle,
        ...installation,
        stopSession: () => {
          throw new Error("Unexpected access removal");
        },
      }),
      githubInstallation: new FakeGitHubIntegration(),
      repositoryAccess: async (_repository, _signal, purpose) => {
        expect(purpose).toBe("read");
        checkedReads++;
        return true;
      },
      repositoryToken: async (_item, _repository, _signal, purpose) => {
        expect(purpose).toBe("read");
        return provider.token();
      },
      launch(input) {
        expect(input.purpose).toBe("answer");
        expect(input.prompt).toContain("./repository");
        return {
          command: process.execPath,
          args: [wrapper, trace, script],
          env: { PATH: "/usr/bin:/bin", HOME: home },
        };
      },
    });
    try {
      await writeFile(
        script,
        JSON.stringify({
          steps: [
            { type: "fs_read", path: "repository/README.md" },
            {
              type: "update",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Complete private repository explanation." },
              },
            },
            { type: "end" },
          ],
        }),
      );
      workspaceDispatch(db, { now: Date.now() });
      await jobs.tick();
      expect(getWorkItem(db, item.id)?.state).toBe("completed");
      expect(checkedReads).toBe(1);
      expect(lifecycle.started).toEqual([]);
      expect(lifecycle.issue.assigneeId).toBe("human");
      expect(tracker.statuses).toEqual([]);
      expect(
        await readFile(
          join(orchestratedRoot, "tasks", item.id, "answer", "repository", "README.md"),
          "utf8",
        ),
      ).toBe("Updated source\n");
      expect(JSON.parse(await readFile(leaked, "utf8"))).toEqual({ leaked: false });
    } finally {
      await orchestrator.shutdown();
      db.close();
      if (priorCa === undefined) delete process.env.GIT_SSL_CAINFO;
      else process.env.GIT_SSL_CAINFO = priorCa;
    }
    expect(accepted).toBeGreaterThan(3);
    expect(assertions).toBeGreaterThanOrEqual(8);
  } finally {
    controller.abort();
    await server.stop(true);
  }
}, 20_000);

test("Stop while acquiring a host credential prevents the Git subprocess", async () => {
  const home = tempHome();
  const destination = join(home, "cancelled.git");
  const controller = new AbortController();
  const reading = Promise.withResolvers<void>();
  const credential = Promise.withResolvers<string>();
  const remoteUrl = "https://127.0.0.1:1/private.git";
  const networkGit = createRepositoryGit({
    remoteUrl,
    signal: controller.signal,
    token: () => {
      reading.resolve();
      return credential.promise;
    },
    assert: async () => {},
    onCleanupFailure: () => {
      throw new Error("Unverified cleanup");
    },
  });
  const pending = networkGit(["clone", "--bare", remoteUrl, destination]);
  await reading.promise;
  controller.abort(new Error("Stopped by owner"));
  credential.resolve(token);
  await expect(pending).rejects.toThrow("Stopped by owner");
  expect(await Bun.file(join(destination, "config")).exists()).toBe(false);
});

test("read providers request only repository contents and reject broader grants", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const permissions = { contents: "read", metadata: "read" };
  let responsePermissions: Record<string, string> = permissions;
  const requests: unknown[] = [];
  const provider = createGitHubTokenProvider({
    auth: "app",
    access: "read",
    repo: "pmdroid/paws-demo",
    appId: "99",
    installationId: "7",
    privateKeyPem: privateKey,
    client: {
      async request(input) {
        requests.push(input.body);
        return {
          status: 201,
          body: {
            token: "synthetic-read-token",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            repository_selection: "selected",
            repositories: [{ name: "paws-demo", full_name: "pmdroid/paws-demo" }],
            permissions: responsePermissions,
          },
        };
      },
    },
  });
  expect(await provider.token()).toBe("synthetic-read-token");
  expect(requests[0]).toEqual({ repositories: ["paws-demo"], permissions });
  responsePermissions = { contents: "write", metadata: "read" };
  await expect(provider.token()).rejects.toThrow("unexpected permissions");
  responsePermissions = { contents: "read", metadata: "read", issues: "read" };
  await expect(provider.token()).rejects.toThrow("unexpected permissions");
});
