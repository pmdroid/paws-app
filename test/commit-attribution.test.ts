import { afterEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  beginGitHubAttribution,
  bindLinearSessionTask,
  consumeGitHubAttributionRequest,
  githubAttribution,
  insertQueuedItem,
  putWorkspaceUser,
  recordLinearInstallation,
  revokeGitHubAttribution,
  saveGitHubAttribution,
  syncWorkspaceMember,
} from "../src/db";
import {
  delegatorCommitCredit,
  delegatorPullRequestToken,
  issueWorkspaceSession,
} from "../src/workspace";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const fetchSpy = spyOn(globalThis, "fetch");
afterEach(() => fetchSpy.mockClear());

async function fixture() {
  const { db, close } = await tempStore();
  const now = Date.now();
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "workspace", linearOrganizationId: "org", name: "Workspace", createdAt: now }),
  );
  const bindings = new Map<string, { userId: string; workspaceId: string; sessionHash: string }>();
  for (const [index, id] of ["lead", "steerer"].entries()) {
    await putWorkspaceUser(db, {
      id,
      linearUserId: id,
      name: id,
      email: `${id}@example.invalid`,
    });
    await syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: id,
      role: "member",
      active: true,
      teamIds: ["team"],
      now,
    });
    const session = await issueWorkspaceSession(db, {
      workspaceId: "workspace",
      userId: id,
      now,
    });
    const binding = {
      workspaceId: "workspace",
      userId: id,
      sessionHash: session.session.tokenHash,
    };
    bindings.set(id, binding);
    await beginGitHubAttribution(db, binding, { stateHash: id, browserHash: id, now });
    const { revision } = await consumeGitHubAttributionRequest(db, binding, {
      stateHash: id,
      browserHash: id,
      now,
    });
    await saveGitHubAttribution(
      db,
      binding,
      { id: index + 1, login: id, name: id, email: `${index + 1}+${id}@users.noreply.github.com` },
      revision,
      now,
    );
  }
  const item = await insertQueuedItem(db, { id: "item", now, sessionKey: "session" });
  await recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: now,
  });
  await bindLinearSessionTask(db, "session", item.delegationId, { actorId: "steerer" });
  await seed(db, (q) =>
    q.orm.insert(q.t.workItemScheduling).values({
      itemId: item.id,
      projectId: "project",
      projectKnown: 1,
      priority: 0,
      projectLeadId: "lead",
    }),
  );
  return { db, close, now, item, bindings };
}

test("credit is the delegating member's linked GitHub identity, never the project lead", async () => {
  const f = await fixture();
  try {
    expect(await delegatorCommitCredit(f.db, f.item.id)).toEqual({
      id: 2,
      login: "steerer",
      name: "steerer",
      email: "2+steerer@users.noreply.github.com",
    });
    expect(await githubAttribution(f.db, "workspace", "lead")).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test("a delegator who did not link GitHub gets no credit", async () => {
  const f = await fixture();
  try {
    await revokeGitHubAttribution(f.db, f.bindings.get("steerer")!, f.now);
    expect(await delegatorCommitCredit(f.db, f.item.id)).toBeNull();
    await seed(f.db, (q) =>
      q.orm.insert(q.t.workspaceIdentityLink).values({
        workspaceId: "workspace",
        userId: "steerer",
        provider: "github",
        externalId: "steerer",
        installationId: null,
        method: "manual",
        status: "linked",
        checkedAt: f.now,
      }),
    );
    expect(await delegatorCommitCredit(f.db, f.item.id)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

for (const scenario of ["no-actor", "unknown-actor", "inactive", "no-workspace"] as const)
  test(`no credit without a permitted delegating member: ${scenario}`, async () => {
    const f = await fixture();
    try {
      await seed(f.db, (q) => {
        const { workItem, workspaceMember, linearSession } = q.t;
        if (scenario === "no-actor")
          return q.orm.update(workItem).set({ ownerUserId: null, delegatedBy: null });
        if (scenario === "unknown-actor")
          return q.orm.update(workItem).set({ ownerUserId: null, delegatedBy: "stranger" });
        if (scenario === "inactive")
          return q.orm
            .update(workspaceMember)
            .set({ active: 0 })
            .where(eq(workspaceMember.userId, "steerer"));
        return q.orm.update(linearSession).set({ organizationId: "other" });
      });
      expect(await delegatorCommitCredit(f.db, f.item.id)).toBeNull();
    } finally {
      await f.close();
    }
  });

test("the pull request token is the delegator's, only with the setting on and a linked account", async () => {
  const f = await fixture();
  const asked: string[] = [];
  const tokens = new Map([["steerer", "ghu_steerer"]]);
  const userToken = async (workspaceId: string, userId: string) => {
    asked.push(`${workspaceId}/${userId}`);
    return tokens.get(userId) ?? null;
  };
  try {
    expect(await delegatorPullRequestToken(f.db, f.item.id, userToken)).toEqual({
      login: "steerer",
      token: "ghu_steerer",
    });
    expect(asked).toEqual(["workspace/steerer"]);
    tokens.clear();
    expect(await delegatorPullRequestToken(f.db, f.item.id, userToken)).toBeNull();
    tokens.set("steerer", "ghu_steerer");
    await revokeGitHubAttribution(f.db, f.bindings.get("steerer")!, f.now);
    expect(await delegatorPullRequestToken(f.db, f.item.id, userToken)).toBeNull();
    expect(asked).toHaveLength(2);
  } finally {
    await f.close();
  }
});
