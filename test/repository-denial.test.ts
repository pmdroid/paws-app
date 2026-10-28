import { expect, test } from "bun:test";
import {
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listOutbox,
  refreshRepositoryCatalog,
  type WorkItemRecord,
} from "../src/db";
import {
  FakeGitHubIntegration,
  GitHubInstallationCheck,
  issueTeamName,
  teamMemberDenial,
  teamRepositoryDenial,
} from "../src/loop";
import { tempDb } from "./helpers";

const MAPPED = { workspaceId: "ws", teamId: "mapped" };
const UNMAPPED = { workspaceId: "ws", teamId: "unmapped" };
const NO_REPOSITORY =
  "Pascal has no repository in Paws yet. Ask Ada Admin or Grace Admin to map one in Integrations, then delegate again.";

async function seed() {
  const db = tempDb();
  db.run(
    "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('ws','org','Workspace',0)",
  );
  for (const [id, name, role, active] of [
    ["ada", "Ada Admin", "admin", 1],
    ["admin", "Grace Admin", "admin", 1],
    ["former", "Old Admin", "admin", 0],
    ["member", "Lin Member", "member", 1],
  ] as const) {
    db.run("INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES(?,?,?,?)", [
      id,
      `linear-${id}`,
      name,
      `${id}@example.com`,
    ]);
    db.run(
      "INSERT INTO workspace_member(workspace_id,user_id,role,source,active,checked_at) VALUES('ws',?,?,'linear',?,0)",
      [id, role, active],
    );
  }
  db.run(
    "INSERT INTO workspace_repository(workspace_id,repository,team_id) VALUES('ws','acme/linked','mapped')",
  );
  await refreshRepositoryCatalog(db, async () =>
    ["linked", "catalog"].map((repo) => ({
      owner: "acme",
      repo,
      remoteUrl: `https://github.com/acme/${repo}.git`,
      defaultBranch: "main",
    })),
  );
  const item = (id = "PAS-677", team: string | null = "Pascal"): WorkItemRecord => {
    insertQueuedItem(db, { id, sessionKey: `session-${id}`, title: id });
    beginImplementRun(db, id, 1000);
    if (team !== null)
      db.run(
        `INSERT INTO inbox_event(dedupe_key,source,action,session_id,issue_id,updated_at_ms,payload,received_at)
         VALUES(?,'webhook','created',?,?,0,?,0)`,
        [
          `created:${id}`,
          `session-${id}`,
          `lin-item-${id}`,
          JSON.stringify({
            type: "AgentSessionEvent",
            action: "created",
            agentSession: {
              issue: { id: `lin-item-${id}`, team: { id: "t", key: "PAS", name: team } },
            },
          }),
        ],
      );
    return getWorkItem(db, id)!;
  };
  return { db, item };
}

function stopResponses(db: ReturnType<typeof tempDb>): string[] {
  return listOutbox(db)
    .filter((entry) => entry.delivery === "stop" && entry.op === "activity")
    .map((entry) => (entry.payload as { body: string }).body);
}

test("a mapped team may use only its linked repositories, and is told which one is not", async () => {
  const { db, item } = await seed();
  try {
    const current = item();
    expect(teamRepositoryDenial(db, current, MAPPED, { owner: "acme", repo: "linked" })).toBeNull();
    expect(teamRepositoryDenial(db, current, MAPPED, { owner: "ACME", repo: "Linked" })).toBeNull();
    expect(teamRepositoryDenial(db, current, MAPPED, { owner: "acme", repo: "catalog" })).toEqual({
      denied: true,
      reason: "acme/catalog isn't mapped to Pascal in Paws.",
    });
  } finally {
    db.close();
  }
});

test("an unmapped team may use any catalog repository, as placement does", async () => {
  const { db, item } = await seed();
  try {
    const current = item();
    for (const repo of ["catalog", "linked"])
      expect(teamRepositoryDenial(db, current, UNMAPPED, { owner: "acme", repo })).toBeNull();
    expect(
      teamRepositoryDenial(db, current, UNMAPPED, { owner: "acme", repo: "elsewhere" }),
    ).toEqual({ denied: true, reason: NO_REPOSITORY });
  } finally {
    db.close();
  }
});

test("a workspace without active admins names the role instead of a person", async () => {
  const { db, item } = await seed();
  try {
    db.run("UPDATE workspace_member SET active=0 WHERE role='admin'");
    expect(
      teamRepositoryDenial(db, item(), UNMAPPED, { owner: "acme", repo: "elsewhere" })?.reason,
    ).toBe(
      "Pascal has no repository in Paws yet. Ask a Paws owner or admin to map one in Integrations, then delegate again.",
    );
  } finally {
    db.close();
  }
});

