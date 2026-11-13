import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { generateKeyPairSync } from "node:crypto";
import {
  bindWorkItemRepository,
  insertQueuedItem,
  openPawsStore,
  putWorkspaceUser,
  syncWorkspaceMember,
  type Db,
} from "../src/db";
import { createFakeGitHub } from "../src/github";
import { verifyRunnerCommand } from "../src/runner-protocol";
import { createRepositoryCommandAccess } from "../src/runner-repository-access";
import {
  createRepositoryCommandsHttp,
  enqueueRepositoryCommand,
  rebaseCommitTitle,
  rebaseOnRunner,
  recordRepositoryCommandResult,
  repositoryCommandState,
  waitForRepositoryCommand,
} from "../src/runner-repository-commands";
import { createRunnerWork, createRunnerWorkHttp } from "../src/runner-work";
import { workspaceId } from "../src/workspace";
import { seed } from "./dialects";
import { pgliteServer, tempStore } from "./pglite";

const bot = { appId: "99", login: "paws-test[bot]", id: 88 };
const repository = {
  owner: "fixture",
  repo: "repository",
  remoteUrl: "https://github.com/fixture/repository.git",
};

function setRunnerVersion(db: Db, runnerVersion: string) {
  return seed(db, (q) => q.orm.update(q.t.runnerHostStatus).set({ runnerVersion }));
}

function setBranch(db: Db, branchName: string) {
  return seed(db, (q) =>
    q.orm.update(q.t.workItem).set({ branchName }).where(eq(q.t.workItem.id, "item-1")),
  );
}

const stores: (() => Promise<void>)[] = [];

// Each test's store closes after it, with no poll or expiry still querying it.
afterEach(async () => {
  for (const close of stores.splice(0)) await close();
});

async function fixture(store?: Db) {
  let db = store;
  if (!db) {
    const opened = await tempStore();
    stores.push(opened.close);
    db = opened.db;
  }
  let now = Date.now();
  const userId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "repository-commands-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = workspaceId();
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: workspace, linearOrganizationId: workspace, name: "Fixture", createdAt: now }),
  );
  await syncWorkspaceMember(db, {
    workspaceId: workspace,
    userId,
    role: "admin",
    active: true,
    teamIds: [],
    now,
  });
  const runners = ["runner-a", "runner-b"];
  for (const runnerId of runners)
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.runner).values({
          id: runnerId,
          workspaceId: workspace,
          ownerUserId: userId,
          name: runnerId,
          status: "active",
          createdAt: now,
          lastSeenAt: now,
        }),
      (q) =>
        q.orm
          .insert(q.t.runnerHostStatus)
          .values({ runnerId, runnerVersion: "0.1.63", reportedAt: now }),
    );
  const item = await insertQueuedItem(db, { id: "item-1", now, branchName: "paws/item-1" });
  await bindWorkItemRepository(db, item.id, repository);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const work = createRunnerWork({
    store: db,
    keyId: "fixture",
    privateKey,
    eventKey: Buffer.alloc(32, 7),
    now: () => now,
  });
  const workHttp = createRunnerWorkHttp(work);
  const commandsHttp = createRepositoryCommandsHttp({ store: db, now: () => now });
  const github = createFakeGitHub();
  const mint = github.mintInstallationToken;
  github.mintInstallationToken = async (input) => ({
    ...(await mint(input)),
    expiresAt: now + 30 * 60_000,
  });
  const access = createRepositoryCommandAccess({
    store: db,
    github,
    installationForRepository: async () => "installation",
    checkpointBot: async () => bot,
    now: () => now,
  });
  const enqueue = (expiresIn = 120_000, title?: string) =>
    enqueueRepositoryCommand(db, {
      runnerId: "runner-a",
      workspaceId: workspace,
      itemId: item.id,
      repository,
      branch: item.branchName,
      head: "a".repeat(40),
      main: "b".repeat(40),
      bot,
      expiresAt: now + expiresIn,
      ...(title ? { title } : {}),
      now,
    });
  const post = (path: string, runnerId: string, body: unknown, token?: string) => {
    const request = new Request(`https://paws.invalid${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return path.endsWith("/repository-credential")
      ? access(request, runnerId)
      : commandsHttp(request, runnerId);
  };
  const poll = async (runnerId: string) => {
    const response = await workHttp(new Request("https://paws.invalid/v1/commands"), runnerId);
    const { commands } = (await response!.json()) as { commands: unknown[] };
    return commands.map((envelope) => {
      const verified = verifyRunnerCommand(envelope, {
        trustedKeys: new Map([["fixture", publicKey]]),
        runnerId,
        workspaceId: workspace,
        now,
        claimCommand: () => true,
      });
      if (!verified.ok) throw new Error(verified.reason);
      return verified.command;
    });
  };
  const grant = async (id: string, runnerId = "runner-a") => {
    const response = await post(`/v1/repository-commands/${id}/grant`, runnerId, {});
    return { status: response!.status, body: (await response!.json()) as { token: string } };
  };
  const credential = (id: string, token: string, runnerId = "runner-a") =>
    post(`/v1/repository-commands/${id}/repository-credential`, runnerId, {}, token);
  const ack = (id: string, runnerId: string) =>
    workHttp(
      new Request(`https://paws.invalid/v1/commands/${id}/ack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      runnerId,
    );
  // A rebase enqueues its command without being awaited; on a server the next query can run
  // before that insert commits, so wait for the runner's nth command to exist.
  const enqueued = async (count: number) => {
    for (let attempt = 0; attempt < 500; attempt++) {
      const rows = await db.run(function* (q) {
        return yield* q.all(
          q.orm.select({ id: q.t.runnerRepositoryCommand.id }).from(q.t.runnerRepositoryCommand),
        );
      });
      if (rows.length >= count) return;
      await Bun.sleep(10);
    }
    throw new Error(`repository command ${count} was never enqueued`);
  };
  return {
    db,
    github,
    ack,
    enqueue,
    enqueued,
    post,
    poll,
    grant,
    credential,
    advance: (ms: number) => (now += ms),
    now: () => now,
    workspace,
    item,
  };
}

