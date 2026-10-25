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
  migrate,
  openDatabase,
  recordLinearInstallation,
  revokeLinearInstallation,
} from "../src/db";

test("transient production authorization persists a wait, survives restart and recovers once alongside a sibling", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-integration-unavailable-"));
  const path = join(root, "db.sqlite");
  const db = openDatabase(path);
  migrate(db);
  const signal = new AbortController().signal;
  let unavailable = true;
  const env = { GITHUB_AUTH: "app", PAWS_HOME: root };
  const host = createGitHubIntegration({
    runtime: loadRuntime(env),
    env,
    repositoryForItem: () => ({
      owner: "acme",
      repo: "widgets",
      remoteUrl: "https://github.com/acme/widgets.git",
    }),
    actorForItem: () => "member",
    authorizeItem: async () => {
      if (unavailable) throw new Error("Scripted Linear outage");
      return true;
    },
  });
  host.check = async () => true;
  host.unavailableRetryMs = [];
  const auth = new GitHubInstallationCheck(db, host, () => 1000);
  insertQueuedItem(db, { id: "unavailable", sessionKey: "unavailable", title: "unavailable" });
  beginImplementRun(db, "unavailable", 1000);
  const first = getWorkItem(db, "unavailable")!;
  try {
    expect(await auth.ensure(first, "initial", signal)).toBe(false);
    expect(getWorkItem(db, first.id)?.state).toBe("awaiting_input");
    expect(listOutbox(db).filter((entry) => entry.op === "elicitation")).toHaveLength(0);
    expect(
      listOutbox(db).some((entry) => JSON.stringify(entry.payload).includes("retry automatically")),
    ).toBe(true);
    await auth.recover();
    expect(getWorkItem(db, first.id)?.state).toBe("awaiting_input");
  } finally {
    auth.close();
    db.close();
  }
  const reopened = openDatabase(path);
  let denied = false;
  host.authorize = async (item) => {
    if (item.id === first.id && unavailable) throw new Error("Scripted Linear outage");
    return !denied;
  };
  const recovered = new GitHubInstallationCheck(reopened, host, () => 2000);
  try {
    insertQueuedItem(reopened, { id: "sibling", sessionKey: "sibling", title: "sibling" });
    beginImplementRun(reopened, "sibling", 2000);
    host.check = async (item) => item.id !== "sibling";
    await recovered.ensure(getWorkItem(reopened, "sibling")!, "initial", signal);
    host.check = async () => true;
    host.unavailableRetryMs = [];
    await recovered.recover();
    expect(getWorkItem(reopened, first.id)?.state).toBe("awaiting_input");
    expect(getWorkItem(reopened, "sibling")?.state).toBe("running");
    unavailable = false;
    await Promise.all([recovered.recover(), recovered.recover()]);
    await recovered.recover();
    expect(getWorkItem(reopened, first.id)?.state).toBe("running");
    expect(listJobs(reopened).filter((job) => job.queue === "run.resume")).toHaveLength(2);
    insertQueuedItem(reopened, { id: "revoked", sessionKey: "revoked", title: "revoked" });
    beginImplementRun(reopened, "revoked", 2000);
    host.check = async () => false;
    await recovered.ensure(getWorkItem(reopened, "revoked")!, "initial", signal);
    denied = true;
    await recovered.recover();
    expect(getWorkItem(reopened, "revoked")?.state).toBe("cancelled");
  } finally {
    recovered.close();
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("real LinearTaskAccess distinguishes revoked installation from unavailable reads without relying on stop callback", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
  const item = insertQueuedItem(db, { id: "task", sessionKey: "session", title: "task" });
  beginImplementRun(db, item.id, 1000);
  recordLinearInstallation(db, { ...scope, sessionId: "session", teamId: "team", observedAtMs: 1 });
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
    stopSession: () => {},
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
    repositoryForItem: () => ({
      owner: "acme",
      repo: "widgets",
      remoteUrl: "https://github.com/acme/widgets.git",
    }),
    actorForItem: () => "human",
    authorizeItem: (current, signal) => authorizeLinearTask(gate, current, signal),
  });
  host.check = async () => true;
  host.unavailableRetryMs = [];
  const auth = new GitHubInstallationCheck(db, host, () => 1000);
  try {
    await auth.ensure(getWorkItem(db, item.id)!, "initial", new AbortController().signal);
    expect(getWorkItem(db, item.id)?.state).toBe("awaiting_input");
    unavailable = false;
    revokeLinearInstallation(db, { ...scope, eventKey: "revoked", createdAtMs: 20 });
    await auth.recover();
    expect(getWorkItem(db, item.id)?.state).toBe("cancelled");
    expect(
      db.query<{ status: string }, []>("SELECT status FROM github_integration_hold").get()?.status,
    ).toBe("revoked");
  } finally {
    auth.close();
    db.close();
  }
});

