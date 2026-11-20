import { migratedHome, withHomeStore } from "./helpers";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupLinkMain, startPaws, type PawsProcess } from "../src/index";

const roots: string[] = [];
const processes: PawsProcess[] = [];

afterEach(async () => {
  for (const process of processes.splice(0)) await process.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function freshInstance(
  expectedOrganizationId?: string,
  setup = false,
  accessToken?: string,
  workspace?: string,
) {
  const home = await migratedHome(mkdtempSync(join(tmpdir(), "paws-browser-onboarding-")));
  roots.push(home);
  if (workspace)
    await withHomeStore(home, (db) =>
      seed(db, (q) =>
        q.orm.insert(q.t.workspace).values({
          id: "existing",
          linearOrganizationId: workspace,
          name: "Workspace",
          createdAt: 0,
        }),
      ),
    );
  const cert = join(home, "server.crt");
  const key = join(home, "server.key");
  const generated = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-config",
      "/dev/null",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  expect(generated.exitCode).toBe(0);
  const paws = await startPaws({
    PAWS_HOME: home,
    PAWS_HOST: "127.0.0.1",
    PAWS_PORT: "0",
    PAWS_PUBLIC_DASHBOARD: "1",
    PAWS_PUBLIC_URL: "https://localhost:8787",
    PAWS_TLS_KEY_PATH: key,
    PAWS_TLS_CERT_PATH: cert,
    LINEAR_ACCESS_TOKEN: accessToken,
    LINEAR_CLIENT_ID: setup ? undefined : "fixture-client",
    LINEAR_CLIENT_SECRET: setup ? undefined : "fixture-client-secret",
    LINEAR_ORGANIZATION_ID: expectedOrganizationId,
  });
  processes.push(paws);
  return paws;
}

test("an HTTPS instance with a workspace serves browser onboarding without a setup link", async () => {
  const paws = await freshInstance(undefined, false, undefined, "org");
  await paws.ready;
  const response = await paws.server.fetch(new Request("https://localhost:8787/api/auth/session"));
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ onboarding: true });
  const blocked = await paws.server.fetch(new Request("https://localhost:8787/api/issues"));
  expect(blocked.status).toBe(401);
  const login = await paws.server.fetch(new Request("https://localhost:8787/auth/linear"));
  expect(login.status).toBe(303);
  const root = await paws.server.fetch(new Request("https://localhost:8787/?onboarding=failed"));
  expect(root.status).toBe(307);
  expect(root.headers.get("location")).toBe("/dashboard/?onboarding=failed");
  const page = await paws.server.fetch(new Request("https://localhost:8787/dashboard/settings"));
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('<base href="/dashboard/"');
  for (const method of ["GET", "HEAD"]) {
    const old = await paws.server.fetch(
      new Request("https://localhost:8787/status/settings/integrations?connecting=1", { method }),
    );
    expect(old.status).toBe(
      (await paws.server.fetch(new Request("https://localhost:8787/unknown", { method }))).status,
    );
    expect(old.headers.get("location")).toBeNull();
  }
  const head = await paws.server.fetch(
    new Request("https://localhost:8787/dashboard/", { method: "HEAD" }),
  );
  expect(head.status).toBe(200);
  const post = await paws.server.fetch(
    new Request("https://localhost:8787/status/settings", { method: "POST" }),
  );
  expect(post.status).toBe(
    (await paws.server.fetch(new Request("https://localhost:8787/unknown", { method: "POST" })))
      .status,
  );
});

test("a fresh HTTPS instance with a Linear client from the environment requires the setup link", async () => {
  const messages: string[] = [];
  const restore = setJournalSink((message) => messages.push(message));
  const paws = await freshInstance();
  restore();
  await paws.ready;
  const login = await paws.server.fetch(new Request("https://localhost:8787/auth/linear"));
  expect(login.status).toBe(403);
  const start = await paws.server.fetch(new Request("https://localhost:8787/"));
  expect(start.status).toBe(503);
  expect(await start.text()).toContain("paws setup-link");
  expect(
    await paws.store.run((q) => q.all(q.orm.select().from(q.t.workspaceOauthRequest))),
  ).toEqual([]);
  expect(await paws.store.run((q) => q.all(q.orm.select().from(q.t.workspace)))).toEqual([]);
  const setupUrl = messages.find((message) => message.includes("/setup?token="))!;
  const setup = await paws.server.fetch(new Request(setupUrl));
  expect(setup.status).toBe(303);
  expect(setup.headers.get("location")).toContain("client_id=fixture-client");
});

