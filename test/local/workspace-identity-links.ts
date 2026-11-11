import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pawsPaths } from "../../src/config";
import { writeCredential } from "../../src/credentials";
import {
  changeWorkspaceRole,
  consumeWorkspaceBootstrap,
  migrate,
  openDatabase,
  putWorkspaceUser,
  saveWorkspaceIdentityLink,
  syncWorkspaceMember,
  workspaceIdentityLinks,
  sqliteDb,
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
  const ids: string[] = [];
  for (let i = 0; i < 10; i++)
    ids.push(
      putWorkspaceUser(db, {
        id: workspaceId(now + i),
        linearUserId: `linear-${i}`,
        name: `Member ${i}`,
        email: `member${i}@example.invalid`,
      }),
    );
  const workspace = { id: workspaceId(), organizationId: "org", name: "Workspace" };
  await consumeWorkspaceBootstrap(sqliteDb(db), {
    ...workspace,
    userId: ids[0]!,
    now,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", now)),
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
  writeCredential(
    db,
    secrets,
    "slack",
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
    let links = await workspaceIdentityLinks(sqliteDb(db), workspace.id);
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
        !(await workspaceIdentityLinks(sqliteDb(db), workspace.id)).some(
          (link) => link.externalId === "blocked",
        ),
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
    // The store reads `inTransaction` as it enters a transaction, before BEGIN IMMEDIATE.
    const restore = () => Reflect.deleteProperty(db, "inTransaction");
    Object.defineProperty(db, "inTransaction", {
      configurable: true,
      get() {
        restore();
        void (async () =>
          changeWorkspaceRole(concurrent, {
            workspaceId: workspace.id,
            actorId: ids[0]!,
            userId: ids[1]!,
            role: "member",
            now: Date.now(),
          }))();
        return db.inTransaction;
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
      restore();
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
        !(await workspaceIdentityLinks(sqliteDb(db), workspace.id)).some(
          (link) => link.externalId === "blocked",
        ),
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
    links = await workspaceIdentityLinks(sqliteDb(db), workspace.id);
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
    const latest = (await workspaceIdentityLinks(sqliteDb(db), workspace.id)).find(
      (link) => link.userId === ids[9] && link.provider === "github",
    )!;
    await saveWorkspaceIdentityLink(sqliteDb(db), {
      ...latest,
      workspaceId: workspace.id,
      actorId: ids[1]!,
      externalId: "stale-member-nine",
      checkedAt: latest.checkedAt - 1,
    });
    const afterStaleManual = (await workspaceIdentityLinks(sqliteDb(db), workspace.id)).find(
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
        (await workspaceIdentityLinks(sqliteDb(db), workspace.id)).some(
          (link) =>
            link.userId === ids[8] && link.externalId === "U888" && link.method === "manual",
        ),
      { status: during.status },
    );
    const cleared = await save(admin, ids[8]!, "slack", null);
    const reset = (await workspaceIdentityLinks(sqliteDb(db), workspace.id)).find(
      (link) => link.userId === ids[8] && link.provider === "slack",
    );
    await service.syncUser(workspace.id, ids[8]!);
    const rematched = (await workspaceIdentityLinks(sqliteDb(db), workspace.id)).find(
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
      (await workspaceIdentityLinks(sqliteDb(db), workspace.id)).some(
        (link) => link.userId === ids[7] && link.status === "error" && link.externalId === null,
      ),
      (await workspaceIdentityLinks(sqliteDb(db), workspace.id)).filter(
        (link) => link.userId === ids[7],
      ),
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
        !JSON.stringify(await workspaceIdentityLinks(sqliteDb(db), workspace.id)).includes(
          "fixture-slack-identity-token",
        ),
      { auditedChanges: audit },
    );
  } finally {
    writeFileSync(join(root, "slack-requests.json"), JSON.stringify(requests, null, 2));
    writeFileSync(
      join(root, "links.json"),
      JSON.stringify(await workspaceIdentityLinks(sqliteDb(db), workspace.id), null, 2),
    );
    await server.stop(true);
    await access.stop();
    db.close();
  }
  const step = "manual identity links and their access audits survive an actual process restart";
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
    { stdout: "pipe", stderr: "pipe", timeout: 15_000 },
  );
  // Wait for the child to exit before reading, then read both pipes to the end: the child's
  // output is a few hundred bytes, so it cannot fill a pipe and block the exit.
  const code = await restarted.exited;
  const [output, errors] = await Promise.all([
    new Response(restarted.stdout).text(),
    new Response(restarted.stderr).text(),
  ]);
  const child = {
    code,
    signal: restarted.signalCode,
    stdout: output.slice(-500),
    stderr: errors.slice(-2000),
  };
  let restored: {
    links: { provider: string; external_id: string; method: string }[];
    audit: { count: number };
  };
  try {
    restored = JSON.parse(output);
  } catch {
    observe(step, false, { ...child, reason: "the child printed no JSON" });
    return;
  }
  writeFileSync(join(root, "restart.json"), JSON.stringify({ ...child, ...restored }, null, 2));
  observe(
    step,
    code === 0 &&
      restored.links.length === 3 &&
      restored.links.some(
        (link) => link.provider === "github" && link.external_id === "member-nine",
      ) &&
      restored.links.some((link) => link.provider === "slack" && link.external_id === "U888") &&
      restored.links.some((link) => link.provider === "slack" && link.external_id === "U999") &&
      restored.audit.count >= 10,
    { ...child, ...restored },
  );
}
