import { expect, test } from "bun:test";
import { setJournalSink } from "../journal";
import { loadMigrationFiles } from "./migration-files";
import { migration } from "./migrations/20261106T0855_retire_named_agent_accounts";
import {
  admitAgentAccounts,
  createAgentAccount,
  ensureLegacyAgentBinding,
  migrate,
  openDatabase,
  removeAgentAccount,
} from "./index";

const NOW = 1_800_000_000_000;

test("the migration disables each named account, journals it once and leaves the default sign-in", () => {
  const ids = loadMigrationFiles().map((entry) => entry.id);
  const db = openDatabase(":memory:");
  migrate(db, { until: ids[ids.indexOf(migration.id) - 1]! });
  db.run("INSERT INTO workspace VALUES('acme','org-acme','Acme',?)", [NOW]);
  db.run(
    "INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES('ada','linear-ada','Ada','ada@acme.test')",
  );
  db.run(
    "INSERT INTO workspace_member(workspace_id,user_id,role,source,active,checked_at) VALUES('acme','ada','admin','manual',1,?)",
    [NOW],
  );
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES('R1','acme','ada','acme-1','active',?)",
    [NOW],
  );
  ensureLegacyAgentBinding(db, "R1", "claude", NOW);
  const named = createAgentAccount(db, {
    workspaceId: "acme",
    agent: "claude",
    label: "Acme team Claude",
    now: NOW,
  });
  const removed = createAgentAccount(db, {
    workspaceId: "acme",
    agent: "codex",
    label: "Old Codex",
    now: NOW,
  });
  removeAgentAccount(db, { workspaceId: "acme", accountId: removed.id, now: NOW });
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    migrate(db);
    migrate(db);
  } finally {
    restore();
  }
  const enabled = (id: string) =>
    db.query<{ enabled: number }, [string]>("SELECT enabled FROM agent_account WHERE id=?").get(id)
      ?.enabled;
  expect(enabled(named.id)).toBe(0);
  expect(enabled("legacy_claude_acme")).toBe(1);
  expect(lines.filter((line) => line.includes("agent account"))).toEqual([
    `agent account ${named.id} (claude "Acme team Claude", workspace acme) disabled: named accounts were replaced by per-runner sign-in`,
  ]);
  expect(admitAgentAccounts(db, "acme", "claude").eligible).toEqual(["legacy_claude_acme"]);
  db.close();
});