import { existsSync } from "node:fs";
import { browserSetupRuntime, webhookFileDigest, createBrowserOnboarding } from "../src/onboarding";
import {
  openPawsStore,
  workspaceForOrganization,
  listWorkspaceMembers,
  recordLinearInstallation,
  revokeLinearInstallation,
  getLinearSessionAccess,
  type Db,
} from "../src/db";
import { loadRuntime, pawsPaths } from "../src/config";
import { seed } from "./pglite-fixtures";

type Table = "workspace" | "workspaceOauthRequest" | "browserInstallationRequest" | "credential";

function rows(db: Db, table: Table) {
  return db.run((q) => q.all(q.orm.select().from(q.t[table])));
}

const foreignWorkspace = (db: Db) =>
  seed(db, (q) =>
    q.orm.insert(q.t.workspace).values({
      id: "foreign",
      linearOrganizationId: "foreign-org",
      name: "Foreign",
      createdAt: 0,
    }),
  );
import { readStoredToken, writeStoredToken } from "../src/linear";
import { createWorkspaceAccess } from "../src/workspace";

async function fixture(setup = false, token = setup) {
  const home = await migratedHome(mkdtempSync(join(tmpdir(), "paws-browser-install-")));
  roots.push(home);
  const open = () => openPawsStore({ url: null, pgliteDir: pawsPaths(home).pgliteDir });
  let database = await open();
  let db = database.store;
  const secrets = setup ? await useDatabaseSecrets(db, join(home, "secrets")) : null;
  const state = {
    admin: true,
    active: true,
    guest: false,
    app: true,
    organization: "org",
    userOrganization: "org",
    expectedOrganizationId: "org" as string | null,
    memberAdmin: true,
    now: Date.now(),
    installed: 0,
    exchanges: 0,
    reconnect: false,
    appToken: "fixture-app",
    prepare: undefined as (() => Promise<void>) | undefined,
  };
  const origin = "https://paws.example";
  const fakeFetch: typeof fetch = (async (input: string | Request | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/oauth/token")) {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("code_verifier")).toHaveLength(43);
      state.exchanges++;
      return Response.json({
        access_token: body.get("code") === "user-code" ? "fixture-user" : state.appToken,
        refresh_token: "fixture-refresh",
        expires_in: 3600,
      });
    }
    const { query } = JSON.parse(String(init?.body));
    if (query.includes("PawsBrowserIdentity"))
      return Response.json({
        data: {
          viewer: {
            id: "admin",
            name: "Admin",
            email: "admin@example.invalid",
            app: false,
            admin: state.admin,
            active: state.active,
            guest: state.guest,
            organization: { id: state.userOrganization, name: "Workspace" },
          },
        },
      });
    const viewer = {
      id: "app",
      app: state.app,
      organization: { id: state.organization, name: "Workspace" },
    };
    if (query.includes("PawsBrowserMembership"))
      return Response.json({
        data: {
          viewer,
          user: {
            id: "admin",
            active: state.active,
            guest: state.guest,
            admin: state.memberAdmin,
            organization: { id: state.organization },
            teams: { nodes: [{ id: "team" }], pageInfo: { hasNextPage: false } },
          },
        },
      });
    if (query.includes("PawsBrowserInstallation") || query.includes("PawsReconnect"))
      return Response.json({ data: { viewer } });
    throw new Error("Unexpected fixture request");
  }) as typeof fetch;
  function handler() {
    return createBrowserOnboarding({
      db,
      home,
      origin,
      setupToken: token ? "setup-token" : undefined,
      environmentClient: token && !setup,
      clientId: setup ? null : "fixture-client",
      clientSecret: setup ? null : "fixture-client-secret",
      expectedOrganizationId: state.expectedOrganizationId,
      prepare: async () => state.prepare?.(),
      fetch: fakeFetch,
      now: () => state.now,
      reconnect: state.reconnect,
      installed: () => {
        state.installed++;
      },
    });
  }
  let handle = handler();
  let setupCookie = "";
  return {
    home,
    state,
    fetch: fakeFetch,
    get db() {
      return db;
    },
    raw: async (request: Request) => {
      const response = await handle(request);
      const cookies = response.headers.getSetCookie();
      setupCookie =
        cookies.find((cookie) => cookie.startsWith("__Host-paws-setup="))?.split(";")[0] ??
        setupCookie;
      return response;
    },
    request: (path: string, cookie = "") =>
      handle(new Request(origin + path, { headers: { cookie } })),
    async user() {
      const response = await handle(
        new Request(origin + "/auth/linear", { headers: { cookie: setupCookie } }),
      );
      const url = new URL(response.headers.get("location")!);
      const cookie =
        response.headers.get("set-cookie")!.split(";")[0]! +
        (setupCookie ? "; " + setupCookie : "");
      return { state: url.searchParams.get("state")!, cookie };
    },
    async installation() {
      const user = await this.user();
      const response = await this.request(
        `/auth/linear/callback?state=${user.state}&code=user-code`,
        user.cookie,
      );
      const url = new URL(response.headers.get("location")!, origin);
      return {
        state: url.searchParams.get("state")!,
        cookie:
          (response.headers.get("set-cookie")?.split(";")[0] ?? "") +
          (setupCookie ? "; " + setupCookie : ""),
        response,
        url,
      };
    },
    async reopen() {
      await database.close();
      database = await open();
      db = database.store;
      handle = handler();
    },
    async close() {
      await secrets?.close();
      await database.close();
    },
  };
}

