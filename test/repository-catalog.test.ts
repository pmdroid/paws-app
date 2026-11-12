import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { createWorkspaceGitHubActivation } from "../src/auth";
import {
  ensureLinearSession,
  recordLinearInstallation,
  listRepositoryCandidates,
  listRepositoryCatalog,
  refreshRepositoryCatalog,
} from "../src/db";
import {
  listAppRepositories,
  listUserRepositories,
  type CatalogRepository,
  type GitHubClient,
} from "../src/github";
import { tempHome } from "./helpers";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();
const NOW = new Date("2026-10-16T12:00:00Z");

function repo(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    full_name: `pmdroid/${name}`,
    owner: { login: "pmdroid" },
    clone_url: `https://github.com/pmdroid/${name}.git`,
    default_branch: "main",
    archived: false,
    permissions: { push: true },
    ...extra,
  };
}

function fakeClient(
  handler: (input: { method: string; path: string; token: string; body?: unknown }) => {
    status: number;
    body: unknown;
  },
): GitHubClient & { calls: { method: string; path: string; token: string; body?: unknown }[] } {
  const calls: { method: string; path: string; token: string; body?: unknown }[] = [];
  return {
    calls,
    async request(input) {
      calls.push(input);
      return handler(input);
    },
  };
}

function listToken(permissions: Record<string, string> = { metadata: "read" }) {
  return {
    status: 201,
    body: {
      token: "list-token",
      expires_at: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
      repository_selection: "all",
      permissions,
    },
  };
}

test("an app installation lists every unarchived repository across pages", async () => {
  const first = Array.from({ length: 100 }, (_, index) => repo(`repo-${index}`));
  const client = fakeClient(({ method, path }) => {
    if (method === "POST") return listToken();
    if (path.endsWith("page=1"))
      return {
        status: 200,
        body: { repositories: [...first.slice(0, 99), repo("old", { archived: true })] },
      };
    return {
      status: 200,
      body: { repositories: [repo("paws-app", { permissions: { push: false, pull: false } })] },
    };
  });
  const listed = await listAppRepositories({
    client,
    appId: "1",
    installationId: "2",
    privateKeyPem: PEM,
    now: NOW,
  });
  expect(client.calls[0]).toMatchObject({
    method: "POST",
    path: "/app/installations/2/access_tokens",
    body: { permissions: { metadata: "read" } },
  });
  expect(client.calls.slice(1).map((call) => [call.path, call.token])).toEqual([
    ["/installation/repositories?per_page=100&page=1", "list-token"],
    ["/installation/repositories?per_page=100&page=2", "list-token"],
  ]);
  expect(listed).toHaveLength(100);
  expect(listed.at(-1)).toEqual({
    owner: "pmdroid",
    repo: "paws-app",
    remoteUrl: "https://github.com/pmdroid/paws-app.git",
    defaultBranch: "main",
  });
  expect(listed.some((entry) => entry.repo === "old")).toBe(false);
});

test("a list token with more than metadata read is refused", async () => {
  const client = fakeClient(({ method }) =>
    method === "POST"
      ? listToken({ metadata: "read", contents: "write" })
      : { status: 200, body: { repositories: [] } },
  );
  await expect(
    listAppRepositories({ client, appId: "1", installationId: "2", privateKeyPem: PEM, now: NOW }),
  ).rejects.toThrow("repository list token grants unexpected permissions");
  expect(client.calls).toHaveLength(1);
});

test("a signed-in user lists only repositories they can push to", async () => {
  const client = fakeClient(() => ({
    status: 200,
    body: [
      repo("paws-app"),
      repo("read-only", { permissions: { push: false } }),
      repo("archived", { archived: true }),
    ],
  }));
  const listed = await listUserRepositories({ client, token: "user-token" });
  expect(client.calls.map((call) => [call.path, call.token])).toEqual([
    [
      "/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&page=1",
      "user-token",
    ],
  ]);
  expect(listed.map((entry) => `${entry.owner}/${entry.repo}`)).toEqual(["pmdroid/paws-app"]);
});

test("the catalog is replaced on refresh and kept when a refresh fails", async () => {
  const { db, close } = await tempStore();
  try {
    const paws: CatalogRepository = {
      owner: "pmdroid",
      repo: "paws-app",
      remoteUrl: "https://github.com/pmdroid/paws-app.git",
      defaultBranch: "main",
    };
    expect(await refreshRepositoryCatalog(db, async () => [paws], 1)).toBe(true);
    expect(await listRepositoryCatalog(db)).toEqual([paws]);
    expect(
      await refreshRepositoryCatalog(
        db,
        async () => {
          throw new Error("GitHub is down");
        },
        2,
      ),
    ).toBe(false);
    expect(await listRepositoryCatalog(db)).toEqual([paws]);
    expect(await refreshRepositoryCatalog(db, async () => [], 3)).toBe(true);
    expect(await listRepositoryCatalog(db)).toEqual([]);
  } finally {
    await close();
  }
});

