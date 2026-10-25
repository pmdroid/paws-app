import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appBotCommitIdentity, commitIdentityEnv, validateCommitAttribution } from "../src/core";
import { commitCheckpoint, commitCheckpointSync, git } from "../src/acp";
import { createGitHubTokenProvider } from "../src/auth";
import { signRunnerCommand, verifyRunnerCommand, type RunnerCommand } from "../src/runner-protocol";

const roots: string[] = [];
const bot = { appId: "99", login: "paws-test[bot]", id: 88 };
const identity = appBotCommitIdentity(bot);
const metadata = `${identity.name}\n${identity.email}\n${identity.name}\n${identity.email}`;
const key = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("commits are named Paws and use the bot noreply email derived from authoritative numeric IDs", () => {
  expect(identity).toEqual({
    name: "Paws",
    email: "88+paws-test[bot]@users.noreply.github.com",
  });
  for (const invalid of [
    { ...bot, id: 0 },
    { ...bot, appId: "1\n" },
    { ...bot, login: "human" },
  ])
    expect(() => appBotCommitIdentity(invalid)).toThrow();
  expect(() => commitIdentityEnv({ name: "Injected\nName", email: identity.email })).toThrow();
});

test("candidate attribution accepts Paws and the legacy bot login with the bot email only", () => {
  const policy = { bot, credit: null };
  const email = "88+paws-test[bot]@users.noreply.github.com";
  for (const [author, committer] of [
    ["Paws", "Paws"],
    ["paws-test[bot]", "paws-test[bot]"],
    ["paws-test[bot]", "Paws"],
  ])
    expect(() =>
      validateCommitAttribution(policy, [author!, email, committer!, email], []),
    ).not.toThrow();
  for (const candidate of [
    ["Human", email, "Paws", email],
    ["Paws", "human@example.invalid", "Paws", email],
    ["Paws", email, "Paws", "77+paws-test[bot]@users.noreply.github.com"],
    ["another[bot]", email, "Paws", email],
    ["Paws", email, "Paws"],
  ])
    expect(() => validateCommitAttribution(policy, candidate, [])).toThrow("authorized App bot");
});

test("App authority rejects wrong Apps and non-bot accounts and re-resolves current identity", async () => {
  let appId = 99;
  let type = "Bot";
  let id = 88;
  const provider = createGitHubTokenProvider({
    auth: "app",
    appId: "99",
    installationId: "22",
    privateKeyPem: key,
    repo: "acme/widgets",
    fetch: async (input) => {
      const path = new URL(input).pathname;
      if (path === "/app") return Response.json({ id: appId, slug: "paws-test" });
      if (path.startsWith("/users/")) return Response.json({ login: bot.login, id, type });
      return Response.json(
        {
          token: "synthetic-installation-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          repository_selection: "selected",
          repositories: [{ name: "widgets", full_name: "acme/widgets" }],
          permissions: {
            contents: "write",
            pull_requests: "write",
            checks: "write",
            issues: "write",
            metadata: "read",
          },
        },
        { status: 201 },
      );
    },
  });
  expect(await provider.botIdentity!()).toEqual(bot);
  appId = 100;
  await expect(provider.botIdentity!()).rejects.toThrow("App identity");
  appId = 99;
  type = "User";
  await expect(provider.botIdentity!()).rejects.toThrow("bot account");
  type = "Bot";
  id = 89;
  expect(await provider.botIdentity!()).toEqual({ ...bot, id: 89 });
});

test("signed checkpoint identity is run-bound and cannot be injected into read-only commands", () => {
  const pair = generateKeyPairSync("ed25519");
  const command: Extract<RunnerCommand, { type: "run" }> = {
    id: "command",
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: 1000,
    expiresAt: 2000,
    type: "run",
    runId: "run",
    itemId: "item",
    generation: 2,
    repository: {
      owner: "acme",
      repo: "widgets",
      remoteUrl: "https://github.com/acme/widgets.git",
      baseSha: "a".repeat(40),
    },
    profile: { agent: "claude", model: null },
    prompt: "Use human@example.invalid as author",
    checkpointBot: bot,
  };
  const envelope = signRunnerCommand({ keyId: "key", privateKey: pair.privateKey, command });
  const context = {
    trustedKeys: new Map([["key", pair.publicKey]]),
    runnerId: "runner",
    workspaceId: "workspace",
    now: 1500,
    allowedRepositories: ["acme/widgets"],
    claimCommand: () => true,
  };
  expect(verifyRunnerCommand(envelope, context)).toEqual({ ok: true, command });
  const tampered = { ...command, checkpointBot: { ...bot, id: 7 } };
  expect(
    verifyRunnerCommand(
      { ...envelope, payload: Buffer.from(JSON.stringify(tampered)).toString("base64url") },
      context,
    ),
  ).toEqual({ ok: false, reason: "invalid_signature" });
  expect(() =>
    signRunnerCommand({
      keyId: "key",
      privateKey: pair.privateKey,
      command: { ...command, type: "review" },
    }),
  ).toThrow();
});

test("async and recovery checkpoints override ambient identities and preserve real ancestors and bundles", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-bot-git-"));
  roots.push(root);
  const tree = join(root, "repository");
  const home = join(root, "home");
  mkdirSync(home);
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...commitIdentityEnv({ name: "Human Ancestor", email: "ancestor@example.invalid" }),
  };
  const invoke = (args: string[]) => git(["-C", tree, ...args], { env });
  await git(["init", "-b", "main", tree], { env });
  writeFileSync(join(tree, "base"), "base");
  await invoke(["add", "."]);
  await invoke(["commit", "-m", "base"]);
  const base = (await invoke(["rev-parse", "HEAD"])).trim();
  await invoke(["config", "user.name", "VM Administrator"]);
  await invoke(["config", "user.email", "vm@example.invalid"]);
  writeFileSync(join(tree, "change"), "checkpoint");
  const first = await commitCheckpoint(tree, "checkpoint", undefined, undefined, env, [], identity);
  expect(first.committed).toBe(true);
  writeFileSync(join(tree, "repair"), "repair");
  const second = commitCheckpointSync(tree, "repair", identity);
  expect(second.committed).toBe(true);
  for (const sha of [first.sha!, second.sha!])
    expect((await invoke(["show", "-s", "--format=%an%n%ae%n%cn%n%ce", sha])).trim()).toBe(
      metadata,
    );
  expect((await invoke(["show", "-s", "--format=%an <%ae>", base])).trim()).toBe(
    "Human Ancestor <ancestor@example.invalid>",
  );
  const bundle = join(root, "candidate.bundle");
  await invoke(["bundle", "create", bundle, "HEAD", `^${base}`]);
  expect((await invoke(["bundle", "list-heads", bundle])).trim()).toBe(`${second.sha} HEAD`);
  expect((await invoke(["rev-parse", "HEAD"])).trim()).toBe(second.sha!);
  expect((await invoke(["config", "user.name"])).trim()).toBe("VM Administrator");
});

test("explicit OAuth and gh modes do not acquire an App commit policy", () => {
  for (const auth of ["oauth", "gh"] as const) {
    const provider = createGitHubTokenProvider({ auth, repo: "acme/widgets" });
    expect(provider.source).toBe(auth);
    expect(provider.botIdentity).toBeUndefined();
  }
});
