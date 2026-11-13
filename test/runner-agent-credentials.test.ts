import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRunnerDaemon } from "../src/runner-daemon";
import {
  openRunnerAccountHome,
  returnRunnerAgentCredentials,
  runnerAgentCredentials,
} from "../src/runner-execution";
import { initializeRunnerAuthority, startRunnerListener } from "../src/runner-identity";
import {
  agentCredentialContext,
  agentCredentialReturnContext,
  sealForRunner,
  signRunnerCommand,
  type RunnerCommand,
} from "../src/runner-protocol";
import { serverIdentity } from "./local/runner-daemon";

const account = { accountId: "account-1", bindingId: "binding-1" };
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
    uploads: unknown[];
    plane: {
      failUploads: boolean;
      receipt: string;
      commands: () => RunnerCommand[];
      version: number;
      sealed: boolean;
    };
  }) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-credentials-"));
  const home = join(root, "agent-home");
  mkdirSync(home, { mode: 0o770 });
  const authority = await initializeRunnerAuthority(join(root, "issuer"));
  const server = await serverIdentity(join(root, "server"));
  const signingKey = generateKeyPairSync("ed25519");
  const publicKeyPem = signingKey.publicKey.export({ type: "spki", format: "pem" }).toString();
  const identity = { runnerId: "runner-local", workspaceId: "workspace-local" };
  const active = new Set<string>();
  let certificate = "";
  const uploads: unknown[] = [];
  const plane = {
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
      if (path === "/v1/heartbeat") return Response.json({ leases: [], fenced: [] });
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
                      JSON.stringify(stored),
                      agentCredentialContext(command.id, account.accountId, plane.version),
                    ),
                  }
                : {}),
            },
          })),
        });
      if (path.endsWith("/ack")) return Response.json({ ok: true });
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
    agentCredentials: runnerAgentCredentials(home),
  });
  try {
    await daemon.enroll("credential-proof", "t".repeat(43));
    await run({ daemon, home, uploads, plane });
  } finally {
    daemon.close();
    await listener.stop();
    enrollment.close();
    rmSync(root, { recursive: true, force: true });
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

const command = (id: string, type: "login" | "login_check"): RunnerCommand => ({
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

test("a sign-in on the runner uploads the new files as the first stored version", async () => {
  await withRunner(async ({ daemon, home, uploads, plane }) => {
    plane.version = 0;
    plane.sealed = false;
    plane.commands = () => [command("login-1", "login")];
    await daemon.pollCommands();
    const accountHome = openRunnerAccountHome(home, account, "claude", { signIn: true });
    writeFileSync(join(accountHome, ".claude/.credentials.json"), '{"claudeAiOauth":{}}', {
      mode: 0o600,
    });
    await daemon.acknowledgeCommand("login-1");
    await sync(daemon);
    expect(daemon.carriesCredential("login-1")).toBe(true);
    agentTurn(daemon, home, "login-1");
    await sync(daemon);
    expect(uploads).toEqual([
      {
        accountId: account.accountId,
        version: 1,
        files: [
          {
            path: ".claude/.credentials.json",
            data: Buffer.from('{"claudeAiOauth":{}}').toString("base64"),
          },
        ],
      },
    ]);
    expect(existsSync(join(accountHome, ".claude/.credentials.json"))).toBe(false);
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

test("an upload whose answer was lost is sent again unchanged, and the next command gets the newest refresh", async () => {
  await withRunner(async ({ daemon, home, uploads, plane }) => {
    plane.commands = () => [command("check-4", "login_check")];
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
