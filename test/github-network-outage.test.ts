import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubInstallationCheck } from "../src/auth";
import {
  sqliteDb,
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listOutbox,
  migrate,
  openDatabase,
  syncSteps,
} from "../src/db";
import { GitHubInstallationCheck, type GitHubIntegration } from "../src/loop";

const key = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const DNS = "getaddrinfo ENOTFOUND api.github.com";

async function scene() {
  const home = mkdtempSync(join(tmpdir(), "paws-github-outage-"));
  roots.push(home);
  const privateKeyPath = join(home, "app.pem");
  writeFileSync(privateKeyPath, key, { mode: 0o600 });
  const github = { mode: "ok" as "ok" | "dns" | "missing" | "5xx" | "429" | "refused", calls: 0 };
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    github.calls += 1;
    const path = new URL(input).pathname;
    if (github.mode === "dns") throw new TypeError(DNS);
    if (github.mode === "5xx") return new Response("bad gateway", { status: 502 });
    if (github.mode === "429") return Response.json({ message: "slow down" }, { status: 429 });
    if (path === "/app") return Response.json({ id: 99, client_id: "Iv1.acme" });
    if (path === "/repos/acme/widgets/installation")
      return github.mode === "missing"
        ? Response.json({ message: "Not Found" }, { status: 404 })
        : Response.json({ id: 22 });
    if (path === "/app/installations/22/access_tokens") {
      if (github.mode === "refused") return Response.json({ message: "nope" }, { status: 403 });
      const permissions = JSON.parse(String(init?.body)).permissions;
      return Response.json(
        {
          token: "fake-installation-token",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          repository_selection: "selected",
          repositories: [{ name: "widgets", full_name: "acme/widgets" }],
          permissions,
        },
        { status: 201 },
      );
    }
    throw new Error(`Unexpected fake GitHub request ${input}`);
  };
  const installation = createGitHubInstallationCheck({
    home,
    env: {
      PAWS_HOME: home,
      GITHUB_APP_ID: "99",
      GITHUB_APP_INSTALLATION_ID: "22",
      PAWS_GITHUB_CLIENT_ID: "Iv1.acme",
      PAWS_GITHUB_CLIENT_SECRET: "fake-secret",
      GITHUB_APP_PRIVATE_KEY_PATH: privateKeyPath,
    },
    fetch,
  });
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = { now: 1_000 };
  const integration: GitHubIntegration = {
    check: (_item, signal) => installation("acme/widgets", "read", signal),
    administrators: () => syncSteps(() => ["admin"]),
    recoveryUrl: "https://paws.example/settings/integrations",
    identity: () => syncSteps(() => "member:acme/widgets"),
    unavailableRetryMs: [0],
  };
  const auth = new GitHubInstallationCheck(sqliteDb(db), integration, () => clock.now);
  insertQueuedItem(db, { id: "PAS-1055", sessionKey: "session-1055", title: "PAS-1055" });
  await beginImplementRun(sqliteDb(db), "PAS-1055", 1_000);
  return {
    db,
    auth,
    github,
    clock,
    integration,
    installation,
    item: async () => (await getWorkItem(sqliteDb(db), "PAS-1055"))!,
    signal: new AbortController().signal,
    questions: () => db.query<{ status: string }, []>("SELECT status FROM question").all(),
    elicitations: async () =>
      (await listOutbox(sqliteDb(db))).filter((entry) => entry.op === "elicitation"),
    close() {
      auth.close();
      db.close();
    },
  };
}

test("a DNS failure posts no github-auth question, and the item proceeds once GitHub answers", async () => {
  const s = await scene();
  s.github.mode = "dns";
  let failed = 0;
  const check = s.integration.check;
  s.integration.check = async (item, signal) => {
    if (failed++ === 3) s.github.mode = "ok";
    return check(item, signal);
  };
  try {
    expect(await s.auth.ensure(await s.item(), "initial", s.signal)).toBe(true);
    expect((await s.item()).state).toBe("running");
    expect(s.questions()).toHaveLength(0);
    expect(await listOutbox(sqliteDb(s.db))).toHaveLength(0);
  } finally {
    s.close();
  }
});

test("a 404 for the repository installation still posts the admin question", async () => {
  const s = await scene();
  s.github.mode = "missing";
  try {
    expect(await s.auth.ensure(await s.item(), "initial", s.signal)).toBe(false);
    expect((await s.item()).state).toBe("awaiting_input");
    expect(s.questions()).toEqual([{ status: "open" }]);
    expect(await s.elicitations()).toHaveLength(1);
  } finally {
    s.close();
  }
});

test("an open github-auth question closes on the recheck once access works, and its item resumes", async () => {
  const s = await scene();
  s.github.mode = "missing";
  try {
    await s.auth.ensure(await s.item(), "initial", s.signal);
    s.github.mode = "dns";
    await s.auth.recover();
    expect(s.questions()).toEqual([{ status: "open" }]);
    expect((await s.item()).state).toBe("awaiting_input");
    s.github.mode = "ok";
    await s.auth.recover();
    expect(s.questions()).toEqual([{ status: "answered" }]);
    expect((await s.item()).state).toBe("running");
  } finally {
    s.close();
  }
});

test("an outage past ten minutes posts one network status line and no admin question", async () => {
  const s = await scene();
  s.github.mode = "dns";
  const check = s.integration.check;
  s.integration.check = async (item, signal) => {
    s.clock.now += 60_000;
    if (s.clock.now > 15 * 60_000) s.github.mode = "ok";
    return check(item, signal);
  };
  try {
    expect(await s.auth.ensure(await s.item(), "initial", s.signal)).toBe(true);
    const lines = (await listOutbox(sqliteDb(s.db))).map((entry) => JSON.stringify(entry.payload));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`Can't reach GitHub: ${DNS}`);
    expect(s.questions()).toHaveLength(0);
    expect(await s.elicitations()).toHaveLength(0);
  } finally {
    s.close();
  }
});

test("a 5xx or 429 from GitHub is transient, not a repository the installation doesn't cover", async () => {
  const s = await scene();
  try {
    for (const mode of ["5xx", "429", "dns"] as const) {
      s.github.mode = mode;
      await expect(s.installation("acme/widgets", "read", s.signal)).rejects.toThrow();
    }
    for (const mode of ["missing", "refused"] as const) {
      s.github.mode = mode;
      expect(await s.installation("acme/widgets", "read", s.signal)).toBe(false);
    }
  } finally {
    s.close();
  }
});

test("an authorization that can't reach Linear doesn't cancel the item; a definite denial does", async () => {
  const s = await scene();
  let unreachable = 2;
  s.integration.authorize = async () => {
    if (unreachable-- > 0) throw new Error(DNS);
    return true;
  };
  try {
    expect(await s.auth.ensure(await s.item(), "initial", s.signal)).toBe(true);
    expect((await s.item()).state).toBe("running");
    expect((await s.item()).cancelRequested).toBe(false);
    expect(s.questions()).toHaveLength(0);
    s.integration.authorize = async () => ({ denied: true, reason: "You're not in Pascal." });
    expect(await s.auth.ensure(await s.item(), "initial", s.signal, { fresh: true })).toBe(false);
    expect((await s.item()).state).toBe("cancelled");
  } finally {
    s.close();
  }
});