test("an enqueued repository command is delivered once, signed, to its runner", async () => {
  const f = await fixture();
  const id = await f.enqueue();
  expect(await f.poll("runner-b")).toEqual([]);
  const delivered = await f.poll("runner-a");
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({ id, type: "rebase", branch: "paws/item-1" });
  expect(await f.poll("runner-a")).toEqual([]);
  expect(await repositoryCommandState(f.db, id)).toBe("delivered");
  expect((await f.ack(id, "runner-b"))!.status).toBe(403);
  expect((await f.ack(id, "runner-a"))!.status).toBe(200);
});

test("the pull request title goes only to a runner that accepts it", async () => {
  const f = await fixture();
  await setRunnerVersion(f.db, "0.1.75");
  await f.enqueue(120_000, "Add widgets");
  expect((await f.poll("runner-a"))[0]).not.toHaveProperty("title");
  await setRunnerVersion(f.db, "0.1.76");
  await f.enqueue(120_000, "Add widgets");
  expect((await f.poll("runner-a"))[0]).toMatchObject({ title: "Add widgets" });
});

test("a rebase title is one trimmed well-formed line of at most 256 units, or none", () => {
  expect(rebaseCommitTitle("  Add\r\nwidgets\0now  ")).toBe("Add widgets now");
  expect(rebaseCommitTitle(" \n ")).toBeUndefined();
  expect(rebaseCommitTitle("")).toBeUndefined();
  expect(rebaseCommitTitle("a".repeat(300))).toBe("a".repeat(256));
  expect(rebaseCommitTitle(`${"a".repeat(255)}😀`)).toBe("a".repeat(255));
});