test("browser sign-in creates an owner only in the operator's configured organization", async () => {
  const scene = await fixture();
  try {
    const install = await scene.installation();
    expect(install.url.searchParams.get("actor")).toBe("app");
    expect(install.url.searchParams.get("redirect_uri")).toBe(
      "https://paws.example/auth/linear/install/callback",
    );
    await scene.reopen();
    const response = await scene.request(
      `/auth/linear/install/callback?state=${install.state}&code=app-code`,
      install.cookie,
    );
    expect(response.headers.get("location")).toBe("/dashboard/settings/integrations?connecting=1");
    expect(response.headers.get("set-cookie")).toContain("__Host-paws-session=");
    expect(scene.state.installed).toBe(1);
    const workspace = (await workspaceForOrganization(scene.db, "org"))!;
    expect((await listWorkspaceMembers(scene.db, workspace.id))[0]?.role).toBe("admin");
    expect((await readStoredToken(scene.db, join(scene.home, "secrets")))?.accessToken).toBe(
      "fixture-app",
    );
    expect(JSON.stringify(await rows(scene.db, "credential"))).not.toContain("fixture-app");
    const again = await scene.request(
      `/auth/linear/install/callback?state=${install.state}&code=app-code`,
      install.cookie,
    );
    expect(again.headers.get("location")).toContain("already-connected");
    expect(scene.state.exchanges).toBe(2);
  } finally {
    await scene.close();
  }
});

test("fresh installation without a setup link or a configured organization answers with the setup page", async () => {
  const scene = await fixture();
  try {
    scene.state.expectedOrganizationId = null;
    await scene.reopen();
    const response = await scene.request("/auth/linear");
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("paws setup-link");
    expect(await rows(scene.db, "workspaceOauthRequest")).toEqual([]);
    expect(await rows(scene.db, "workspace")).toEqual([]);
    expect(scene.state.exchanges).toBe(0);
  } finally {
    await scene.close();
  }
});

async function setupSignIn(scene: Awaited<ReturnType<typeof fixture>>) {
  const start = await scene.raw(new Request("https://paws.example/setup?token=setup-token"));
  expect(start.status).toBe(303);
  expect(start.headers.get("location")).toContain("client_id=fixture-client");
  const install = await scene.installation();
  return scene.request(
    `/auth/linear/install/callback?state=${install.state}&code=app-code`,
    install.cookie,
  );
}

