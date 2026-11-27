import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountAgentEnv } from "../src/acp";
import { writeAgentCredentialSteps } from "../src/credentials";
import { createAgentAccountSteps, writeAgentAuthSteps } from "../src/db";
import {
  openRunnerAccountHome,
  returnRunnerAgentCredentials,
  runnerAgentCredentials,
  runnerSignInsLeft,
} from "../src/runner-execution";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import {
  agentCredentialContext,
  openForRunner,
  RUNNER_AGENT_CREDENTIAL_FILES,
  RUNNER_AGENT_SIGN_INS,
  RUNNER_CODING_AGENTS,
  RUNNER_RETRO_CAPABILITY,
  RunnerAgentCredentialFilesSchema,
  RunnerCommandSchema,
  RunnerRetroCommandSchema,
  runnerAccountAgentUnsupported,
  runnerAgentSignInRefusal,
  runnerCommandAccount,
  signRunnerCommand,
  signRunnerRetroCommand,
  verifyRunnerCommand,
  verifyRunnerRetroCommand,
  type RunnerAccount,
  type RunnerAgentSignIn,
  type RunnerCodingAgent,
  type RunnerCommand,
  type RunnerRetroCommand,
  type SignedRunnerCommand,
} from "../src/runner-protocol";
import { createRunnerWork } from "../src/runner-work";
import { describePglite, seed, withoutForeignKeys, type PgliteTestDb } from "./pglite-fixtures";
import { seedRunner } from "./runner-rows";

const NOW = 1_800_000_000_000;
const REFRESH = "refresh-secret-never-leaves";
const ACCESS = "access-token-for-the-turn";
const encode = (value: unknown) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64");
const jwt = `e30.${Buffer.from(JSON.stringify({ exp: NOW / 1000 + 3600 })).toString("base64url")}.${ACCESS}`;
const apiKey = (agent: RunnerCodingAgent) => [
  { path: ".paws/api-key.json", data: encode({ kind: "api_key", agent, key: ACCESS }) },
];
const codexAuth = encode({
  auth_mode: "chatgpt",
  tokens: { access_token: jwt, id_token: "id", refresh_token: REFRESH, account_id: "a" },
});
const grokAuth = encode({ key: ACCESS, refresh_token: REFRESH, user_id: "u", email: "e@x.io" });
const opencodeAuth = encode({ type: "oauth", access: ACCESS, refresh: REFRESH, expires: NOW });

const SIGN_INS: Record<
  RunnerCodingAgent,
  Partial<Record<RunnerAgentSignIn, { path: string; data: string }[]>>
> = {
  claude: {
    stored: [
      {
        path: ".claude/.credentials.json",
        data: encode({ claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH } }),
      },
    ],
    oauth_token: [
      {
        path: ".claude/paws-oauth.json",
        data: encode({
          kind: "oauth_token",
          token: `sk-ant-oat01-${ACCESS}`,
          createdAt: NOW,
          expiresAt: NOW + 86_400_000,
        }),
      },
    ],
    api_key: apiKey("claude"),
  },
  codex: {
    stored: [{ path: ".codex/auth.json", data: codexAuth }],
    central: [{ path: ".codex/auth.json", data: codexAuth }],
    api_key: apiKey("codex"),
  },
  grok: {
    stored: [{ path: ".grok/auth.json", data: grokAuth }],
    central: [{ path: ".grok/auth.json", data: grokAuth }],
    api_key: apiKey("grok"),
  },
  opencode: {
    stored: [{ path: ".local/share/opencode/auth.json", data: opencodeAuth }],
    central: [{ path: ".paws/opencode-credential.json", data: opencodeAuth }],
    api_key: apiKey("opencode"),
  },
};

const repository = {
  owner: "acme",
  repo: "app",
  remoteUrl: "https://github.com/acme/app.git",
  baseSha: "a".repeat(40),
};
const work = (agent: RunnerCodingAgent) => ({
  runId: "run",
  itemId: "item",
  generation: 1,
  repository,
  profile: { agent, model: null },
  prompt: "Do the work.",
});
const helper =
  (purpose: string, extra: Record<string, unknown> = {}) =>
  (agent: RunnerCodingAgent) => ({
    type: "helper",
    sessionId: "session",
    sessionGeneration: 1,
    purpose,
    profile: { agent, model: null },
    prompt: "Help with this.",
    ...extra,
  });
const LAUNCH_PATHS: Record<
  string,
  (agent: RunnerCodingAgent) => Record<string, unknown> & { type: string }
