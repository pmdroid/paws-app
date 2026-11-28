import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  consumeWorkspaceBootstrap,
  putWorkspaceUser,
  syncWorkspaceMember,
  type Db,
} from "../src/db";
import { createRunnerControl, createRunnerHttp } from "../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import {
  issueWorkspaceBootstrap,
  workspaceId,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../src/workspace";
import { seed } from "./pglite-fixtures";
import { tempStore } from "./pglite";

const NOW = Date.UTC(2026, 10, 28);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-vm-host-enrollment-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const { db, close } = await tempStore();
  cleanups.push(close);
  const authority = await initializeRunnerAuthority(join(root, "issuer"));
  const adminId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "admin",
    name: "Admin",
    email: "admin@example.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "org",
    userId: adminId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", NOW)),
    now: NOW,
  });
  const memberId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "ada",
    name: "Ada",
    email: "ada@example.invalid",
  });
  await syncWorkspaceMember(db, {
    workspaceId: workspace.id,
    userId: memberId,
    role: "member",
    active: true,
    teamIds: [],
    now: NOW,
  });
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.agentAccount).values({
        id: "account",
        workspaceId: workspace.id,
        ownerUserId: adminId,
        agent: "claude",
        label: "Claude",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    (q) =>
      q.orm.insert(q.t.agentAccountCredential).values({
        accountId: "account",
        agent: "claude",
        ciphertext: "sealed",
        version: 1,
        updatedAt: NOW,
        runnerId: null,
      }),
  );
  const principal = (userId: string): WorkspacePrincipal => ({
    workspaceId: workspace.id,
    userId,
    role: userId === adminId ? "admin" : "member",
    authenticatedAt: NOW,
    teamIds: [],
  });
  const control = createRunnerControl({
    store: db,
    authority,
    certificateRoot: join(root, "issuer"),
    disconnect: () => {},
    now: () => NOW,
  });
  const http = createRunnerHttp(control, { hostConfig: async () => null });
  const mint = (userId: string, body: unknown) =>
    http.browser(
      new Request("https://localhost/api/runners/enrollments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      principal(userId),
      [],
    );
  const enroll = async (token: string, name: string) => {
    const key = await createRunnerKey(join(root, name));
    const { runnerId } = await control.enroll({ token, name, csr: key.csr });
    await control.setStatus(principal(adminId), runnerId, "active");
    return runnerId;
  };
  return { db, adminId, memberId, mint, enroll };
}

const rows = (db: Db) =>
  db.run(function* (q) {
    return {
      enrollments: yield* q.all(q.orm.select().from(q.t.runnerEnrollment)),
      audits: yield* q.all(
        q.orm
          .select()
          .from(q.t.workspaceAccessAudit)
          .where(eq(q.t.workspaceAccessAudit.action, "runner.enrollment_denied")),
      ),
    };
  });

const runnerRows = (db: Db, runnerId: string) =>
  db.run(function* (q) {
    return {
      vmHost: yield* q.one(
        q.orm.select().from(q.t.vmHost).where(eq(q.t.vmHost.runnerId, runnerId)),
      ),
      bindings: yield* q.all(
        q.orm
          .select()
          .from(q.t.agentAccountBinding)
          .where(eq(q.t.agentAccountBinding.runnerId, runnerId)),
      ),
    };
  });

test("an admin's vm_host token enrolls a VM host with its size and no agent bindings", async () => {
  const { db, adminId, mint, enroll } = await fixture();
  const response = await mint(adminId, {
    name: "rack-1",
    kind: "vm_host",
    vmHost: { vmVcpus: 4, vmMemoryGb: 8, slotCap: 3 },
  });
  expect(response?.status).toBe(200);
  const { token } = (await response!.json()) as { token: string };
  const runnerId = await enroll(token, "rack-1");
  const { vmHost, bindings } = await runnerRows(db, runnerId);
  expect(vmHost).toMatchObject({
    vmVcpus: 4,
    vmMemoryGb: 8,
    vmDiskGb: 30,
    reserveVcpus: 4,
    reserveMemoryGb: 8,
    slotCap: 3,
    updatedBy: adminId,
  });
  expect(bindings).toEqual([]);
});

test("a token minted without a kind enrolls a personal runner with its bindings", async () => {
  const { db, adminId, mint, enroll } = await fixture();
  const response = await mint(adminId, { name: "laptop" });
  expect(response?.status).toBe(200);
  const { token } = (await response!.json()) as { token: string };
  const runnerId = await enroll(token, "laptop");
  const { vmHost, bindings } = await runnerRows(db, runnerId);
  expect(vmHost).toBeUndefined();
  expect(bindings.map((binding) => binding.accountId)).toEqual(["account"]);
  expect((await rows(db)).enrollments[0]).toMatchObject({ kind: "personal", vmHostSettings: null });
});

test("a member asking for a vm_host token gets 403 and an audit row, and nothing is stored", async () => {
  const { db, memberId, mint } = await fixture();
  const response = await mint(memberId, { name: "rack-1", kind: "vm_host" });
  expect(response?.status).toBe(403);
  expect(await response!.json()).toEqual({
    error: "Only workspace admins can add a workspace VM host",
  });
  const { enrollments, audits } = await rows(db);
  expect(enrollments).toEqual([]);
  expect(audits).toMatchObject([{ userId: memberId, subject: "vm_host" }]);
});

test("an invalid vmHost size is refused with the parser's message", async () => {
  const { db, adminId, mint } = await fixture();
  const response = await mint(adminId, {
    name: "rack-1",
    kind: "vm_host",
    vmHost: { vmVcpus: 99 },
  });
  expect(response?.status).toBe(400);
  expect(await response!.json()).toEqual({ error: "vmVcpus must be a whole number from 1 to 32." });
  expect((await rows(db)).enrollments).toEqual([]);
});