test("the setup link claims a fresh instance for the admin's organization with an environment client", async () => {
  const scene = await fixture(false, true);
  try {
    scene.state.expectedOrganizationId = null;
    await scene.reopen();
    const response = await setupSignIn(scene);
    expect(response.headers.get("location")).toBe("/dashboard/settings/integrations?connecting=1");
    const workspace = (await workspaceForOrganization(scene.db, "org"))!;
    expect((await listWorkspaceMembers(scene.db, workspace.id))[0]?.role).toBe("admin");
    expect(existsSync(join(scene.home, "secrets/linear-browser-client.json"))).toBe(false);
    expect(scene.state.installed).toBe(1);
  } finally {
    await scene.close();
  }
});

test("a fresh instance with an environment client refuses sign-in without the setup link", async () => {
  const scene = await fixture(false, true);
  try {
    scene.state.expectedOrganizationId = null;
    await scene.reopen();
    expect((await scene.request("/setup")).status).toBe(403);
    expect((await scene.request("/auth/linear")).status).toBe(403);
    expect((await scene.request("/auth/linear/callback?code=attacker")).status).toBe(403);
    const start = await scene.request("/");
    expect(start.status).toBe(503);
    expect(await start.text()).toContain("paws setup-link");
    expect(await rows(scene.db, "workspaceOauthRequest")).toEqual([]);
    expect(await rows(scene.db, "workspace")).toEqual([]);
  } finally {
    await scene.close();
  }
});

test("a mismatching configured organization refuses the setup link sign-in", async () => {
  const scene = await fixture(false, true);
  try {
    scene.state.expectedOrganizationId = "another-org";
    await scene.reopen();
    const start = await scene.raw(new Request("https://paws.example/setup?token=setup-token"));
    expect(start.status).toBe(303);
    const install = await scene.installation();
    expect(install.response.headers.get("location")).toBe(
      "/dashboard/?onboarding=workspace-mismatch",
    );
    expect(await rows(scene.db, "workspace")).toEqual([]);
    expect(await readStoredToken(scene.db, join(scene.home, "secrets"))).toBeNull();
    expect(scene.state.installed).toBe(0);
  } finally {
    await scene.close();
  }
});

test("an existing workspace signs in without a configured organization", async () => {
  const scene = await fixture();
  try {
    scene.state.expectedOrganizationId = null;
    await scene.reopen();
    await seed(scene.db, (q) =>
      q.orm.insert(q.t.workspace).values({
        id: "existing",
        linearOrganizationId: "org",
        name: "Workspace",
        createdAt: 0,
      }),
    );
    const install = await scene.installation();
    const response = await scene.request(
      `/auth/linear/install/callback?state=${install.state}&code=app-code`,
      install.cookie,
    );
    expect(response.headers.get("location")).toBe("/dashboard/settings/integrations?connecting=1");
    expect((await workspaceForOrganization(scene.db, "org"))?.id).toBe("existing");
    expect(scene.state.installed).toBe(1);
  } finally {
    await scene.close();
  }
});

test("an unrelated Linear admin cannot claim a fresh instance", async () => {
  const scene = await fixture();
  try {
    scene.state.userOrganization = "foreign-org";
    scene.state.organization = "foreign-org";
    const install = await scene.installation();
    expect(install.response.headers.get("location")).toBe(
      "/dashboard/?onboarding=workspace-mismatch",
    );
    expect(await rows(scene.db, "browserInstallationRequest")).toEqual([]);
    expect(await rows(scene.db, "workspace")).toEqual([]);
    expect(await readStoredToken(scene.db, join(scene.home, "secrets"))).toBeNull();
    expect(install.response.headers.get("set-cookie")).toBeNull();
    expect(scene.state.installed).toBe(0);
  } finally {
    await scene.close();
  }
});

test("installation rechecks the operator organization after a restart", async () => {
  const scene = await fixture();
  try {
    const install = await scene.installation();
    scene.state.expectedOrganizationId = "another-org";
    await scene.reopen();
    const response = await scene.request(
      `/auth/linear/install/callback?state=${install.state}&code=app-code`,
      install.cookie,
    );
    expect(response.headers.get("location")).toBe("/dashboard/?onboarding=workspace-mismatch");
    expect(await readStoredToken(scene.db, join(scene.home, "secrets"))).toBeNull();
    expect(await rows(scene.db, "workspace")).toEqual([]);
    expect(scene.state.exchanges).toBe(1);
    expect(scene.state.installed).toBe(0);
  } finally {
    await scene.close();
  }
});

