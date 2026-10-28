import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPaws, type PawsProcess } from "../src/index";

const roots: string[] = [];
const processes: PawsProcess[] = [];

afterEach(async () => {
  for (const process of processes.splice(0)) await process.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshInstance(expectedOrganizationId?: string) {
  const home = mkdtempSync(join(tmpdir(), "paws-browser-onboarding-"));
  roots.push(home);
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
  const paws = startPaws({
    PAWS_HOME: home,
    PAWS_HOST: "127.0.0.1",
    PAWS_PORT: "0",
    PAWS_PUBLIC_DASHBOARD: "1",
    PAWS_PUBLIC_URL: "https://localhost:8787",
    PAWS_TLS_KEY_PATH: key,
    PAWS_TLS_CERT_PATH: cert,
    LINEAR_CLIENT_ID: "fixture-client",
    LINEAR_CLIENT_SECRET: "fixture-client-secret",
    LINEAR_ORGANIZATION_ID: expectedOrganizationId,
  });
  processes.push(paws);
  return paws;
}

test("a fresh HTTPS instance serves browser onboarding for its configured organization", async () => {
  const paws = freshInstance("org");
  await paws.ready;
  const response = await paws.server.fetch(new Request("https://localhost:8787/api/auth/session"));
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ onboarding: true });
  const blocked = await paws.server.fetch(new Request("https://localhost:8787/api/status"));
  expect(blocked.status).toBe(401);
  const login = await paws.server.fetch(new Request("https://localhost:8787/auth/linear"));
  expect(login.status).toBe(303);
});

test("a fresh HTTPS instance refuses sign-in until its organization is configured", async () => {
  const paws = freshInstance();
  await paws.ready;
  const login = await paws.server.fetch(new Request("https://localhost:8787/auth/linear"));
  expect(login.status).toBe(503);
  expect(await login.text()).toContain("LINEAR_ORGANIZATION_ID");
  expect(paws.db.query("SELECT 1 FROM workspace_oauth_request").get()).toBeNull();
  expect(paws.db.query("SELECT 1 FROM workspace").get()).toBeNull();
});

import { existsSync, readFileSync } from "node:fs";
import { createBrowserOnboarding } from "../src/onboarding";
import {
  migrate,
  openDatabase,
  workspaceForOrganization,
  listWorkspaceMembers,
  recordLinearInstallation,
  revokeLinearInstallation,
  getLinearSessionAccess,
} from "../src/db";
import { readStoredToken } from "../src/linear";
import { createWorkspaceAccess } from "../src/workspace";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "paws-browser-install-"));
  roots.push(home);
  let db = openDatabase(join(home, "paws.db"));
  migrate(db);
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
      clientId: "fixture-client",
      clientSecret: "fixture-client-secret",
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
  return {
    home,
    state,
    fetch: fakeFetch,
    get db() {
      return db;
    },
    request: (path: string, cookie = "") =>
      handle(new Request(origin + path, { headers: { cookie } })),
    async user() {
      const response = await handle(new Request(origin + "/auth/linear"));
      const url = new URL(response.headers.get("location")!);
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
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
        cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
        response,
        url,
      };
    },
    reopen() {
      db.close();
      db = openDatabase(join(home, "paws.db"));
      handle = handler();
    },
    close() {
      db.close();
    },
  };
}

test("browser sign-in creates an owner only in the operator's configured organization", async () => {
  const scene = fixture();
  try {
    const install = await scene.installation();
    expect(install.url.searchParams.get("actor")).toBe("app");
    expect(install.url.searchParams.get("redirect_uri")).toBe(
      "https://paws.example/auth/linear/install/callback",
    );
    scene.reopen();
    const response = await scene.request(
      `/auth/linear/install/callback?state=${install.state}&code=app-code`,
      install.cookie,
    );
    expect(response.headers.get("location")).toBe("/status/settings/integrations?connecting=1");
    expect(response.headers.get("set-cookie")).toContain("__Host-paws-session=");
    expect(scene.state.installed).toBe(1);
    const workspace = workspaceForOrganization(scene.db, "org")!;
    expect(listWorkspaceMembers(scene.db, workspace.id)[0]?.role).toBe("admin");
    expect(readStoredToken(join(scene.home, "secrets/linear-oauth.json"))?.accessToken).toBe(
      "fixture-app",
    );
    expect(readFileSync(join(scene.home, "secrets/linear-oauth.json"), "utf8")).not.toContain(
      "fixture-app",
    );
    const again = await scene.request(
      `/auth/linear/install/callback?state=${install.state}&code=app-code`,
      install.cookie,
    );
    expect(again.headers.get("location")).toContain("already-connected");
    expect(scene.state.exchanges).toBe(2);
  } finally {
    scene.close();
  }
});

test("fresh installation requires an operator-configured Linear organization", async () => {
  const scene = fixture();
  try {
    scene.state.expectedOrganizationId = null;
    scene.reopen();
    const response = await scene.request("/auth/linear");
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("LINEAR_ORGANIZATION_ID");
    expect(scene.db.query("SELECT 1 FROM workspace_oauth_request").get()).toBeNull();
    expect(scene.db.query("SELECT 1 FROM workspace").get()).toBeNull();
    expect(scene.state.exchanges).toBe(0);
  } finally {
    scene.close();
  }
});

