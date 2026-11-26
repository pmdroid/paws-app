import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountHomeEnv } from "../src/acp";
import { setJournalSink } from "../src/journal";
import { Database } from "bun:sqlite";
import { runnerSleepLeftovers } from "../src/runner-cli";
import { heldCredentialsLeft, openRunnerDaemon } from "../src/runner-daemon";
import {
  onTmpfs,
  openRunnerAccountHome,
  returnRunnerAgentCredentials,
  runnerAccountCache,
  runnerAgentCredentials,
  writeReturnedCredentials,
} from "../src/runner-execution";
import { initializeRunnerAuthority, startRunnerListener } from "../src/runner-identity";
import {
  accessCredentialFiles,
  agentCredentialContext,
  agentCredentialReturnContext,
  sealForRunner,
  signRunnerCommand,
  type RunnerCommand,
} from "../src/runner-protocol";
import { serverIdentity } from "./local/runner-daemon";

const account = { accountId: "account-1", bindingId: "binding-1" };
const urls = { controlPlaneUrl: "https://localhost:1", runnerApiUrl: "https://localhost:2" };
const shmTmpfs = existsSync("/dev/shm") && onTmpfs("/dev/shm");
const stored = [
  {
    path: ".claude/.credentials.json",
    data: Buffer.from('{"claudeAiOauth":{"refreshToken":"r1"}}').toString("base64"),
  },
  {
    path: ".claude/.claude.json",
    data: Buffer.from('{"oauthAccount":{"id":"a"}}').toString("base64"),
  },
];

async function withRunner(
  run: (runner: {
    daemon: ReturnType<typeof openRunnerDaemon>;
    home: string;
    root: string;
    uploads: unknown[];
    plane: {
      failUploads: boolean;
      receipt: string;
      commands: () => RunnerCommand[];
      version: number;
      sealed: boolean;
      files: typeof stored;
      now: number;
      pulls: number;
      protocols: number[];
    };
    store?: string;
  }) => Promise<void>,
  issueVm = false,
) {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-credentials-"));
  const memory = issueVm ? mkdtempSync("/dev/shm/paws-issue-vm-") : null;
  const home = join(memory ?? root, "agent-home");
  mkdirSync(home, { mode: 0o770 });
  const store = memory ? join(memory, "credentials") : undefined;
  if (store) mkdirSync(store, { mode: 0o700 });
  const authority = await initializeRunnerAuthority(join(root, "issuer"));
  const server = await serverIdentity(join(root, "server"));
  const signingKey = generateKeyPairSync("ed25519");
  const publicKeyPem = signingKey.publicKey.export({ type: "spki", format: "pem" }).toString();
  const identity = { runnerId: "runner-local", workspaceId: "workspace-local" };
  const active = new Set<string>();
  let certificate = "";
  const uploads: unknown[] = [];
  const plane = {
    files: stored,
    now: Date.now(),
    pulls: 0,
    protocols: [] as number[],
    failUploads: false,
    receipt: "written",
    commands: (): RunnerCommand[] => [],
    version: 3,
    sealed: true,
  };
  const enrollment = createServer(server, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const issued = await authority.issue(JSON.parse(Buffer.concat(chunks).toString()).csr);
    active.add(issued.fingerprint);
    certificate = issued.pem;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ...identity,
        status: "approved",
        certificate: issued.pem,
        authority: authority.certificate,
        signingKeys: [{ keyId: "coordinator", publicKeyPem }],
      }),
    );
  });
  await new Promise<void>((resolve) => enrollment.listen(0, "127.0.0.1", resolve));
  const listener = await startRunnerListener({
    tls: { ...server, ca: authority.certificate },
    authorize: (peer) => active.has(peer.fingerprint),
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/heartbeat") {
        const sent = (await request.json()) as { accounts?: { protocol: number } };
        if (sent.accounts) plane.protocols.push(sent.accounts.protocol);
        return Response.json({ leases: [], fenced: [] });
      }
      if (path === "/v1/commands")
        return Response.json({
          commands: plane.commands().map((command) => ({
            ...signRunnerCommand({
              keyId: "coordinator",
              privateKey: signingKey.privateKey,
              command,
            }),
            credential: {
              version: plane.version,
              ...(plane.sealed
                ? {
                    sealed: sealForRunner(
                      certificate,
                      JSON.stringify(plane.files),
                      agentCredentialContext(command.id, account.accountId, plane.version),
                    ),
                  }
                : {}),
            },
          })),
        });
      if (path.endsWith("/ack")) return Response.json({ ok: true });
      if (path === "/v1/agent-credentials/current") {
        plane.pulls++;
        return Response.json({
          version: plane.version,
          sealed: sealForRunner(
            certificate,
            JSON.stringify(plane.files),
            agentCredentialContext("current", account.accountId, plane.version),
          ),
        });
      }
      if (path === "/v1/agent-credentials") {
        if (plane.failUploads) return Response.json({ error: "busy" }, { status: 503 });
        uploads.push(await request.json());
        return Response.json({ result: plane.receipt });
      }
      return Response.json({ error: "unknown" }, { status: 404 });
    },
  });
  const address = enrollment.address();
  if (!address || typeof address === "string") throw new Error("Enrollment has no port");
  const daemon = openRunnerDaemon({
    root: join(root, "daemon"),
    controlPlaneUrl: `https://localhost:${address.port}`,
    runnerApiUrl: `https://localhost:${listener.port}`,
    serverCa: server.cert,
    agentCredentials: runnerAgentCredentials(home, undefined, issueVm),
    ...(store ? { credentialStore: store, memorySignIns: () => onTmpfs(home) } : {}),
    now: () => Math.max(plane.now, Date.now()),
  });
  try {
    await daemon.enroll("credential-proof", "t".repeat(43));
    await run({ daemon, home, root, uploads, plane, ...(store ? { store } : {}) });
  } finally {
    daemon.close();
    await listener.stop();
    enrollment.close();
    rmSync(root, { recursive: true, force: true });
    if (memory) rmSync(memory, { recursive: true, force: true });
  }
}

