import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pawsPaths } from "../../src/config";
import { writeSecretFile } from "../../src/credentials";
import {
  changeWorkspaceRole,
  consumeWorkspaceBootstrap,
  migrate,
  openDatabase,
  putWorkspaceUser,
  saveWorkspaceIdentityLink,
  syncWorkspaceMember,
  workspaceIdentityLinks,
} from "../../src/db";
import { createSlackIdentityReads } from "../../src/slack";
import {
  createWorkspaceAccess,
  createWorkspaceIdentityLinks,
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  requestWorkspaceSession,
  workspaceId,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
} from "../../src/workspace";

export async function probeWorkspaceIdentityLinks(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true });
  const db = openDatabase(join(root, "identity-links.sqlite"));
  migrate(db);
  const now = Date.now();
  const ids = Array.from({ length: 10 }, (_, i) =>
    putWorkspaceUser(db, {
      id: workspaceId(now + i),
      linearUserId: `linear-${i}`,
      name: `Member ${i}`,
      email: `member${i}@example.invalid`,
    }),
  );
  const workspace = { id: workspaceId(), organizationId: "org", name: "Workspace" };
  consumeWorkspaceBootstrap(db, {
    ...workspace,
    userId: ids[0]!,
    now,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
  });
  for (const userId of ids)
    syncWorkspaceMember(db, {
      workspaceId: workspace.id,
      userId,
      role: "member",
      active: true,
      teamIds: ["team"],
      now,
    });
  changeWorkspaceRole(db, {
    workspaceId: workspace.id,
    actorId: ids[0]!,
    userId: ids[1]!,
    role: "admin",
    now,
  });
  const secrets = pawsPaths(root).secretsDir;
  writeSecretFile(
    join(secrets, "slack-oauth.json"),
    JSON.stringify({
      accessToken: "fixture-slack-identity-token",
      refreshToken: null,
      expiresAtMs: null,
      scope: "users:read.email",
      teamId: "T123",
      botUserId: "U123",
    }),
  );
  const requests: { email: string; authorized: boolean }[] = [];
  let wrongTeam = false;
  let barrier: { entered: () => void; wait: Promise<void> } | undefined;
  const slack = createSlackIdentityReads({
    home: root,
    db,
    fetch: async (input, init) => {
      const url = new URL(input);
      if (url.origin !== "https://slack.com" || url.pathname !== "/api/users.lookupByEmail")
        throw new Error("Unexpected Slack request.");
      const email = url.searchParams.get("email")!;
      requests.push({
        email,
        authorized:
          new Headers(init?.headers).get("authorization") === "Bearer fixture-slack-identity-token",
      });
      const waiting = barrier;
      if (waiting !== undefined) {
        barrier = undefined;
        waiting.entered();
        await waiting.wait;
      }
      if (email === "member9@example.invalid")
        return Response.json({ ok: false, error: "users_not_found" });
      return Response.json({
        ok: true,
        user: {
          id: `U${email.match(/member(\d+)/)![1]}`,
          team_id: wrongTeam ? "TOTHER" : "T123",
          deleted: false,
          is_bot: false,
          is_app_user: false,
          profile: { email },
        },
      });
    },
  })!;
  let access: ReturnType<typeof createWorkspaceAccess>;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) =>
      (await access.handle(request)) ?? new Response("Not found", { status: 404 }),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  access = createWorkspaceAccess({
    db,
    publicUrl: origin,
    clientId: "client",
    installedOrganization: { id: "org", name: "Workspace" },
    slackIdentities: slack,
    memberships: {
      async installation() {
        return { id: "org", name: "Workspace" };
      },
      async member(organizationId, userId) {
        return {
          organizationId,
          userId,
          active: true,
          guest: false,
          admin: false,
          teamIds: ["team"],
        };
      },
    },
  });
  const owner = issueWorkspaceSession(db, { workspaceId: workspace.id, userId: ids[0]!, now });
  const admin = issueWorkspaceSession(db, { workspaceId: workspace.id, userId: ids[1]!, now });
  const member = issueWorkspaceSession(db, { workspaceId: workspace.id, userId: ids[2]!, now });
  const read = (session = owner) =>
    fetch(`${origin}/api/workspaces/identity-links`, {
      headers: { cookie: `${WORKSPACE_COOKIE}=${session.token}` },
    });
  const save = (
    session: typeof owner,
    userId: string,
    provider: string,
    externalId: string | null,
    csrf = session.session.csrfToken,
  ) =>
    fetch(`${origin}/api/workspaces/identity-links`, {
      method: "PUT",
      headers: {
        cookie: `${WORKSPACE_COOKIE}=${session.token}`,
        origin,
        "content-type": "application/json",
        "x-paws-csrf": csrf,
      },
      body: JSON.stringify({ userId, provider, externalId }),
    });
  try {
    await access.refreshMemberships();
    let links = workspaceIdentityLinks(db, workspace.id);
    const matched = links.filter(
      (link) => link.status === "linked" && link.method === "email",
    ).length;
    const listed = await read(admin);
    const listing = (await listed.json()) as { links: typeof links };
    observe(
      "Slack email matching links 90 percent of a ten-member test team and lists mismatches for admins",
      matched === 9 &&
        links.length === 10 &&
        listed.status === 200 &&
        listed.headers.get("x-content-type-options") === "nosniff" &&
        listed.headers.get("referrer-policy") === "no-referrer" &&
        listing.links.some((link) => link.userId === ids[9] && link.status === "unmatched") &&
        requests.every((request) => request.authorized),
      {
        matched,
        total: links.length,
        percent: matched * 10,
        mismatchListed: listing.links.some((link) => link.status === "unmatched"),
      },
    );
    const denied = await read(member);
    const deniedWrite = await save(member, ids[9]!, "github", "member-nine");
    const badCsrf = await save(owner, ids[9]!, "github", "member-nine", "wrong");
    observe(
      "identity administration requires owner or admin and CSRF",
      [denied, deniedWrite, badCsrf].every((response) => response.status === 403),
      {
        read: denied.status,
        write: deniedWrite.status,
        csrf: badCsrf.status,
      },
    );
    let releaseBody!: () => void;
    let enteredBody!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      enteredBody = resolve;
    });
    const bodyWait = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const context = requestWorkspaceSession(
      db,
      new Request(origin, { headers: { cookie: `${WORKSPACE_COOKIE}=${admin.token}` } }),
      Date.now(),
    )!;
    const raced = createWorkspaceIdentityLinks({ db, slack }).handle(
      new Request(`${origin}/api/workspaces/identity-links`, {
        method: "PUT",
        headers: {
          origin,
          "content-type": "application/json",
          "x-paws-csrf": admin.session.csrfToken,
        },
        body: new ReadableStream(
          {
            async pull(controller) {
              enteredBody();
              await bodyWait;
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({ userId: ids[9], provider: "github", externalId: "blocked" }),
                ),
              );
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      }),
      { ...context, origin, now: Date.now() },
    );
    await bodyStarted;
    changeWorkspaceRole(db, {
      workspaceId: workspace.id,
      actorId: ids[0]!,
      userId: ids[1]!,
      role: "member",
      now: Date.now(),
    });
    releaseBody();
    const demoted = await raced;
    const denial = db
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM workspace_access_audit WHERE action='access.denied' AND subject='/api/workspaces/identity-links' AND user_id=?",
      )
      .get(ids[1]!)!.count;
    observe(
      "administrator demotion during body read denies and audits the identity mutation",
      demoted?.status === 403 &&
        denial > 0 &&
        !workspaceIdentityLinks(db, workspace.id).some((link) => link.externalId === "blocked"),
      { status: demoted?.status, denials: denial },
    );
    changeWorkspaceRole(db, {
      workspaceId: workspace.id,
      actorId: ids[0]!,
      userId: ids[1]!,
      role: "admin",
      now: Date.now(),
    });
    const concurrent = openDatabase(join(root, "identity-links.sqlite"));
    const transaction = db.transaction.bind(db);
    Object.defineProperty(db, "transaction", {
      configurable: true,
      value: (run: () => unknown) => {
        Object.defineProperty(db, "transaction", { configurable: true, value: transaction });
        changeWorkspaceRole(concurrent, {
          workspaceId: workspace.id,
          actorId: ids[0]!,
          userId: ids[1]!,
          role: "member",
          now: Date.now(),
        });
        return transaction(run);
      },
    });
    let transactionDenial: Response | null;
    try {
      transactionDenial = await createWorkspaceIdentityLinks({ db, slack }).handle(
        new Request(`${origin}/api/workspaces/identity-links`, {
          method: "PUT",
          headers: {
            origin,
            "content-type": "application/json",
            "x-paws-csrf": admin.session.csrfToken,
          },
          body: JSON.stringify({ userId: ids[9], provider: "github", externalId: "blocked" }),
        }),
        { ...context, origin, now: Date.now() },
      );
    } finally {
      Object.defineProperty(db, "transaction", { configurable: true, value: transaction });
      concurrent.close();
    }
    observe(
      "a concurrent SQLite demotion at transaction entry returns an audited forbidden response",
      transactionDenial?.status === 403 &&
        db
          .query<{ count: number }, [string]>(
            "SELECT count(*) AS count FROM workspace_access_audit WHERE action='access.denied' AND subject='/api/workspaces/identity-links' AND user_id=?",
          )
          .get(ids[1]!)!.count > denial &&
        !workspaceIdentityLinks(db, workspace.id).some((link) => link.externalId === "blocked"),
      { status: transactionDenial?.status },
    );
    changeWorkspaceRole(db, {
      workspaceId: workspace.id,
      actorId: ids[0]!,
      userId: ids[1]!,
      role: "admin",
      now: Date.now(),
    });
    const github = await save(admin, ids[9]!, "github", "Member-Nine");
    const manualSlack = await save(admin, ids[9]!, "slack", "U999");
    await access.refreshMemberships();
    links = workspaceIdentityLinks(db, workspace.id);
    observe(
      "admin manual Slack and GitHub mappings persist their method and survive email sync",
      github.status === 200 &&
        manualSlack.status === 200 &&
        links.some(
          (link) =>
            link.userId === ids[9] &&
            link.provider === "github" &&
            link.externalId === "member-nine" &&
            link.method === "manual",
        ) &&
        links.some(
          (link) =>
            link.userId === ids[9] &&
            link.provider === "slack" &&
            link.externalId === "U999" &&
            link.installationId === "T123" &&
            link.method === "manual",
        ),
      { github: github.status, slack: manualSlack.status },
    );
    const latest = workspaceIdentityLinks(db, workspace.id).find(
      (link) => link.userId === ids[9] && link.provider === "github",
    )!;
    saveWorkspaceIdentityLink(db, {
      ...latest,
      workspaceId: workspace.id,
      actorId: ids[1]!,
      externalId: "stale-member-nine",
      checkedAt: latest.checkedAt - 1,
    });
    const afterStaleManual = workspaceIdentityLinks(db, workspace.id).find(
      (link) => link.userId === ids[9] && link.provider === "github",
    );
    observe(
      "an older manual identity mutation cannot overwrite a newer saved mapping",
      afterStaleManual?.externalId === "member-nine" &&
        afterStaleManual.checkedAt === latest.checkedAt,
      { latest, after: afterStaleManual },
    );
    const duplicate = await save(owner, ids[9]!, "slack", "U0");
    const foreignUser = await save(owner, "foreign-user", "github", "someone");
    const invalid = await save(owner, ids[9]!, "github", "bad/name");
    observe(
      "duplicate external identities, unknown members and malformed manual mappings are rejected",
      [duplicate, foreignUser, invalid].every((response) => response.status === 400),
      { duplicate: duplicate.status, foreignUser: foreignUser.status, invalid: invalid.status },
    );
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    barrier = {
      entered,
      wait: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const service = createWorkspaceIdentityLinks({ db, slack });
    const delayed = service.syncUser(workspace.id, ids[8]!);
    await started;
    const during = await save(admin, ids[8]!, "slack", "U888");
    release();
    await delayed;
    observe(
      "a delayed email lookup cannot overwrite a newer manual identity mapping",
      during.status === 200 &&
        workspaceIdentityLinks(db, workspace.id).some(
          (link) =>
            link.userId === ids[8] && link.externalId === "U888" && link.method === "manual",
        ),
      { status: during.status },
    );
    const cleared = await save(admin, ids[8]!, "slack", null);
    const reset = workspaceIdentityLinks(db, workspace.id).find(
      (link) => link.userId === ids[8] && link.provider === "slack",
    );
    await service.syncUser(workspace.id, ids[8]!);
    const rematched = workspaceIdentityLinks(db, workspace.id).find(
      (link) => link.userId === ids[8] && link.provider === "slack",
    );
    observe(
      "clearing a manual Slack mapping restores automatic email matching",
      cleared.status === 200 &&
        reset?.method === "email" &&
        reset.externalId === null &&
        rematched?.method === "email" &&
        rematched.externalId === "U8",
      { status: cleared.status, reset, rematched },
    );
    await save(admin, ids[8]!, "slack", "U888");
    wrongTeam = true;
    await service.syncUser(workspace.id, ids[7]!);
    observe(
      "Slack identities from another installation are recorded as errors without being linked",
      workspaceIdentityLinks(db, workspace.id).some(
        (link) => link.userId === ids[7] && link.status === "error" && link.externalId === null,
      ),
      workspaceIdentityLinks(db, workspace.id).filter((link) => link.userId === ids[7]),
    );
    const audit = db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM workspace_access_audit WHERE action='identity.link.changed'",
      )
      .get()!.count;
    observe(
      "identity changes are audited and Slack credentials never enter identity rows",
      audit >= 10 &&
        db
          .query(
            "SELECT 1 FROM workspace_access_audit WHERE action='identity.link.changed' AND subject LIKE '%:github:manual:linked:member-nine'",
          )
          .get() !== null &&
        !JSON.stringify(workspaceIdentityLinks(db, workspace.id)).includes(
          "fixture-slack-identity-token",
        ),
      { auditedChanges: audit },
    );
  } finally {
    writeFileSync(join(root, "slack-requests.json"), JSON.stringify(requests, null, 2));
    writeFileSync(
      join(root, "links.json"),
      JSON.stringify(workspaceIdentityLinks(db, workspace.id), null, 2),
    );
    await server.stop(true);
    await access.stop();
    db.close();
  }
  const restarted = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(join(root, "identity-links.sqlite"))}, { readonly: true });
const links = db.query("SELECT provider,external_id,method FROM workspace_identity_link WHERE method='manual' ORDER BY external_id").all();
const audit = db.query("SELECT count(*) AS count FROM workspace_access_audit WHERE action='identity.link.changed'").get();
console.log(JSON.stringify({ links, audit }));
db.close();`,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 5000 },
  );
  const [output, errors, code] = await Promise.all([
    new Response(restarted.stdout).text(),
    new Response(restarted.stderr).text(),
    restarted.exited,
  ]);
  const restored = JSON.parse(output) as {
    links: { provider: string; external_id: string; method: string }[];
    audit: { count: number };
  };
  writeFileSync(join(root, "restart.json"), JSON.stringify({ code, ...restored, errors }, null, 2));
  observe(
    "manual identity links and their access audits survive an actual process restart",
    code === 0 &&
      restored.links.length === 3 &&
      restored.links.some(
        (link) => link.provider === "github" && link.external_id === "member-nine",
      ) &&
      restored.links.some((link) => link.provider === "slack" && link.external_id === "U888") &&
      restored.links.some((link) => link.provider === "slack" && link.external_id === "U999") &&
      restored.audit.count >= 10,
    { code, ...restored, errors },
  );
}
