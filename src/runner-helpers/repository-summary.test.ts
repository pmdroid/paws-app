import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  consumeWorkspaceBootstrap,
  listAgentBindings,
  putWorkspaceUser,
  recordLinearInstallation,
  recordRunnerCapacity,
  syncSteps,
} from "../db";
import { RunnerCommandSchema } from "../runner-protocol";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../workspace";
import { createRunnerHelpers, HelperFencedError } from ".";
import { sqlRows, sqlRun, tempStore } from "../../test/pglite";
import { signInFixtureRunner } from "../../test/pglite-fixtures";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(withAuthority: boolean) {
  const { db, close } = await tempStore();
  cleanup.push(close);
  const now = Date.now();
  const userId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Acme",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  await sqlRun(
    db,
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,'runner','active',?,?)",
    ["runner", workspace.id, userId, now, now],
  );
  await recordRunnerCapacity(db, "runner", 1, 1, 2);
  await signInFixtureRunner(db, "runner", "codex");
  const authority = { allowed: true, asked: [] as unknown[] };
  const allow = (_q: unknown, input: unknown) =>
    syncSteps(() => {
      authority.asked.push(input);
      return authority.allowed;
    });
  const helpers = createRunnerHelpers({
    store: db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    ...(withAuthority ? { summary: allow, probes: allow } : {}),
  });
  const binding = (await listAgentBindings(db, workspace.id)).find(
    (row) => row.runnerId === "runner",
  )!;
  const account = { accountId: binding.accountId, bindingId: binding.id };
  const distill = () =>
    helpers.dispatch({
      runnerId: "runner",
      sessionId: `probes-${crypto.randomUUID()}`,
      purpose: "probe_distill",
      profile: { agent: "codex", model: null },
      prompt: "Distill these sources.",
      account,
    });
  const dispatch = () =>
    helpers.dispatch({
      runnerId: "runner",
      sessionId: `summary-${crypto.randomUUID()}`,
      purpose: "repository_summary",
      profile: { agent: "codex", model: null },
      prompt: "Summarise this README.",
      summary: { repository: "acme/web" },
    });
  return { db, now, userId, workspace, authority, helpers, dispatch, account, distill };
}

test("a repository summary is delivered only while its authority allows the runner's owner", async () => {
  const { db, userId, workspace, authority, helpers, dispatch } = await fixture(true);
  const { command } = await dispatch();
  expect(command.expiresAt - command.issuedAt).toBe(120_000);
  expect(authority.asked[0]).toEqual({
    workspaceId: workspace.id,
    userId,
    repository: "acme/web",
  });
  expect(
    await sqlRows(db, "SELECT session_id, purpose FROM runner_helper WHERE id=?", [command.id]),
  ).toEqual([{ session_id: null, purpose: "repository_summary" }]);
  const delivered = await helpers.commands("runner");
  expect(delivered).toHaveLength(1);
  expect(
    RunnerCommandSchema.parse(
      JSON.parse(Buffer.from(delivered[0]!.payload, "base64url").toString("utf8")),
    ),
  ).toMatchObject({ purpose: "repository_summary", summary: { repository: "acme/web" } });
  authority.allowed = false;
  expect(await helpers.commands("runner")).toEqual([]);
  await expect(dispatch()).rejects.toBeInstanceOf(HelperFencedError);
});

test("a repository summary and probe_distill are fenced when no authority is configured", async () => {
  const { helpers, dispatch, distill } = await fixture(false);
  await expect(dispatch()).rejects.toBeInstanceOf(HelperFencedError);
  await expect(distill()).rejects.toBeInstanceOf(HelperFencedError);
  expect(await helpers.commands("runner")).toEqual([]);
});

test("probe_distill dispatches without a Linear session under the bound account while its authority allows", async () => {
  const { db, userId, workspace, authority, helpers, account, distill } = await fixture(true);
  const { command } = await distill();
  expect(command.expiresAt - command.issuedAt).toBe(900_000);
  expect(command.account).toEqual(account);
  expect(authority.asked[0]).toEqual({ workspaceId: workspace.id, userId });
  expect(
    await sqlRows(db, "SELECT session_id, purpose FROM runner_helper WHERE id=?", [command.id]),
  ).toEqual([{ session_id: null, purpose: "probe_distill" }]);
  authority.allowed = false;
  expect(await helpers.commands("runner")).toEqual([]);
  await expect(distill()).rejects.toBeInstanceOf(HelperFencedError);
});

test("only Slack replies, repository summaries and probe_distill are stored without a Linear session", async () => {
  const { db, now, workspace } = await fixture(true);
  await recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "app",
    appUserId: "app-user",
    sessionId: "session-1",
    teamId: "team",
    observedAtMs: now,
  });
  let n = 0;
  const insert = (purpose: string, sessionId: string | null) =>
    sqlRun(
      db,
      "INSERT INTO runner_helper(id,runner_id,workspace_id,session_id,session_generation,runner_fence,envelope,expires_at,purpose) VALUES(?,'runner',?,?,0,0,'{}',?,?)",
      [`helper-${n++}`, workspace.id, sessionId, now + 60_000, purpose],
    );
  await insert("repository_summary", null);
  await insert("slack_reply", null);
  await insert("probe_distill", null);
  await insert("classify", "session-1");
  for (const [purpose, sessionId] of [
    ["repository_summary", "session-1"],
    ["slack_reply", "session-1"],
    ["probe_distill", "session-1"],
    ["classify", null],
  ] as const)
    await expect(insert(purpose, sessionId)).rejects.toThrow();
});
