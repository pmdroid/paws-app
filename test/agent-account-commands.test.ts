import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindAgentAccount,
  commandAccount,
  consumeWorkspaceBootstrap,
  createAgentAccount,
  migrate,
  openDatabase,
  putWorkspaceUser,
  sqliteDb,
} from "../src/db";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { createRunnerWork, createRunnerWorkHttp } from "../src/runner-work";
import {
  issueWorkspaceBootstrap,
  workspaceId,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../src/workspace";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-agent-accounts-"));
  roots.push(root);
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const now = 1_800_000_000_000;
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const bootstrap = await issueWorkspaceBootstrap(db, "fixture-host", now);
  const workspace = await consumeWorkspaceBootstrap(sqliteDb(db), {
    id: workspaceId(),
    organizationId: "fixture-host",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(bootstrap),
    now,
  });
  const principal: WorkspacePrincipal = {
    workspaceId: workspace.id,
    userId,
    role: "admin",
    authenticatedAt: now,
    teamIds: [],
  };
  const issuer = join(root, "issuer");
  const control = createRunnerControl({
    db,
    authority: await initializeRunnerAuthority(issuer),
    certificateRoot: issuer,
    disconnect() {},
    now: () => now,
    serverVersion: "2.3.4",
  });
  const client = await createRunnerKey(join(root, "runner"));
  const pending = { name: "goldbox", csr: client.csr };
  const { runnerId } = await control.enroll({
    ...pending,
    token: (await control.createEnrollment(principal, pending)).token,
  });
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
    now: () => now,
  });
  const http = createRunnerWorkHttp(work, {});
  const heartbeat = async (body: unknown) =>
    (await http(
      new Request("https://runner.invalid/v1/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      runnerId,
    ))!.status;
  let sequence = 0;
  const check = async (account?: { accountId: string; bindingId: string }) => {
    const id = `check-${++sequence}`;
    await work.enqueue({
      id,
      type: "login_check",
      runnerId,
      workspaceId: workspace.id,
      agent: "claude",
      issuedAt: now,
      expiresAt: now + 60_000,
      ...(account ? { account } : {}),
    });
    return id;
  };
  const queued = async () =>
    (await work.commands(runnerId)).map((envelope) => {
      const payload = JSON.parse(Buffer.from(envelope.payload, "base64url").toString()) as {
        id: string;
        account?: unknown;
      };
      return { id: payload.id, account: payload.account };
    });
  return { db, now, runnerId, workspace: workspace.id, heartbeat, check, queued };
}

test("an old runner keeps running the default sign-in and never receives a named account", async () => {
  const { db, now, runnerId, workspace, heartbeat, check, queued } = await fixture();
  expect(await heartbeat({ runnerVersion: "0.1.59" })).toBe(200);
  const legacy = await check();
  expect(await commandAccount(sqliteDb(db), legacy)).toMatchObject({
    bindingId: `legacy_claude_${runnerId}`,
    accountId: `legacy_claude_${workspace}`,
    named: false,
  });

  const account = await createAgentAccount(sqliteDb(db), {
    workspaceId: workspace,
    agent: "claude",
    label: "B",
    now,
  });
  const binding = await bindAgentAccount(sqliteDb(db), {
    workspaceId: workspace,
    accountId: account.id,
    runnerId,
    now,
  });
  const named = { accountId: account.id, bindingId: binding.id };
  await expect(check(named)).rejects.toThrow(/runner 0\.1\.61 or later/);
  expect(
    await heartbeat({
      runnerVersion: "0.1.59",
      accounts: { protocol: 1, bindings: [{ bindingId: binding.id, agent: "claude" }] },
    }),
  ).toBe(200);
  await expect(check(named)).rejects.toThrow(/runner 0\.1\.61 or later/);
  expect(await heartbeat({ runnerVersion: "0.1.61" })).toBe(200);
  await expect(check(named)).rejects.toThrow(/not reported agent account support/);
  expect(
    await heartbeat({ runnerVersion: "0.1.61", accounts: { protocol: 1, bindings: [] } }),
  ).toBe(200);
  await expect(check(named)).rejects.toThrow(/not reported this account binding/);
  expect(await queued()).toEqual([{ id: legacy, account: undefined }]);

  expect(
    await heartbeat({
      runnerVersion: "0.1.61",
      accounts: { protocol: 1, bindings: [{ bindingId: binding.id, agent: "claude" }] },
    }),
  ).toBe(200);
  const accepted = await check(named);
  expect(await commandAccount(sqliteDb(db), accepted)).toMatchObject({
    bindingId: binding.id,
    named: true,
  });
  // Routine checks go to the runner one at a time: the named one follows the legacy one's result.
  expect(await queued()).toEqual([{ id: legacy, account: undefined }]);
  db.run(
    "INSERT INTO runner_health_result(command_id,runner_id,result_json,received_at) VALUES(?,?,'{}',?)",
    [legacy, runnerId, now],
  );
  expect(await queued()).toEqual([{ id: accepted, account: named }]);
  expect(
    await heartbeat({
      runnerVersion: "0.1.61",
      accounts: { protocol: 1, bindings: [{ bindingId: "legacy_claude_x", agent: "claude" }] },
    }),
  ).toBe(403);
  db.close();
});
