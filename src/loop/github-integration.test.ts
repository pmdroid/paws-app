import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWorkItemEvent,
  advanceLinearSessionGeneration,
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  migrate,
  openDatabase,
  saveCheckpoint,
} from "../db";
import { FakeHostGitHubAuth } from "./fake-auth";
import { GitHubAuthQuestions } from "./github-auth";

function fixture(path = ":memory:") {
  const db = openDatabase(path);
  migrate(db);
  let ready = false;
  let allowed = true;
  let authority = "requester:repository:candidate:evidence";
  const host = new FakeHostGitHubAuth();
  host.check = async () => {
    throw new Error("Personal account lookup is forbidden");
  };
  const integration = {
    async check() {
      return ready && allowed;
    },
    administrators: () => ["owner", "admin", "admin"],
    recoveryUrl: "https://paws.example/status/settings/integrations",
    identity: () => authority,
  };
  const auth = new GitHubAuthQuestions(
    db,
    {
      ...host,
      integration,
      owner: () => null,
      linkedAccount: async () => {
        throw new Error("Personal token lookup is forbidden");
      },
      check: host.check,
      begin: host.begin.bind(host),
    },
    () => 1000,
    () => allowed,
  );
  const item = (id: string) => {
    insertQueuedItem(db, { id, sessionKey: `session-${id}`, title: id });
    beginImplementRun(db, id, 1000);
    return getWorkItem(db, id)!;
  };
  return {
    db,
    auth,
    integration,
    item,
    signal: new AbortController().signal,
    ready: () => {
      ready = true;
    },
    deny: () => {
      allowed = false;
    },
    supersede: () => {
      authority = "changed";
    },
  };
}

test("two members use one App without personal GitHub sign-in", async () => {
  const f = fixture();
  try {
    f.ready();
    for (const id of ["member-a", "member-b"])
      expect(await f.auth.ensure(f.item(id), "initial", f.signal)).toBe(true);
    expect(listJobs(f.db)).toHaveLength(0);
    expect(f.db.query("SELECT * FROM linear_github_task_account").all()).toHaveLength(0);
  } finally {
    f.auth.close();
    f.db.close();
  }
});

test("App hold survives restart, notifies only administrators and revalidates exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-integration-"));
  const path = join(root, "db.sqlite");
  const f = fixture(path);
  const item = f.item("member");
  expect(await f.auth.ensure(item, "initial", f.signal)).toBe(false);
  expect(await f.auth.ensure(getWorkItem(f.db, item.id)!, "initial", f.signal)).toBe(false);
  const prompts = listOutbox(f.db).filter((entry) => entry.op === "elicitation");
  expect(prompts).toHaveLength(2);
  expect(
    prompts.map((entry) => (entry.payload as { auth: { userId: string } }).auth.userId).sort(),
  ).toEqual(["admin", "owner"]);
  const hold = f.db
    .query<{ question_id: string }, []>("SELECT question_id FROM github_integration_hold")
    .get()!;
  expect(await f.auth.retry(hold.question_id, "member")).toBe(false);
  f.auth.close();
  f.db.close();
  const reopened = openDatabase(path);
  const host = new FakeHostGitHubAuth();
  f.ready();
  const recovered = new GitHubAuthQuestions(
    reopened,
    Object.assign(host, { integration: f.integration }),
    () => 1000000,
  );
  try {
    await Promise.all([recovered.recover(), recovered.recover()]);
    await recovered.recover();
    expect(listJobs(reopened)).toHaveLength(1);
    expect(getWorkItem(reopened, item.id)?.state).toBe("running");
    expect(
      reopened.query<{ status: string }, []>("SELECT status FROM github_integration_hold").get()
        ?.status,
    ).toBe("verified");
  } finally {
    recovered.close();
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const invalidation of [
  "membership",
  "stop",
  "generation",
  "candidate",
  "checkpoint",
] as const) {
  test(`App recovery refuses obsolete ${invalidation}`, async () => {
    const f = fixture();
    try {
      const item = f.item("member");
      await f.auth.ensure(item, "initial", f.signal);
      if (invalidation === "membership") f.deny();
      if (invalidation === "stop")
        f.db.run("UPDATE work_item SET cancel_requested=1 WHERE id=?", [item.id]);
      if (invalidation === "generation") advanceLinearSessionGeneration(f.db, item.sessionKey!);
      if (invalidation === "candidate") f.supersede();
      if (invalidation === "checkpoint")
        saveCheckpoint(f.db, item.id, {
          phase: "running",
          wipCommit: "changed",
        });
      f.ready();
      await f.auth.recover();
      expect(
        listJobs(f.db).filter((job) => job.queue === "run.resume" || job.queue === "run.reverify"),
      ).toHaveLength(0);
      if (invalidation !== "stop") expect(getWorkItem(f.db, item.id)?.state).toBe("cancelled");
      expect(
        f.db.query("SELECT * FROM question WHERE status='open' AND cancelled_at IS NULL").all(),
      ).toHaveLength(0);
    } finally {
      f.auth.close();
      f.db.close();
    }
  });
}