> = {
  run: (agent) => ({ type: "run", ...work(agent) }),
  review: (agent) => ({ type: "review", ...work(agent) }),
  task: (agent) => ({
    type: "task",
    ...work(agent),
    sessionId: "session",
    sessionGeneration: 1,
    taskModeGeneration: 1,
    purpose: "answer",
  }),
  "helper classify": helper("classify"),
  "helper select_repository": helper("select_repository"),
  "helper finding_groups": helper("finding_groups"),
  "helper conversation": helper("conversation", {
    conversation: { itemId: "item", runId: "run", resumeSessionId: "session" },
  }),
  "helper slack_reply": helper("slack_reply", {
    slack: {
      requestId: "request",
      teamId: "T0001",
      channelId: "C0001",
      threadTs: "1800000000.000100",
      memberUserId: "member",
      installGeneration: 1,
    },
  }),
  "helper repository_summary": helper("repository_summary", {
    summary: { repository: "acme/app" },
  }),
  "probe collection probe_distill": helper("probe_distill"),
  "probe collection probe_write": helper("probe_write", {
    probe: { repository: "acme/app", path: ".agents/probes/no-raw-sql.ts" },
  }),
  probe: (agent) => ({ type: "probe", profile: { agent, model: null } }),
  login_check: (agent) => ({ type: "login_check", agent }),
  retro: (agent) => ({
    type: "retro",
    capability: RUNNER_RETRO_CAPABILITY,
    retroId: "retro",
    attempt: 1,
    settingsRevision: 1,
    profile: { agent, model: null },
    executionLimit: { activeMinutes: 10 },
    output: { maxItems: 3, workedWell: 1, maxChars: 4000 },
    digest: input("digest"),
    prompt: input("prompt"),
  }),
};
function input(kind: "digest" | "prompt") {
  return { kind, workspaceId: "acme", retroId: "retro", sha256: "b".repeat(64), sizeBytes: 10 };
}

const launchPaths = [
  ...RunnerCommandSchema.options
    .filter((option) => "account" in option.shape)
    .flatMap((option) =>
      "purpose" in option.shape && option.shape.type.value === "helper"
        ? option.shape.purpose.options.map((purpose: string) =>
            purpose.startsWith("probe_") ? `probe collection ${purpose}` : `helper ${purpose}`,
          )
        : [option.shape.type.value],
    ),
  RunnerRetroCommandSchema.shape.type.value,
];

test("the matrix names every agent, sign-in and command type that carries an account", () => {
  expect(Object.keys(SIGN_INS).sort()).toEqual([...RUNNER_CODING_AGENTS].sort());
  for (const agent of RUNNER_CODING_AGENTS) {
    expect(runnerAccountAgentUnsupported(agent)).toBeNull();
    expect(Object.keys(SIGN_INS[agent]).sort()).toEqual([...RUNNER_AGENT_SIGN_INS[agent]].sort());
    for (const mode of RUNNER_AGENT_SIGN_INS[agent])
      for (const file of SIGN_INS[agent][mode]!)
        expect(RUNNER_AGENT_CREDENTIAL_FILES[agent]).toContain(file.path);
  }
  expect(Object.keys(LAUNCH_PATHS).sort()).toEqual(launchPaths.toSorted());
  expect(runnerAgentSignInRefusal("claude", "central")).toBe(
    "Claude accounts can't sign in with a browser sign-in. Use a runner sign-in, a setup token, or an API key.",
  );
});