const token = (value: string) =>
  Buffer.from(`{"claudeAiOauth":{"refreshToken":"${value}"}}`).toString("base64");

const EXECUTION = "01J0000000000000000000EXE1";

function agentTurn(daemon: ReturnType<typeof openRunnerDaemon>, home: string, commandId: string) {
  let returned: Buffer | null = null;
  returnRunnerAgentCredentials(
    join(home, ".paws-accounts", account.bindingId),
    "claude",
    EXECUTION,
    (files) => {
      returned = Buffer.from(
        sealForRunner(
          daemon.credentialRecipient(),
          JSON.stringify(files),
          agentCredentialReturnContext(EXECUTION),
        ),
      );
    },
  );
  expect(String(returned)).not.toContain("refreshToken");
  daemon.returnCredentials(commandId, EXECUTION, returned);
}

async function sync(daemon: ReturnType<typeof openRunnerDaemon>) {
  await daemon.heartbeat(undefined, undefined, undefined, []);
  await daemon.credentialSync();
}

const sent = (uploads: unknown[]) =>
  (uploads as { version: number; files: { data: string }[] }[]).map(({ version, files }) => [
    version,
    files[0]!.data,
  ]);

const command = (id: string, type: "login_check"): RunnerCommand => ({
  id,
  type,
  runnerId: "runner-local",
  workspaceId: "workspace-local",
  issuedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  agent: "claude",
  account,
});

