import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Db, Q, WorkspaceRole } from "../src/db";
import {
  handleIssueVmGrantRequest,
  issueVmAdmissionSteps,
  recordIssueVmSteps,
  setIssueVmStateSteps,
} from "../src/issue-vm";
import { describePglite, seed, withoutForeignKeys, type PgliteTestDb } from "./pglite-fixtures";

const DAY = 86_400_000;
const NOW = 1_000 * DAY;
const ORIGIN = "http://127.0.0.1:8787";

const opened: PgliteTestDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

async function connected(connect: () => Promise<PgliteTestDb>): Promise<Db> {
  const handle = await connect();
  opened.push(handle);
  const { db } = handle;
  await withoutForeignKeys(db);
  const people: [string, string, WorkspaceRole][] = [
    ["admin", "Grace", "admin"],
    ["ada", "Ada", "member"],
  ];
  await seed(
    db,
    (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "acme", linearOrganizationId: "org", name: "Acme", createdAt: 0 }),
    ...people.map(
      ([id, name]) =>
        (q: Q) =>
          q.orm
            .insert(q.t.workspaceUser)
            .values({ id, linearUserId: `linear-${id}`, name, email: `${id}@acme.test` }),
    ),
    ...people.map(
      ([id, , role]) =>
        (q: Q) =>
          q.orm.insert(q.t.workspaceMember).values({
            workspaceId: "acme",
            userId: id,
            role,
            source: "linear",
            active: 1,
            checkedAt: 0,
          }),
    ),
  );
  return db;
}

function call(
  db: Db,
  method: string,
  path: string,
  options: { body?: unknown; role?: WorkspaceRole; at?: number } = {},
) {
  return handleIssueVmGrantRequest(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-paws-csrf": "csrf" },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    {
      db,
      csrfToken: "csrf",
      now: () => options.at ?? NOW,
      principal: {
        workspaceId: "acme",
        userId: options.role === "member" ? "ada" : "admin",
        role: options.role ?? "admin",
        authenticatedAt: 0,
        teamIds: [],
      },
    },
  );
}

async function ada(db: Db) {
  const response = await call(db, "GET", "/api/settings/issue-vm/members");
  expect(response?.status).toBe(200);
  const body = (await response!.json()) as {
    defaultLimit: number;
    members: { userId: string; limit: number; grant: { endsAt: number } | null; inUse: unknown }[];
  };
  expect(body.defaultLimit).toBe(2);
  return body.members.find((member) => member.userId === "ada")!;
}

function admit(db: Db, at = NOW) {
  return db.run((q) =>
    issueVmAdmissionSteps(q, { workspaceId: "acme", memberUserId: "ada", provider: "host", at }),
  );
}

async function audits(db: Db) {
  const rows = await db.run((q) =>
    q.all(
      q.orm
        .select({
          action: q.t.workspaceAccessAudit.action,
          subject: q.t.workspaceAccessAudit.subject,
        })
        .from(q.t.workspaceAccessAudit)
        .where(eq(q.t.workspaceAccessAudit.workspaceId, "acme")),
    ),
  );
  return rows.map((row) => `${row.action}: ${row.subject}`);
}