test("a concurrently bound foreign workspace prevents credential writes", async () => {
  const scene = await fixture();
  try {
    const install = await scene.installation();
    scene.state.prepare = async () => {
      await foreignWorkspace(scene.db);
    };
    const response = await scene.request(
      `/auth/linear/install/callback?state=${install.state}&code=app-code`,
      install.cookie,
    );
    expect(response.headers.get("location")).toBe("/dashboard/?onboarding=workspace-mismatch");
    expect(await readStoredToken(scene.db, join(scene.home, "secrets"))).toBeNull();
    expect(existsSync(join(scene.home, "secrets/linear-client.json"))).toBe(false);
    expect(await workspaceForOrganization(scene.db, "org")).toBeNull();
    expect(scene.state.installed).toBe(0);
  } finally {
    await scene.close();
  }
});

test("configured organization cannot override a persisted workspace", async () => {
  const scene = await fixture();
  try {
    await foreignWorkspace(scene.db);
    const response = await scene.request("/auth/linear");
    expect(response.status).toBe(503);
    expect(await rows(scene.db, "workspaceOauthRequest")).toEqual([]);
    expect(scene.state.exchanges).toBe(0);
  } finally {
    await scene.close();
  }
});

for (const property of ["admin", "active", "guest"] as const) {
  test(`initial ${property} authorization is checked before app installation`, async () => {
    const scene = await fixture();
    try {
      scene.state[property] = property === "guest";
      const install = await scene.installation();
      expect(install.response.headers.get("location")).toBe(
        "/dashboard/?onboarding=admin-required",
      );
      expect(scene.state.installed).toBe(0);
    } finally {
      await scene.close();
    }
  });
}

for (const failure of [
  "workspace",
  "revoked-admin",
  "user-token",
  "cookie",
  "expired",
  "cancelled",
] as const) {
  test(`installation rejects ${failure} without storing credentials or an owner`, async () => {
    const scene = await fixture();
    try {
      const install = await scene.installation();
      if (failure === "workspace") scene.state.organization = "other-org";
      if (failure === "revoked-admin") scene.state.memberAdmin = false;
      if (failure === "user-token") scene.state.app = false;
      if (failure === "expired") scene.state.now += 600_001;
      const suffix = failure === "cancelled" ? "error=access_denied" : "code=app-code";
      const response = await scene.request(
        `/auth/linear/install/callback?state=${install.state}&${suffix}`,
        failure === "cookie" ? "" : install.cookie,
      );
      expect(response.headers.get("location")).toContain("/dashboard/?onboarding=");
      expect(await readStoredToken(scene.db, join(scene.home, "secrets"))).toBeNull();
      expect(await workspaceForOrganization(scene.db, "org")).toBeNull();
      expect(scene.state.installed).toBe(0);
    } finally {
      await scene.close();
    }
  });
}

