import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
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
  saveCheckpoint,
  openPawsStore,
  syncSteps,
  type Db,
} from "../db";
import { LinearRateLimitError } from "../linear";
import { getQuestion } from "../questions";
import { GitHubInstallationCheck } from "./github-integration";
import { seed } from "../../test/dialects";
import { copyMigratedPglite, tempStore } from "../../test/pglite";

function questions(db: Db) {
  return db.run((q) =>
    q.all(
      q.orm
        .select({
          body: q.t.question.body,
          status: q.t.question.status,
          cancelledAt: q.t.question.cancelledAt,
        })
        .from(q.t.question),
    ),
  );
}

function holds(db: Db) {
  return db.run((q) =>
    q.all(
      q.orm
        .select({
          questionId: q.t.githubIntegrationHold.questionId,
          status: q.t.githubIntegrationHold.status,
        })
        .from(q.t.githubIntegrationHold),
    ),
  );
}

async function fixture(store?: { db: Db; close(): Promise<void> }) {
  const { db, close } = store ?? (await tempStore());
  let ready = false;
  let allowed = true;
  let authority = "requester:repository:candidate:evidence";
  const integration = {
    async check() {
      return ready && allowed;
    },
    administrators: () => syncSteps(() => ["lead", "admin", "admin"]),
    recoveryUrl: "https://paws.example/status/settings/integrations",
    identity: () => syncSteps(() => authority),
  };
  const auth = new GitHubInstallationCheck(
    db,
    integration,
    () => 1000,
    () => syncSteps(() => allowed),
  );
  const item = async (id: string) => {
    await insertQueuedItem(db, { id, sessionKey: `session-${id}`, title: id });
    await beginImplementRun(db, id, 1000);
    return (await getWorkItem(db, id))!;
  };
  return {
    db,
    close,
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
  const f = await fixture();
  try {
    f.ready();
    for (const id of ["member-a", "member-b"])
      expect(await f.auth.ensure(await f.item(id), "initial", f.signal)).toBe(true);
    expect(await f.auth.ensure(await f.item("publisher"), "publication", f.signal)).toBe(true);
    expect(await listJobs(f.db)).toHaveLength(0);
    expect(await listOutbox(f.db)).toHaveLength(0);
    expect(await questions(f.db)).toHaveLength(0);
  } finally {
    f.auth.close();
    await f.close();
  }
});

test("missing installation: the waiting message shows once and the item resumes by itself", async () => {
  const f = await fixture();
  try {
    const item = await f.item("member");
    expect(await f.auth.ensure(item, "initial", f.signal)).toBe(false);
    expect(await f.auth.ensure((await getWorkItem(f.db, item.id))!, "initial", f.signal)).toBe(
      false,
    );
    await f.auth.recover();
    const waiting = (await listOutbox(f.db)).filter(
      (entry) =>
        entry.op === "activity" &&
        JSON.stringify(entry.payload).includes("Waiting for a workspace admin"),
    );
    expect(waiting).toHaveLength(1);
    expect(await questions(f.db)).toHaveLength(1);
    expect((await getWorkItem(f.db, item.id))?.state).toBe("awaiting_input");
    f.ready();
    await f.auth.recover();
    expect((await getWorkItem(f.db, item.id))?.state).toBe("running");
    expect((await listJobs(f.db)).map((job) => job.queue)).toEqual(["run.resume"]);
    expect((await questions(f.db)).filter((row) => row.status === "open")).toHaveLength(0);
  } finally {
    f.auth.close();
    await f.close();
  }
});

test("an App hold is asked as the github-auth kind and posts no question of its own", async () => {
  const f = await fixture();
  try {
    expect(await f.auth.ensure(await f.item("member"), "initial", f.signal)).toBe(false);
    const hold = (await holds(f.db))[0]!;
    expect(await getQuestion(f.db, hold.questionId)).toMatchObject({
      kind: "github-auth",
    });
    expect((await listOutbox(f.db)).map((row) => row.idempotencyKey).sort()).toEqual([
      `github-integration:admin:${hold.questionId}:admin`,
      `github-integration:admin:${hold.questionId}:lead`,
      `github-integration:waiting:${hold.questionId}`,
    ]);
  } finally {
    f.auth.close();
    await f.close();
  }
});