describePglite((connect) => {
  test("a grant raises the member's limit until it is revoked", async () => {
    const db = await connected(connect);
    for (const id of ["one", "two", "three"]) {
      await db.run((q) =>
        recordIssueVmSteps(q, {
          id,
          workspaceId: "acme",
          itemId: `item-${id}`,
          memberUserId: "ada",
          provider: "exe-dev",
          now: NOW,
        }),
      );
    }
    await db.run((q) => setIssueVmStateSteps(q, { id: "two", state: "awake", now: NOW }));
    await db.run((q) => setIssueVmStateSteps(q, { id: "three", state: "asleep", now: NOW }));
    expect(await ada(db)).toEqual({
      userId: "ada",
      name: "Ada",
      role: "member",
      inUse: { creating: 1, awake: 1, asleep: 1, total: 3 },
      limit: 2,
      grant: null,
    } as never);

    const endsAt = NOW + 30 * DAY;
    const granted = await call(db, "POST", "/api/settings/issue-vm/grants", {
      body: { memberUserId: "ada", limit: 4, endsAt: new Date(endsAt).toISOString() },
    });
    expect(granted?.status).toBe(201);
    const { grant } = (await granted!.json()) as { grant: { id: string } };
    const listed = await ada(db);
    expect(listed.limit).toBe(4);
    expect(listed.grant).toMatchObject({ id: grant.id, limit: 4, endsAt, grantedBy: "admin" });
    expect(await admit(db)).toEqual({ ok: true });
    await db.run((q) =>
      recordIssueVmSteps(q, {
        id: "four",
        workspaceId: "acme",
        itemId: "item-four",
        memberUserId: "ada",
        provider: "exe-dev",
        now: NOW,
      }),
    );
    expect(await admit(db)).toEqual({ ok: false, reason: "member_limit", limit: 4, inUse: 4 });

    const revoked = await call(db, "DELETE", `/api/settings/issue-vm/grants/${grant.id}`);
    expect(revoked?.status).toBe(200);
    expect(await ada(db)).toMatchObject({ limit: 2, grant: null });
    expect(await admit(db)).toEqual({ ok: false, reason: "member_limit", limit: 2, inUse: 4 });
    expect((await call(db, "DELETE", `/api/settings/issue-vm/grants/${grant.id}`))?.status).toBe(
      404,
    );

    const until = new Date(endsAt).toISOString();
    expect(await audits(db)).toEqual([
      `settings.issue_vm_grant: Granted Ada (ada): 4 issue VMs until ${until}`,
      `settings.issue_vm_grant_revoked: Revoked issue VM grant for Ada (ada): 4 issue VMs until ${until}`,
    ]);
  });

  test("a member reads only their own row and never another member's", async () => {
    const db = await connected(connect);
    await call(db, "POST", "/api/settings/issue-vm/grants", {
      body: { memberUserId: "ada", limit: 4, endsAt: NOW + DAY },
    });
    const response = await call(db, "GET", "/api/settings/issue-vm/members", { role: "member" });
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as {
      defaultLimit: number;
      members: { userId: string; limit: number; grant: { limit: number } | null }[];
    };
    expect(body.defaultLimit).toBe(2);
    expect(body.members.map((member) => member.userId)).toEqual(["ada"]);
    expect(body.members[0]).toMatchObject({ limit: 4, grant: { limit: 4 } });
    expect(JSON.stringify(body)).not.toContain("Grace");
  });

  test("admins see every failing issue VM delete and a member only their own", async () => {
    const db = await connected(connect);
    for (const [id, memberUserId] of [
      ["01KVMADA00000000000000000A", "ada"],
      ["01KVMGRACE000000000000000A", "admin"],
    ] as const)
      await seed(db, (q) =>
        q.orm.insert(q.t.issueVm).values({
          id,
          workspaceId: "acme",
          itemId: `item-${memberUserId}`,
          memberUserId,
          provider: "host",
          state: "deleting",
          failure: "The VM host refused",
          createdAt: NOW,
          stateAt: NOW,
        }),
      );
    const read = async (role: WorkspaceRole) => {
      const response = await call(db, "GET", "/api/settings/issue-vm/members", { role });
      const body = (await response!.json()) as { failingDeletes: { id: string }[] };
      return body.failingDeletes.map((vm) => vm.id);
    };
    expect(await read("admin")).toEqual([
      "01KVMADA00000000000000000A",
      "01KVMGRACE000000000000000A",
    ]);
    expect(await read("member")).toEqual(["01KVMADA00000000000000000A"]);
  });

  test("members get 403 from the grant routes", async () => {
    const db = await connected(connect);
    const body = { memberUserId: "ada", limit: 4, endsAt: NOW + DAY };
    for (const [method, path] of [
      ["POST", "/api/settings/issue-vm/grants"],
      ["DELETE", "/api/settings/issue-vm/grants/01HZY"],
    ] as const) {
      const response = await call(db, method, path, {
        role: "member",
        ...(method === "POST" ? { body } : {}),
      });
      expect(response?.status).toBe(403);
    }
    expect(await audits(db)).toEqual([]);
  });

  test("refuses an end in the past, beyond 90 days, or a limit outside 1 to 50", async () => {
    const db = await connected(connect);
    const refused = async (body: Record<string, unknown>) => {
      const response = await call(db, "POST", "/api/settings/issue-vm/grants", {
        body: { memberUserId: "ada", limit: 4, endsAt: NOW + DAY, ...body },
      });
      expect(response?.status).toBe(400);
      return ((await response!.json()) as { error: string }).error;
    };
    expect(await refused({ endsAt: NOW - 1 })).toBe("endsAt must be in the future");
    expect(await refused({ endsAt: NOW + 90 * DAY + 1 })).toBe(
      "endsAt must be at most 90 days ahead",
    );
    expect(await refused({ limit: 0 })).toBe("limit must be a whole number from 1 to 50");
    expect(await refused({ limit: 51 })).toBe("limit must be a whole number from 1 to 50");
    const stranger = await call(db, "POST", "/api/settings/issue-vm/grants", {
      body: { memberUserId: "nobody", limit: 4, endsAt: NOW + DAY },
    });
    expect(stranger?.status).toBe(404);
    expect(await ada(db)).toMatchObject({ limit: 2, grant: null });
  });
});
