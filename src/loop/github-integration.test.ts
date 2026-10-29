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
import { LinearRateLimitError } from "../linear";
import { getQuestion } from "../questions";
import { GitHubInstallationCheck } from "./github-integration";

function fixture(path = ":memory:") {
  const db = openDatabase(path);
  migrate(db);
  let ready = false;
  let allowed = true;
  let authority = "requester:repository:candidate:evidence";
  const integration = {
    async check() {
      return ready && allowed;
    },
    administrators: () => ["lead", "admin", "admin"],
    recoveryUrl: "https://paws.example/status/settings/integrations",
    identity: () => authority,
  };
  const auth = new GitHubInstallationCheck(
    db,
    integration,
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

test("ready: two members use one App installation and proceed without any question", async () => {
  const f = fixture();
  try {
    f.ready();
    for (const id of ["member-a", "member-b"])
      expect(await f.auth.ensure(f.item(id), "initial", f.signal)).toBe(true);
    expect(await f.auth.ensure(f.item("publisher"), "publication", f.signal)).toBe(true);
    expect(listJobs(f.db)).toHaveLength(0);
    expect(listOutbox(f.db)).toHaveLength(0);
    expect(f.db.query("SELECT * FROM question").all()).toHaveLength(0);
  } finally {
    f.auth.close();
    f.db.close();
  }
});

test("missing installation: the waiting message shows once and the item resumes by itself", async () => {
  const f = fixture();
  try {
    const item = f.item("member");
    expect(await f.auth.ensure(item, "initial", f.signal)).toBe(false);
    expect(await f.auth.ensure(getWorkItem(f.db, item.id)!, "initial", f.signal)).toBe(false);
    await f.auth.recover();
    const waiting = listOutbox(f.db).filter(
      (entry) =>
        entry.op === "activity" &&
        JSON.stringify(entry.payload).includes("Waiting for a workspace admin"),
    );
    expect(waiting).toHaveLength(1);
    expect(f.db.query("SELECT * FROM question").all()).toHaveLength(1);
    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    f.ready();
    await f.auth.recover();
    expect(getWorkItem(f.db, item.id)?.state).toBe("running");
    expect(listJobs(f.db).map((job) => job.queue)).toEqual(["run.resume"]);
    expect(f.db.query("SELECT * FROM question WHERE status='open'").all()).toHaveLength(0);
  } finally {
    f.auth.close();
    f.db.close();
  }
});

test("an App hold is asked as the github-auth kind and posts no question of its own", async () => {
  const f = fixture();
  try {
    expect(await f.auth.ensure(f.item("member"), "initial", f.signal)).toBe(false);
    const hold = f.db
      .query<{ question_id: string }, []>("SELECT question_id FROM github_integration_hold")
      .get()!;
    expect(getQuestion(f.db, hold.question_id)).toMatchObject({ kind: "github-auth" });
    expect(
      listOutbox(f.db)
        .map((row) => row.idempotencyKey)
        .sort(),
    ).toEqual([
      `github-integration:admin:${hold.question_id}:admin`,
      `github-integration:admin:${hold.question_id}:lead`,
      `github-integration:waiting:${hold.question_id}`,
    ]);
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
  ).toEqual(["admin", "lead"]);
  const hold = f.db
    .query<{ question_id: string }, []>("SELECT question_id FROM github_integration_hold")
    .get()!;
  expect(getQuestion(f.db, hold.question_id)?.status).toBe("open");
  f.auth.close();
  f.db.close();
  const reopened = openDatabase(path);
  f.ready();
  const recovered = new GitHubInstallationCheck(reopened, f.integration, () => 1000000);
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

test("unavailable: a failed check holds the item with the retry message and no admin prompt", async () => {
  const f = fixture();
  Object.assign(f.integration, {
    unavailableRetryMs: [],
    async check() {
      throw new Error("Linear unavailable");
    },
  });
  try {
    const item = f.item("outage");
    expect(await f.auth.ensure(item, "initial", f.signal)).toBe(false);
    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    expect(f.db.query<{ body: string }, []>("SELECT body FROM question").get()?.body).toContain(
      "could not be checked",
    );
    expect(listOutbox(f.db).filter((entry) => entry.op === "elicitation")).toHaveLength(0);
  } finally {
    f.auth.close();
    f.db.close();
  }
});

test("denied: a member who loses access while held is cancelled on recovery", async () => {
  const f = fixture();
  try {
    const item = f.item("member");
    expect(await f.auth.ensure(item, "initial", f.signal)).toBe(false);
    f.deny();
    f.ready();
    await f.auth.recover();
    expect(getWorkItem(f.db, item.id)?.state).toBe("cancelled");
    expect(listJobs(f.db).filter((job) => job.queue === "run.resume")).toHaveLength(0);
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
  test(`denied: ${source} loss of access before a hold cancels instead of stranding running work`, async () => {
    const f = fixture();
    const item = f.item("denied");
    const auth = new GitHubInstallationCheck(
      f.db,
      {
        ...f.integration,
        current: () => source !== "local",
        authorize: async () => source !== "live",
      },
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

test("recovery replaces an unavailable message with the current installation blocker only once", async () => {
  const f = fixture();
  let unavailable = true;
  let installed = false;
  Object.assign(f.integration, {
    unavailableRetryMs: [],
    async check() {
      if (unavailable) throw new Error("Scripted outage");
      return installed;
    },
  });
  const blocker = "restore the GitHub App installation";
  try {
    const item = f.item("changed-blocker");
    await f.auth.ensure(item, "initial", f.signal);
    const question = () => f.db.query<{ body: string }, []>("SELECT body FROM question").get()!;
    expect(question().body).toContain("could not be checked");
    unavailable = false;
    await f.auth.recover();
    await f.auth.recover();
    expect(question().body).toContain(blocker);
    expect(
      listOutbox(f.db).filter((entry) => JSON.stringify(entry.payload).includes(blocker)),
    ).toHaveLength(1);
    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    expect(listJobs(f.db).filter((job) => job.queue === "run.resume")).toHaveLength(0);
    installed = true;
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

test("a rate-limited check keeps retrying quietly and posts nothing in Linear", async () => {
  const f = fixture();
  let limited = 5;
  Object.assign(f.integration, {
    unavailableRetryMs: [0, 0],
    async check() {
      if (limited-- > 0)
        throw new LinearRateLimitError(0, {
          requestsRemaining: 0,
          requestsLimit: 5000,
          requestsResetMs: null,
          complexityRemaining: null,
          complexityLimit: null,
          complexityResetMs: null,
          complexity: null,
        });
      return true;
    },
  });
  try {
    const item = f.item("limited");
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