test("a stored sign-in is written for the run, an agent-owned 0600 refresh reaches Paws at version + 1, and the tokens leave the disk", async () => {
  await withRunner(async ({ daemon, home, uploads, plane }) => {
    plane.commands = () => [command("check-1", "login_check")];
    const polled = await daemon.pollCommands();
    expect(polled.rejected).toEqual([]);
    expect(polled.commands.map(({ id }) => id)).toEqual(["check-1"]);
    expect(daemon.carriesCredential("check-1")).toBe(true);

    const accountHome = openRunnerAccountHome(home, account, "claude");
    const credentials = join(accountHome, ".claude/.credentials.json");
    const state = join(accountHome, ".claude/.claude.json");
    expect(readFileSync(credentials, "utf8")).toBe('{"claudeAiOauth":{"refreshToken":"r1"}}');
    expect(statSync(credentials).mode & 0o777).toBe(0o660);
    expect(statSync(credentials).gid).toBe(process.getgid!());
    expect(JSON.parse(readFileSync(state, "utf8"))).toEqual({ oauthAccount: { id: "a" } });

    rmSync(credentials);
    writeFileSync(credentials, '{"claudeAiOauth":{"refreshToken":"r2"}}', { mode: 0o600 });
    writeFileSync(
      state,
      JSON.stringify({ oauthAccount: { id: "a" }, hasCompletedOnboarding: true }),
    );
    agentTurn(daemon, home, "check-1");
    expect(existsSync(credentials)).toBe(false);
    expect(JSON.parse(readFileSync(state, "utf8")).hasCompletedOnboarding).toBe(true);

    plane.failUploads = true;
    await sync(daemon);
    expect(uploads).toEqual([]);

    plane.failUploads = false;
    plane.receipt = "stale_version";
    await sync(daemon);
    expect(sent(uploads)).toEqual([[4, token("r2")]]);

    plane.receipt = "written";
    await sync(daemon);
    expect(uploads.at(-1)).toEqual({
      accountId: account.accountId,
      version: 4,
      files: [{ path: ".claude/.credentials.json", data: token("r2") }, stored[1]],
    });

    await daemon.acknowledgeCommand("check-1");
    await sync(daemon);
    expect(uploads).toHaveLength(2);
    expect(daemon.carriesCredential("check-1")).toBe(false);
    expect(JSON.parse(readFileSync(state, "utf8")).hasCompletedOnboarding).toBe(true);
  });
}, 30_000);

test("a missing credentials result keeps the stored version and the runner's copy still leaves", async () => {
  await withRunner(async ({ daemon, home, uploads, plane }) => {
    plane.commands = () => [command("check-2", "login_check")];
    await daemon.pollCommands();
    daemon.returnCredentials("check-2", EXECUTION, null);
    await daemon.acknowledgeCommand("check-2");
    await sync(daemon);
    expect(uploads).toEqual([]);
    expect(existsSync(join(home, ".paws-accounts/binding-1/.claude/.credentials.json"))).toBe(
      false,
    );
  });
}, 30_000);

test("a command whose sign-in can't be written is refused and accepted when it comes again", async () => {
  await withRunner(async ({ daemon, home, plane }) => {
    plane.commands = () => [command("check-3", "login_check")];
    rmSync(home, { recursive: true });
    expect((await daemon.pollCommands()).rejected).toEqual(["account_unavailable"]);
    mkdirSync(home, { mode: 0o770 });
    const polled = await daemon.pollCommands();
    expect(polled.rejected).toEqual([]);
    expect(polled.commands.map(({ id }) => id)).toEqual(["check-3"]);
    expect(existsSync(join(home, ".paws-accounts/binding-1/.claude/.credentials.json"))).toBe(true);
  });
}, 30_000);