test("an unrelated Linear admin cannot claim a fresh instance", async () => {
  const scene = fixture();
  try {
    scene.state.userOrganization = "foreign-org";
    scene.state.organization = "foreign-org";
    const install = await scene.installation();
    expect(install.response.headers.get("location")).toBe("/status/?onboarding=workspace-mismatch");
    expect(scene.db.query("SELECT 1 FROM browser_installation_request").get()).toBeNull();
    expect(scene.db.query("SELECT 1 FROM workspace").get()).toBeNull();
    expect(existsSync(join(scene.home, "secrets/linear-oauth.json"))).toBe(false);
    expect(install.response.headers.get("set-cookie")).toBeNull();
    expect(scene.state.installed).toBe(0);
  } finally {
    scene.close();
  }
});

test("installation rechecks the operator organization after a restart", async () => {
  const scene = fixture();
  try {
    const install = await scene.installation();
    scene.state.expectedOrganizationId = "another-org";
    scene.reopen();
    const response = await scene.request(
      `/auth/linear/install/callback?state=${install.state}&code=app-code`,
      install.cookie,
    );
    expect(response.headers.get("location")).toBe("/status/?onboarding=workspace-mismatch");
    expect(existsSync(join(scene.home, "secrets/linear-oauth.json"))).toBe(false);
    expect(scene.db.query("SELECT 1 FROM workspace").get()).toBeNull();
    expect(scene.state.exchanges).toBe(1);
    expect(scene.state.installed).toBe(0);
  } finally {
    scene.close();
  }
});

test("a concurrently bound foreign workspace prevents credential writes", async () => {
  const scene = fixture();
  try {
    const install = await scene.installation();
    scene.state.prepare = async () => {
      scene.db.run(
        "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('foreign','foreign-org','Foreign',0)",
      );
    };
    const response = await scene.request(
      `/auth/linear/install/callback?state=${install.state}&code=app-code`,
      install.cookie,
    );
    expect(response.headers.get("location")).toBe("/status/?onboarding=workspace-mismatch");
    expect(existsSync(join(scene.home, "secrets/linear-oauth.json"))).toBe(false);
    expect(existsSync(join(scene.home, "secrets/linear-client.json"))).toBe(false);
    expect(workspaceForOrganization(scene.db, "org")).toBeNull();
    expect(scene.state.installed).toBe(0);
  } finally {
    scene.close();
  }
});

test("configured organization cannot override a persisted workspace", async () => {
  const scene = fixture();
  try {
    scene.db.run(
      "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('foreign','foreign-org','Foreign',0)",
    );
    const response = await scene.request("/auth/linear");
    expect(response.status).toBe(503);
    expect(scene.db.query("SELECT 1 FROM workspace_oauth_request").get()).toBeNull();
    expect(scene.state.exchanges).toBe(0);
  } finally {
    scene.close();
  }
});

for (const property of ["admin", "active", "guest"] as const) {
  test(`initial ${property} authorization is checked before app installation`, async () => {
    const scene = fixture();
    try {
      scene.state[property] = property === "guest";
      const install = await scene.installation();
      expect(install.response.headers.get("location")).toBe("/status/?onboarding=admin-required");
      expect(scene.state.installed).toBe(0);
    } finally {
      scene.close();
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
    const scene = fixture();
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
      expect(response.headers.get("location")).toContain("/status/?onboarding=");
      expect(existsSync(join(scene.home, "secrets/linear-oauth.json"))).toBe(false);
      expect(workspaceForOrganization(scene.db, "org")).toBeNull();
      expect(scene.state.installed).toBe(0);
    } finally {
      scene.close();
    }
  });
}

for (const concurrentRevocation of [false, true]) {
  test(`browser reconnection preserves workspace ownership and fences concurrent revocation: ${concurrentRevocation}`, async () => {
    const scene = fixture();
    try {
      const initial = await scene.installation();
      await scene.request(
        `/auth/linear/install/callback?state=${initial.state}&code=app-code`,
        initial.cookie,
      );
      const workspace = workspaceForOrganization(scene.db, "org")!;
      const scope = { organizationId: "org", oauthClientId: "fixture-client", appUserId: "app" };
      recordLinearInstallation(scene.db, {
        ...scope,
        sessionId: "session",
        teamId: "team",
        observedAtMs: scene.state.now,
      });
      revokeLinearInstallation(scene.db, {
        ...scope,
        eventKey: "first",
        createdAtMs: scene.state.now,
      });
      scene.state.now++;
      scene.state.reconnect = true;
      scene.state.expectedOrganizationId = null;
      scene.state.appToken = "fixture-reconnected-app";
      scene.reopen();
      const next = await scene.installation();
      scene.reopen();
      if (concurrentRevocation)
        revokeLinearInstallation(scene.db, {
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
          ? "/status/?onboarding=failed"
          : "/status/settings/integrations?connecting=1",
      );
      expect(getLinearSessionAccess(scene.db, "session")).toBe(
        concurrentRevocation ? "revoked" : "allowed",
      );
      expect(readStoredToken(join(scene.home, "secrets/linear-oauth.json"))?.accessToken).toBe(
        concurrentRevocation ? "fixture-app" : "fixture-reconnected-app",
      );
      expect(workspaceForOrganization(scene.db, "org")?.id).toBe(workspace.id);
      expect(
        listWorkspaceMembers(scene.db, workspace.id).filter((member) => member.role === "admin"),
      ).toHaveLength(1);
    } finally {
      scene.close();
    }
  });
}

for (const admin of [false, true]) {
  test(`an already installed app only lets a Linear admin create its first owner without a code: ${admin}`, async () => {
    const scene = fixture();
    try {
      const access = createWorkspaceAccess({
        db: scene.db,
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
      const workspace = workspaceForOrganization(scene.db, "org");
      if (admin) expect(listWorkspaceMembers(scene.db, workspace!.id)[0]?.role).toBe("admin");
      else expect(workspace).toBeNull();
      await access.stop();
    } finally {
      scene.close();
    }
  });
}