test("App recovery migrates legacy personal-auth waits without requiring the old human account", async () => {
  const f = fixture();
  const item = f.item("legacy");
  const personal = new GitHubAuthQuestions(f.db, new FakeHostGitHubAuth(), () => 1000);
  await personal.ensure(item, "initial", f.signal);
  personal.close();
  f.ready();
  try {
    await f.auth.recover();
    expect(getWorkItem(f.db, item.id)?.state).toBe("running");
    expect(listJobs(f.db)).toHaveLength(1);
    expect(
      f.db.query<{ status: string }, []>("SELECT status FROM linear_github_auth").get()?.status,
    ).toBe("revoked");
  } finally {
    f.auth.close();
    f.db.close();
  }
});

test("App preflight refuses a checkpoint changed during installation lookup", async () => {
  const f = fixture();
  const item = f.item("member");
  f.integration.check = async () => {
    saveCheckpoint(f.db, item.id, { phase: "running", wipCommit: "new" });
    return true;
  };
  try {
    expect(await f.auth.ensure(item, "initial", f.signal)).toBe(false);
    expect(listJobs(f.db)).toHaveLength(0);
  } finally {
    f.auth.close();
    f.db.close();
  }
});

test("stale legacy question cannot revoke a newer integration hold", async () => {
  const f = fixture();
  const item = f.item("member");
  await f.auth.ensure(item, "initial", f.signal);
  f.db.run(
    "INSERT INTO question(id,item_id,session_id,body,status,created_at,answered_at,answer) VALUES('old',?,'old-session','old','answered',0,1,'old')",
    [item.id],
  );
  f.db.run(
    "INSERT INTO linear_github_auth(question_id,item_id,actor_id,github_account_id,phase,expires_at,status) VALUES('old',?,'owner',7,'initial',1,'expired')",
    [item.id],
  );
  f.ready();
  try {
    await f.auth.recover();
    expect(getWorkItem(f.db, item.id)?.state).toBe("running");
    expect(listJobs(f.db)).toHaveLength(1);
  } finally {
    f.auth.close();
    f.db.close();
  }
});

test("one unavailable requester does not stop recovery of other held work", async () => {
  const f = fixture();
  for (const id of ["unavailable", "ready"]) await f.auth.ensure(f.item(id), "initial", f.signal);
  const original = f.integration.check;
  f.integration.check = async (item?: { id: string }) => {
    if (item?.id === "unavailable") throw new Error("Linear unavailable");
    return original();
  };
  f.ready();
  try {
    await f.auth.recover();
    expect(getWorkItem(f.db, "unavailable")?.state).toBe("awaiting_input");
    expect(getWorkItem(f.db, "ready")?.state).toBe("running");
    expect(listJobs(f.db)).toHaveLength(1);
  } finally {
    f.auth.close();
    f.db.close();
  }
});

test("App publication recovery queues fresh verification, not publication", async () => {
  const f = fixture();
  try {
    const item = f.item("member");
    applyWorkItemEvent(f.db, item.id, "turn_ended");
    applyWorkItemEvent(f.db, item.id, "closeout_accepted");
    await f.auth.ensure(getWorkItem(f.db, item.id)!, "publication", f.signal);
    f.ready();
    await f.auth.recover();
    expect(listJobs(f.db).map((job) => job.queue)).toEqual(["run.reverify"]);
    expect(getWorkItem(f.db, item.id)?.state).toBe("verifying");
  } finally {
    f.auth.close();
    f.db.close();
  }
});

for (const source of ["local", "live"] as const) {
  test(`denied ${source} authority before a hold canonically cancels instead of stranding running work`, async () => {
    const f = fixture();
    const item = f.item("denied");
    const auth = new GitHubAuthQuestions(
      f.db,
      Object.assign(new FakeHostGitHubAuth(), {
        integration: {
          ...f.integration,
          current: () => source !== "local",
          authorize: async () => source !== "live",
        },
      }),
      () => 1000,
    );
    try {
      expect(await auth.ensure(item, "initial", f.signal)).toBe(false);
      expect(getWorkItem(f.db, item.id)?.state).toBe("cancelled");
      expect(getWorkItem(f.db, item.id)?.cancelRequested).toBe(true);
      expect(f.db.query("SELECT * FROM github_integration_hold").all()).toHaveLength(0);
      expect(listOutbox(f.db).some((entry) => entry.delivery === "stop")).toBe(true);
    } finally {
      auth.close();
      f.auth.close();
      f.db.close();
    }
  });
}

