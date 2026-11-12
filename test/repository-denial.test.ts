import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listOutbox,
  refreshRepositoryCatalog,
  type WorkItemRecord,
  type Db,
  type Q,
} from "../src/db";
import {
  FakeGitHubIntegration,
  GitHubInstallationCheck,
  issueTeamNameSteps,
  teamMemberDenialSteps,
  teamRepositoryDenial,
} from "../src/loop";
import { seed as insertRows } from "./dialects";
import { tempStore } from "./pglite";

const MAPPED = { workspaceId: "ws", teamId: "mapped" };
const UNMAPPED = { workspaceId: "ws", teamId: "unmapped" };
const NO_REPOSITORY =
  "Pascal has no repository in Paws yet. Ask Ada Admin or Grace Admin to map one in Integrations, then delegate again.";

async function seed() {
  const { db, close } = await tempStore();
  await insertRows(
    db,
    (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "ws", linearOrganizationId: "org", name: "Workspace", createdAt: 0 }),
    ...(
      [
        ["ada", "Ada Admin", "admin", 1],
        ["admin", "Grace Admin", "admin", 1],
        ["former", "Old Admin", "admin", 0],
        ["member", "Lin Member", "member", 1],
      ] as const
    ).flatMap(([id, name, role, active]) => [
      (q: Q) =>
        q.orm
          .insert(q.t.workspaceUser)
          .values({ id, linearUserId: `linear-${id}`, name, email: `${id}@example.com` }),
      (q: Q) =>
        q.orm.insert(q.t.workspaceMember).values({
          workspaceId: "ws",
          userId: id,
          role,
          source: "linear",
          active,
          checkedAt: 0,
        }),
    ]),
    (q) =>
      q.orm
        .insert(q.t.workspaceRepository)
        .values({ workspaceId: "ws", repository: "acme/linked", teamId: "mapped" }),
  );
  await refreshRepositoryCatalog(db, async () =>
    ["linked", "catalog"].map((repo) => ({
      owner: "acme",
      repo,
      remoteUrl: `https://github.com/acme/${repo}.git`,
      defaultBranch: "main",
    })),
  );
  const item = async (id = "PAS-677", team: string | null = "Pascal"): Promise<WorkItemRecord> => {
    await insertQueuedItem(db, { id, sessionKey: `session-${id}`, title: id });
    await beginImplementRun(db, id, 1000);
    if (team !== null)
      await insertRows(db, (q) =>
        q.orm.insert(q.t.inboxEvent).values({
          dedupeKey: `created:${id}`,
          source: "webhook",
          action: "created",
          sessionId: `session-${id}`,
          issueId: `lin-item-${id}`,
          updatedAtMs: 0,
          payload: {
            type: "AgentSessionEvent",
            action: "created",
            agentSession: {
              issue: { id: `lin-item-${id}`, team: { id: "t", key: "PAS", name: team } },
            },
          },
          receivedAt: 0,
        }),
      );
    return (await getWorkItem(db, id))!;
  };
  return { db, close, item };
}

async function stopResponses(db: Db): Promise<string[]> {
  return (await listOutbox(db))
    .filter((entry) => entry.delivery === "stop" && entry.op === "activity")
    .map((entry) => (entry.payload as { body: string }).body);
}

async function count(db: Db, table: "githubIntegrationHold" | "question"): Promise<number> {
  return (await db.run((q) => q.all(q.orm.select().from(q.t[table])))).length;
}

test("a mapped team may use only its linked repositories, and is told which one is not", async () => {
  const { db, close, item } = await seed();
  try {
    const current = await item();
    expect(
      await teamRepositoryDenial(db, current, MAPPED, { owner: "acme", repo: "linked" }),
    ).toBeNull();
    expect(
      await teamRepositoryDenial(db, current, MAPPED, { owner: "ACME", repo: "Linked" }),
    ).toBeNull();
    expect(
      await teamRepositoryDenial(db, current, MAPPED, { owner: "acme", repo: "catalog" }),
    ).toEqual({
      denied: true,
      reason: "acme/catalog isn't mapped to Pascal in Paws.",
    });
  } finally {
    await close();
  }
});

test("an unmapped team may use any catalog repository, as placement does", async () => {
  const { db, close, item } = await seed();
  try {
    const current = await item();
    for (const repo of ["catalog", "linked"])
      expect(await teamRepositoryDenial(db, current, UNMAPPED, { owner: "acme", repo })).toBeNull();
    expect(
      await teamRepositoryDenial(db, current, UNMAPPED, {
        owner: "acme",
        repo: "elsewhere",
      }),
    ).toEqual({ denied: true, reason: NO_REPOSITORY });
  } finally {
    await close();
  }
});