test("a sign-in the runner can't write is journaled once an hour for its binding", async () => {
  await withRunner(async ({ daemon, home, plane }) => {
    const issued = command("check-4", "login_check");
    plane.commands = () => [{ ...issued, expiresAt: issued.issuedAt + 7_200_000 }];
    mkdirSync(join(home, ".paws-accounts/binding-1"), { recursive: true });
    chmodSync(join(home, ".paws-accounts/binding-1"), 0o777);
    const lines: string[] = [];
    const restore = setJournalSink((line) => lines.push(line));
    try {
      for (let poll = 0; poll < 3; poll++)
        expect((await daemon.pollCommands()).rejected).toEqual(["account_unavailable"]);
      const logged = () => lines.filter((line) => line.includes("daemon.receiveCredential"));
      expect(logged()).toHaveLength(1);
      expect(logged()[0]).toContain("open to other users");
      plane.now = Date.now() + 3_600_000;
      await daemon.pollCommands();
      expect(logged()).toHaveLength(2);
    } finally {
      restore();
    }
  });
}, 30_000);

test("an upload whose answer was lost is sent again unchanged, and the next command gets the newest refresh", async () => {
  await withRunner(async ({ daemon, home, root, uploads, plane }) => {
    const issued = command("check-4", "login_check");
    plane.commands = () => [{ ...issued, expiresAt: issued.issuedAt + 7_200_000 }];
    await daemon.pollCommands();
    const credentials = join(
      openRunnerAccountHome(home, account, "claude"),
      ".claude/.credentials.json",
    );
    writeFileSync(credentials, '{"claudeAiOauth":{"refreshToken":"r2"}}');
    agentTurn(daemon, home, "check-4");
    plane.receipt = "busy";
    await sync(daemon);
    plane.commands = () => [command("check-5", "login_check")];
    await daemon.pollCommands();
    expect(readFileSync(credentials, "utf8")).toBe('{"claudeAiOauth":{"refreshToken":"r2"}}');
    writeFileSync(credentials, '{"claudeAiOauth":{"refreshToken":"r3"}}');
    agentTurn(daemon, home, "check-5");
    plane.receipt = "written";
    await sync(daemon);
    expect(sent(uploads)).toEqual([
      [4, token("r2")],
      [4, token("r2")],
      [5, token("r3")],
    ]);
    expect(existsSync(credentials)).toBe(false);
    const held = ["commands.db", "commands.db-wal"]
      .map((name) => join(root, "daemon", name))
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path).toString("latin1"))
      .join("");
    for (const secret of ["r1", "r2", "r3"])
      for (const text of ["refreshToken", token(secret).slice(8, -4)])
        expect(held).not.toContain(text);
  });
}, 30_000);

test("an unchanged sign-in the agent removed is written again for the next command", async () => {
  await withRunner(async ({ daemon, home, uploads, plane }) => {
    plane.commands = () => [command("check-6", "login_check")];
    await daemon.pollCommands();
    const credentials = join(home, ".paws-accounts/binding-1/.claude/.credentials.json");
    agentTurn(daemon, home, "check-6");
    expect(existsSync(credentials)).toBe(false);
    plane.commands = () => [command("check-7", "login_check")];
    expect((await daemon.pollCommands()).rejected).toEqual([]);
    expect(readFileSync(credentials, "utf8")).toBe('{"claudeAiOauth":{"refreshToken":"r1"}}');
    await sync(daemon);
    expect(uploads).toEqual([]);
  });
}, 30_000);

test("a queued command gets the sign-in back after another command's turn removed it", async () => {
  await withRunner(async ({ daemon, home, plane }) => {
    plane.commands = () => [command("check-8", "login_check"), command("check-9", "login_check")];
    await daemon.pollCommands();
    const credentials = join(home, ".paws-accounts/binding-1/.claude/.credentials.json");
    agentTurn(daemon, home, "check-9");
    expect(existsSync(credentials)).toBe(false);
    daemon.restoreCredentials("check-8");
    expect(readFileSync(credentials, "utf8")).toBe('{"claudeAiOauth":{"refreshToken":"r1"}}');
  });
}, 30_000);

