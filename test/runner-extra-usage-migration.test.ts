import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyMigrate } from "../src/db";
import { loadConfigFile } from "../src/config";

const BEFORE = "20261105T1918_pull_request_text";

test("the retired [agents] extra_usage key turns extra usage on for its agents once", () => {
  const home = mkdtempSync(join(tmpdir(), "paws-extra-usage-"));
  const config = join(home, "config.toml");
  writeFileSync(config, '[agents]\nimplementer = "claude"\nextra_usage = ["claude"] # stopgap\n');
  const db = new Database(join(home, "paws.db"));
  try {
    db.run("PRAGMA foreign_keys=ON");
    legacyMigrate(db, { until: BEFORE });
    db.run(
      "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('w','o','W',1)",
    );
    db.run(
      "INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES('u','l','U','u@example.com')",
    );
    db.run(
      "INSERT INTO workspace_member(workspace_id,user_id,role,source,active,checked_at) VALUES('w','u','admin','manual',1,1)",
    );
    for (const runner of ["a", "b"]) {
      db.run(
        "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES(?,'w','u',?,'active',1)",
        [runner, runner],
      );
      for (const agent of ["claude", "codex"])
        db.run(
          "INSERT INTO runner_agent_policy(runner_id,agent,ready,quota_state,cooldown_until) VALUES(?,?,1,'low',0)",
          [runner, agent],
        );
    }

    legacyMigrate(db);
    const rows = () =>
      db
        .query("SELECT runner_id,agent,ready,quota_state,extra_usage FROM runner_agent_policy")
        .all();
    expect(rows()).toEqual([
      { runner_id: "a", agent: "claude", ready: 1, quota_state: "low", extra_usage: 1 },
      { runner_id: "a", agent: "codex", ready: 1, quota_state: "low", extra_usage: 0 },
      { runner_id: "b", agent: "claude", ready: 1, quota_state: "low", extra_usage: 1 },
      { runner_id: "b", agent: "codex", ready: 1, quota_state: "low", extra_usage: 0 },
    ]);

    db.run("UPDATE runner_agent_policy SET extra_usage=0 WHERE runner_id='b'");
    writeFileSync(config, '[agents]\nextra_usage = ["claude", "codex"]\n');
    legacyMigrate(db);
    expect(
      db.query("SELECT extra_usage FROM runner_agent_policy WHERE runner_id='b'").all(),
    ).toEqual([{ extra_usage: 0 }, { extra_usage: 0 }]);
    expect(loadConfigFile(config)).not.toHaveProperty("extraUsageAgents");
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