test("an App task with a selected repository starts without an attribution wait", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const env = { GITHUB_AUTH: "app" };
  const host = createGitHubIntegration({
    runtime: loadRuntime(env),
    env,
    repositoryForItem: () => ({
      owner: "acme",
      repo: "chosen",
      remoteUrl: "https://github.com/acme/chosen.git",
    }),
    actorForItem: () => "member",
  });
  expect(Object.keys(host!)).not.toContain("attributionReady");
  host.check = async () => true;
  host.unavailableRetryMs = [];
  const auth = new GitHubInstallationCheck(db, host, () => 1000);
  const item = insertQueuedItem(db, { id: "unlinked", sessionKey: "session" });
  beginImplementRun(db, item.id, 1000);
  try {
    expect(
      await auth.ensure(getWorkItem(db, item.id)!, "initial", new AbortController().signal),
    ).toBe(true);
    expect(getWorkItem(db, item.id)?.state).toBe("running");
    expect(
      listOutbox(db).some((entry) => JSON.stringify(entry.payload).includes("commit policy")),
    ).toBe(false);
  } finally {
    auth.close();
    db.close();
  }
});

for (const [later, outcome] of [
  [60_000, "running"],
  [11 * 60_000, "awaiting_input"],
] as const) {
  test(`a GitHub check that fails ${later / 60_000} min after it passed leaves the task ${outcome}`, async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const env = { GITHUB_AUTH: "app" };
    const host = createGitHubIntegration({
      runtime: loadRuntime(env),
      env,
      repositoryForItem: () => ({
        owner: "acme",
        repo: "widgets",
        remoteUrl: "https://github.com/acme/widgets.git",
      }),
      actorForItem: () => "member",
      authorizeItem: async () => true,
    });
    host.check = async () => true;
    host.unavailableRetryMs = [];
    let now = 1_000;
    const auth = new GitHubInstallationCheck(db, host, () => now);
    insertQueuedItem(db, { id: "cached", sessionKey: "cached", title: "cached" });
    beginImplementRun(db, "cached", now);
    const signal = new AbortController().signal;
    try {
      expect(await auth.ensure(getWorkItem(db, "cached")!, "initial", signal)).toBe(true);
      host.check = async () => {
        throw new Error("GitHub API request failed with 502");
      };
      now += later;
      expect(await auth.ensure(getWorkItem(db, "cached")!, "initial", signal)).toBe(
        outcome === "running",
      );
      expect(getWorkItem(db, "cached")?.state).toBe(outcome);
    } finally {
      auth.close();
      db.close();
    }
  });
}

test("a denied authorization after an issue change still stops the task", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const env = { GITHUB_AUTH: "app" };
  let allowed = true;
  const host = createGitHubIntegration({
    runtime: loadRuntime(env),
    env,
    repositoryForItem: () => ({
      owner: "acme",
      repo: "widgets",
      remoteUrl: "https://github.com/acme/widgets.git",
    }),
    actorForItem: () => "member",
    authorizeItem: async () => allowed,
  });
  host.check = async () => true;
  host.unavailableRetryMs = [];
  const auth = new GitHubInstallationCheck(db, host, () => 1_000);
  insertQueuedItem(db, { id: "revoked", sessionKey: "revoked", title: "revoked" });
  beginImplementRun(db, "revoked", 1_000);
  const signal = new AbortController().signal;
  try {
    expect(await auth.ensure(getWorkItem(db, "revoked")!, "initial", signal)).toBe(true);
    allowed = false;
    auth.invalidate({ issueId: "lin-item-revoked" });
    expect(await auth.ensure(getWorkItem(db, "revoked")!, "initial", signal)).toBe(false);
    expect(getWorkItem(db, "revoked")?.state).not.toBe("running");
  } finally {
    auth.close();
    db.close();
  }
});

