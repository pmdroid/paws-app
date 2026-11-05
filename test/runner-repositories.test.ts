import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeWorkspaceBootstrap,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordRunnerRepositories,
  runnerAllowsRepository,
  setRunnerAdminRepositories,
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

type Lists = { admin: string[] | null; host: string[] | null };

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-repositories-"));
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
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "fixture-host",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "fixture-host", now)),
    now,
  });
  const principal = (id: string, role: WorkspacePrincipal["role"]): WorkspacePrincipal => ({
    workspaceId: workspace.id,
    userId: id,
    role,
    authenticatedAt: now,
    teamIds: [],
  });
  const admin = principal(userId, "admin");
  const memberId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "member",
    name: "member",
    email: "member@example.invalid",
  });
  syncWorkspaceMember(db, {
    workspaceId: workspace.id,
    userId: memberId,
    role: "member",
    active: true,
    teamIds: [],
    now,
  });
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
  const pending = { name: "Host VM", csr: client.csr };
  const { runnerId } = await control.enroll({
    ...pending,
    token: control.createEnrollment(admin, pending).token,
  });
  const work = createRunnerWorkHttp(
    createRunnerWork({
      db,
      keyId: "fixture",
      privateKey: generateKeyPairSync("ed25519").privateKey,
      eventKey: Buffer.alloc(32, 7),
      now: () => now,
    }),
  );
  const browser = createRunnerHttp(control);
  return {
    db,
    runnerId,
    workspaceId: workspace.id,
    userId,
    now,
    admin,
    member: principal(memberId, "member"),
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
    },
    async list(): Promise<Lists> {
      const response = await browser.browser(
        new Request("https://paws.invalid/api/runners"),
        admin,
        [],
      );
      return ((await response!.json()) as { runners: { repositories: Lists }[] }).runners[0]!
        .repositories;
    },
    async save(repositories: unknown, as = admin) {
      const response = (await browser.browser(
        new Request(`https://paws.invalid/api/runners/${runnerId}/repositories`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repositories }),
        }),
        as,
        [],
      ))!;
      return response.status;
    },
  };
}

test("a runner with no admin list and no host list allows any repository", async () => {
  const runner = await fixture();
  expect(runnerAllowsRepository(runner.db, runner.runnerId, "acme/anything")).toBe(true);
  recordRunnerRepositories(runner.db, runner.runnerId, null, runner.now);
  expect(runnerAllowsRepository(runner.db, runner.runnerId, "acme/anything")).toBe(true);
  expect(await runner.list()).toEqual({ admin: null, host: null });
});

test("an admin list excludes a repository the host allows, matching case-insensitively", async () => {
  const runner = await fixture();
  recordRunnerRepositories(runner.db, runner.runnerId, ["acme/looky", "acme/paws"], runner.now);
  setRunnerAdminRepositories(runner.db, {
    runnerId: runner.runnerId,
    workspaceId: runner.workspaceId,
    userId: runner.userId,
    repositories: ["ACME/Paws"],
    now: runner.now,
  });
  expect(runnerAllowsRepository(runner.db, runner.runnerId, "acme/paws")).toBe(true);
  expect(runnerAllowsRepository(runner.db, runner.runnerId, "acme/looky")).toBe(false);
  expect(runnerAllowsRepository(runner.db, runner.runnerId, "acme/other")).toBe(false);
});

test("a heartbeat does not change the admin list", async () => {
  const runner = await fixture();
  expect(await runner.save(["acme/paws"])).toBe(200);
  await runner.heartbeat({ capacity: 1, repositories: ["acme/paws", "acme/looky"] });
  await runner.heartbeat({ capacity: 1, repositories: null });
  await runner.heartbeat({ capacity: 1, repositories: ["acme/looky"] });
  expect(await runner.list()).toEqual({ admin: ["acme/paws"], host: ["acme/looky"] });
});

test("only admins save valid owner/repo names, and null restores all repositories", async () => {
  const runner = await fixture();
  expect(await runner.save(["acme/paws"], runner.member)).toBe(403);
  expect(await runner.list()).toEqual({ admin: null, host: null });
  expect(await runner.save(["not a repository"])).toBe(400);
  expect(await runner.save(["acme/paws/extra"])).toBe(400);
  expect(await runner.save(Array.from({ length: 257 }, (_, index) => `acme/repo-${index}`))).toBe(
    400,
  );
  expect(await runner.save(["acme/paws"])).toBe(200);
  expect(runnerAllowsRepository(runner.db, runner.runnerId, "acme/looky")).toBe(false);
  expect(await runner.save(null)).toBe(200);
  expect(await runner.list()).toEqual({ admin: null, host: null });
  expect(runnerAllowsRepository(runner.db, runner.runnerId, "acme/looky")).toBe(true);
  expect(
    runner.db
      .query("SELECT action FROM workspace_access_audit WHERE action='runner.repositories'")
      .all(),
  ).toHaveLength(2);
});