test("a grant and a credential go only to the delivered runner while the command is current", async () => {
  const f = await fixture();
  const id = await f.enqueue();
  expect((await f.grant(id)).status).toBe(403);
  await f.poll("runner-a");
  expect((await f.grant(id, "runner-b")).status).toBe(403);
  const issued = await f.grant(id);
  expect(issued.status).toBe(200);
  expect((await f.credential(id, issued.body.token, "runner-b"))!.status).toBe(403);
  expect((await f.credential(id, "x".repeat(43)))!.status).toBe(403);
  const response = await f.credential(id, issued.body.token);
  expect(response!.status).toBe(200);
  expect(await response!.json()).toMatchObject({
    remoteUrl: repository.remoteUrl,
    branch: "paws/item-1",
  });
  expect(f.github.minted.at(-1)).toMatchObject({
    access: "write",
    repository: "fixture/repository",
    installationId: "installation",
  });
  await setBranch(f.db, "paws/other");
  expect((await f.credential(id, issued.body.token))!.status).toBe(403);
  expect((await f.grant(id)).status).toBe(403);
});

test("a posted result completes waitForRepositoryCommand and replays only unchanged", async () => {
  const f = await fixture();
  const id = await f.enqueue();
  const waiting = waitForRepositoryCommand(f.db, id);
  const early = await f.post(`/v1/repository-commands/${id}/result`, "runner-a", {
    outcome: "rebased",
    head: "c".repeat(40),
  });
  expect(early!.status).toBe(403);
  await f.poll("runner-a");
  const result = { outcome: "conflict", files: ["src/index.ts"] };
  expect((await f.post(`/v1/repository-commands/${id}/result`, "runner-b", result))!.status).toBe(
    403,
  );
  const posted = await f.post(`/v1/repository-commands/${id}/result`, "runner-a", result);
  expect(await posted!.json()).toEqual({ duplicate: false });
  expect(await waiting).toEqual({ outcome: "conflict", files: ["src/index.ts"] });
  const replay = await f.post(`/v1/repository-commands/${id}/result`, "runner-a", result);
  expect(await replay!.json()).toEqual({ duplicate: true });
  const changed = await f.post(`/v1/repository-commands/${id}/result`, "runner-a", {
    outcome: "failed",
    reason: "other",
  });
  expect(changed!.status).toBe(403);
  expect(await repositoryCommandState(f.db, id)).toBe("done");
});

test("waitForRepositoryCommand returns only after its database poll has settled", async () => {
  const f = await fixture();
  const id = await f.enqueue();
  await f.poll("runner-a");
  const run = f.db.run.bind(f.db);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  f.db.run = (async (...args: Parameters<typeof run>) => {
    f.db.run = run;
    await gate;
    return run(...args);
  }) as typeof run;
  const waiting = waitForRepositoryCommand(f.db, id);
  const result = { outcome: "rebased" as const, head: "c".repeat(40) };
  expect(
    await (await f.post(`/v1/repository-commands/${id}/result`, "runner-a", result))!.json(),
  ).toEqual({ duplicate: false });
  const first = await Promise.race([
    waiting.then(() => "returned"),
    Bun.sleep(200).then(() => "held"),
  ]);
  release();
  expect(first).toBe("held");
  expect(await waiting).toEqual(result);
});

test("a command past expiresAt is expired and its credential route refuses", async () => {
  const f = await fixture();
  const id = await f.enqueue(60_000);
  await f.poll("runner-a");
  const issued = await f.grant(id);
  expect(issued.status).toBe(200);
  f.advance(60_000);
  expect((await f.credential(id, issued.body.token))!.status).toBe(403);
  expect(await repositoryCommandState(f.db, id)).toBe("expired");
  expect(await waitForRepositoryCommand(f.db, id)).toEqual({ outcome: "expired" });
  expect((await f.grant(id)).status).toBe(403);
  const late = await f.post(`/v1/repository-commands/${id}/result`, "runner-a", {
    outcome: "rebased",
    head: "c".repeat(40),
  });
  expect(late!.status).toBe(403);
});

test("an undelivered command past expiresAt is never delivered", async () => {
  const f = await fixture();
  const id = await f.enqueue(60_000);
  f.advance(60_000);
  expect(await f.poll("runner-a")).toEqual([]);
  expect(await repositoryCommandState(f.db, id)).toBe("expired");
});

