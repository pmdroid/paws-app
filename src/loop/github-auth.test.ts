import { afterEach, describe, expect, test } from "bun:test";
import { FakeClock, CommandBus, JOB_KIND } from "../core";
import { mkdtempSync } from "node:fs";
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
  submitCommand,
} from "../db";
import { findOpenQuestion, getQuestion, openQuestion } from "../questions";
import { GitHubAuthQuestions } from "./github-auth";
import { FakeHostGitHubAuth } from "./fake-auth";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

function fixture(phase: "initial" | "publication" = "initial", path = ":memory:") {
  const db = openDatabase(path);
  migrate(db);
  const clock = new FakeClock(1_000);
  insertQueuedItem(db, { id: "item", sessionKey: "session", title: "Export rows" });
  beginImplementRun(db, "item", clock.now());
  if (phase === "publication") {
    applyWorkItemEvent(db, "item", "turn_ended");
    applyWorkItemEvent(db, "item", "closeout_accepted");
  }
  const host = new FakeHostGitHubAuth();
  const auth = new GitHubAuthQuestions(db, host, () => clock.now());
  cleanup.push(
    () => db.close(),
    () => auth.close(),
  );
  return {
    db,
    clock,
    host,
    auth,
    item: getWorkItem(db, "item")!,
    signal: new AbortController().signal,
  };
}

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("verified GitHub authentication questions", () => {
  test("a pinned task cannot publish after the operator relinks during account lookup", async () => {
    const f = fixture();
    f.host.account = { id: 7, login: "owner" };
    expect(await f.auth.ensure(f.item, "initial", f.signal)).toBe(true);
    applyWorkItemEvent(f.db, f.item.id, "turn_ended");
    applyWorkItemEvent(f.db, f.item.id, "closeout_accepted");
    const lookup = Promise.withResolvers<number | null>();
    const reading = Promise.withResolvers<void>();
    f.host.linkedAccount = () => {
      reading.resolve();
      return lookup.promise;
    };
    let published = false;
    const publication = f.auth
      .ensure(getWorkItem(f.db, f.item.id)!, "publication", f.signal)
      .then((ready) => {
        if (ready) published = true;
        return ready;
      });
    await reading.promise;
    f.host.linkedId = 8;
    lookup.resolve(8);
    expect(await publication).toBe(false);
    expect(published).toBe(false);
    expect(getWorkItem(f.db, f.item.id)?.state).toBe("awaiting_input");
    expect(f.host.challenges[0]!.acceptAccount(8)).toBe(false);
    expect(listJobs(f.db)).toEqual([]);
  });

  test("publication retains the verified task account after the operator relinks", async () => {
    const f = fixture();
    f.host.account = { id: 7, login: "owner" };
    expect(await f.auth.ensure(f.item, "initial", f.signal)).toBe(true);
    applyWorkItemEvent(f.db, f.item.id, "turn_ended");
    applyWorkItemEvent(f.db, f.item.id, "closeout_accepted");
    f.host.account = { id: 8, login: "other-operator" };
    f.host.linkedId = 8;
    expect(await f.auth.ensure(getWorkItem(f.db, f.item.id)!, "publication", f.signal)).toBe(false);
    expect(f.host.challenges[0]!.acceptAccount(8)).toBe(false);
    expect(
      f.db
        .query<{ account_id: number }, []>("SELECT account_id FROM linear_github_task_account")
        .get()?.account_id,
    ).toBe(7);
    expect(listJobs(f.db)).toEqual([]);
  });

  test("the owner can restore the pinned host account after a rejected retry", async () => {
    const f = fixture();
    f.host.account = { id: 7, login: "owner" };
    expect(await f.auth.ensure(f.item, "initial", f.signal)).toBe(true);
    applyWorkItemEvent(f.db, f.item.id, "turn_ended");
    applyWorkItemEvent(f.db, f.item.id, "closeout_accepted");
    f.host.linkedId = 8;
    f.host.account = { id: 8, login: "other" };
    await f.auth.ensure(getWorkItem(f.db, f.item.id)!, "publication", f.signal);
    const question = findOpenQuestion(f.db, "session")!;
    f.host.challenges[0]!.fail(new Error("Wrong host account"));
    await settled();
    expect(await f.auth.retry(question.id, "linear-owner")).toBe(false);
    expect(await f.auth.retry(question.id, "linear-owner")).toBe(false);
    expect(listOutbox(f.db).filter((row) => row.status === "pending")).toHaveLength(1);
    expect(getQuestion(f.db, question.id)?.status).toBe("open");
    expect(listJobs(f.db)).toEqual([]);
    expect(listOutbox(f.db).at(-1)?.payload).toMatchObject({
      body: "Reconnect the original GitHub account on the Paws host, then reply here to continue.",
    });
    f.host.linkedId = 7;
    f.host.account = { id: 7, login: "owner" };
    expect(await f.auth.retry(question.id, "linear-owner")).toBe(true);
    expect(getQuestion(f.db, question.id)?.status).toBe("answered");
    expect(listJobs(f.db).filter((job) => job.queue === JOB_KIND.reverify)).toHaveLength(1);
    expect(await f.auth.retry(question.id, "linear-owner")).toBe(false);
  });

  test("external host login retries verify the original account without an OAuth challenge", async () => {
    const f = fixture();
    f.host.linkedId = null;
    const external = Object.assign(f.host, {
      externalLogin: true,
      recoveryMessage: "Run gh auth login on the Paws host, then reply here.",
    });
    external.account = { id: 7, login: "owner" };
    external.begin = async () => {
      throw new Error("Host login required");
    };
    expect(await f.auth.ensure(f.item, "initial", f.signal)).toBe(true);
    applyWorkItemEvent(f.db, f.item.id, "turn_ended");
    applyWorkItemEvent(f.db, f.item.id, "closeout_accepted");
    external.account = null;
    await f.auth.ensure(getWorkItem(f.db, f.item.id)!, "publication", f.signal);
    const question = findOpenQuestion(f.db, "session")!;
    expect(listOutbox(f.db).at(-1)?.payload).toMatchObject({ body: external.recoveryMessage });
    external.account = { id: 8, login: "other-operator" };
    expect(await f.auth.retry(question.id, "linear-owner")).toBe(true);
    expect(getQuestion(f.db, question.id)?.status).toBe("open");
    external.account = { id: 7, login: "owner" };
    expect(await f.auth.retry(question.id, "linear-owner")).toBe(true);
    expect(getQuestion(f.db, question.id)?.status).toBe("answered");
    expect(listJobs(f.db).filter((job) => job.queue === JOB_KIND.reverify)).toHaveLength(1);
    expect(f.host.challenges).toHaveLength(0);
  });

  test.each(["prompt", "revocation"] as const)(
    "a %s fence rejects an old native completion without answering",
    async (reason) => {
      const f = fixture();
      let allowed = true;
      const guarded = new GitHubAuthQuestions(
        f.db,
        f.host,
        () => f.clock.now(),
        () => allowed,
      );
      cleanup.push(() => guarded.close());
      await guarded.ensure(f.item, "initial", f.signal);
      const question = findOpenQuestion(f.db, "session")!;
      if (reason === "prompt") advanceLinearSessionGeneration(f.db, "session");
      else allowed = false;
      const deliveries = listOutbox(f.db);
      f.host.challenges[0]!.complete({ id: 7, login: "owner" });
      await settled();
      expect(getQuestion(f.db, question.id)?.status).toBe("open");
      expect(listJobs(f.db)).toEqual([]);
      expect(listOutbox(f.db)).toEqual(deliveries);
      expect(f.host.account).toBeNull();
    },
  );

  test("preflight cannot create an auth question after its session generation changes", async () => {
    const f = fixture();
    const checked = Promise.withResolvers<null>();
    f.host.check = () => checked.promise;
    const ensuring = f.auth.ensure(f.item, "initial", f.signal);
    advanceLinearSessionGeneration(f.db, "session");
    checked.resolve(null);
    expect(await ensuring).toBe(false);
    expect(findOpenQuestion(f.db, "session")).toBeNull();
    expect(f.host.challenges).toHaveLength(0);
  });

  test("retry consumption and auth generation commit or roll back together", async () => {
    const f = fixture();
    f.host.begin = async () => {
      throw new Error("Unavailable");
    };
    await f.auth.ensure(f.item, "initial", f.signal);
    const question = findOpenQuestion(f.db, "session")!;
    const generation = () =>
      f.db.query<{ generation: number }, []>("SELECT generation FROM linear_github_auth").get()!
        .generation;
    const before = generation();
    await expect(
      f.auth.retry(question.id, "linear-owner", () => {
        throw new Error("Consumption failed");
      }),
    ).rejects.toThrow("Consumption failed");
    expect(generation()).toBe(before);
    let consumed = false;
    expect(await f.auth.retry(question.id, "someone-else", () => (consumed = true))).toBe(false);
    expect(consumed).toBe(false);
    expect(await f.auth.retry(question.id, "linear-owner", () => (consumed = true))).toBe(true);
    expect(consumed).toBe(true);
    expect(getQuestion(f.db, question.id)?.status).toBe("open");
    expect(listJobs(f.db)).toEqual([]);
  });

  test.each(["begin", "completion"] as const)(
    "failed %s publishes a durable retry question without resuming",
    async (phase) => {
      const f = fixture();
      const begin = f.host.begin.bind(f.host);
      if (phase === "begin")
        f.host.begin = async () => {
          throw new Error("Private provider failure details");
        };
      await f.auth.ensure(f.item, "initial", f.signal);
      if (phase === "completion") {
        f.host.challenges[0]!.fail(new Error("Private provider failure details"));
        await settled();
      }
      const question = findOpenQuestion(f.db, "session")!;
      const pending = listOutbox(f.db).filter((row) => row.status === "pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]?.payload).toMatchObject({
        questionId: question.id,
        sessionId: "session",
        body: "GitHub sign-in could not finish. Reply here to try again.",
      });
      expect(JSON.stringify(pending)).not.toContain("Private provider");
      expect(getQuestion(f.db, question.id)?.status).toBe("open");
      expect(getWorkItem(f.db, "item")?.state).toBe("awaiting_input");
      expect(listJobs(f.db)).toEqual([]);
      f.host.begin = begin;
      await f.auth.retry(question.id, "another-user");
      expect(listOutbox(f.db).filter((row) => row.status === "pending")).toEqual(pending);
      await f.auth.retry(question.id, "linear-owner");
      expect(f.host.challenges.at(-1)?.acceptAccount(7)).toBe(true);
      expect(findOpenQuestion(f.db, "session")?.id).toBe(question.id);
      expect(listJobs(f.db)).toEqual([]);
    },
  );

  test.each(["stop", "close"] as const)(
    "a late provider failure after %s creates no retry delivery",
    async (action) => {
      const f = fixture();
      await f.auth.ensure(f.item, "initial", f.signal);
      if (action === "close") f.auth.close();
      else
        submitCommand(f.db, new CommandBus(), {
          type: "stop",
          source: "linear",
          itemId: "item",
          requestedAt: f.clock.now(),
        });
      const before = listOutbox(f.db);
      f.host.challenges[0]!.fail(new Error("Provider failed after cancellation"));
      await settled();
      expect(listOutbox(f.db)).toEqual(before);
      expect(listJobs(f.db).filter((job) => job.queue === "run.resume")).toEqual([]);
    },
  );

  test("requires the verified task owner and previous host account", async () => {
    const f = fixture();
    f.host.actorId = null;
    await expect(f.auth.ensure(f.item, "initial", f.signal)).rejects.toThrow("owner");
    f.host.actorId = "linear-owner";
    f.host.linkedId = null;
    await expect(f.auth.ensure(f.item, "initial", f.signal)).rejects.toThrow("Sign in");
    expect(findOpenQuestion(f.db, "session")).toBeNull();
  });

  test("valid host credentials do not create a blocking question", async () => {
    const f = fixture();
    f.host.account = { id: 7, login: "owner" };
    expect(await f.auth.ensure(f.item, "initial", f.signal)).toBe(true);
    expect(f.host.challenges).toHaveLength(0);
    expect(findOpenQuestion(f.db, "session")).toBeNull();
  });

  test("a relink during preflight cannot accept the previously linked account", async () => {
    const f = fixture();
    f.host.check = async () => {
      f.host.linkedId = 8;
      return { id: 7, login: "owner" };
    };
    expect(await f.auth.ensure(f.item, "initial", f.signal)).toBe(false);
    expect(getWorkItem(f.db, "item")?.state).toBe("awaiting_input");
    expect(f.host.challenges[0]!.acceptAccount(7)).toBe(false);
    expect(f.host.challenges[0]!.acceptAccount(8)).toBe(true);
  });

  test("recovery pauses a request when the host account changes during verification", async () => {
    const f = fixture();
    await f.auth.ensure(f.item, "initial", f.signal);
    f.auth.close();
    f.host.check = async () => {
      f.host.linkedId = 8;
      return { id: 7, login: "owner" };
    };
    const recovered = new GitHubAuthQuestions(f.db, f.host, () => f.clock.now());
    cleanup.push(() => recovered.close());
    await recovered.recover();
    expect(listJobs(f.db)).toHaveLength(0);
    expect(getWorkItem(f.db, "item")?.state).toBe("awaiting_input");
    expect(
      f.db.query<{ status: string }, []>("SELECT status FROM linear_github_auth").get()?.status,
    ).toBe("expired");
  });

  test("targets the task owner and renewal never answers authentication", async () => {
    const f = fixture();
    expect(await f.auth.ensure(f.item, "initial", f.signal)).toBe(false);
    const question = findOpenQuestion(f.db, "session")!;
    expect(listOutbox(f.db)[0]?.payload).toMatchObject({
      questionId: question.id,
      auth: { userId: "linear-owner", providerName: "GitHub" },
    });
    await f.auth.retry(question.id, "linear-owner");
    expect(getQuestion(f.db, question.id)?.status).toBe("open");
    expect(listJobs(f.db)).toHaveLength(0);
  });

  test("verified provider completion resumes once", async () => {
    const f = fixture();
    await f.auth.ensure(f.item, "initial", f.signal);
    const question = findOpenQuestion(f.db, "session")!;
    f.host.challenges[0]!.complete({ id: 7, login: "owner" });
    await settled();
    expect(getQuestion(f.db, question.id)).toMatchObject({
      status: "answered",
      answeredBy: "linear-owner",
    });
    expect(getWorkItem(f.db, "item")?.state).toBe("running");
    expect(listJobs(f.db).map((job) => job.queue)).toEqual(["run.resume"]);
    expect(listOutbox(f.db)[0]?.status).toBe("dropped");
    expect(listOutbox(f.db)[1]?.payload).toMatchObject({
      kind: "thought",
      body: "GitHub account connected. Continuing your task.",
    });
    await f.auth.recover();
    expect(listJobs(f.db)).toHaveLength(1);
  });

  test("a different GitHub account cannot save or resume", async () => {
    const f = fixture();
    await f.auth.ensure(f.item, "initial", f.signal);
    f.host.challenges[0]!.complete({ id: 8, login: "other" });
    await settled();
    expect(f.host.account).toBeNull();
    expect(getWorkItem(f.db, "item")?.state).toBe("awaiting_input");
    expect(listJobs(f.db)).toHaveLength(0);
  });

  test("operator relinking before verified completion prevents the old account from resuming", async () => {
    const f = fixture();
    await f.auth.ensure(f.item, "initial", f.signal);
    f.host.challenges[0]!.complete({ id: 7, login: "owner" });
    f.host.linkedId = 8;
    await settled();
    expect(listJobs(f.db)).toHaveLength(0);
    expect(findOpenQuestion(f.db, "session")?.status).toBe("open");
    expect(
      f.db.query<{ status: string }, []>("SELECT status FROM linear_github_auth").get()?.status,
    ).toBe("expired");
  });

  test("an expired challenge cannot renew the account that the operator unlinked", async () => {
    const f = fixture();
    await f.auth.ensure(f.item, "initial", f.signal);
    const question = findOpenQuestion(f.db, "session")!;
    f.clock.advance(10 * 60_000);
    await f.auth.recover();
    f.host.linkedId = 8;
    await f.auth.retry(question.id, "linear-owner");
    expect(f.host.challenges).toHaveLength(1);
    expect(listJobs(f.db)).toHaveLength(0);
    expect(
      f.db.query<{ status: string }, []>("SELECT status FROM linear_github_auth").get()?.status,
    ).toBe("expired");
  });

  test("Stop during an awaited completion account check prevents continuation", async () => {
    const f = fixture();
    await f.auth.ensure(f.item, "initial", f.signal);
    const started = Promise.withResolvers<void>();
    const checked = Promise.withResolvers<number>();
    f.host.linkedAccount = async () => {
      started.resolve();
      return checked.promise;
    };
    f.host.challenges[0]!.complete({ id: 7, login: "owner" });
    await started.promise;
    f.auth.revoke("item");
    checked.resolve(7);
    await settled();
    expect(listJobs(f.db)).toHaveLength(0);
  });

  test("shutdown while renewing prevents database access after close", async () => {
    const f = fixture();
    await f.auth.ensure(f.item, "initial", f.signal);
    const question = findOpenQuestion(f.db, "session")!;
    f.clock.advance(10 * 60_000);
    await f.auth.recover();
    const started = Promise.withResolvers<void>();
    const checked = Promise.withResolvers<number>();
    f.host.linkedAccount = async () => {
      started.resolve();
      return checked.promise;
    };
    const pending = f.auth.retry(question.id, "linear-owner");
    await started.promise;
    f.auth.close();
    f.db.close();
    checked.resolve(7);
    await expect(pending).resolves.toBe(false);
  });

  test("cancelled SQL-open authentication cannot answer or renew a replacement question", async () => {
    const f = fixture();
    await f.auth.ensure(f.item, "initial", f.signal);
    const obsolete = findOpenQuestion(f.db, "session")!;
    f.db.run("UPDATE question SET cancelled_at = ? WHERE id = ?", [f.clock.now(), obsolete.id]);
    const replacement = openQuestion(f.db, {
      itemId: "item",
      sessionId: "session",
      body: "Choose the new request",
      now: f.clock.now() + 1,
    });
    expect(getQuestion(f.db, obsolete.id)?.status).toBe("cancelled");
    expect(f.host.challenges[0]!.acceptAccount(7)).toBe(false);
    f.host.challenges[0]!.complete({ id: 7, login: "owner" });
    await settled();
    await f.auth.retry(obsolete.id, "linear-owner");
    expect(f.host.challenges).toHaveLength(1);
    expect(findOpenQuestion(f.db, "session")?.id).toBe(replacement.id);
    expect(listJobs(f.db)).toHaveLength(0);
    expect(getWorkItem(f.db, "item")?.state).toBe("awaiting_input");
  });

  test("expiry rejects provider completion", async () => {
    const f = fixture();
    await f.auth.ensure(f.item, "initial", f.signal);
    f.clock.advance(10 * 60_000);
    expect(f.host.challenges[0]!.acceptAccount(7)).toBe(false);
    await f.auth.recover();
    expect(
      f.db.query<{ status: string }, []>("SELECT status FROM linear_github_auth").get()?.status,
    ).toBe("expired");
    expect(listOutbox(f.db)[0]?.status).toBe("dropped");
    f.host.challenges[0]!.complete({ id: 7, login: "owner" });
    await settled();
    expect(listJobs(f.db)).toHaveLength(0);
  });

  test("revocation and task-owner replacement reject the old callback", async () => {
    const f = fixture();
    await f.auth.ensure(f.item, "initial", f.signal);
    f.host.actorId = "different-linear-owner";
    expect(f.host.challenges[0]!.acceptAccount(7)).toBe(false);
    f.db.run("UPDATE linear_github_auth SET status = 'revoked' WHERE item_id = 'item'");
    f.auth.revoke("item");
    expect(f.host.challenges[0]!.signal.aborted).toBe(true);
    f.host.challenges[0]!.complete({ id: 7, login: "owner" });
    await settled();
    expect(listJobs(f.db)).toHaveLength(0);
  });

  test("a durable Stop revokes authentication without a live command subscriber", async () => {
    const f = fixture();
    await f.auth.ensure(f.item, "initial", f.signal);
    const question = findOpenQuestion(f.db, "session")!;
    expect(
      submitCommand(f.db, new CommandBus(), {
        type: "stop",
        source: "linear",
        itemId: "item",
        requestedAt: f.clock.now(),
      }).applied,
    ).toBe(true);
    expect(
      f.db.query<{ status: string }, []>("SELECT status FROM linear_github_auth").get()?.status,
    ).toBe("revoked");
    expect(getQuestion(f.db, question.id)?.status).toBe("cancelled");
    expect(f.host.challenges[0]!.acceptAccount(7)).toBe(false);
    f.host.challenges[0]!.complete({ id: 7, login: "owner" });
    await settled();
    expect(listJobs(f.db).filter((job) => job.queue === "run.resume")).toHaveLength(0);
    expect(getWorkItem(f.db, "item")?.state).toBe("cancelled");
  });

  test("only the task owner can renew an expired challenge without resuming", async () => {
    const f = fixture();
    await f.auth.ensure(f.item, "initial", f.signal);
    const question = findOpenQuestion(f.db, "session")!;
    f.clock.advance(10 * 60_000);
    await f.auth.recover();
    await f.auth.retry(question.id, "other-user");
    expect(f.host.challenges).toHaveLength(1);
    await f.auth.retry(question.id, "linear-owner");
    expect(f.host.challenges).toHaveLength(2);
    const prompts = listOutbox(f.db).map((row) => row.payload as { id: string });
    expect(prompts[0]!.id).not.toBe(prompts[1]!.id);
    expect(f.host.challenges[0]!.acceptAccount(7)).toBe(false);
    expect(listJobs(f.db)).toHaveLength(0);
    expect(getWorkItem(f.db, "item")?.state).toBe("awaiting_input");
  });

  test("restart rejects the old challenge and recovers a saved verified account", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "paws-auth-")), "paws.db");
    const f = fixture("initial", path);
    await f.auth.ensure(f.item, "initial", f.signal);
    f.auth.close();
    f.db.close();
    const reopened = openDatabase(path);
    migrate(reopened);
    const recovered = new GitHubAuthQuestions(reopened, f.host, () => f.clock.now());
    cleanup.push(
      () => reopened.close(),
      () => recovered.close(),
    );
    await recovered.recover();
    expect(f.host.challenges).toHaveLength(2);
    expect(f.host.challenges[0]!.acceptAccount(7)).toBe(false);
    f.host.account = { id: 7, login: "owner" };
    recovered.close();
    reopened.close();
    const final = openDatabase(path);
    migrate(final);
    const saved = new GitHubAuthQuestions(final, f.host, () => f.clock.now());
    cleanup.push(
      () => final.close(),
      () => saved.close(),
    );
    await saved.recover();
    expect(listJobs(final)).toHaveLength(1);
  });

  test("publication authentication requires fresh verification before publication", async () => {
    const f = fixture("publication");
    await f.auth.ensure(f.item, "publication", f.signal);
    f.host.challenges[0]!.complete({ id: 7, login: "owner" });
    await settled();
    expect(getWorkItem(f.db, "item")?.state).toBe("verifying");
    expect(listJobs(f.db).map((job) => job.queue)).toEqual(["run.reverify"]);
  });

  test("shutdown cancels a recovery check before the database closes", async () => {
    const f = fixture();
    await f.auth.ensure(f.item, "initial", f.signal);
    f.auth.close();
    let finish!: (account: { id: number; login: string }) => void;
    f.host.check = async (_item, signal) => {
      expect(signal).toBe(controller.signal);
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const controller = new AbortController();
    const recovered = new GitHubAuthQuestions(f.db, f.host, () => f.clock.now());
    const recovery = recovered.recover(controller.signal);
    controller.abort();
    recovered.close();
    f.db.close();
    finish({ id: 7, login: "owner" });
    await expect(recovery).resolves.toBeUndefined();
  });

  test("failed continuation persistence rolls the verified answer back", async () => {
    const f = fixture();
    await f.auth.ensure(f.item, "initial", f.signal);
    const question = findOpenQuestion(f.db, "session")!;
    f.db.run(
      "CREATE TRIGGER reject_auth_resume BEFORE INSERT ON job BEGIN SELECT RAISE(ABORT, 'fake failure'); END",
    );
    f.host.challenges[0]!.complete({ id: 7, login: "owner" });
    await settled();
    expect(getQuestion(f.db, question.id)?.status).toBe("open");
    expect(getWorkItem(f.db, "item")?.state).toBe("awaiting_input");
    f.db.run("DROP TRIGGER reject_auth_resume");
    await f.auth.recover();
    expect(getQuestion(f.db, question.id)?.status).toBe("answered");
    expect(listJobs(f.db)).toHaveLength(1);
  });
});
