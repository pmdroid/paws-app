import { expect, test } from "bun:test";
import { AGENT_ACCOUNTS_RETIRED, createAccountManagement } from "../src/account-management";
import type { WorkspacePrincipal } from "../src/workspace";

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
