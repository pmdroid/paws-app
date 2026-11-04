import type { Database } from "bun:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRetro, migrate, openDatabase, saveRetroSettingsRevision } from "../db";
import { signRunnerRetroCommand, type RunnerRetroCommand } from "../runner-protocol";
import { collectRetroDigest, createRetroDispatcher } from "./index";
import { FIXTURE_END, FIXTURE_REPO, FIXTURE_START } from "./result.fixtures";

export const keys = generateKeyPairSync("ed25519");
export const trustedKeys = new Map([["k1", keys.publicKey]]);
export const sign = (command: RunnerRetroCommand) =>
  signRunnerRetroCommand({ keyId: "k1", privateKey: keys.privateKey, command });

export function seedActivity(db: Database, identifier: string, answers: number) {
  const id = `item-${identifier}`;
  db.run(
    `INSERT INTO linear_session (session_id, issue_id, organization_id, team_id, created_at)
     VALUES (?, ?, 'org', 'team', 0)`,
    [`session-${identifier}`, `issue-${identifier}`],
  );
  db.run(
    `INSERT INTO work_item (id, delegation_id, linear_issue_id, linear_identifier, title, state,
       branch_name, position, created_at, session_key)
     VALUES (?, ?, ?, ?, ?, 'running', ?, 0, ?, ?)`,
    [
      id,
      `delegation-${identifier}`,
      `issue-${identifier}`,
      identifier,
      `Work on ${identifier}`,
      `paws/${identifier}`,
      FIXTURE_START,
      `session-${identifier}`,
    ],
  );
  const [owner, repo] = FIXTURE_REPO.split("/");
  db.run("INSERT INTO work_item_repository VALUES (?, ?, ?, 'git@x')", [id, owner!, repo!]);
  for (let n = 0; n < answers; n += 1)
    db.run(
      `INSERT INTO question (id, item_id, session_id, kind, reason, body, status, answer, answered_by,
         created_at, answered_at) VALUES (?, ?, 's', 'agent', 'push_rejected', 'How do I recover?',
         'answered', 'Fetch and rebase.', 'someone', ?, ?)`,
      [`q-${identifier}-${n}`, id, FIXTURE_START + n, FIXTURE_START + n + 1],
    );
}

export function addRunner(
  db: Database,
  input: { id: string; owner?: string; version?: string; capacity?: number; ready?: boolean },
) {
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,'ws',?,?,'active',0,0)",
    [input.id, input.owner ?? "admin", input.id],
  );
  db.run("INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,?,0)", [
    input.id,
    input.version ?? "0.1.63",
  ]);
  db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'codex',?)", [
    input.id,
    input.ready === false ? 0 : 1,
  ]);
  db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES(?,?)", [
    input.id,
    input.capacity ?? 1,
  ]);
}

export function world(options: { activity?: boolean; retries?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "paws-retro-dispatch-"));
  const path = join(root, "paws.db");
  const db = openDatabase(path);
  migrate(db);
  db.run("INSERT INTO workspace VALUES ('ws', 'org', 'ws', 0)");
  db.run("INSERT INTO workspace_repository VALUES ('ws', ?, 'team')", [FIXTURE_REPO]);
  for (const [id, role] of [
    ["admin", "admin"],
    ["member", "member"],
  ]) {
    db.run("INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES(?,?,?,?)", [
      id!,
      `linear-${id}`,
      id!,
      `${id}@example.test`,
    ]);
    db.run(
      "INSERT INTO workspace_member(workspace_id,user_id,role,source,active,checked_at) VALUES('ws',?,?,'manual',1,0)",
      [id!, role!],
    );
  }
  if (options.activity !== false) {
    seedActivity(db, "PAS-817", 4);
    seedActivity(db, "PAS-843", 5);
  }
  const { revision } = saveRetroSettingsRevision(db, {
    workspaceId: "ws",
    prompt: "Review {{period}} in {{repositories}}.\n\n{{digest}}",
    agentProfile: { agent: "codex", model: "gpt-x", effort: null },
    repositories: [FIXTURE_REPO],
    outputLimits: { maxItems: 5, workedWell: 3 },
    executionLimits: { activeMinutes: 15, retries: options.retries ?? 1 },
    schedule: {},
    createdBy: "admin",
    now: 1,
  });
  createRetro(db, {
    id: "r1",
    workspaceId: "ws",
    windowStart: FIXTURE_START,
    windowEnd: FIXTURE_END,
    origin: "manual",
    settingsRevision: revision,
    agentProfile: { agent: "codex", model: "gpt-x", effort: null },
    now: FIXTURE_END,
  });
  const collected = collectRetroDigest(db, { retroId: "r1", artifactRoot: root, now: FIXTURE_END });
  if (!collected.ok) throw new Error(collected.reason);
  const clock = { now: FIXTURE_END + 10_000 };
  const open = (database: Database) =>
    createRetroDispatcher({ db: database, artifactRoot: root, sign, now: () => clock.now });
  return { db, root, path, clock, open, digestSha256: collected.digestSha256 };
}