for (const concurrentRevocation of [false, true]) {
  test(`browser reconnection preserves workspace ownership and fences concurrent revocation: ${concurrentRevocation}`, async () => {
    const scene = await fixture();
    try {
      const initial = await scene.installation();
      await scene.request(
        `/auth/linear/install/callback?state=${initial.state}&code=app-code`,
        initial.cookie,
      );
      const workspace = (await workspaceForOrganization(scene.db, "org"))!;
      const scope = { organizationId: "org", oauthClientId: "fixture-client", appUserId: "app" };
      await recordLinearInstallation(scene.db, {
        ...scope,
        sessionId: "session",
        teamId: "team",
        observedAtMs: scene.state.now,
      });
      await revokeLinearInstallation(scene.db, {
        ...scope,
        eventKey: "first",
        createdAtMs: scene.state.now,
      });
      scene.state.now++;
      scene.state.reconnect = true;
      scene.state.expectedOrganizationId = null;
      scene.state.appToken = "fixture-reconnected-app";
      await scene.reopen();
      const next = await scene.installation();
      await scene.reopen();
      if (concurrentRevocation)
        await revokeLinearInstallation(scene.db, {
          ...scope,
          eventKey: "second",
          createdAtMs: scene.state.now + 1,
        });
      const response = await scene.request(
        `/auth/linear/install/callback?state=${next.state}&code=app-code`,
        next.cookie,
      );
      expect(response.headers.get("location")).toBe(
        concurrentRevocation
          ? "/dashboard/?onboarding=failed"
          : "/dashboard/settings/integrations?connecting=1",
      );
      expect(await getLinearSessionAccess(scene.db, "session")).toBe(
        concurrentRevocation ? "revoked" : "allowed",
      );
      expect((await readStoredToken(scene.db, join(scene.home, "secrets")))?.accessToken).toBe(
        concurrentRevocation ? "fixture-app" : "fixture-reconnected-app",
      );
      expect((await workspaceForOrganization(scene.db, "org"))?.id).toBe(workspace.id);
      expect(
        (await listWorkspaceMembers(scene.db, workspace.id)).filter(
          (member) => member.role === "admin",
        ),
      ).toHaveLength(1);
    } finally {
      await scene.close();
    }
  });
}

for (const admin of [false, true]) {
  test(`an already installed app only lets a Linear admin create its first owner without a code: ${admin}`, async () => {
    const scene = await fixture();
    try {
      const access = createWorkspaceAccess({
        store: scene.db,
        publicUrl: "https://paws.example",
        clientId: "fixture-client",
        installedOrganization: { id: "org", name: "Workspace" },
        fetch: scene.fetch,
        memberships: {
          installation: async () => ({ id: "org", name: "Workspace" }),
          member: async () => ({
            userId: "admin",
            organizationId: "org",
            active: true,
            guest: false,
            admin,
            teamIds: ["team"],
          }),
        },
      });
      const login = await scene.user();
      const response = await access.handle(
        new Request(
          `https://paws.example/auth/linear/callback?state=${login.state}&code=user-code`,
          { headers: { cookie: login.cookie } },
        ),
      );
      expect(response?.status).toBe(admin ? 303 : 403);
      const workspace = await workspaceForOrganization(scene.db, "org");
      if (admin)
        expect((await listWorkspaceMembers(scene.db, workspace!.id))[0]?.role).toBe("admin");
      else expect(workspace).toBeNull();
      await access.stop();
    } finally {
      await scene.close();
    }
  });
}

import { useDatabaseSecrets, readSecretFile, saveSecret } from "../src/credentials";