test("a sign-in another worker removed during its cleanup is written back while that worker still holds the account", async () => {
  await withRunner(async ({ daemon, home, plane }) => {
    plane.commands = () => [command("check-10", "login_check")];
    await daemon.pollCommands();
    const accountHome = join(home, ".paws-accounts", account.bindingId);
    const credentials = join(accountHome, ".claude/.credentials.json");
    mkdirSync(join(accountHome, ".paws-active"), { recursive: true });
    writeFileSync(
      join(accountHome, ".paws-active", "01J0000000000000000000EXE2"),
      JSON.stringify({ scope: "0123456789abcdef" }),
    );
    rmSync(credentials);
    daemon.restoreCredentials("check-10");
    expect(readFileSync(credentials, "utf8")).toBe('{"claudeAiOauth":{"refreshToken":"r1"}}');
    writeFileSync(credentials, '{"claudeAiOauth":{"refreshToken":"r9"}}');
    daemon.restoreCredentials("check-10");
    expect(readFileSync(credentials, "utf8")).toBe('{"claudeAiOauth":{"refreshToken":"r9"}}');
  });
}, 30_000);

test("central Codex credentials are access-only, replaced ten minutes before expiry, and never uploaded", async () => {
  await withRunner(async ({ daemon, home, uploads, plane }) => {
    const expiry = plane.now + 3_600_000;
    const credential = (exp: number) =>
      accessCredentialFiles(
        JSON.stringify([
          {
            path: ".codex/auth.json",
            data: Buffer.from(
              JSON.stringify({
                auth_mode: "chatgpt",
                tokens: {
                  access_token: `e30.${Buffer.from(JSON.stringify({ exp: exp / 1000 })).toString("base64url")}.sig`,
                  id_token: "id",
                  refresh_token: "secret",
                  account_id: "account",
                },
                last_refresh: new Date(plane.now).toISOString(),
              }),
            ).toString("base64"),
          },
        ]),
      );
    plane.files = credential(expiry);
    const run = {
      ...command("codex-run", "login_check"),
      agent: "codex" as const,
      expiresAt: expiry + 3_600_000,
    };
    plane.commands = () => [run];
    expect((await daemon.pollCommands()).rejected).toEqual([]);
    const path = join(home, ".paws-accounts", account.bindingId, ".codex/auth.json");
    expect(JSON.parse(readFileSync(path, "utf8")).tokens.refresh_token).toBe("");
    plane.files = credential(expiry + 3_600_000);
    plane.version++;
    plane.now = expiry - 600_001;
    await sync(daemon);
    expect(plane.pulls).toBe(0);
    plane.now++;
    await sync(daemon);
    expect(plane.pulls).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(Buffer.from(plane.files[0]!.data, "base64").toString());
    daemon.returnCredentials(run.id, EXECUTION, null);
    await sync(daemon);
    expect(uploads).toEqual([]);
  });
});