test("a branch outside paws/ or an old runner is refused at enqueue", async () => {
  const f = await fixture();
  await setRunnerVersion(f.db, "0.1.62");
  await expect(f.enqueue()).rejects.toThrow(/runner 0\.1\.63/);
  await setRunnerVersion(f.db, "0.1.63");
  await setBranch(f.db, "main");
  await expect(f.enqueue()).rejects.toThrow();
});

test("a runner rebase resolves with the runner's result, and as failed on a timeout or refusal", async () => {
  const f = await fixture();
  const rebase = (runnerId = "runner-a", signal?: AbortSignal) =>
    rebaseOnRunner(
      f.db,
      {
        runnerId,
        workspaceId: f.workspace,
        itemId: f.item.id,
        repository,
        branch: f.item.branchName,
        head: "a".repeat(40),
        main: "b".repeat(40),
        bot,
        now: f.now(),
      },
      signal,
    );
  const rebased = rebase();
  await f.enqueued(1);
  const [command] = await f.poll("runner-a");
  await recordRepositoryCommandResult(
    f.db,
    {
      runnerId: "runner-a",
      commandId: command!.id,
      result: { outcome: "rebased", head: "c".repeat(40) },
    },
    f.now(),
  );
  expect(await rebased).toEqual({ outcome: "rebased", head: "c".repeat(40) });

  const slow = rebase();
  await f.enqueued(2);
  f.advance(10 * 60_000);
  expect(await f.poll("runner-a")).toEqual([]);
  expect(await slow).toEqual({ outcome: "failed", reason: "timed out after 10 minutes" });

  const stop = new AbortController();
  const stopped = rebase("runner-a", stop.signal);
  stop.abort(new Error("item stopped"));
  await expect(stopped).rejects.toThrow("item stopped");
  expect(await f.poll("runner-a")).toEqual([]);

  const granted = new AbortController();
  const late = rebase("runner-a", granted.signal);
  await f.enqueued(4);
  const [delivered] = await f.poll("runner-a");
  const issued = await f.grant(delivered!.id);
  expect(issued.status).toBe(200);
  granted.abort(new Error("item stopped"));
  await expect(late).rejects.toThrow("item stopped");
  expect(await repositoryCommandState(f.db, delivered!.id, f.now())).toBe("expired");
  expect((await f.credential(delivered!.id, issued.body.token))!.status).toBe(403);
  expect((await f.grant(delivered!.id)).status).toBe(403);

  expect(await rebase("runner-missing")).toEqual({
    outcome: "failed",
    reason: "Runner is not accepting repository commands.",
  });
});

test("a rebase whose result arrives on another instance resolves within a second", async () => {
  const server = await pgliteServer();
  const other = await openPawsStore({ url: server.url, pgliteDir: "" });
  const stop = new AbortController();
  let rebased: Promise<unknown> = Promise.resolve();
  try {
    const f = await fixture(server.store);
    const otherHttp = createRepositoryCommandsHttp({ store: other.store, now: f.now });
    const rebasing = rebaseOnRunner(
      f.db,
      {
        runnerId: "runner-a",
        workspaceId: f.workspace,
        itemId: f.item.id,
        repository,
        branch: f.item.branchName,
        head: "a".repeat(40),
        main: "b".repeat(40),
        bot,
        now: f.now(),
      },
      stop.signal,
    );
    rebased = rebasing;
    await f.enqueued(1);
    const [command] = await f.poll("runner-a");
    const posted = await otherHttp(
      new Request(`https://paws.invalid/v1/repository-commands/${command!.id}/result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome: "rebased", head: "c".repeat(40) }),
      }),
      "runner-a",
    );
    expect(await posted!.json()).toEqual({ duplicate: false });
    const started = performance.now();
    expect(await rebasing).toEqual({ outcome: "rebased", head: "c".repeat(40) });
    expect(performance.now() - started).toBeLessThan(1_000);
  } finally {
    // A rebase left waiting by a failed assertion stops before its store closes.
    stop.abort(new Error("test ended"));
    await rebased.catch(() => undefined);
    await other.close();
    await server.close();
  }
});
