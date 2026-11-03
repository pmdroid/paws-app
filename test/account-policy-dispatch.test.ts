import { expect, test } from "bun:test";
import { join } from "node:path";
import type { RunAgentOptions } from "../src/acp";
import { createAgentAccount, insertQueuedItem, setAgentAccountEnabled } from "../src/db";
import {
  AccountPolicyUnavailable,
  createRemoteAgentRunner,
  createRemoteSessionAgentRunner,
} from "../src/runner-backend";
import type { PlacementRequest, RunnerPlacement } from "../src/runner-placement";
import { migratedDatabase, tempHome } from "./helpers";

const NOW = 1_800_000_000_000;

function fixture() {
  const root = tempHome();
  const db = migratedDatabase(join(root, "paws.db"));
  db.run("INSERT INTO workspace VALUES(?,?,?,?)", ["W1", "org-1", "W1", NOW]);
  db.run("INSERT INTO linear_session(session_id,organization_id,created_at) VALUES(?,?,?)", [
    "S1",
    "org-1",
    NOW,
  ]);
  insertQueuedItem(db, { id: "I1", now: NOW, sessionKey: "S1" });
  const placed: string[] = [];
  const orders: (PlacementRequest["accounts"] | undefined)[] = [];
  const placement = {
    async candidates(request: PlacementRequest) {
      placed.push("candidates");
      orders.push(request.accounts);
      return [];
    },
  } as unknown as RunnerPlacement;
  const unused = {} as never;
  const backend = createRemoteAgentRunner({
    db,
    work: unused,
    results: unused,
    health: unused,
    placement,
    now: () => NOW,
    async fetchCandidate() {
      throw new Error("unused");
    },
  });
  const named = createAgentAccount(db, {
    workspaceId: "W1",
    agent: "claude",
    label: "A",
    now: NOW,
  });
  const run = (accounts: string[], extra: Partial<RunAgentOptions> = {}) =>
    backend.forItem("I1")({
      role: "implementer",
      itemId: "I1",
      runId: "R1",
      pawsRoot: root,
      worktreePath: root,
      prompt: "Work",
      profile: { agent: "claude", model: null },
      accounts: {
        revision: "r1",
        profile: { agent: "claude", accounts, source: "defaults" },
      },
      ...extra,
    });
  return { db, root, placed, orders, placement, named, run };
}

test("a configured order with no eligible account waits visibly and never reaches placement", async () => {
  const f = fixture();
  setAgentAccountEnabled(f.db, {
    workspaceId: "W1",
    accountId: f.named.id,
    enabled: false,
    now: NOW,
  });
  await expect(f.run([f.named.id])).rejects.toThrow("No configured Claude account is eligible");
  await expect(f.run(["01ARZ3NDEKTSV4RRFFQ69G5FAV"])).rejects.toBeInstanceOf(
    AccountPolicyUnavailable,
  );
  expect(f.placed).toEqual([]);
  expect(f.db.query("SELECT count(*) AS n FROM runner_command").get()).toEqual({ n: 0 });
});

test("a configured order reaches placement with its eligible accounts in order", async () => {
  const f = fixture();
  await expect(f.run([f.named.id, "legacy_claude_W1"])).rejects.toThrow(
    "Remote task has no current run",
  );
  await expect(f.run(["legacy_claude_W1", f.named.id])).rejects.toThrow(
    "Remote task has no current run",
  );
});

test("session helpers check the same account order before placing a helper", async () => {
  const f = fixture();
  let accounts = [f.named.id, "legacy_claude_W1"];
  const sessions = createRemoteSessionAgentRunner({
    db: f.db,
    helpers: {} as never,
    placement: f.placement,
    accountPolicy: () => ({ agent: "claude", accounts, source: "defaults" }),
  });
  const helper = () =>
    sessions.forSession(
      "S1",
      "classify",
    )({
      role: "implementer",
      itemId: "",
      runId: "helper",
      pawsRoot: f.root,
      worktreePath: f.root,
      prompt: "Classify",
      readOnly: true,
      profile: { agent: "claude", model: null },
    });
  await expect(helper()).rejects.not.toBeInstanceOf(AccountPolicyUnavailable);
  expect(f.orders.at(-1)?.accountIds).toEqual([f.named.id, "legacy_claude_W1"]);
  setAgentAccountEnabled(f.db, {
    workspaceId: "W1",
    accountId: f.named.id,
    enabled: false,
    now: NOW,
  });
  const before = f.placed.length;
  accounts = [f.named.id];
  await expect(helper()).rejects.toBeInstanceOf(AccountPolicyUnavailable);
  expect(f.placed.length).toBe(before);
  accounts = [f.named.id, "legacy_claude_W1"];
  await expect(helper()).rejects.not.toBeInstanceOf(AccountPolicyUnavailable);
  expect(f.orders.at(-1)?.accountIds).toEqual(["legacy_claude_W1"]);
});
