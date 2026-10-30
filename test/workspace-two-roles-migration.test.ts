import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/db";

test("owner becomes admin, observer becomes an inactive member, member and admin stay", () => {
  const db = new Database(":memory:");
  try {
    migrate(db, { until: "20261028T0052_runner_transcript_chunk_key" });
    db.run(
      "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('w','o','W',1)",
    );
    const people = [
      ["owner", "manual", "owner"],
      ["admin", "linear", null],
      ["member", "linear", null],
      ["observer", "manual", "observer"],
    ] as const;
    for (const [role, source, manual] of people) {
      db.run("INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES(?,?,?,?)", [
        role,
        `l-${role}`,
        role,
        `${role}@example.com`,
      ]);
      db.run(
        "INSERT INTO workspace_member(workspace_id,user_id,role,source,active,checked_at,manual_role) VALUES('w',?,?,?,1,1,?)",
        [role, role, source, manual],
      );
      db.run(
        "INSERT INTO workspace_session(token_hash,user_id,workspace_id,csrf_token,authenticated_at,last_seen_at,expires_at) VALUES(?,?,'w','c',1,1,9)",
        [`t-${role}`, role],
      );
    }
    migrate(db, { until: "20261028T0223_workspace_two_roles" });
    expect(
      db
        .query(
          "SELECT user_id AS id,role,manual_role AS manual,active FROM workspace_member ORDER BY user_id",
        )
        .all(),
    ).toEqual([
      { id: "admin", role: "admin", manual: null, active: 1 },
      { id: "member", role: "member", manual: null, active: 1 },
      { id: "observer", role: "member", manual: "member", active: 0 },
      { id: "owner", role: "admin", manual: "admin", active: 1 },
    ]);
    expect(db.query("SELECT user_id AS id FROM workspace_session ORDER BY user_id").all()).toEqual([
      { id: "admin" },
      { id: "member" },
      { id: "owner" },
    ]);
  } finally {
    db.close();
  }
});