test("the team name comes from the stored webhook, else the issue key, never from Linear", async () => {
  const { db, item } = await seed();
  try {
    expect(issueTeamName(db, item("PAS-1", "Pascal"))).toBe("Pascal");
    expect(issueTeamName(db, item("ENG-2", null))).toBe("ENG");
    expect(teamMemberDenial(db, item("PAS-3"))).toEqual({
      denied: true,
      reason: "You're not a member of Pascal in Paws.",
    });
  } finally {
    db.close();
  }
});

for (const [name, decide, response] of [
  [
    "an unmapped team's repository outside the catalog",
    (db: ReturnType<typeof tempDb>, item: WorkItemRecord) =>
      teamRepositoryDenial(db, item, UNMAPPED, { owner: "acme", repo: "elsewhere" })!,
    NO_REPOSITORY,
  ],
  [
    "a repository outside the team's links",
    (db: ReturnType<typeof tempDb>, item: WorkItemRecord) =>
      teamRepositoryDenial(db, item, MAPPED, { owner: "acme", repo: "catalog" })!,
    "acme/catalog isn't mapped to Pascal in Paws.",
  ],
  [
    "a delegator outside the team",
    (db: ReturnType<typeof tempDb>, item: WorkItemRecord) => teamMemberDenial(db, item),
    "You're not a member of Pascal in Paws.",
  ],
] as const) {
  test(`${name} cancels the item once and ends the session with its reason`, async () => {
    const { db, item } = await seed();
    const current = item();
    const integration = new FakeGitHubIntegration();
    integration.permitted = decide(db, current);
    const check = new GitHubInstallationCheck(db, integration, () => 1000);
    try {
      expect(await check.ensure(current, "initial", new AbortController().signal)).toBe(false);
      expect(getWorkItem(db, current.id)?.state).toBe("cancelled");
      expect(stopResponses(db)).toEqual([response]);
      expect(integration.checks.map((entry) => entry.kind)).toEqual(["installation", "member"]);
      expect(db.query("SELECT * FROM github_integration_hold").all()).toHaveLength(0);
      expect(db.query("SELECT * FROM question").all()).toHaveLength(0);
      expect(
        await check.ensure(getWorkItem(db, current.id)!, "initial", new AbortController().signal),
      ).toBe(false);
      expect(stopResponses(db)).toEqual([response]);
    } finally {
      check.close();
      db.close();
    }
  });
}

test("a denial without a reason still ends with the default response", async () => {
  const { db, item } = await seed();
  const current = item();
  const integration = new FakeGitHubIntegration();
  integration.permitted = false;
  const check = new GitHubInstallationCheck(db, integration, () => 1000);
  try {
    expect(await check.ensure(current, "initial", new AbortController().signal)).toBe(false);
    expect(getWorkItem(db, current.id)?.state).toBe("cancelled");
    expect(stopResponses(db)).toEqual([
      "Cancelled from Linear. Branch paws/PAS-677 has no commits; no PR was opened. Re-delegate to continue.",
    ]);
  } finally {
    check.close();
    db.close();
  }
});

test("a membership lost while held cancels on recovery with the member reason", async () => {
  const { db, item } = await seed();
  const current = item();
  const integration = new FakeGitHubIntegration();
  integration.installed = false;
  const check = new GitHubInstallationCheck(db, integration, () => 1000);
  try {
    expect(await check.ensure(current, "initial", new AbortController().signal)).toBe(false);
    expect(getWorkItem(db, current.id)?.state).toBe("awaiting_input");
    integration.installed = true;
    integration.permitted = teamMemberDenial(db, current);
    await check.recover();
    expect(getWorkItem(db, current.id)?.state).toBe("cancelled");
    expect(stopResponses(db)).toEqual(["You're not a member of Pascal in Paws."]);
  } finally {
    check.close();
    db.close();
  }
});

test("a local membership check that fails explains without reading GitHub or Linear", async () => {
  const { db, item } = await seed();
  const current = item();
  const integration = new FakeGitHubIntegration({
    current: (subject) => teamMemberDenial(db, subject),
  });
  const check = new GitHubInstallationCheck(db, integration, () => 1000);
  try {
    expect(await check.ensure(current, "initial", new AbortController().signal)).toBe(false);
    expect(stopResponses(db)).toEqual(["You're not a member of Pascal in Paws."]);
    expect(integration.checks).toEqual([]);
  } finally {
    check.close();
    db.close();
  }
});