test("Claude OAuth accounts use the token environment and never return refreshed credentials", async () => {
  const { accountAgentEnv, minimalAgentEnv } = await import("../src/acp");
  const { claudeTokenHealth } = await import("../src/runner-protocol");
  const root = mkdtempSync(join(tmpdir(), "paws-oauth-"));
  const createdAt = Date.now();
  const expiresAt = createdAt + 365 * 86400000;
  const credential = { kind: "oauth_token", token: "sk-ant-oat01-test", createdAt, expiresAt };
  try {
    const credentials = runnerAgentCredentials(root);
    credentials.write(account, "claude", []);
    const stagedHome = openRunnerAccountHome(root, account, "claude");
    const active = join(stagedHome, ".paws-active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "01J0000000000000000000EXE2"),
      JSON.stringify({ scope: "0123456789abcdef" }),
    );
    const incoming = [
      {
        path: ".claude/paws-oauth.json",
        data: Buffer.from(JSON.stringify(credential)).toString("base64"),
      },
    ];
    credentials.write(account, "claude", incoming);
    const home = openRunnerAccountHome(root, account, "claude");
    expect(
      minimalAgentEnv({ ...accountHomeEnv(home), ...accountAgentEnv("claude", home) })
        .CLAUDE_CODE_OAUTH_TOKEN,
    ).toBeUndefined();
    expect(accountAgentEnv("claude", home).CLAUDE_CODE_OAUTH_TOKEN).toBe(credential.token);
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "01J0000000000000000000EXE2"),
      JSON.stringify({ scope: "0123456789abcdef" }),
    );
    const renewed = { ...credential, token: "sk-ant-oat01-renewed" };
    credentials.write(account, "claude", [
      {
        path: ".claude/paws-oauth.json",
        data: Buffer.from(JSON.stringify(renewed)).toString("base64"),
      },
    ]);
    expect(accountAgentEnv("claude", home).CLAUDE_CODE_OAUTH_TOKEN).toBe(renewed.token);
    let returned = false;
    returnRunnerAgentCredentials(home, "claude", "execution", () => {
      returned = true;
    });
    expect(returned).toBe(false);
    expect(claudeTokenHealth(expiresAt, expiresAt - 14 * 86400000)).toBe("expiring");
    expect(claudeTokenHealth(expiresAt, expiresAt - 14 * 86400000 - 1)).toBe("healthy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!shmTmpfs)(
  "on an issue VM the sign-in stays in the tmpfs, its refresh reaches Paws and nothing is left after the turn",
  async () => {
    await withRunner(async ({ daemon, home, root, uploads, plane, store }) => {
      plane.commands = () => [command("check-vm", "login_check")];
      expect((await daemon.pollCommands()).rejected).toEqual([]);
      const credentials = join(
        openRunnerAccountHome(home, account, "claude"),
        ".claude/.credentials.json",
      );
      expect(readFileSync(credentials, "utf8")).toContain("r1");
      expect(heldCredentialsLeft(store!)).toBe(1);
      expect(runnerSleepLeftovers(home, store!)).toEqual([
        "binding-1/.claude/.credentials.json",
        "1 held or pending sign-in uploads",
      ]);

      rmSync(credentials);
      writeFileSync(credentials, '{"claudeAiOauth":{"refreshToken":"r2"}}', { mode: 0o600 });
      const accountHome = join(home, ".paws-accounts", account.bindingId);
      const cache = runnerAccountCache(root, accountHome)!;
      expect(cache).toBe(join(root, ".paws-account-caches", account.bindingId));
      expect(accountHomeEnv(accountHome, cache)).toMatchObject({ XDG_CACHE_HOME: cache });
      returnRunnerAgentCredentials(accountHome, "claude", EXECUTION, (files) =>
        writeReturnedCredentials(
          accountHome,
          EXECUTION,
          sealForRunner(
            daemon.credentialRecipient(),
            JSON.stringify(files),
            agentCredentialReturnContext(EXECUTION),
          ),
        ),
      );
      expect(existsSync(credentials)).toBe(false);
      const returned = join(accountHome, ".paws-returned", EXECUTION);
      expect(existsSync(returned)).toBe(true);
      expect(runnerSleepLeftovers(home, store!)).toContain(`binding-1/.paws-returned/${EXECUTION}`);
      daemon.returnCredentials("check-vm", EXECUTION, null);
      expect(existsSync(returned)).toBe(false);
      expect(runnerSleepLeftovers(home, store!)).toEqual(["1 held or pending sign-in uploads"]);
      await daemon.acknowledgeCommand("check-vm");
      await sync(daemon);
      expect(sent(uploads)).toEqual([[4, token("r2")]]);
      await sync(daemon);
      expect(heldCredentialsLeft(store!)).toBe(0);
      expect(runnerSleepLeftovers(home, store!)).toEqual([]);
      expect(plane.protocols).toContain(2);
      expect(plane.protocols).not.toContain(1);
      expect(readFileSync(join(store!, "credentials.db"), "latin1")).not.toMatch(
        /[A-Za-z0-9_-]{100}/,
      );
    }, true);
  },
  30_000,
);

test.skipIf(onTmpfs(tmpdir()))(
  "an issue VM refuses a sign-in whose account homes are on disk",
  () => {
    const home = mkdtempSync(join(tmpdir(), "paws-issue-vm-disk-"));
    try {
      chmodSync(home, 0o770);
      expect(() =>
        runnerAgentCredentials(home, undefined, true).write(account, "claude", stored),
      ).toThrow("Agent sign-ins on an issue VM need a tmpfs account root");
      expect(() =>
        openRunnerDaemon({ root: join(home, "daemon"), ...urls, credentialStore: home }),
      ).toThrow("Runner credential store must be a private tmpfs folder.");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test.skipIf(!shmTmpfs)(
  "an issue VM store resumes an interrupted scrub of commands.db while its marker exists",
  () => {
    const root = mkdtempSync(join(tmpdir(), "paws-runner-scrub-"));
    const store = mkdtempSync("/dev/shm/paws-issue-vm-store-");
    const options = { root: join(root, "daemon"), ...urls };
    try {
      chmodSync(store, 0o700);
      openRunnerDaemon(options).close();
      const path = join(options.root, "commands.db");
      const disk = new Database(path);
      disk.run(
        "INSERT INTO agent_credential (binding_id, account_id, agent, version, digest, commands, files) VALUES ('b', 'a', 'claude', 1, 'd', '[]', ?)",
        ["sealed-held-sign-in".repeat(20)],
      );
      disk.run("DROP TABLE agent_credential");
      disk.close();
      writeFileSync(`${path}.scrubbing`, "");
      openRunnerDaemon({ ...options, credentialStore: store }).close();
      expect(existsSync(`${path}.scrubbing`)).toBe(false);
      for (const suffix of ["", "-wal"])
        if (existsSync(`${path}${suffix}`))
          expect(readFileSync(`${path}${suffix}`, "latin1")).not.toContain("sealed-held-sign-in");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(store, { recursive: true, force: true });
    }
  },
);

test("an issue VM refuses OpenCode sign-ins", () => {
  const home = mkdtempSync(join(tmpdir(), "paws-issue-vm-opencode-"));
  try {
    expect(() =>
      runnerAgentCredentials(home, undefined, true).write(account, "opencode", stored),
    ).toThrow("OpenCode sign-ins are refused on an issue VM");
    expect(existsSync(join(home, ".paws-accounts"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.skipIf(!shmTmpfs)(
  "sleep-check fails closed and keeps staged sign-ins while their writer runs",
  () => {
    const agentHome = mkdtempSync("/dev/shm/paws-sleep-check-");
    try {
      const store = join(agentHome, "store");
      expect(runnerSleepLeftovers(agentHome, store, true)).toEqual([
        "runner credential store is not ready",
        "account homes are not on a tmpfs",
      ]);
      const claude = join(agentHome, ".paws-accounts/binding-1/.claude");
      mkdirSync(claude, { recursive: true });
      const id = "00000000-0000-0000-0000-000000000000";
      const live = `.credentials.json.${process.pid}-${id}.tmp`;
      writeFileSync(join(claude, live), "token");
      writeFileSync(
        join(claude, `.credentials.json.${Bun.spawnSync(["true"]).pid}-${id}.tmp`),
        "t",
      );
      mkdirSync(store, { mode: 0o700 });
      const held = new Database(join(store, "credentials.db"));
      held.run("CREATE TABLE agent_credential (a)");
      held.close();
      expect(runnerSleepLeftovers(agentHome, store, true)).toEqual([`binding-1/.claude/${live}`]);
      rmSync(join(claude, live));
      expect(runnerSleepLeftovers(agentHome, store, true)).toEqual([]);
      expect(readdirSync(claude)).toEqual([]);
    } finally {
      rmSync(agentHome, { recursive: true, force: true });
    }
  },
);
