import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeLinearAccessReads, createFakeLinearIssueLifecycle } from "../src/linear";
import { loadRuntime } from "../src/config";
import { createGitHubIntegration } from "../src/index";
import {
  GitHubInstallationCheck,
  LinearTaskAccess,
  TASK_ACCESS_TTL_MS,
  authorizeLinearTask,
} from "../src/loop";
import {
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  syncSteps,
  openPglite,
  postgresDb,
  recordLinearInstallation,
  revokeLinearInstallation,
} from "../src/db";
import { copyMigratedPglite, tempStore } from "./pglite";

test("transient production authorization persists a wait, survives restart and recovers once alongside a sibling", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-integration-unavailable-"));
  const path = join(root, "pglite");
  await copyMigratedPglite(path);
  const pg = await openPglite(path);
  const db = postgresDb(pg);
  const signal = new AbortController().signal;
  let unavailable = true;
  const env = { GITHUB_AUTH: "app", PAWS_HOME: root };
  const host = createGitHubIntegration({
    runtime: loadRuntime(env),
    env,
    repositoryForItem: async () => ({
      owner: "acme",
      repo: "widgets",
      remoteUrl: "https://github.com/acme/widgets.git",
    }),
    integrationIdentity: () => syncSteps(() => "member"),
    authorizeItem: async () => {
      if (unavailable) throw new Error("Scripted Linear outage");
      return true;
    },
  });
  host.check = async () => true;
  host.unavailableRetryMs = [];
  const auth = new GitHubInstallationCheck(db, host, () => 1000);
  await insertQueuedItem(db, {
    id: "unavailable",
    sessionKey: "unavailable",
    title: "unavailable",
  });
  await beginImplementRun(db, "unavailable", 1000);
  const first = (await getWorkItem(db, "unavailable"))!;
  try {
    expect(await auth.ensure(first, "initial", signal)).toBe(false);
    expect((await getWorkItem(db, first.id))?.state).toBe("awaiting_input");
    expect((await listOutbox(db)).filter((entry) => entry.op === "elicitation")).toHaveLength(0);
    expect(
      (await listOutbox(db)).some((entry) =>
        JSON.stringify(entry.payload).includes("retry automatically"),
      ),
    ).toBe(true);
    await auth.recover();
    expect((await getWorkItem(db, first.id))?.state).toBe("awaiting_input");
  } finally {
    auth.close();
    await pg.$client.close();
  }
  const reopenedPg = await openPglite(path);
  const reopened = postgresDb(reopenedPg);
  let denied = false;
  host.authorize = async (item) => {
    if (item.id === first.id && unavailable) throw new Error("Scripted Linear outage");
    return !denied;
  };
  const recovered = new GitHubInstallationCheck(reopened, host, () => 2000);
  try {
    await insertQueuedItem(reopened, { id: "sibling", sessionKey: "sibling", title: "sibling" });
    await beginImplementRun(reopened, "sibling", 2000);
    host.check = async (item) => item.id !== "sibling";
    await recovered.ensure((await getWorkItem(reopened, "sibling"))!, "initial", signal);
    host.check = async () => true;
    host.unavailableRetryMs = [];
    await recovered.recover();
    expect((await getWorkItem(reopened, first.id))?.state).toBe("awaiting_input");
    expect((await getWorkItem(reopened, "sibling"))?.state).toBe("running");
    unavailable = false;
    await Promise.all([recovered.recover(), recovered.recover()]);
    await recovered.recover();
    expect((await getWorkItem(reopened, first.id))?.state).toBe("running");
    expect((await listJobs(reopened)).filter((job) => job.queue === "run.resume")).toHaveLength(2);
    await insertQueuedItem(reopened, { id: "revoked", sessionKey: "revoked", title: "revoked" });
    await beginImplementRun(reopened, "revoked", 2000);
    host.check = async () => false;
    await recovered.ensure((await getWorkItem(reopened, "revoked"))!, "initial", signal);
    denied = true;
    await recovered.recover();
    expect((await getWorkItem(reopened, "revoked"))?.state).toBe("cancelled");
  } finally {
    recovered.close();
    await reopenedPg.$client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("real LinearTaskAccess distinguishes revoked installation from unavailable reads without relying on stop callback", async () => {
  const { db, close } = await tempStore();
  const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
  const item = await insertQueuedItem(db, { id: "task", sessionKey: "session", title: "task" });
  await beginImplementRun(db, item.id, 1000);
  await recordLinearInstallation(db, {
    ...scope,
    sessionId: "session",
    teamId: "team",
    observedAtMs: 1,
  });
  const reads = createFakeLinearAccessReads({
    installation: scope,
    sessions: [{ ...scope, sessionId: "session", teamId: "team", issueId: item.linearIssueId }],
    teams: ["team"],
  });
  const lifecycle = createFakeLinearIssueLifecycle({
    id: item.linearIssueId,
    teamId: "team",
    assigneeId: "human",
    delegateId: "app",
    stateType: "started",
  });
  const gate = new LinearTaskAccess(db, {
    access: reads.adapter,
    lifecycle,
    oauthClientId: "client",
    appUserId: "app",
    stopSession: () => syncSteps(() => {}),
    now: () => 10,
  });
  let unavailable = true;
  const sessionRead = reads.adapter.session;
  reads.adapter.session = (...args) => {
    if (unavailable) return Promise.reject(new Error("Scripted outage"));
    return sessionRead(...args);
  };
  const host = createGitHubIntegration({
    runtime: loadRuntime({ GITHUB_AUTH: "app" }),
    env: {},
    repositoryForItem: async () => ({
      owner: "acme",
      repo: "widgets",
      remoteUrl: "https://github.com/acme/widgets.git",
    }),
    integrationIdentity: () => syncSteps(() => "human"),
    authorizeItem: (current, signal) => authorizeLinearTask(gate, current, signal),
  });
  host.check = async () => true;
  host.unavailableRetryMs = [];
  const auth = new GitHubInstallationCheck(db, host, () => 1000);
  try {
    await auth.ensure((await getWorkItem(db, item.id))!, "initial", new AbortController().signal);
    expect((await getWorkItem(db, item.id))?.state).toBe("awaiting_input");
    unavailable = false;
    await revokeLinearInstallation(db, {
      ...scope,
      eventKey: "revoked",
      createdAtMs: 20,
    });
    await auth.recover();
    expect((await getWorkItem(db, item.id))?.state).toBe("cancelled");
    expect(
      (await db.run((q) => q.all(q.orm.select().from(q.t.githubIntegrationHold))))[0]?.status,
    ).toBe("revoked");
  } finally {
    auth.close();
    await close();
  }
});

test("an App task with a selected repository starts without an attribution wait", async () => {
  const { db, close } = await tempStore();
  const env = { GITHUB_AUTH: "app" };
  const host = createGitHubIntegration({
    runtime: loadRuntime(env),
    env,
    repositoryForItem: async () => ({
      owner: "acme",
      repo: "chosen",
      remoteUrl: "https://github.com/acme/chosen.git",
    }),
    integrationIdentity: () => syncSteps(() => "member"),
  });
  expect(Object.keys(host!)).not.toContain("attributionReady");
  host.check = async () => true;
  host.unavailableRetryMs = [];
  const auth = new GitHubInstallationCheck(db, host, () => 1000);
  const item = await insertQueuedItem(db, { id: "unlinked", sessionKey: "session" });
  await beginImplementRun(db, item.id, 1000);
  try {
    expect(
      await auth.ensure((await getWorkItem(db, item.id))!, "initial", new AbortController().signal),
    ).toBe(true);
    expect((await getWorkItem(db, item.id))?.state).toBe("running");
    expect(
      (await listOutbox(db)).some((entry) =>
        JSON.stringify(entry.payload).includes("commit policy"),
      ),
    ).toBe(false);
  } finally {
    auth.close();
    await close();
  }
});

for (const later of [60_000, 11 * 60_000]) {
  test(`a GitHub 502 ${later / 60_000} min after a pass keeps the task running without a question`, async () => {
    const { db, close } = await tempStore();
    const env = { GITHUB_AUTH: "app" };
    const host = createGitHubIntegration({
      runtime: loadRuntime(env),
      env,
      repositoryForItem: async () => ({
        owner: "acme",
        repo: "widgets",
        remoteUrl: "https://github.com/acme/widgets.git",
      }),
      integrationIdentity: () => syncSteps(() => "member"),
      authorizeItem: async () => true,
    });
    host.check = async () => true;
    host.unavailableRetryMs = [];
    let now = 1_000;
    const auth = new GitHubInstallationCheck(db, host, () => now);
    await insertQueuedItem(db, { id: "cached", sessionKey: "cached", title: "cached" });
    await beginImplementRun(db, "cached", now);
    const signal = new AbortController().signal;
    try {
      expect(await auth.ensure((await getWorkItem(db, "cached"))!, "initial", signal)).toBe(true);
      let failures = 2;
      host.unavailableRetryMs = [0];
      host.check = async () => {
        if (failures-- > 0) throw new Error("GitHub API request failed with 502");
        return true;
      };
      now += later;
      expect(await auth.ensure((await getWorkItem(db, "cached"))!, "initial", signal)).toBe(true);
      expect((await getWorkItem(db, "cached"))?.state).toBe("running");
      expect(await db.run((q) => q.all(q.orm.select().from(q.t.question)))).toHaveLength(0);
    } finally {
      auth.close();
      await close();
    }
  });
}

test("a denied authorization after an issue change still stops the task", async () => {
  const { db, close } = await tempStore();
  const env = { GITHUB_AUTH: "app" };
  let allowed = true;
  const host = createGitHubIntegration({
    runtime: loadRuntime(env),
    env,
    repositoryForItem: async () => ({
      owner: "acme",
      repo: "widgets",
      remoteUrl: "https://github.com/acme/widgets.git",
    }),
    integrationIdentity: () => syncSteps(() => "member"),
    authorizeItem: async () => allowed,
  });
  host.check = async () => true;
  host.unavailableRetryMs = [];
  const auth = new GitHubInstallationCheck(db, host, () => 1_000);
  await insertQueuedItem(db, { id: "revoked", sessionKey: "revoked", title: "revoked" });
  await beginImplementRun(db, "revoked", 1_000);
  const signal = new AbortController().signal;
  try {
    expect(await auth.ensure((await getWorkItem(db, "revoked"))!, "initial", signal)).toBe(true);
    allowed = false;
    await auth.invalidate({ issueId: "lin-item-revoked" });
    expect(await auth.ensure((await getWorkItem(db, "revoked"))!, "initial", signal)).toBe(false);
    expect((await getWorkItem(db, "revoked"))?.state).not.toBe("running");
  } finally {
    auth.close();
    await close();
  }
});

test("production App authorization retries an unavailable check for about a minute", () => {
  const env = { GITHUB_AUTH: "app", PAWS_HOME: mkdtempSync(join(tmpdir(), "paws-retry-")) };
  const host = createGitHubIntegration({
    runtime: loadRuntime(env),
    env,
    repositoryForItem: async () => null,
    integrationIdentity: () => syncSteps(() => "member"),
  });
  const total = (host.unavailableRetryMs ?? []).reduce((sum, ms) => sum + ms, 0);
  expect(total).toBeGreaterThanOrEqual(60_000);
  rmSync(env.PAWS_HOME, { recursive: true, force: true });
});

async function cachedAuthorization() {
  const { db, close } = await tempStore();
  const env = { GITHUB_AUTH: "app" };
  const reads = { membership: 0, installation: 0 };
  let ready = true;
  const host = createGitHubIntegration({
    runtime: loadRuntime(env),
    env,
    repositoryForItem: async () => ({
      owner: "acme",
      repo: "widgets",
      remoteUrl: "https://github.com/acme/widgets.git",
    }),
    integrationIdentity: () => syncSteps(() => "member"),
    authorizeItem: async () => {
      reads.membership++;
      return true;
    },
  });
  host.check = async () => {
    reads.installation++;
    return ready;
  };
  host.unavailableRetryMs = [];
  const clock = { now: 1_000 };
  const auth = new GitHubInstallationCheck(db, host, () => clock.now);
  await insertQueuedItem(db, { id: "task", sessionKey: "session", title: "task" });
  await beginImplementRun(db, "task", clock.now);
  const ensure = async (options?: { fresh?: boolean }) =>
    auth.ensure((await getWorkItem(db, "task"))!, "initial", new AbortController().signal, options);
  return {
    db,
    auth,
    host,
    reads,
    clock,
    ensure,
    blockInstallation: (blocked: boolean) => {
      ready = !blocked;
    },
    close: async () => {
      auth.close();
      await close();
    },
  };
}

test("ten git operations in one task read membership and installation once", async () => {
  const f = await cachedAuthorization();
  try {
    for (let i = 0; i < 10; i++) expect(await f.ensure()).toBe(true);
    expect(f.reads).toEqual({ membership: 1, installation: 1 });
    f.clock.now += TASK_ACCESS_TTL_MS;
    expect(await f.ensure()).toBe(true);
    expect(f.reads).toEqual({ membership: 2, installation: 2 });
  } finally {
    await f.close();
  }
});

for (const scope of [{ issueId: "lin-item-task" }, { sessionId: "session" }, {}])
  test(`invalidating ${JSON.stringify(scope)} makes the next check read Linear again`, async () => {
    const f = await cachedAuthorization();
    try {
      await f.ensure();
      await f.auth.invalidate({ issueId: "another-issue" });
      await f.auth.invalidate({ sessionId: "another-session" });
      await f.ensure();
      expect(f.reads.membership).toBe(1);
      await f.auth.invalidate(scope);
      await f.ensure();
      expect(f.reads).toEqual({ membership: 2, installation: 2 });
    } finally {
      await f.close();
    }
  });

test("a check that is not ready is never reused", async () => {
  const f = await cachedAuthorization();
  try {
    f.blockInstallation(true);
    expect(await f.ensure()).toBe(false);
    f.blockInstallation(false);
    expect(await f.ensure()).toBe(true);
    expect(f.reads).toEqual({ membership: 2, installation: 2 });
  } finally {
    await f.close();
  }
});

test("a fresh check before publication always reads Linear and refreshes the cache", async () => {
  const f = await cachedAuthorization();
  try {
    await f.ensure();
    await f.ensure({ fresh: true });
    await f.ensure({ fresh: true });
    expect(f.reads).toEqual({ membership: 3, installation: 3 });
    await f.ensure();
    expect(f.reads.membership).toBe(3);
  } finally {
    await f.close();
  }
});

test("an invalidation still keeps the recent ready check as a fallback for a transient outage", async () => {
  const f = await cachedAuthorization();
  try {
    await f.ensure();
    await f.auth.invalidate();
    f.host.check = async () => {
      throw new Error("GitHub API request failed with 502");
    };
    expect(await f.ensure()).toBe(true);
    expect((await getWorkItem(f.db, "task"))?.state).toBe("running");
  } finally {
    await f.close();
  }
});