test("token protects setup and stores the client at the default path", async () => {
  const scene = await fixture(true);
  try {
    scene.state.expectedOrganizationId = null;
    await writeStoredToken(scene.db, join(scene.home, "secrets"), {
      actor: "app",
      scope: null,
      accessToken: "old-token",
      refreshToken: "old-refresh",
      expiresAtMs: Date.now() + 600000,
    });
    expect((await scene.request("/setup")).status).toBe(403);
    expect((await scene.request("/setup?token=wrong")).status).toBe(403);
    expect((await scene.request("/api/issues")).status).toBe(503);
    const start = await scene.request("/");
    expect(start.status).toBe(503);
    const page = await start.text();
    expect(page).toContain("paws setup-link");
    expect(page).not.toContain("setup-token");
    expect((await scene.request("/setup?token=setup-token")).status).toBe(200);
    const response = await scene.raw(
      new Request("https://paws.example/setup?token=setup-token", {
        method: "POST",
        headers: { origin: "https://paws.example" },
        body: new URLSearchParams({
          clientId: "fixture-client",
          clientSecret: "fixture-client-secret",
          webhookSecret: "signing-secret",
        }),
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("client_id=fixture-client");
    const dir = join(scene.home, "secrets");
    expect(
      JSON.parse(readSecretFile(join(scene.home, "secrets/linear-browser-client.json"))!),
    ).toMatchObject({ clientId: "fixture-client", clientSecret: "fixture-client-secret" });
    expect(readSecretFile(join(dir, "linear-webhook"))).toBe("signing-secret");
    expect(existsSync(join(dir, "linear-webhook"))).toBe(false);
    const stored = await scene.db.run((q) => q.all(q.orm.select().from(q.t.secret)));
    expect(JSON.stringify(stored)).not.toContain("signing-secret");
    expect(JSON.stringify(stored)).not.toContain("fixture-client-secret");
    expect((await scene.request("/auth/linear")).status).toBe(403);
    expect((await scene.request("/auth/linear/callback?code=attacker")).status).toBe(403);
    expect((await scene.request("/auth/linear/install/callback?code=attacker")).status).toBe(403);
    await saveSecret(join(dir, "setup-token"), "setup-token");
    const install = await scene.installation();
    const connected = await scene.request(
      `/auth/linear/install/callback?state=${install.state}&code=app-code`,
      install.cookie,
    );
    expect(connected.headers.get("location")).toBe("/dashboard/settings/integrations?connecting=1");
    expect(scene.state.installed).toBe(1);
    expect(readSecretFile(join(dir, "linear-setup-pending"))).toBeNull();
    expect(readSecretFile(join(dir, "setup-token"))).toBeNull();
    expect(existsSync(join(dir, "setup-token"))).toBe(false);
    expect((await scene.request("/setup?token=setup-token")).status).toBe(403);
  } finally {
    await scene.close();
  }
});
import { setJournalSink } from "../src/journal";

test("a process without a Linear client starts in token-protected setup mode", async () => {
  const messages: string[] = [];
  const restore = setJournalSink((message) => messages.push(message));
  try {
    const paws = await freshInstance(undefined, true, "existing-token");
    await paws.ready;
    const setupUrl = messages.find((message) => message.includes("/setup?token="))!;
    expect(setupUrl).toStartWith("https://localhost:8787/setup?token=");
    expect((await paws.server.fetch(new Request(setupUrl))).status).toBe(200);
    expect((await paws.server.fetch(new Request("https://localhost:8787/setup"))).status).toBe(403);
    expect(
      (await paws.server.fetch(new Request("https://localhost:8787/setup?token=wrong"))).status,
    ).toBe(403);
    expect((await paws.server.fetch(new Request("https://localhost:8787/health"))).status).toBe(
      200,
    );

    await paws.server.fetch(
      new Request(setupUrl, {
        method: "POST",
        headers: { origin: "https://localhost:8787" },
        body: new URLSearchParams({
          clientId: "saved-client",
          clientSecret: "saved-secret",
          webhookSecret: "saved-webhook",
        }),
      }),
    );
    await paws.stop();
    processes.splice(processes.indexOf(paws), 1);
    const restarted = await startPaws({
      LINEAR_ACCESS_TOKEN: "existing-token",
      PAWS_HOME: paws.paths.home,
      PAWS_HOST: "127.0.0.1",
      PAWS_PORT: "0",
      PAWS_PUBLIC_DASHBOARD: "1",
      PAWS_PUBLIC_URL: "https://localhost:8787",
      PAWS_TLS_KEY_PATH: join(paws.paths.home, "server.key"),
      PAWS_TLS_CERT_PATH: join(paws.paths.home, "server.crt"),
    });
    processes.push(restarted);
    const resumedUrl = messages.filter((message) => message.includes("/setup?token=")).at(-1)!;
    expect(resumedUrl).toBe(setupUrl);
    expect((await restarted.server.fetch(new Request(setupUrl))).status).toBe(200);
    expect((await restarted.server.fetch(new Request("https://localhost:8787/setup"))).status).toBe(
      403,
    );
    expect(
      (await restarted.server.fetch(new Request("https://localhost:8787/auth/linear"))).status,
    ).toBe(403);
    await restarted.stop();
    processes.splice(processes.indexOf(restarted), 1);
    const printed: string[] = [];
    expect(
      await setupLinkMain(
        [],
        { PAWS_HOME: paws.paths.home, PAWS_PUBLIC_URL: "https://localhost:8787" },
        (text) => printed.push(text),
      ),
    ).toBe(0);
    expect(printed).toEqual([setupUrl]);
  } finally {
    restore();
  }
});

test("paws setup-link reports a finished setup", async () => {
  const home = mkdtempSync(join(tmpdir(), "paws-setup-link-"));
  roots.push(home);
  const printed: string[] = [];
  expect(await setupLinkMain([], { PAWS_HOME: home }, (text) => printed.push(text))).toBe(0);
  expect(printed).toEqual(["Setup is complete."]);
});

test("setup rejects oversized and stalled bodies and releases its save lock", async () => {
  const scene = await fixture(true);
  const post = (body: NonNullable<RequestInit["body"]>, headers: Record<string, string> = {}) =>
    scene.raw(
      new Request("https://paws.example/setup?token=setup-token", {
        method: "POST",
        headers: { origin: "https://paws.example", ...headers },
        body,
      }),
    );
  try {
    expect((await post("x", { "content-length": "16385" })).status).toBe(413);
    expect(
      (
        await post(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(16385));
              controller.close();
            },
          }),
        )
      ).status,
    ).toBe(413);
    expect((await post(new ReadableStream({ start() {} }))).status).toBe(408);
    expect((await post("")).status).toBe(400);
  } finally {
    await scene.close();
  }
});

