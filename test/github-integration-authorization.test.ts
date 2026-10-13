import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeLinearAccessReads, createFakeLinearIssueLifecycle } from "../src/linear";
import { loadRuntime } from "../src/config";
import { createLinearGitHubAuth } from "../src/index";
import { GitHubAuthQuestions, LinearTaskAccess, authorizeLinearTask } from "../src/loop";
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
  const host = createLinearGitHubAuth({
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
  host.integration!.check = async () => true;
  const auth = new GitHubAuthQuestions(db, host, () => 1000);
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
  host.integration!.authorize = async (item) => {
    if (item.id === first.id && unavailable) throw new Error("Scripted Linear outage");
    return !denied;
  };
  const recovered = new GitHubAuthQuestions(reopened, host, () => 2000);
  try {
    insertQueuedItem(reopened, { id: "sibling", sessionKey: "sibling", title: "sibling" });
    beginImplementRun(reopened, "sibling", 2000);
    host.integration!.check = async (item) => item.id !== "sibling";
    await recovered.ensure(getWorkItem(reopened, "sibling")!, "initial", signal);
    host.integration!.check = async () => true;
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
    host.integration!.check = async () => false;
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
  const host = createLinearGitHubAuth({
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
  host.integration!.check = async () => true;
  const auth = new GitHubAuthQuestions(db, host, () => 1000);
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
