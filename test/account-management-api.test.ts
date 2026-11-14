import { expect, test } from "bun:test";
import { AGENT_ACCOUNTS_RETIRED, createAccountManagement } from "../src/account-management";
import { centralAgentAccountsSteps, writeAgentCredentialCiphertextSteps } from "../src/db";
import type { WorkspacePrincipal } from "../src/workspace";
import { forEachDialect, seed, withoutForeignKeys } from "./dialects";
import { seedRunner } from "./runner-rows";

const RUNNER = "01JRUNNER0000000000000000A";
const principal: WorkspacePrincipal = {
  workspaceId: "acme",
  userId: "ada",
  role: "admin",
  authenticatedAt: 1_800_000_000_000,
  teamIds: [],
};

const call = (method: string, path: string) =>
  createAccountManagement()(
    new Request(`http://127.0.0.1:8787${path}`, {
      method,
      ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: "{}" }),
    }),
    principal,
  );

test("every named-account and account-order route answers 410 with where sign-in moved", async () => {
  expect(AGENT_ACCOUNTS_RETIRED).toBe(
    "Agent accounts were replaced by per-runner sign-in on the Runners page",
  );
  for (const [method, path] of [
    ["GET", "/api/runners/accounts"],
    ["POST", "/api/runners/accounts"],
    ["GET", "/api/runners/accounts/preview?role=reviewerFallback"],
    ["POST", "/api/runners/accounts/01JACCOUNT000000000000000A"],
    ["POST", "/api/runners/accounts/01JACCOUNT000000000000000A/remove"],
    ["POST", "/api/runners/accounts/01JACCOUNT000000000000000A/bindings"],
    ["POST", "/api/runners/accounts/01JACCOUNT000000000000000A/bindings/B1/remove"],
  ]) {
    const response = await call(method!, path!);
    expect(response?.status).toBe(410);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response!.json()).toEqual({ error: AGENT_ACCOUNTS_RETIRED });
  }
});

test("the Runners page's sign-in and health routes pass through to runner control", async () => {
  for (const [method, path] of [
    ["GET", `/api/runners/${RUNNER}/accounts`],
    ["POST", `/api/runners/${RUNNER}/accounts/claude/login`],
    ["GET", `/api/runners/${RUNNER}/accounts/claude/login/01JLOGIN00000000000000000A`],
    ["GET", `/api/runners/${RUNNER}/health`],
    ["GET", "/api/runners"],
  ])
    expect(await call(method!, path!)).toBeNull();
});

const NOW = 1_800_000_000_000;
type Answer = {
  id: string;
  canManage: boolean;
  accounts: Record<string, unknown>[];
};