test("App hold survives restart, notifies only administrators and revalidates exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-integration-"));
  const pgliteDir = join(root, "pglite");
  await copyMigratedPglite(pgliteDir);
  const opened = await openPawsStore({ url: null, pgliteDir });
  const f = await fixture({ db: opened.store, close: opened.close });
  const item = await f.item("member");
  expect(await f.auth.ensure(item, "initial", f.signal)).toBe(false);
  expect(await f.auth.ensure((await getWorkItem(f.db, item.id))!, "initial", f.signal)).toBe(false);
  const prompts = (await listOutbox(f.db)).filter((entry) => entry.op === "elicitation");
  expect(prompts).toHaveLength(2);
  expect(
    prompts.map((entry) => (entry.payload as { auth: { userId: string } }).auth.userId).sort(),
  ).toEqual(["admin", "lead"]);
  const hold = (await holds(f.db))[0]!;
  expect((await getQuestion(f.db, hold.questionId))?.status).toBe("open");
  f.auth.close();
  await f.close();
  const { store: reopened, close } = await openPawsStore({ url: null, pgliteDir });
  f.ready();
  const recovered = new GitHubInstallationCheck(reopened, f.integration, () => 1000000);
  try {
    await Promise.all([recovered.recover(), recovered.recover()]);
    await recovered.recover();
    expect(await listJobs(reopened)).toHaveLength(1);
    expect((await getWorkItem(reopened, item.id))?.state).toBe("running");
    expect((await holds(reopened))[0]?.status).toBe("verified");
  } finally {
    recovered.close();
    await close();
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
    const f = await fixture();
    try {
      const item = await f.item("member");
      await f.auth.ensure(item, "initial", f.signal);
      if (invalidation === "membership") f.deny();
      if (invalidation === "stop")
        await seed(f.db, (q) =>
          q.orm
            .update(q.t.workItem)
            .set({ cancelRequested: 1 })
            .where(eq(q.t.workItem.id, item.id)),
        );
      if (invalidation === "generation")
        await advanceLinearSessionGeneration(f.db, item.sessionKey!);
      if (invalidation === "candidate") f.supersede();
      if (invalidation === "checkpoint")
        await saveCheckpoint(f.db, item.id, {
          phase: "running",
          wipCommit: "changed",
        });
      f.ready();
      await f.auth.recover();
      expect(
        (await listJobs(f.db)).filter(
          (job) => job.queue === "run.resume" || job.queue === "run.reverify",
        ),
      ).toHaveLength(0);
      if (invalidation !== "stop")
        expect((await getWorkItem(f.db, item.id))?.state).toBe("cancelled");
      expect(
        (await questions(f.db)).filter((row) => row.status === "open" && row.cancelledAt === null),
      ).toHaveLength(0);
    } finally {
      f.auth.close();
      await f.close();
    }
  });
}

test("App preflight refuses a checkpoint changed during installation lookup", async () => {
  const f = await fixture();
  const item = await f.item("member");
  f.integration.check = async () => {
    await saveCheckpoint(f.db, item.id, { phase: "running", wipCommit: "new" });
    return true;
  };
  try {
    expect(await f.auth.ensure(item, "initial", f.signal)).toBe(false);
    expect(await listJobs(f.db)).toHaveLength(0);
  } finally {
    f.auth.close();
    await f.close();
  }
});

test("unavailable: a failed check holds the item with the retry message and no admin prompt", async () => {
  const f = await fixture();
  Object.assign(f.integration, {
    unavailableRetryMs: [],
    async check() {
      throw new Error("Linear unavailable");
    },
  });
  try {
    const item = await f.item("outage");
    expect(await f.auth.ensure(item, "initial", f.signal)).toBe(false);
    expect((await getWorkItem(f.db, item.id))?.state).toBe("awaiting_input");
    expect((await questions(f.db))[0]?.body).toContain("could not be checked");
    expect((await listOutbox(f.db)).filter((entry) => entry.op === "elicitation")).toHaveLength(0);
  } finally {
    f.auth.close();
    await f.close();
  }
});

test("denied: a member who loses access while held is cancelled on recovery", async () => {
  const f = await fixture();
  try {
    const item = await f.item("member");
    expect(await f.auth.ensure(item, "initial", f.signal)).toBe(false);
    f.deny();
    f.ready();
    await f.auth.recover();
    expect((await getWorkItem(f.db, item.id))?.state).toBe("cancelled");
    expect((await listJobs(f.db)).filter((job) => job.queue === "run.resume")).toHaveLength(0);
  } finally {
    f.auth.close();
    await f.close();
  }
});

test("one unavailable requester does not stop recovery of other held work", async () => {
  const f = await fixture();
  for (const id of ["unavailable", "ready"])
    await f.auth.ensure(await f.item(id), "initial", f.signal);
  const original = f.integration.check;
  f.integration.check = async (item?: { id: string }) => {
    if (item?.id === "unavailable") throw new Error("Linear unavailable");
    return original();
  };
  f.ready();
  try {
    await f.auth.recover();
    expect((await getWorkItem(f.db, "unavailable"))?.state).toBe("awaiting_input");
    expect((await getWorkItem(f.db, "ready"))?.state).toBe("running");
    expect(await listJobs(f.db)).toHaveLength(1);
  } finally {
    f.auth.close();
    await f.close();
  }
});

