import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  consumeWorkspaceBootstrap,
  listAgentBindings,
  putWorkspaceUser,
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
  const binding = (await listAgentBindings(db, workspace.id)).find(
    (row) => row.runnerId === "runner",
  )!;
  const account = { accountId: binding.accountId, bindingId: binding.id };
  const authority = { allowed: true, asked: [] as unknown[] };
  const helpers = createRunnerHelpers({
    store: db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    ...(withAuthority
      ? {
          probes: (_q, input) =>
            syncSteps(() => {
              authority.asked.push(input);
              return authority.allowed;
            }),
        }
      : {}),
  });
  const base = {
    runnerId: "runner",
    profile: { agent: "codex" as const, model: null },
    account,
  };
  const distill = () =>
    helpers.dispatch({
      ...base,
      sessionId: `probes-${crypto.randomUUID()}`,
      purpose: "probe_distill",
      prompt: "Distill these sources.",
    });
  const write = () =>
    helpers.dispatch({
      ...base,
      sessionId: `probes-${crypto.randomUUID()}`,
      purpose: "probe_write",
      prompt: "Write the probe.",
      probe: { repository: "acme/web", path: ".agents/probes/no-raw-sql.ts" },
      repositories: ["acme/web"],
    });
  return { db, userId, workspace, account, authority, helpers, distill, write };
}

test("probe helpers dispatch without a Linear session under the bound account while their authority allows", async () => {
  const { db, userId, workspace, account, authority, helpers, distill, write } =
    await fixture(true);
  const distilled = (await distill()).command;
  expect(distilled.expiresAt - distilled.issuedAt).toBe(900_000);
  expect(distilled.account).toEqual(account);
  expect(authority.asked[0]).toEqual({ workspaceId: workspace.id, userId, repository: null });
  await helpers.finish(distilled.id);
  const written = (await write()).command;
  expect(authority.asked.at(-1)).toEqual({
    workspaceId: workspace.id,
    userId,
    repository: "acme/web",
  });
  expect(
    await sqlRows(db, "SELECT session_id, purpose FROM runner_helper WHERE id=?", [written.id]),
  ).toEqual([{ session_id: null, purpose: "probe_write" }]);
  const delivered = await helpers.commands("runner");
  expect(
    RunnerCommandSchema.parse(
      JSON.parse(Buffer.from(delivered.at(-1)!.payload, "base64url").toString("utf8")),
    ),
  ).toMatchObject({
    purpose: "probe_write",
    account,
    probe: { repository: "acme/web", path: ".agents/probes/no-raw-sql.ts" },
  });
  authority.allowed = false;
  expect(await helpers.commands("runner")).toEqual([]);
  await expect(distill()).rejects.toBeInstanceOf(HelperFencedError);
});

test("probe helpers are fenced when no authority is configured", async () => {
  const { helpers, distill, write } = await fixture(false);
  await expect(distill()).rejects.toBeInstanceOf(HelperFencedError);
  await expect(write()).rejects.toBeInstanceOf(HelperFencedError);
  expect(await helpers.commands("runner")).toEqual([]);
});