test("a workspace without active admins names the role instead of a person", async () => {
  const { db, close, item } = await seed();
  try {
    await insertRows(db, (q) =>
      q.orm
        .update(q.t.workspaceMember)
        .set({ active: 0 })
        .where(eq(q.t.workspaceMember.role, "admin")),
    );
    expect(
      (
        await teamRepositoryDenial(db, await item(), UNMAPPED, {
          owner: "acme",
          repo: "elsewhere",
        })
      )?.reason,
    ).toBe(
      "Pascal has no repository in Paws yet. Ask a Paws admin to map one in Integrations, then delegate again.",
    );
  } finally {
    await close();
  }
});

test("the team name comes from the stored webhook, else the issue key, never from Linear", async () => {
  const { db, close, item } = await seed();
  try {
    const pascal = await item("PAS-1", "Pascal");
    const eng = await item("ENG-2", null);
    const unmapped = await item("PAS-3");
    expect(await db.run((q) => issueTeamNameSteps(q, pascal))).toBe("Pascal");
    expect(await db.run((q) => issueTeamNameSteps(q, eng))).toBe("ENG");
    expect(await db.run((q) => teamMemberDenialSteps(q, unmapped))).toEqual({
      denied: true,
      reason: "You're not a member of Pascal in Paws.",
    });
  } finally {
    await close();
  }
});

for (const [name, decide, response] of [
  [
    "an unmapped team's repository outside the catalog",
    async (db: Db, item: WorkItemRecord) =>
      (await teamRepositoryDenial(db, item, UNMAPPED, {
        owner: "acme",
        repo: "elsewhere",
      }))!,
    NO_REPOSITORY,
  ],
  [
    "a repository outside the team's links",
    async (db: Db, item: WorkItemRecord) =>
      (await teamRepositoryDenial(db, item, MAPPED, { owner: "acme", repo: "catalog" }))!,
    "acme/catalog isn't mapped to Pascal in Paws.",
  ],
  [
    "a delegator outside the team",
    (db: Db, item: WorkItemRecord) => db.run((q) => teamMemberDenialSteps(q, item)),
    "You're not a member of Pascal in Paws.",
  ],
] as const) {
  test(`${name} cancels the item once and ends the session with its reason`, async () => {
    const { db, close, item } = await seed();
    const current = await item();
    const integration = new FakeGitHubIntegration();
    integration.permitted = await decide(db, current);
    const check = new GitHubInstallationCheck(db, integration, () => 1000);
    try {
      expect(await check.ensure(current, "initial", new AbortController().signal)).toBe(false);
      expect((await getWorkItem(db, current.id))?.state).toBe("cancelled");
      expect(await stopResponses(db)).toEqual([response]);
      expect(integration.checks.map((entry) => entry.kind)).toEqual(["installation", "member"]);
      expect(await count(db, "githubIntegrationHold")).toBe(0);
      expect(await count(db, "question")).toBe(0);
      expect(
        await check.ensure(
          (await getWorkItem(db, current.id))!,
          "initial",
          new AbortController().signal,
        ),
      ).toBe(false);
      expect(await stopResponses(db)).toEqual([response]);
    } finally {
      check.close();
      await close();
    }
  });
}

test("a denial without a reason still ends with the default response", async () => {
  const { db, close, item } = await seed();
  const current = await item();
  const integration = new FakeGitHubIntegration();
  integration.permitted = false;
  const check = new GitHubInstallationCheck(db, integration, () => 1000);
  try {
    expect(await check.ensure(current, "initial", new AbortController().signal)).toBe(false);
    expect((await getWorkItem(db, current.id))?.state).toBe("cancelled");
    expect(await stopResponses(db)).toEqual([
      "Cancelled from Linear. Branch paws/PAS-677 has no commits; no PR was opened. Re-delegate to continue.",
    ]);
  } finally {
    check.close();
    await close();
  }
});

test("a membership lost while held cancels on recovery with the member reason", async () => {
  const { db, close, item } = await seed();
  const current = await item();
  const integration = new FakeGitHubIntegration();
  integration.installed = false;
  const check = new GitHubInstallationCheck(db, integration, () => 1000);
  try {
    expect(await check.ensure(current, "initial", new AbortController().signal)).toBe(false);
    expect((await getWorkItem(db, current.id))?.state).toBe("awaiting_input");
    integration.installed = true;
    integration.permitted = await db.run((q) => teamMemberDenialSteps(q, current));
    await check.recover();
    expect((await getWorkItem(db, current.id))?.state).toBe("cancelled");
    expect(await stopResponses(db)).toEqual(["You're not a member of Pascal in Paws."]);
  } finally {
    check.close();
    await close();
  }
});

test("a local membership check that fails explains without reading GitHub or Linear", async () => {
  const { db, close, item } = await seed();
  const current = await item();
  const integration = new FakeGitHubIntegration({
    current: (q, subject) => teamMemberDenialSteps(q, subject),
  });
  const check = new GitHubInstallationCheck(db, integration, () => 1000);
  try {
    expect(await check.ensure(current, "initial", new AbortController().signal)).toBe(false);
    expect(await stopResponses(db)).toEqual(["You're not a member of Pascal in Paws."]);
    expect(integration.checks).toEqual([]);
  } finally {
    check.close();
    await close();
  }
});