const open: PgliteTestDb[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describePglite((connect) => {
  test("every agent and sign-in reaches the turn through every command type and leaves after it", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    const root = mkdtempSync(join(tmpdir(), "paws-sign-in-matrix-"));
    dirs.push(root);
    const authority = await initializeRunnerAuthority(join(root, "issuer"));
    const key = await createRunnerKey(root);
    const issued = await authority.issue(key.csr);
    await seed(db, (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "acme", linearOrganizationId: "acme", name: "acme", createdAt: 0 }),
    );
    await seedRunner(db, "runner");
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerCertificate).values({
        fingerprint: issued.fingerprint,
        serial: issued.serial,
        runnerId: "runner",
        pem: issued.pem,
        notBefore: 0,
        notAfter: NOW * 2,
        acceptedUntil: NOW * 2,
      }),
    );
    const secretsDir = join(root, "secrets");
    const signing = generateKeyPairSync("ed25519");
    const host = createRunnerWork({
      store: db,
      keyId: "coordinator",
      privateKey: signing.privateKey,
      eventKey: randomBytes(32),
      secretsDir,
      now: () => NOW,
    });
    const privateKey = readFileSync(key.keyPath, "utf8");
    const cells: { agent: RunnerCodingAgent; mode: RunnerAgentSignIn; accountId: string }[] = [];
    for (const agent of RUNNER_CODING_AGENTS)
      for (const mode of RUNNER_AGENT_SIGN_INS[agent]) {
        const { id } = await db.transaction((q) =>
          createAgentAccountSteps(q, {
            ownerUserId: "owner",
            workspaceId: "acme",
            agent,
            label: `${agent} ${mode}`,
            now: NOW,
          }),
        );
        await db.transaction(function* (q) {
          yield* writeAgentCredentialSteps(q, secretsDir, {
            accountId: id,
            runnerId: mode === "stored" ? "runner" : null,
            version: 1,
            blob: JSON.stringify(SIGN_INS[agent][mode]),
            now: NOW,
          });
          if (mode === "central")
            yield* writeAgentAuthSteps(q, id, JSON.stringify({ state: "signed-in" }));
        });
        cells.push({ agent, mode, accountId: id });
      }

    const trustedKeys = new Map([["coordinator", signing.publicKey]]);
    const verify = (path: string, envelope: SignedRunnerCommand) => {
      const context = {
        trustedKeys,
        runnerId: "runner",
        workspaceId: "acme",
        now: NOW,
        accountBindings: new Set<string>(),
        claimCommand: () => true,
      };
      return path === "retro"
        ? verifyRunnerRetroCommand(envelope, { ...context, latestAttempt: () => undefined })
        : verifyRunnerCommand(envelope, context);
    };
    const sign = (path: string, command: Record<string, unknown>): SignedRunnerCommand =>
      path === "retro"
        ? signRunnerRetroCommand({
            keyId: "coordinator",
            privateKey: signing.privateKey,
            command: command as unknown as RunnerRetroCommand,
          })
        : signRunnerCommand({
            keyId: "coordinator",
            privateKey: signing.privateKey,
            command: command as unknown as RunnerCommand,
          });

    for (const [row, path] of launchPaths.entries())
      for (const { agent, mode, accountId } of cells) {
        const cell = `${path} ${agent} ${mode}`;
        const account: RunnerAccount = { accountId, bindingId: `b${row}-${accountId}` };
        const unsigned = {
          id: `cmd${row}-${accountId}`,
          runnerId: "runner",
          workspaceId: "acme",
          issuedAt: NOW,
          expiresAt: NOW + 60_000,
          ...LAUNCH_PATHS[path]!(agent),
        };
        const command = { ...unsigned, account };
        const envelope = sign(path, command);
        const named = runnerCommandAccount(command as unknown as RunnerCommand);
        expect(named, cell).toEqual({ account, agent });
        expect(verify(path, envelope), cell).toEqual({ ok: false, reason: "account_unavailable" });
        if (!path.startsWith("probe collection")) {
          const [bare] = await host.attachCredentials("runner", [sign(path, unsigned)]);
          expect(bare?.credential, cell).toBeUndefined();
        }

        const [sent] = await host.attachCredentials("runner", [envelope]);
        expect(sent?.credential?.sealed, cell).toBeDefined();
        const delivered = RunnerAgentCredentialFilesSchema.parse(
          JSON.parse(
            openForRunner(
              privateKey,
              sent!.credential!.sealed!,
              agentCredentialContext(command.id, accountId, sent!.credential!.version),
            ),
          ),
        );
        const text = delivered.map((file) => Buffer.from(file.data, "base64").toString()).join();
        expect(text, cell).toContain(ACCESS);
        if (mode === "central") expect(text, cell).not.toContain(REFRESH);
        for (const other of cells.filter((entry) => entry.accountId !== accountId).slice(0, 1))
          expect(() =>
            openForRunner(
              privateKey,
              sent!.credential!.sealed!,
              agentCredentialContext(command.id, other.accountId, sent!.credential!.version),
            ),
          ).toThrow();

        const agentHome = join(root, "agents", `${row}-${agent}-${mode}`);
        expect(() => runnerAgentCredentials(agentHome).write(account, agent, delivered)).toThrow();
        expect(existsSync(agentHome), cell).toBe(false);
        mkdirSync(join(agentHome, ".paws-accounts", account.bindingId), {
          recursive: true,
          mode: 0o770,
        });
        chmodSync(agentHome, 0o770);
        chmodSync(join(agentHome, ".paws-accounts", account.bindingId), 0o777);
        expect(() => runnerAgentCredentials(agentHome).write(account, agent, delivered)).toThrow(
          "open to other users",
        );
        rmSync(join(agentHome, ".paws-accounts"), { recursive: true });
        const store = runnerAgentCredentials(agentHome);
        store.write(account, agent, delivered);
        const home = openRunnerAccountHome(agentHome, account, agent);
        for (const file of delivered)
          expect(existsSync(join(home, file.path)), `${cell} ${file.path}`).toBe(true);
        const env = accountAgentEnv(agent, home);
        if (mode === "api_key") expect(Object.values(env), cell).toEqual([ACCESS]);
        else if (mode === "oauth_token")
          expect(env, cell).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${ACCESS}` });
        else expect(env, cell).toEqual({});

        const returned: string[] = [];
        returnRunnerAgentCredentials(home, agent, "01J0000000000000000000EXE1", (files) =>
          returned.push(...files.map((file) => Buffer.from(file.data, "base64").toString())),
        );
        if (mode === "central") expect(returned.join(), cell).not.toContain(REFRESH);
        store.remove(account, agent);
        expect(runnerSignInsLeft(agentHome), cell).toEqual([]);
      }
  }, 60_000);
});