test("an existing Linear access token still enters setup when the client is missing", async () => {
  const messages: string[] = [];
  const restore = setJournalSink((message) => messages.push(message));
  try {
    const paws = await freshInstance(undefined, true, "existing-token");
    const url = messages.find((message) => message.includes("/setup?token="))!;
    expect((await paws.server.fetch(new Request(url))).status).toBe(200);
  } finally {
    restore();
  }
});

test("browser credentials survive runtime reloads and webhook precedence is env then database then file", async () => {
  const scene = await fixture(true);
  try {
    const dir = join(scene.home, "secrets");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "linear-webhook"), "legacy-webhook");
    await saveSecret(
      join(dir, "linear-browser-client.json"),
      JSON.stringify({
        webhookFileDigest: webhookFileDigest(dir),
        clientId: "browser-id",
        clientSecret: "browser-secret",
      }),
    );
    await saveSecret(join(dir, "linear-webhook"), "browser-webhook");
    for (const source of [
      { PAWS_HOME: scene.home },
      {
        PAWS_HOME: scene.home,
        LINEAR_WEBHOOK_SECRET: "env-webhook",
        LINEAR_CLIENT_ID: "env-id",
        LINEAR_CLIENT_SECRET: "env-secret",
      },
    ]) {
      for (let reload = 0; reload < 2; reload++) {
        const loaded = loadRuntime(source);
        loaded.linearClientSecret = source.LINEAR_CLIENT_SECRET ?? "unrelated-legacy-secret";
        loaded.env.linearWebhookSecret = source.LINEAR_WEBHOOK_SECRET ?? "legacy-webhook";
        const { runtime } = await browserSetupRuntime(scene.db, loaded, source);
        expect(runtime.linearClientId).toBe(source.LINEAR_CLIENT_ID ?? "browser-id");
        expect(runtime.linearClientSecret).toBe(source.LINEAR_CLIENT_SECRET ?? "browser-secret");
        expect(runtime.env.linearWebhookSecret).toBe(
          source.LINEAR_WEBHOOK_SECRET ?? "browser-webhook",
        );
      }
    }
    writeFileSync(join(dir, "linear-webhook"), "rotated-webhook");
    const loaded = loadRuntime({ PAWS_HOME: scene.home });
    loaded.env.linearWebhookSecret = "rotated-webhook";
    expect((await browserSetupRuntime(scene.db, loaded)).runtime.env.linearWebhookSecret).toBe(
      "rotated-webhook",
    );
    writeFileSync(join(dir, "linear-webhook"), "legacy-webhook");
    loaded.env.linearWebhookSecret = "legacy-webhook";
    expect((await browserSetupRuntime(scene.db, loaded)).runtime.env.linearWebhookSecret).toBe(
      "legacy-webhook",
    );
    expect(
      (await browserSetupRuntime(scene.db, loaded, { LINEAR_WEBHOOK_SECRET: "override" })).runtime
        .env.linearWebhookSecret,
    ).toBe("override");
  } finally {
    await scene.close();
  }
});
