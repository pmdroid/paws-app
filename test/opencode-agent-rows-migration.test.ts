import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/db";

const BEFORE = "20261028T1525_review_finding";

test("opencode joins every runner agent row without losing what was recorded", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys=ON");
    migrate(db, { until: BEFORE });
    db.run(
      "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('w','o','W',1)",
    );
    db.run(
      "INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES('u','l','U','u@example.com')",
    );
    db.run(
      "INSERT INTO workspace_member(workspace_id,user_id,role,source,active,checked_at) VALUES('w','u','admin','manual',1,1)",
    );
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES('r','w','u','R','active',1)",
    );
    for (const id of ["c", "p", "l"])
      db.run(
        "INSERT INTO runner_command(id,runner_id,kind,envelope,expires_at) VALUES(?,'r','probe','{}',9)",
        [id],
      );
    db.run(
      "INSERT INTO runner_agent_policy(runner_id,agent,ready,auth_expired,quota_state,resets_at,cooldown_until,resolved_model,last_used_at,virtual_finish) VALUES('r','grok',1,0,'low',5,7,'grok-4',9,0.5)",
    );
    db.run(
      "INSERT INTO runner_execution_usage(command_id,runner_id,owner_user_id,item_id,run_id,agent,model,role,purpose,started_at,ended_at,outcome,resolved_model,output_bytes,resets_at,placement_reason) VALUES('c','r','u',NULL,NULL,'codex','gpt','reviewer','check',1,2,'ok','gpt-5',10,3,'session_restore')",
    );
    db.run(
      "INSERT INTO agent_model_catalog(runner_id,user_id,agent,model,result_json,updated_at) VALUES('r','u','claude','claude-x','{}',4)",
    );
    db.run(
      "INSERT INTO agent_model_probe(command_id,runner_id,user_id,agent,model,requested_at,finished_at) VALUES('p','r','u','grok','grok-4',6,8)",
    );
    db.run(
      "INSERT INTO runner_login(id,runner_id,workspace_id,user_id,agent,state,expires_at,terminal,authorization,input_id,updated_at) VALUES('l','r','w','u','codex','connected',2,'gone',NULL,NULL,3)",
    );

    migrate(db, { until: "20261029T1559_opencode_agent_rows" });

    expect(db.query("SELECT * FROM runner_agent_policy").all()).toEqual([
      {
        runner_id: "r",
        agent: "grok",
        ready: 1,
        auth_expired: 0,
        quota_state: "low",
        resets_at: 5,
        cooldown_until: 7,
        resolved_model: "grok-4",
        last_used_at: 9,
        virtual_finish: 0.5,
      },
    ]);
    expect(
      db
        .query("SELECT command_id,agent,placement_reason,resets_at FROM runner_execution_usage")
        .all(),
    ).toEqual([
      { command_id: "c", agent: "codex", placement_reason: "session_restore", resets_at: 3 },
    ]);
    expect(db.query("SELECT agent,model FROM agent_model_catalog").all()).toEqual([
      { agent: "claude", model: "claude-x" },
    ]);
    expect(db.query("SELECT command_id,agent FROM agent_model_probe").all()).toEqual([
      { command_id: "p", agent: "grok" },
    ]);
    expect(db.query("SELECT id,agent,state FROM runner_login").all()).toEqual([
      { id: "l", agent: "codex", state: "connected" },
    ]);

    for (const id of ["c2", "p2", "l2"])
      db.run(
        "INSERT INTO runner_command(id,runner_id,kind,envelope,expires_at) VALUES(?,'r','probe','{}',9)",
        [id],
      );
    db.run("INSERT INTO runner_agent_policy(runner_id,agent) VALUES('r','opencode')");
    db.run(
      "INSERT INTO runner_execution_usage(command_id,runner_id,owner_user_id,agent,role,purpose,started_at) VALUES('c2','r','u','opencode','implementer','work',1)",
    );
    db.run(
      "INSERT INTO agent_model_catalog(runner_id,user_id,agent,model,result_json,updated_at) VALUES('r','u','opencode','opencode/big','{}',1)",
    );
    db.run(
      "INSERT INTO agent_model_probe(command_id,runner_id,user_id,agent,model,requested_at) VALUES('p2','r','u','opencode','opencode/big',1)",
    );
    db.run(
      "INSERT INTO runner_login(id,runner_id,workspace_id,user_id,agent,state,expires_at,updated_at) VALUES('l2','r','w','u','opencode','starting',2,1)",
    );
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM agent_model_catalog WHERE agent='opencode'",
        )
        .get()?.n,
    ).toBe(1);
  } finally {
    db.close();
  }
});