test("production App authorization retries an unavailable check for about a minute", () => {
  const env = { GITHUB_AUTH: "app", PAWS_HOME: mkdtempSync(join(tmpdir(), "paws-retry-")) };
  const host = createGitHubIntegration({
    runtime: loadRuntime(env),
    env,
    repositoryForItem: () => null,
    actorForItem: () => "member",
  });
  const total = (host.unavailableRetryMs ?? []).reduce((sum, ms) => sum + ms, 0);
  expect(total).toBeGreaterThanOrEqual(60_000);
  rmSync(env.PAWS_HOME, { recursive: true, force: true });
});

function cachedAuthorization() {
  const db = openDatabase(":memory:");
  migrate(db);
  const env = { GITHUB_AUTH: "app" };
  const reads = { membership: 0, installation: 0 };
  let ready = true;
  const host = createGitHubIntegration({
    runtime: loadRuntime(env),
    env,
    repositoryForItem: () => ({
      owner: "acme",
      repo: "widgets",
      remoteUrl: "https://github.com/acme/widgets.git",
    }),
    actorForItem: () => "member",
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
  insertQueuedItem(db, { id: "task", sessionKey: "session", title: "task" });
  beginImplementRun(db, "task", clock.now);
  const ensure = (options?: { fresh?: boolean }) =>
    auth.ensure(getWorkItem(db, "task")!, "initial", new AbortController().signal, options);
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
    close: () => {
      auth.close();
      db.close();
    },
  };
}

test("ten git operations in one task read membership and installation once", async () => {
  const f = cachedAuthorization();
  try {
    for (let i = 0; i < 10; i++) expect(await f.ensure()).toBe(true);
    expect(f.reads).toEqual({ membership: 1, installation: 1 });
    f.clock.now += TASK_ACCESS_TTL_MS;
    expect(await f.ensure()).toBe(true);
    expect(f.reads).toEqual({ membership: 2, installation: 2 });
  } finally {
    f.close();
  }
});

for (const scope of [{ issueId: "lin-item-task" }, { sessionId: "session" }, {}])
  test(`invalidating ${JSON.stringify(scope)} makes the next check read Linear again`, async () => {
    const f = cachedAuthorization();
    try {
      await f.ensure();
      f.auth.invalidate({ issueId: "another-issue" });
      f.auth.invalidate({ sessionId: "another-session" });
      await f.ensure();
      expect(f.reads.membership).toBe(1);
      f.auth.invalidate(scope);
      await f.ensure();
      expect(f.reads).toEqual({ membership: 2, installation: 2 });
    } finally {
      f.close();
    }
  });

test("a check that is not ready is never reused", async () => {
  const f = cachedAuthorization();
  try {
    f.blockInstallation(true);
    expect(await f.ensure()).toBe(false);
    f.blockInstallation(false);
    expect(await f.ensure()).toBe(true);
    expect(f.reads).toEqual({ membership: 2, installation: 2 });
  } finally {
    f.close();
  }
});

test("a fresh check before publication always reads Linear and refreshes the cache", async () => {
  const f = cachedAuthorization();
  try {
    await f.ensure();
    await f.ensure({ fresh: true });
    await f.ensure({ fresh: true });
    expect(f.reads).toEqual({ membership: 3, installation: 3 });
    await f.ensure();
    expect(f.reads.membership).toBe(3);
  } finally {
    f.close();
  }
});

test("an invalidation still keeps the recent ready check as a fallback for a transient outage", async () => {
  const f = cachedAuthorization();
  try {
    await f.ensure();
    f.auth.invalidate();
    f.host.check = async () => {
      throw new Error("GitHub API request failed with 502");
    };
    expect(await f.ensure()).toBe(true);
    expect(getWorkItem(f.db, "task")?.state).toBe("running");
  } finally {
    f.close();
  }
});