test("app installations come from the workspace GitHub connections", async () => {
  const { db, close } = await tempStore();
  const home = tempHome();
  try {
    mkdirSync(join(home, "secrets"), { recursive: true, mode: 0o700 });
    const activation = createWorkspaceGitHubActivation(db, home, {});
    await seed(db, (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "ws", linearOrganizationId: "org", name: "Workspace", createdAt: 0 }),
    );
    expect(await activation.installations()).toEqual([]);
    activation.save("secret-1", {
      appId: "1",
      clientId: "client",
      clientSecret: "client-secret",
      privateKeyPem: PEM,
      installationId: "42",
      generation: 0,
    });
    await seed(db, (q) =>
      q.orm.insert(q.t.workspaceGithubConnection).values({
        workspaceId: "ws",
        generation: 3,
        secretId: "secret-1",
        installationId: "42",
      }),
    );
    expect(await activation.installations()).toEqual([
      expect.objectContaining({ appId: "1", installationId: "42", generation: 3 }),
    ]);
  } finally {
    await close();
  }
});

test("fresh workspace repository choices are available before catalog refresh and follow current team mappings", async () => {
  const { db, close } = await tempStore();
  try {
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.workspace).values([
          { id: "ws", linearOrganizationId: "org", name: "Workspace", createdAt: 0 },
          { id: "other", linearOrganizationId: "other-org", name: "Other workspace", createdAt: 0 },
        ]),
      (q) =>
        q.orm.insert(q.t.workspaceRepository).values([
          { workspaceId: "ws", repository: "Acme/One", teamId: "team" },
          { workspaceId: "ws", repository: "acme/two", teamId: "team" },
          { workspaceId: "ws", repository: "acme/other-team", teamId: "another-team" },
          { workspaceId: "other", repository: "acme/other-workspace", teamId: "team" },
        ]),
    );
    await ensureLinearSession(db, { sessionId: "session", issueId: "issue" });
    await recordLinearInstallation(db, {
      sessionId: "session",
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      teamId: "team",
      observedAtMs: 1,
    });
    const one = { owner: "acme", repo: "one", remoteUrl: "https://github.com/acme/one.git" };
    const two = { owner: "acme", repo: "two", remoteUrl: "https://github.com/acme/two.git" };
    expect(await listRepositoryCatalog(db)).toEqual([]);
    expect(await listRepositoryCandidates(db, "session", [])).toEqual([one, two]);
    expect(await listRepositoryCandidates(db, "unrelated-session", [])).toEqual([]);
    expect(await listRepositoryCandidates(db, null, [])).toEqual([]);
    await refreshRepositoryCatalog(db, async () => [
      { ...one, defaultBranch: "main" },
      {
        owner: "acme",
        repo: "other-team",
        remoteUrl: "https://github.com/acme/other-team.git",
        defaultBranch: "main",
      },
    ]);
    expect(await listRepositoryCandidates(db, "session", [])).toEqual([one, two]);
    await seed(db, (q) =>
      q.orm
        .delete(q.t.workspaceRepository)
        .where(
          and(
            eq(q.t.workspaceRepository.workspaceId, "ws"),
            eq(sql`lower(${q.t.workspaceRepository.repository})`, "acme/one"),
          ),
        ),
    );
    expect(await listRepositoryCandidates(db, "session", [one])).toEqual([two]);
  } finally {
    await close();
  }
});

test("repository candidates preserve configured clone URLs and deduplicate catalog entries", async () => {
  const { db, close } = await tempStore();
  try {
    const configured = { owner: "Acme", repo: "One", remoteUrl: "/synthetic-paws-remotes/one.git" };
    await refreshRepositoryCatalog(db, async () => [
      {
        owner: "acme",
        repo: "one",
        remoteUrl: "https://github.com/acme/one.git",
        defaultBranch: "main",
      },
      {
        owner: "acme",
        repo: "two",
        remoteUrl: "https://github.com/acme/two.git",
        defaultBranch: "main",
      },
    ]);
    expect(await listRepositoryCandidates(db, null, [configured, configured])).toEqual([
      configured,
      { owner: "acme", repo: "two", remoteUrl: "https://github.com/acme/two.git" },
    ]);
  } finally {
    await close();
  }
});