test("App publication recovery queues fresh verification, not publication", async () => {
  const f = await fixture();
  try {
    const item = await f.item("member");
    await applyWorkItemEvent(f.db, item.id, "turn_ended");
    await applyWorkItemEvent(f.db, item.id, "closeout_accepted");
    await f.auth.ensure((await getWorkItem(f.db, item.id))!, "publication", f.signal);
    f.ready();
    await f.auth.recover();
    expect((await listJobs(f.db)).map((job) => job.queue)).toEqual(["run.reverify"]);
    expect((await getWorkItem(f.db, item.id))?.state).toBe("verifying");
  } finally {
    f.auth.close();
    await f.close();
  }
});

for (const source of ["local", "live"] as const) {
  test(`denied: ${source} loss of access before a hold cancels instead of stranding running work`, async () => {
    const f = await fixture();
    const item = await f.item("denied");
    const auth = new GitHubInstallationCheck(
      f.db,
      {
        ...f.integration,
        current: () => syncSteps(() => source !== "local"),
        authorize: async () => source !== "live",
      },
      () => 1000,
    );
    try {
      expect(await auth.ensure(item, "initial", f.signal)).toBe(false);
      expect((await getWorkItem(f.db, item.id))?.state).toBe("cancelled");
      expect((await getWorkItem(f.db, item.id))?.cancelRequested).toBe(true);
      expect(await holds(f.db)).toHaveLength(0);
      expect((await listOutbox(f.db)).some((entry) => entry.delivery === "stop")).toBe(true);
    } finally {
      auth.close();
      f.auth.close();
      await f.close();
    }
  });
}

test("recovery replaces an unavailable message with the current installation blocker only once", async () => {
  const f = await fixture();
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
    const item = await f.item("changed-blocker");
    await f.auth.ensure(item, "initial", f.signal);
    const question = async () => (await questions(f.db))[0]!;
    expect((await question()).body).toContain("could not be checked");
    unavailable = false;
    await f.auth.recover();
    await f.auth.recover();
    expect((await question()).body).toContain(blocker);
    expect(
      (await listOutbox(f.db)).filter((entry) => JSON.stringify(entry.payload).includes(blocker)),
    ).toHaveLength(1);
    expect((await getWorkItem(f.db, item.id))?.state).toBe("awaiting_input");
    expect((await listJobs(f.db)).filter((job) => job.queue === "run.resume")).toHaveLength(0);
    installed = true;
    await f.auth.recover();
    await f.auth.recover();
    expect((await getWorkItem(f.db, item.id))?.state).toBe("running");
    expect((await listJobs(f.db)).filter((job) => job.queue === "run.resume")).toHaveLength(1);
  } finally {
    f.auth.close();
    await f.close();
  }
});

test("a check that fails briefly is retried quietly before the task is held", async () => {
  const f = await fixture();
  let failures = 2;
  Object.assign(f.integration, {
    unavailableRetryMs: [0, 0, 0],
    async check() {
      if (failures-- > 0) throw new Error("Linear GraphQL returned no data");
      return true;
    },
  });
  try {
    const item = await f.item("restarted");
    expect(await f.auth.ensure(item, "initial", f.signal)).toBe(true);
    expect((await getWorkItem(f.db, item.id))?.state).toBe("running");
    expect(await holds(f.db)).toHaveLength(0);
    expect(await listOutbox(f.db)).toHaveLength(0);
  } finally {
    f.auth.close();
    await f.close();
  }
});

test("a rate-limited check keeps retrying quietly and posts nothing in Linear", async () => {
  const f = await fixture();
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
    const item = await f.item("limited");
    expect(await f.auth.ensure(item, "initial", f.signal)).toBe(true);
    expect((await getWorkItem(f.db, item.id))?.state).toBe("running");
    expect(await holds(f.db)).toHaveLength(0);
    expect(await listOutbox(f.db)).toHaveLength(0);
  } finally {
    f.auth.close();
    await f.close();
  }
});

test("a check that keeps failing still holds the task after the quiet retries", async () => {
  const f = await fixture();
  let calls = 0;
  Object.assign(f.integration, {
    unavailableRetryMs: [0, 0],
    async check() {
      calls += 1;
      throw new Error("Linear GraphQL returned no data");
    },
  });
  try {
    const item = await f.item("outage");
    expect(await f.auth.ensure(item, "initial", f.signal)).toBe(false);
    expect(calls).toBe(3);
    expect((await getWorkItem(f.db, item.id))?.state).toBe("awaiting_input");
  } finally {
    f.auth.close();
    await f.close();
  }
});
