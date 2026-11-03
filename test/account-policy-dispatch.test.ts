import { expect, test } from "bun:test";
import { join } from "node:path";
import type { RunAgentOptions } from "../src/acp";
import { createAgentAccount, insertQueuedItem } from "../src/db";
import {
  AccountPolicyUnavailable,
  createRemoteAgentRunner,
  createRemoteSessionAgentRunner,
} from "../src/runner-backend";
import type { RunnerPlacement } from "../src/runner-placement";
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
  const placement = {
    async candidates() {
      placed.push("candidates");
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
  return { db, root, placed, placement, named, run };
}

test("a configured order whose first eligible account is named never runs on the default sign-in", async () => {
  const f = fixture();
  await expect(f.run([f.named.id, "legacy_claude_W1"])).rejects.toBeInstanceOf(
    AccountPolicyUnavailable,
  );
  await expect(f.run([f.named.id])).rejects.toThrow(/cannot run a named account/);
  expect(f.placed).toEqual([]);
  expect(f.db.query("SELECT count(*) AS n FROM runner_command").get()).toEqual({ n: 0 });
});

test("a configured order led by the default sign-in passes the gate and reaches placement", async () => {
  const f = fixture();
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
  await expect(helper()).rejects.toBeInstanceOf(AccountPolicyUnavailable);
  expect(f.placed).toEqual([]);
  accounts = ["legacy_claude_W1"];
  await expect(helper()).rejects.not.toBeInstanceOf(AccountPolicyUnavailable);
  expect(f.placed.length).toBeGreaterThan(0);
});
