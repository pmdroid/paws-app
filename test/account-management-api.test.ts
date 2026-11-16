import { expect, test } from "bun:test";
import { AGENT_ACCOUNTS_RETIRED, createAccountManagement } from "../src/account-management";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentCredentialSteps } from "../src/credentials";
import {
  agentCredentialCiphertextSteps,
  centralAgentAccountsSteps,
  listAgentBindingsSteps,
  writeAgentCredentialCiphertextSteps,
} from "../src/db";
import type { WorkspacePrincipal } from "../src/workspace";
import { describePglite, seed, withoutForeignKeys } from "./pglite-fixtures";
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
  expect(AGENT_ACCOUNTS_RETIRED).toBe("This route was replaced by /api/runners/agent-accounts.");
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

describePglite((connect) => {
  test("a pasted Claude setup token is checked, stored centrally and bound to the owner's runners", async () => {
    const handle = await connect();
    const { db } = handle;
    const secretsDir = mkdtempSync(join(tmpdir(), "token-paste-"));
    try {
      await withoutForeignKeys(db);
      await seed(db, (q) =>
        q.orm
          .insert(q.t.workspace)
          .values({ id: "acme", linearOrganizationId: "org", name: "acme", createdAt: NOW }),
      );
      await seedRunner(db, "R1", { lastSeenAt: NOW - 5_000, ownerUserId: "ada" });
      await seedRunner(db, "R0", { lastSeenAt: NOW - 5_000, ownerUserId: "bea" });
      const accepted = new Set(["sk-ant-oat01-good"]);
      const api = createAccountManagement({
        store: db,
        secretsDir,
        now: () => NOW,
        checkClaudeToken: async (token) => accepted.has(token),
      });
      const send = (method: string, path: string, body?: unknown) =>
        api(
          new Request(`http://127.0.0.1:8787/api/runners/agent-accounts${path}`, {
            method,
            ...(body === undefined
              ? {}
              : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
          }),
          principal,
        ).then(async (response) => ({
          status: response!.status,
          body: (await response!.json()) as Record<string, unknown>,
        }));
      const claude = (await send("POST", "", { agent: "claude", label: "Pasted" })).body;
      expect(await send("POST", `/${claude.id}/sign-in`)).toEqual({
        status: 400,
        body: {
          error: "Claude signs in with a pasted setup token. Run claude setup-token and paste it.",
        },
      });
      const codex = (await send("POST", "", { agent: "codex", label: "Codex" })).body;
      expect((await send("PUT", `/${claude.id}/token`, { token: "not-a-token" })).status).toBe(400);
      expect(await send("PUT", `/${claude.id}/token`, { token: "sk-ant-oat01-bad" })).toEqual({
        status: 400,
        body: { error: "This token was not accepted by Claude." },
      });
      expect((await send("PUT", `/${codex.id}/token`, { token: "sk-ant-oat01-good" })).status).toBe(
        400,
      );
      expect(await db.run((q) => agentCredentialCiphertextSteps(q, String(claude.id)))).toBeNull();
      expect(await send("PUT", `/${claude.id}/token`, { token: "sk-ant-oat01-good" })).toEqual({
        status: 200,
        body: { ok: true },
      });
      const stored = await db.run((q) =>
        readAgentCredentialSteps(q, secretsDir, String(claude.id)),
      );
      expect(stored?.runnerId).toBeNull();
      const files = JSON.parse(stored!.blob!) as { path: string; data: string }[];
      const token = JSON.parse(Buffer.from(files[0]!.data, "base64").toString());
      expect(files[0]!.path).toBe(".claude/paws-oauth.json");
      expect(token).toEqual({
        kind: "oauth_token",
        token: "sk-ant-oat01-good",
        createdAt: NOW,
        expiresAt: NOW + 365 * 86_400_000,
      });
      const bindings = await db.run((q) => listAgentBindingsSteps(q, "acme", String(claude.id)));
      expect(bindings.map((binding) => binding.runnerId)).toEqual(["R1"]);
    } finally {
      rmSync(secretsDir, { recursive: true, force: true });
      await handle.close();
    }
  });

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
      expect((await send("POST", `/${home.id}/sign-in`)).status).toBe(400);
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
          enabled: true,
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
          enabled: true,
          signingIn: false,
          credential: null,
          usage: {
            limits: [{ window: "5h", usedPercent: 100, resetsAt: NOW + 3_600_000 }],
            observedAt: NOW,
          },
          lease: null,
        },
      ]);
      expect((await send("PUT", `/${work.id}/enabled`, { enabled: false })).status).toBe(200);
      expect((await send("GET", "")).body.accounts[1]?.enabled).toBe(false);
      expect((await send("PUT", `/${work.id}/enabled`, { enabled: true })).status).toBe(200);
      expect((await send("GET", "")).body.accounts[1]?.enabled).toBe(true);
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
      const member = { ...principal, userId: "bea", role: "member" as const };
      expect((await send("GET", "", undefined, member)).body.canManage).toBe(true);
      expect((await send("GET", "", undefined, member)).body.accounts).toEqual([]);
      const mine = await send("POST", "", { agent: "codex", label: "Mine" }, member);
      expect(mine.status).toBe(201);
      expect((await send("GET", "", undefined, member)).body.accounts.map((a) => a.id)).toEqual([
        mine.body.id,
      ]);
      for (const [method, path, body] of [
        ["PUT", "/order", { agent: "claude", ids: [work.id, home.id] }],
        ["PUT", `/${work.id}/extra-usage`, { extraUsage: false }],
        ["POST", `/${work.id}/sign-in`, undefined],
        ["DELETE", `/${work.id}/credential`, undefined],
        ["PUT", `/${work.id}/enabled`, { enabled: false }],
        ["DELETE", `/${work.id}`, undefined],
      ] as const)
        expect((await send(method, path, body, member)).status).toBe(403);
      expect((await send("DELETE", `/${work.id}`)).status).toBe(200);
      expect((await send("GET", "")).body.accounts.map((a) => a.id)).toEqual([home.id]);
      expect(await candidates()).toEqual([home.id]);
    } finally {
      await handle.close();
    }
  });
});