forEachDialect((connect) => {
  test("admins add, order, sign out and toggle extra usage on workspace agent accounts", async () => {
    const handle = await connect();
    const { db } = handle;
    try {
      await withoutForeignKeys(db);
      await seed(db, (q) =>
        q.orm
          .insert(q.t.workspace)
          .values({ id: "acme", linearOrganizationId: "org", name: "acme", createdAt: NOW }),
      );
      await seedRunner(db, "R0", { lastSeenAt: NOW - 5_000, ownerUserId: "bea" });
      await seedRunner(db, "R1", { lastSeenAt: NOW - 5_000, ownerUserId: "ada" });
      await seedRunner(db, "R2", { lastSeenAt: NOW - 5_000, ownerUserId: "ada" });
      await seed(db, (q) =>
        q.orm.insert(q.t.runnerHostStatus).values([
          { runnerId: "R0", runnerVersion: "9.0.0", reportedAt: NOW },
          { runnerId: "R1", runnerVersion: "0.1.0", reportedAt: NOW },
          { runnerId: "R2", runnerVersion: "9.0.0", reportedAt: NOW },
        ]),
      );
      const api = createAccountManagement({ store: db, now: () => NOW });
      const send = (method: string, path: string, body?: unknown, who = principal) =>
        api(
          new Request(`http://127.0.0.1:8787/api/runners/agent-accounts${path}`, {
            method,
            ...(body === undefined
              ? {}
              : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
          }),
          who,
        ).then(async (response) => ({
          status: response!.status,
          body: (await response!.json()) as Answer,
        }));
      const work = (await send("POST", "", { agent: "claude", label: "Work" })).body;
      const home = (await send("POST", "", { agent: "claude", label: "Home" })).body;
      expect((await send("POST", "", { agent: "claude", label: "work" })).status).toBe(409);
      expect((await send("PUT", "/order", { agent: "claude", ids: [work.id] })).status).toBe(400);
      expect(
        (await send("PUT", "/order", { agent: "claude", ids: [home.id, work.id] })).status,
      ).toBe(200);
      expect((await send("PUT", `/${work.id}/extra-usage`, { extraUsage: true })).status).toBe(200);
      expect((await send("POST", `/${home.id}/sign-in`)).body).toMatchObject({
        runnerId: "R2",
        agent: "claude",
      });
      await seed(db, (q) =>
        q.orm.insert(q.t.agentAccountCredential).values({
          accountId: home.id,
          agent: "claude",
          ciphertext: "sealed",
          version: 1,
          updatedAt: NOW - 60_000,
          runnerId: "R2",
        }),
      );
      await seed(db, (q) =>
        q.orm.insert(q.t.agentAccountUsage).values({
          accountId: work.id,
          runnerId: "R1",
          limitsJson: JSON.stringify([
            { window: "5h", usedPercent: 100, resetsAt: NOW + 3_600_000 },
          ]),
          observedAt: NOW,
        }),
      );
      await seed(db, (q) =>
        q.orm
          .insert(q.t.agentAccountLease)
          .values({ accountId: home.id, runnerId: "R2", runId: "run-1", expiresAt: NOW + 60_000 }),
      );
      const listed = await send("GET", "");
      expect(listed.body.canManage).toBe(true);
      expect(listed.body.accounts).toEqual([
        {
          id: home.id,
          agent: "claude",
          label: "Home",
          position: 1,
          extraUsage: false,
          signingIn: false,
          credential: { refreshedAt: NOW - 60_000, runner: "R2" },
          usage: null,
          lease: { runner: "R2", runId: "run-1", startedAt: null, issue: null },
        },
        {
          id: work.id,
          agent: "claude",
          label: "Work",
          position: 2,
          extraUsage: true,
          signingIn: false,
          credential: null,
          usage: {
            limits: [{ window: "5h", usedPercent: 100, resetsAt: NOW + 3_600_000 }],
            observedAt: NOW,
          },
          lease: null,
        },
      ]);
      expect((await send("DELETE", `/${home.id}/credential`)).status).toBe(200);
      expect((await send("GET", "")).body.accounts[0]?.credential).toBeNull();
      const candidates = () =>
        db
          .run((q) => centralAgentAccountsSteps(q, "acme", "claude"))
          .then((rows) => rows.map((row) => row.id));
      expect(await candidates()).toEqual([work.id]);
      const upload = (version: number) =>
        db.transaction((q) =>
          writeAgentCredentialCiphertextSteps(q, {
            accountId: home.id,
            runnerId: "R2",
            version,
            ciphertext: "late",
            now: NOW,
          }),
        );
      expect(await upload(2)).toBe("stale_version");
      expect(await upload(3)).toBe("written");
      expect(await candidates()).toEqual([home.id, work.id]);
      expect((await send("GET", "")).body.accounts[0]?.credential).toEqual({
        refreshedAt: NOW,
        runner: "R2",
      });
      const member = { ...principal, role: "member" as const };
      expect((await send("GET", "", undefined, member)).body.canManage).toBe(false);
      for (const [method, path, body] of [
        ["POST", "", { agent: "codex", label: "Mine" }],
        ["PUT", "/order", { agent: "claude", ids: [work.id, home.id] }],
        ["PUT", `/${work.id}/extra-usage`, { extraUsage: false }],
        ["POST", `/${work.id}/sign-in`, undefined],
        ["DELETE", `/${work.id}/credential`, undefined],
      ] as const)
        expect((await send(method, path, body, member)).status).toBe(403);
    } finally {
      await handle.close();
    }
  });
});
