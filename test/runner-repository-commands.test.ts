import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  bindWorkItemRepository,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import { createFakeGitHub } from "../src/github";
import { verifyRunnerCommand } from "../src/runner-protocol";
import { createRepositoryCommandAccess } from "../src/runner-repository-access";
import {
  createRepositoryCommandsHttp,
  enqueueRepositoryCommand,
  rebaseOnRunner,
  recordRepositoryCommandResult,
  repositoryCommandState,
  waitForRepositoryCommand,
} from "../src/runner-repository-commands";
import { createRunnerWork, createRunnerWorkHttp } from "../src/runner-work";
import { workspaceId } from "../src/workspace";

const bot = { appId: "99", login: "paws-test[bot]", id: 88 };
const repository = {
  owner: "fixture",
  repo: "repository",
  remoteUrl: "https://github.com/fixture/repository.git",
};

function fixture() {
  const db = openDatabase(":memory:");
  migrate(db);
  let now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "repository-commands-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = workspaceId();
  db.run("INSERT INTO workspace VALUES(?,?,?,?)", [workspace, workspace, "Fixture", now]);
  syncWorkspaceMember(db, {
    workspaceId: workspace,
    userId,
    role: "admin",
    active: true,
    teamIds: [],
    now,
  });
  const runners = ["runner-a", "runner-b"];
  for (const runnerId of runners) {
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
      [runnerId, workspace, userId, runnerId, now, now],
    );
    db.run(
      "INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,'0.1.63',?)",
      [runnerId, now],
    );
  }
  const item = insertQueuedItem(db, { id: "item-1", now, branchName: "paws/item-1" });
  bindWorkItemRepository(db, item.id, repository);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey,
    eventKey: Buffer.alloc(32, 7),
    now: () => now,
  });
  const workHttp = createRunnerWorkHttp(work);
  const commandsHttp = createRepositoryCommandsHttp({ db, now: () => now });
  const github = createFakeGitHub();
  const mint = github.mintInstallationToken;
  github.mintInstallationToken = async (input) => ({
    ...(await mint(input)),
    expiresAt: now + 30 * 60_000,
  });
  const access = createRepositoryCommandAccess({
    db,
    github,
    installationForRepository: () => "installation",
    checkpointBot: async () => bot,
    now: () => now,
  });
  const enqueue = (expiresIn = 120_000) =>
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
  return {
    db,
    github,
    ack,
    enqueue,
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
  const f = fixture();
  const id = f.enqueue();
  expect(await f.poll("runner-b")).toEqual([]);
  const delivered = await f.poll("runner-a");
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({ id, type: "rebase", branch: "paws/item-1" });
  expect(await f.poll("runner-a")).toEqual([]);
  expect(repositoryCommandState(f.db, id)).toBe("delivered");
  expect((await f.ack(id, "runner-b"))!.status).toBe(403);
  expect((await f.ack(id, "runner-a"))!.status).toBe(200);
});

test("a grant and a credential go only to the delivered runner while the command is current", async () => {
  const f = fixture();
  const id = f.enqueue();
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
  f.db.run("UPDATE work_item SET branch_name='paws/other' WHERE id='item-1'");
  expect((await f.credential(id, issued.body.token))!.status).toBe(403);
  expect((await f.grant(id)).status).toBe(403);
});

test("a posted result completes waitForRepositoryCommand and replays only unchanged", async () => {
  const f = fixture();
  const id = f.enqueue();
  const waiting = waitForRepositoryCommand(id);
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
  expect(repositoryCommandState(f.db, id)).toBe("done");
});

test("a command past expiresAt is expired and its credential route refuses", async () => {
  const f = fixture();
  const id = f.enqueue(60_000);
  await f.poll("runner-a");
  const issued = await f.grant(id);
  expect(issued.status).toBe(200);
  f.advance(60_000);
  expect((await f.credential(id, issued.body.token))!.status).toBe(403);
  expect(repositoryCommandState(f.db, id)).toBe("expired");
  expect(await waitForRepositoryCommand(id)).toEqual({ outcome: "expired" });
  expect((await f.grant(id)).status).toBe(403);
  const late = await f.post(`/v1/repository-commands/${id}/result`, "runner-a", {
    outcome: "rebased",
    head: "c".repeat(40),
  });
  expect(late!.status).toBe(403);
});

test("an undelivered command past expiresAt is never delivered", async () => {
  const f = fixture();
  const id = f.enqueue(60_000);
  f.advance(60_000);
  expect(await f.poll("runner-a")).toEqual([]);
  expect(repositoryCommandState(f.db, id)).toBe("expired");
});

test("a branch outside paws/ or an old runner is refused at enqueue", () => {
  const f = fixture();
  f.db.run("UPDATE runner_host_status SET runner_version='0.1.62'");
  expect(() => f.enqueue()).toThrow(/runner 0\.1\.63/);
  f.db.run("UPDATE runner_host_status SET runner_version='0.1.63'");
  f.db.run("UPDATE work_item SET branch_name='main' WHERE id='item-1'");
  expect(() => f.enqueue()).toThrow();
});

test("a runner rebase resolves with the runner's result, and as failed on a timeout or refusal", async () => {
  const f = fixture();
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
  const [command] = await f.poll("runner-a");
  recordRepositoryCommandResult(
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
  f.advance(10 * 60_000);
  expect(await f.poll("runner-a")).toEqual([]);
  expect(await slow).toEqual({ outcome: "failed", reason: "timed out after 10 minutes" });

  const stop = new AbortController();
  const stopped = rebase("runner-a", stop.signal);
  stop.abort(new Error("item stopped"));
  await expect(stopped).rejects.toThrow("item stopped");

  expect(await rebase("runner-missing")).toEqual({
    outcome: "failed",
    reason: "Runner is not accepting repository commands.",
  });
});
