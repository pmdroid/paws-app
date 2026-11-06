import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  bindAgentAccount,
  bindLinearSessionTask,
  consumeWorkspaceBootstrap,
  createAgentAccount,
  insertQueuedItem,
  legacyAgentAccountId,
  legacyAgentBindingId,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  recordRunnerAccountCapability,
} from "../src/db";
import {
  createRunnerPlacement,
  itemOwnerHasEligibleRunner,
  type PlacementRequest,
} from "../src/runner-placement";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { tempHome } from "./helpers";

const HOUR = 3_600_000;

function acme() {
  const db = openDatabase(join(tempHome(), "paws.sqlite"));
  migrate(db);
  const now = Date.now();
  const ada = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "ada",
    name: "Ada",
    email: "ada@acme.test",
  });
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "acme-org",
    name: "Acme",
    userId: ada,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "acme-org", now)),
    now,
  });
  recordLinearInstallation(db, {
    organizationId: "acme-org",
    oauthClientId: "app-client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: now,
  });
  const item = insertQueuedItem(db, { id: "item", now, sessionKey: "session" });
  bindLinearSessionTask(db, "session", item.delegationId, { actorId: "ada" });
  db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [ada, item.id]);
  for (const id of ["acme-1", "acme-2"]) {
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
      [id, workspace.id, ada, id, now, now],
    );
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'claude',1)", [id]);
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'codex',0)", [id]);
  }
  const placement = createRunnerPlacement({ db, now: () => now });
  const place = async (request: Partial<PlacementRequest> = {}) => {
    const rejected: { runnerId: string; reason: string; until?: number }[] = [];
    const placed = await placement.candidates({
      itemId: item.id,
      profile: { agent: "claude", model: "opus" },
      role: "implementer",
      purpose: "work",
      onRejected: (runnerId, reason, until) =>
        rejected.push({ runnerId, reason, ...(until === undefined ? {} : { until }) }),
      ...request,
    });
    return { placed, rejected };
  };
  return { db, now, workspaceId: workspace.id, item, placement, place };
}

test("two runners signed in to Claude, one with its 5-hour window spent: the implementer goes to the other", async () => {
  const f = acme();
  const reset = f.now + 5 * HOUR;
  f.db.run(
    "UPDATE runner_agent_policy SET quota_state='exhausted',resets_at=?,cooldown_until=? WHERE runner_id='acme-1' AND agent='claude'",
    [reset, reset],
  );
  const { placed, rejected } = await f.place();
  expect(placed).toEqual([
    {
      id: "acme-2",
      workspaceId: f.workspaceId,
      account: {
        accountId: legacyAgentAccountId(f.workspaceId, "claude"),
        bindingId: legacyAgentBindingId("acme-2", "claude"),
        named: false,
      },
    },
  ]);
  expect(rejected).toEqual([{ runnerId: "acme-1", reason: "agent quota cooldown", until: reset }]);
  f.db.run(
    "INSERT INTO runner_command(id,runner_id,kind,envelope,expires_at) VALUES('cmd','acme-2','run','{}',?)",
    [f.now + HOUR],
  );
  f.placement.started({
    commandId: "cmd",
    runnerId: "acme-2",
    itemId: f.item.id,
    profile: { agent: "claude", model: "opus" },
    account: placed[0]!.account!,
    role: "implementer",
    purpose: "work",
    startedAt: f.now,
  });
  expect(
    f.db
      .query(
        "SELECT runner_id AS runnerId,account_policy_revision AS revision,account_fallback AS fallback FROM runner_execution_usage",
      )
      .all(),
  ).toEqual([{ runnerId: "acme-2", revision: null, fallback: null }]);
});

test("no runner signed in to the reviewer's agent: placement offers none and waits for a sign-in", async () => {
  const f = acme();
  const reviewer = {
    role: "reviewer" as const,
    profile: { agent: "codex" as const, model: "gpt-5" },
  };
  const { placed, rejected } = await f.place(reviewer);
  expect(placed).toEqual([]);
  expect(rejected).toEqual([
    { runnerId: "acme-1", reason: "agent-not-signed-in" },
    { runnerId: "acme-2", reason: "agent-not-signed-in" },
  ]);
  expect(f.placement.setupNeed!({ itemId: f.item.id, purpose: "work", ...reviewer })).toMatchObject(
    { reason: "agent-not-signed-in", runnerId: "acme-1", agent: "codex" },
  );
  expect(itemOwnerHasEligibleRunner(f.db, { itemId: f.item.id, agent: "codex", now: f.now })).toBe(
    false,
  );
});

test("a named account bound to a runner no longer stands in for that runner's own sign-in", async () => {
  const f = acme();
  const named = createAgentAccount(f.db, {
    workspaceId: f.workspaceId,
    agent: "claude",
    label: "Acme team Claude",
    now: f.now,
  });
  const binding = bindAgentAccount(f.db, {
    workspaceId: f.workspaceId,
    accountId: named.id,
    runnerId: "acme-1",
    now: f.now,
  });
  f.db.run(
    "INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES('acme-1','0.1.61',?)",
    [f.now],
  );
  recordRunnerAccountCapability(
    f.db,
    "acme-1",
    { protocol: 1, bindings: [{ bindingId: binding.id, agent: "claude" }] },
    f.now,
  );
  f.db.run("UPDATE runner_agent_policy SET ready=0 WHERE runner_id='acme-1' AND agent='claude'");
  const { placed, rejected } = await f.place();
  expect(placed.map((entry) => entry.id)).toEqual(["acme-2"]);
  expect(rejected).toEqual([{ runnerId: "acme-1", reason: "agent-not-signed-in" }]);
  f.db.run("UPDATE runner_agent_policy SET ready=0 WHERE runner_id='acme-2' AND agent='claude'");
  expect(itemOwnerHasEligibleRunner(f.db, { itemId: f.item.id, agent: "claude", now: f.now })).toBe(
    false,
  );
});
