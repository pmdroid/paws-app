import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeWorkspaceBootstrap,
  getRunner,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import { createLinearMembershipReads } from "../src/linear";
import { createRunnerControl, createRunnerHttp } from "../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { startServer } from "../src/server";
import {
  createWorkspaceAccess,
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceId,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
} from "../src/workspace";

test("authenticated members pair only as themselves with current permitted membership", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-self-pairing-"));
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const now = Date.now();
  const users = Object.fromEntries(
    ["owner", "admin", "member", "other", "observer", "inactive", "outsider"].map((name) => [
      name,
      putWorkspaceUser(db, {
        id: workspaceId(),
        linearUserId: name,
        name,
        email: `${name}@example.invalid`,
      }),
    ]),
  );
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "self-pairing",
    name: "Self pairing",
    userId: users.owner!,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "self-pairing", now)),
    now,
  });
  for (const name of ["admin", "member", "other", "observer", "inactive"] as const)
    syncWorkspaceMember(db, {
      workspaceId: workspace.id,
      userId: users[name]!,
      role: name === "admin" ? "admin" : name === "observer" ? "observer" : "member",
      active: true,
      teamIds: [],
      now,
    });
  const sessions = Object.fromEntries(
    ["owner", "admin", "member", "other", "observer", "inactive"].map((name) => [
      name,
      issueWorkspaceSession(db, { workspaceId: workspace.id, userId: users[name]!, now }),
    ]),
  );
  syncWorkspaceMember(db, {
    workspaceId: workspace.id,
    userId: users.inactive!,
    role: "member",
    active: false,
    teamIds: [],
    now: now + 1,
  });
  let issuanceBarrier: { entered(): void; wait: Promise<void> } | undefined;
  const authorityRoot = join(root, "issuer");
  const authority = await initializeRunnerAuthority(authorityRoot);
  const key = await createRunnerKey(join(root, "client"));
  const control = createRunnerControl({
    db,
    authority: {
      ...authority,
      async issue(...args) {
        const barrier = issuanceBarrier;
        issuanceBarrier = undefined;
        if (barrier) {
          barrier.entered();
          await barrier.wait;
        }
        return authority.issue(...args);
      },
    },
    certificateRoot: authorityRoot,
    disconnect() {},
  });
  const routes = createRunnerHttp(control);
  const ready = Promise.withResolvers<ReturnType<typeof createWorkspaceAccess>>();
  const server = startServer({
    hostname: "127.0.0.1",
    port: 0,
    db,
    webhooks: false,
    statusEnv: {},
    workspaceAccess: ready.promise,
    runnerControl: routes.browser,
  });
  const origin = `http://127.0.0.1:${server.port}`;
  ready.resolve(
    createWorkspaceAccess({
      db,
      publicUrl: origin,
      clientId: "self-pairing-client",
      installedOrganization: { id: "self-pairing", name: "Self pairing" },
      memberships: createLinearMembershipReads({
        async query() {
          throw new Error("Fresh fixture membership must not call Linear.");
        },
      }),
    }),
  );
  const pending = () => control.beginPairing({ name: "Member VM", csr: key.csr });
  const call = (name: string, action: string, body: unknown, extra: Record<string, string> = {}) =>
    fetch(`${origin}/api/runners/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${WORKSPACE_COOKIE}=${sessions[name]?.token ?? "invalid"}`,
        origin,
        "x-paws-csrf": sessions[name]?.session.csrfToken ?? "invalid",
        ...extra,
      },
      body: JSON.stringify(body),
    });
  try {
    const pairing = await pending();
    const body = { code: pairing.code };
    expect((await call("member", "pairings/inspect", body)).status).toBe(200);
    expect((await call("anonymous", "pairings/approve", body)).status).toBe(401);
    expect((await call("inactive", "pairings/approve", body)).status).toBe(401);
    expect((await call("observer", "pairings/inspect", body)).status).toBe(403);
    expect((await call("observer", "pairings/approve", body)).status).toBe(403);
    const deniedHeaders: Record<string, string>[] = [
      { origin: "https://foreign.invalid" },
      { origin: "" },
      { "x-paws-csrf": "" },
      { "x-paws-csrf": "wrong" },
      { "x-paws-workspace": "another-workspace" },
    ];
    for (const extra of deniedHeaders)
      expect((await call("member", "pairings/approve", body, extra)).status).toBe(403);
    for (const extra of [
      { userId: users.other },
      { ownerUserId: users.owner },
      { workspaceId: "another-workspace" },
      { role: "owner" },
    ])
      expect((await call("member", "pairings/approve", { ...body, ...extra })).status).toBe(403);
    const approval = await call("member", "pairings/approve", body);
    expect(approval.status).toBe(200);
    const { runnerId } = (await approval.json()) as { runnerId: string };
    expect(getRunner(db, runnerId)).toMatchObject({
      workspaceId: workspace.id,
      ownerUserId: users.member,
      status: "active",
      fence: 0,
    });
    expect(control.claimPairing(pairing.id, pairing.claim).status).toBe("approved");
    expect(() => control.claimPairing(pairing.id, pairing.code)).toThrow();
    expect((await call("other", "pairings/approve", body)).status).toBe(403);
    expect((await call("member", "pairings/approve", body)).status).toBe(403);
    expect((await call("member", `${runnerId}/status`, { status: "revoked" })).status).toBe(403);
    expect(
      (await call("member", `${runnerId}/status`, { status: "revoked", role: "owner" })).status,
    ).toBe(403);
    expect((await call("owner", `${runnerId}/status`, { status: "paused" })).status).toBe(200);
    for (const name of ["owner", "admin"] as const) {
      const next = await pending();
      const response = await call(name, "pairings/approve", { code: next.code });
      expect(response.status).toBe(200);
      const approved = (await response.json()) as { runnerId: string };
      expect(getRunner(db, approved.runnerId)?.ownerUserId).toBe(users[name]);
    }
    for (const role of ["observer", "inactive"] as const) {
      const next = await pending();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      issuanceBarrier = { entered: () => entered.resolve(), wait: release.promise };
      const approving = call("other", "pairings/approve", { code: next.code });
      await entered.promise;
      syncWorkspaceMember(db, {
        workspaceId: workspace.id,
        userId: users.other!,
        role: role === "observer" ? "observer" : "member",
        active: role !== "inactive",
        teamIds: [],
        now: Date.now() + 1,
      });
      release.resolve();
      expect((await approving).status).toBe(403);
      expect(control.claimPairing(next.id, next.claim).status).toBe("pending");
      syncWorkspaceMember(db, {
        workspaceId: workspace.id,
        userId: users.other!,
        role: "member",
        active: true,
        teamIds: [],
        now: Date.now() + 2,
      });
    }
    const principal = {
      workspaceId: workspace.id,
      userId: users.observer!,
      role: "owner" as const,
      authenticatedAt: now,
      teamIds: [],
    };
    const next = await pending();
    await expect(control.approvePairing(principal, next.code)).rejects.toThrow("permitted");
    await expect(
      control.approvePairing({ ...principal, userId: users.outsider! }, next.code),
    ).rejects.toThrow("permitted");
    await expect(
      control.approvePairing(
        { ...principal, userId: users.member!, workspaceId: "other" },
        next.code,
      ),
    ).rejects.toThrow("permitted");
    expect(db.query("SELECT count(*) AS count FROM runner").get()).toEqual({ count: 3 });
  } finally {
    await server.stop(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