test("unverified commit policy parks canonically and automatically resumes exactly once when ready", async () => {
  const f = fixture();
  let consent = false;
  Object.assign(f.integration, { attributionReady: async () => consent });
  try {
    f.ready();
    const item = f.item("attribution");
    expect(await f.auth.ensure(item, "initial", f.signal)).toBe(false);
    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    expect(
      listOutbox(f.db).some((entry) =>
        JSON.stringify(entry.payload).includes("GitHub App commit policy"),
      ),
    ).toBe(true);
    expect(listOutbox(f.db).filter((entry) => entry.op === "elicitation")).toHaveLength(0);
    await f.auth.recover();
    expect(listJobs(f.db)).toHaveLength(0);
    consent = true;
    await Promise.all([f.auth.recover(), f.auth.recover()]);
    await f.auth.recover();
    expect(getWorkItem(f.db, item.id)?.state).toBe("running");
    expect(listJobs(f.db)).toHaveLength(1);
  } finally {
    f.auth.close();
    f.db.close();
  }
});

test("attribution provider outage is a retryable unavailable hold, not missing consent", async () => {
  const f = fixture();
  Object.assign(f.integration, {
    attributionReady: async () => {
      throw new Error("Scripted outage");
    },
  });
  try {
    f.ready();
    expect(await f.auth.ensure(f.item("outage"), "initial", f.signal)).toBe(false);
    expect(
      listOutbox(f.db).some((entry) =>
        JSON.stringify(entry.payload).includes("retry automatically"),
      ),
    ).toBe(true);
    expect(
      listOutbox(f.db).some((entry) =>
        JSON.stringify(entry.payload).includes("GitHub App commit policy"),
      ),
    ).toBe(false);
  } finally {
    f.auth.close();
    f.db.close();
  }
});

test("recovery replaces an unavailable message with the current commit policy blocker only once", async () => {
  const f = fixture();
  let unavailable = true;
  let consent = false;
  Object.assign(f.integration, {
    attributionReady: async () => {
      if (unavailable) throw new Error("Attribution repository is missing");
      return consent;
    },
  });
  try {
    f.ready();
    const item = f.item("changed-blocker");
    await f.auth.ensure(item, "initial", f.signal);
    const question = () => f.db.query<{ body: string }, []>("SELECT body FROM question").get()!;
    expect(question().body).toContain("could not be checked");
    unavailable = false;
    await f.auth.recover();
    await f.auth.recover();
    expect(question().body).toContain("GitHub App commit policy");
    expect(
      listOutbox(f.db).filter((entry) =>
        JSON.stringify(entry.payload).includes("GitHub App commit policy"),
      ),
    ).toHaveLength(1);
    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    expect(listJobs(f.db).filter((job) => job.queue === "run.resume")).toHaveLength(0);
    consent = true;
    await f.auth.recover();
    await f.auth.recover();
    expect(getWorkItem(f.db, item.id)?.state).toBe("running");
    expect(listJobs(f.db).filter((job) => job.queue === "run.resume")).toHaveLength(1);
  } finally {
    f.auth.close();
    f.db.close();
  }
});

test("a check that fails briefly is retried quietly before the task is held", async () => {
  const f = fixture();
  let failures = 2;
  Object.assign(f.integration, {
    unavailableRetryMs: [0, 0, 0],
    async check() {
      if (failures-- > 0) throw new Error("Linear GraphQL returned no data");
      return true;
    },
  });
  try {
    const item = f.item("restarted");
    expect(await f.auth.ensure(item, "initial", f.signal)).toBe(true);
    expect(getWorkItem(f.db, item.id)?.state).toBe("running");
    expect(f.db.query("SELECT * FROM github_integration_hold").all()).toHaveLength(0);
    expect(listOutbox(f.db)).toHaveLength(0);
  } finally {
    f.auth.close();
    f.db.close();
  }
});

test("a check that keeps failing still holds the task after the quiet retries", async () => {
  const f = fixture();
  let calls = 0;
  Object.assign(f.integration, {
    unavailableRetryMs: [0, 0],
    async check() {
      calls += 1;
      throw new Error("Linear GraphQL returned no data");
    },
  });
  try {
    const item = f.item("outage");
    expect(await f.auth.ensure(item, "initial", f.signal)).toBe(false);
    expect(calls).toBe(3);
    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
  } finally {
    f.auth.close();
    f.db.close();
  }
});
