import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeWorkspaceBootstrap,
  insertRun,
  migrate,
  openDatabase,
  putWorkspaceUser,
  runnerHasCapacity,
  syncWorkspaceMember,
} from "../src/db";
import { createRunnerControl, createRunnerHttp } from "../src/runner-control";
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

type Listed = {
  slots: { used: number; total: number };
  concurrency: { desired: number | null; applied: number; ceiling: number | null } | null;
};

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-concurrency-"));
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
  const bootstrap = issueWorkspaceBootstrap(db, "fixture-host", now);
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "fixture-host",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(bootstrap),
    now,
  });
  const principal = (id: string, role: WorkspacePrincipal["role"]): WorkspacePrincipal => ({
    workspaceId: workspace.id,
    userId: id,
    role,
    authenticatedAt: now,
    teamIds: [],
  });
  const owner = principal(userId, "owner");
  const others = Object.fromEntries(
    (["member", "observer"] as const).map((role) => {
      const id = putWorkspaceUser(db, {
        id: workspaceId(),
        linearUserId: role,
        name: role,
        email: `${role}@example.invalid`,
      });
      syncWorkspaceMember(db, {
        workspaceId: workspace.id,
        userId: id,
        role,
        active: true,
        teamIds: [],
        now,
      });
      return [role, principal(id, role)];
    }),
  ) as Record<"member" | "observer", WorkspacePrincipal>;
  const issuer = join(root, "issuer");
  const control = createRunnerControl({
    db,
    authority: await initializeRunnerAuthority(issuer),
    certificateRoot: issuer,
    disconnect() {},
    now: () => now,
    serverVersion: "2.3.4",
  });
  const client = await createRunnerKey(join(root, "client"));
  const pending = await control.beginPairing({ name: "Host VM", csr: client.csr });
  const { runnerId } = await control.approvePairing(owner, pending.code);
  const work = createRunnerWorkHttp(
    createRunnerWork({
      db,
      keyId: "fixture",
      privateKey: generateKeyPairSync("ed25519").privateKey,
      now: () => now,
    }),
  );
  const browser = createRunnerHttp(control);
  return {
    db,
    runnerId,
    workspaceId: workspace.id,
    owner,
    ...others,
    now,
    async heartbeat(body: unknown) {
      const response = (await work(
        new Request("https://runner.invalid/v1/heartbeat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        runnerId,
      ))!;
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    },
    async list(as = owner) {
      const response = await browser.browser(new Request("https://paws.invalid/api/runners"), as);
      return ((await response!.json()) as { runners: Listed[] }).runners[0]!;
    },
    async set(concurrency: unknown, as = owner) {
      const response = (await browser.browser(
        new Request(`https://paws.invalid/api/runners/${runnerId}/concurrency`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ concurrency }),
        }),
        as,
      ))!;
      return { status: response.status, body: (await response.json()) as { error?: string } };
    },
  };
}

test("the heartbeat reply carries the chosen concurrency only to runners that report a ceiling", async () => {
  const runner = await fixture();
  expect(await runner.heartbeat({ capacity: 4 })).toEqual({ leases: [], fenced: [] });
  expect((await runner.list()).concurrency).toEqual({ desired: null, applied: 4, ceiling: null });
  const old = await runner.set(2);
  expect(old.status).toBe(400);
  expect(old.body.error).toContain("Update this runner");

  expect(await runner.heartbeat({ capacity: 4, ceiling: 4 })).toEqual({
    leases: [],
    fenced: [],
    concurrency: 4,
  });
  expect(await runner.list()).toMatchObject({
    slots: { used: 0, total: 4 },
    concurrency: { desired: null, applied: 4, ceiling: 4 },
  });
});

test("owners and admins change concurrency within one heartbeat and cannot exceed the ceiling", async () => {
  const runner = await fixture();
  await runner.heartbeat({ capacity: 4, ceiling: 4 });

  const above = await runner.set(5);
  expect(above.status).toBe(400);
  expect(above.body.error).toBe("Concurrency must be from 1 to 4, the limit set on the host.");
  expect((await runner.set(0)).status).toBe(403);

  expect((await runner.set(2)).status).toBe(200);
  expect((await runner.list()).slots.total).toBe(2);
  expect((await runner.heartbeat({ capacity: 4, ceiling: 4 })).concurrency).toBe(2);
  await runner.heartbeat({ capacity: 2, ceiling: 4 });
  expect((await runner.list()).concurrency).toEqual({ desired: 2, applied: 2, ceiling: 4 });

  expect((await runner.set(3)).status).toBe(200);
  expect((await runner.list()).slots.total).toBe(2);
  expect((await runner.heartbeat({ capacity: 2, ceiling: 4 })).concurrency).toBe(3);
  await runner.heartbeat({ capacity: 3, ceiling: 4 });
  expect((await runner.list()).slots.total).toBe(3);

  // A lowered host ceiling caps the stored value without editing it.
  expect((await runner.heartbeat({ capacity: 2, ceiling: 2 })).concurrency).toBe(2);
  expect(
    runner.db
      .query("SELECT action FROM workspace_access_audit WHERE action='runner.concurrency'")
      .all(),
  ).toHaveLength(2);
});

test("members and observers see concurrency but cannot change it", async () => {
  const runner = await fixture();
  await runner.heartbeat({ capacity: 3, ceiling: 3 });
  for (const as of [runner.member, runner.observer]) {
    expect((await runner.set(1, as)).status).toBe(403);
    expect((await runner.list(as)).concurrency).toEqual({
      desired: null,
      applied: 3,
      ceiling: 3,
    });
  }
});

test("lowering concurrency below running work holds back new placement", async () => {
  const runner = await fixture();
  await runner.heartbeat({ capacity: 3, ceiling: 3 });
  for (const index of [0, 1]) {
    runner.db.run(
      "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES(?,?,?,?,?,'running',?,0,?)",
      [
        `item-${index}`,
        `epic-${index}`,
        `issue-${index}`,
        `ENG-${index}`,
        "Task",
        `paws/eng-${index}`,
        runner.now,
      ],
    );
    const run = insertRun(runner.db, {
      itemId: `item-${index}`,
      now: runner.now,
      status: "active",
    });
    runner.db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence) VALUES(?,?,?,1,0,?,?,0)",
      [run.id, runner.runnerId, runner.workspaceId, `cmd-${index}`, runner.now + 60_000],
    );
  }
  expect(runnerHasCapacity(runner.db, runner.runnerId, runner.now)).toBe(true);
  expect((await runner.set(1)).status).toBe(200);
  expect(runnerHasCapacity(runner.db, runner.runnerId, runner.now)).toBe(false);
  expect((await runner.list()).slots).toEqual({ used: 2, total: 1 });
  expect(
    runner.db
      .query("SELECT count(*) AS open FROM runner_work WHERE runner_id=? AND ended_at IS NULL")
      .get(runner.runnerId),
  ).toEqual({ open: 2 });
});
