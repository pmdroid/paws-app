import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MINIMUM_RUNNER_VERSION } from "../src/runner-protocol";

type Paws = {
  coordinator: typeof import("../src/runner-coordinator");
  db: typeof import("../src/db");
  credentials: typeof import("../src/credentials");
  workspace: typeof import("../src/workspace");
  pglite: typeof import("../test/pglite");
  fixtures: typeof import("../test/pglite-fixtures");
};
type Runner = {
  daemon: typeof import("../src/runner-daemon");
  protocol: typeof import("../src/runner-protocol");
};

export type CompatibilityReport = {
  refusals: string[];
  heartbeatError: string | null;
  delivered: boolean;
  rejected: string[];
  credentialDelivered: boolean;
};

const REPOSITORY = resolve(import.meta.dir, "..");

async function run(argv: string[], cwd = REPOSITORY) {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${argv.join(" ")} exited ${code}: ${stderr || stdout}`);
  return stdout;
}

async function checkout(ref: string, root: string, name: string) {
  if (ref === ".") return REPOSITORY;
  const dir = join(root, name);
  mkdirSync(dir);
  const commit = (await run(["git", "rev-parse", "--verify", `${ref}^{commit}`])).trim();
  await run([
    "bash",
    "-o",
    "pipefail",
    "-c",
    'git archive "$1" | tar -x -C "$2"',
    "-",
    commit,
    dir,
  ]);
  await run(["bun", "install", "--frozen-lockfile"], dir);
  return dir;
}

async function loadPaws(tree: string): Promise<Paws> {
  return {
    coordinator: await import(join(tree, "src/runner-coordinator/index.ts")),
    db: await import(join(tree, "src/db/index.ts")),
    credentials: await import(join(tree, "src/credentials/index.ts")),
    workspace: await import(join(tree, "src/workspace/index.ts")),
    pglite: await import(join(tree, "test/pglite.ts")),
    fixtures: await import(join(tree, "test/pglite-fixtures.ts")),
  };
}

async function loadRunner(tree: string): Promise<Runner> {
  return {
    daemon: await import(join(tree, "src/runner-daemon/index.ts")),
    protocol: await import(join(tree, "src/runner-protocol/index.ts")),
  };
}

async function serverTls(root: string) {
  const key = join(root, "server.key");
  const cert = join(root, "server.pem");
  await run([
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
  ]);
  chmodSync(key, 0o600);
  return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
}

function everyHostField(runner: Runner, sampled: Record<string, unknown>) {
  const host: Record<string, unknown> = { ...sampled };
  const shape = runner.protocol.RunnerHostStatusSchema.shape as Record<
    string,
    { safeParse(value: unknown): { success: boolean } }
  >;
  for (const [name, field] of Object.entries(shape)) {
    if (host[name] !== undefined) continue;
    const value = [null, "runner", 1, "1.0.0", []].find(
      (candidate) => field.safeParse(candidate).success,
    );
    if (value !== undefined) host[name] = value;
  }
  return host;
}

export async function checkRunnerCompatibility(options: {
  pawsTree: string;
  runnerTree: string;
  root: string;
  unknownHostField?: string;
}): Promise<CompatibilityReport> {
  const paws = await loadPaws(options.pawsTree);
  const runner = await loadRunner(options.runnerTree);
  const identity = join(options.root, "identity");
  const secretsDir = join(options.root, "secrets");
  mkdirSync(secretsDir, { mode: 0o700 });
  await paws.coordinator.initializeRunnerCoordinator(identity);
  const tls = await serverTls(options.root);
  const { db, close } = await paws.pglite.tempStore();
  const now = Date.now();
  const userId = await paws.db.putWorkspaceUser(db, {
    id: paws.workspace.workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = await paws.db.consumeWorkspaceBootstrap(db, {
    id: paws.workspace.workspaceId(),
    organizationId: "org",
    name: "Compatibility",
    userId,
    tokenHash: paws.workspace.workspaceTokenHash(
      await paws.workspace.issueWorkspaceBootstrap(db, "org", now),
    ),
    now,
  });
  const principal = {
    workspaceId: workspace.id,
    userId,
    role: "admin" as const,
    authenticatedAt: now,
    teamIds: [],
  };
  const logged: string[] = [];
  const warn = console.warn;
  console.warn = (...parts: unknown[]) => logged.push(parts.map(String).join(" "));
  const coordinator = await paws.coordinator
    .openRunnerCoordinator({
      eventKey: Buffer.alloc(32, 7),
      root: identity,
      tls,
      hostname: "127.0.0.1",
      port: 0,
      db,
      secretsDir,
      onError: () => {},
    })
    .finally(() => {
      console.warn = warn;
    });
  const browser = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    fetch: (request) => coordinator.hostEnrollment(request),
  });
  let held: { bindingId: string; agent: "codex" }[] = [];
  const received: string[] = [];
  const sample = runner.daemon.createRunnerHostSampler({ workRoot: options.root });
  const daemon = runner.daemon.openRunnerDaemon({
    root: join(options.root, "runner"),
    controlPlaneUrl: `https://127.0.0.1:${browser.port}`,
    runnerApiUrl: `https://127.0.0.1:${coordinator.port}`,
    serverCa: tls.cert,
    allowedRepositories: ["fixture/repository"],
    concurrency: 1,
    conversationConcurrency: 1,
    sampleHost: () =>
      ({
        ...everyHostField(runner, sample()),
        ...(options.unknownHostField ? { [options.unknownHostField]: null } : {}),
      }) as never,
    accountBindings: () => held,
    agentCredentials: {
      write: (account) => void received.push(account.bindingId),
      busy: () => false,
      remove: () => {},
    },
  });
  try {
    const enrollment = await coordinator.control.createEnrollment(principal, {
      name: "Compatibility runner",
    });
    const paired = await daemon.enroll("Compatibility runner", enrollment.token);
    if (paired.phase !== "paired") throw new Error("The runner did not pair.");
    await coordinator.control.setStatus(principal, paired.runnerId, "active");
    await paws.fixtures.signInFixtureRunner(db, paired.runnerId, "codex");
    const [bound] = await paws.db.runnerNamedBindings(db, paired.runnerId, workspace.id);
    assert(bound, "The fixture account is not bound to the runner.");
    held = [{ bindingId: bound.bindingId, agent: "codex" }];
    const files = [{ path: ".codex/auth.json", data: Buffer.from("{}").toString("base64") }];
    let written = "stale_version";
    for (let version = 1; written !== "written" && version <= 4; version++)
      written = await db.transaction((q) =>
        paws.credentials.writeAgentCredentialSteps(q, secretsDir, {
          accountId: bound.accountId,
          runnerId: paired.runnerId,
          version,
          blob: JSON.stringify(files),
          now,
        }),
      );
    assert.equal(written, "written", "The fixture sign-in was not stored.");
    const heartbeatError = await daemon
      .heartbeat([], [], [], [], [])
      .then(() => daemon.heartbeat([], [], [], [], []))
      .then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    const refusals = logged.filter((line) => /\/v1\/heartbeat answered 403/.test(line));
    if (heartbeatError)
      return {
        refusals,
        heartbeatError,
        delivered: false,
        rejected: [],
        credentialDelivered: false,
      };
    const command = await coordinator.health.request(principal, paired.runnerId, {
      type: "login_check",
      agent: "codex",
    });
    const polled = await daemon.pollCommands();
    return {
      refusals,
      heartbeatError,
      delivered: polled.commands.some((entry) => entry.id === command.commandId),
      rejected: polled.rejected.map(String),
      credentialDelivered: received.includes(bound.bindingId),
    };
  } finally {
    daemon.close();
    await browser.stop(true);
    await coordinator.stop();
    await close();
  }
}

export function compatibilityFailures(report: CompatibilityReport): string[] {
  return [
    ...report.refusals,
    ...(report.heartbeatError ? [`Heartbeat failed: ${report.heartbeatError}`] : []),
    ...(report.delivered ? [] : ["The login_check command was not delivered."]),
    ...report.rejected.map((reason) => `The runner rejected a command: ${reason}`),
    ...(report.credentialDelivered ? [] : ["The command's sealed sign-in was not delivered."]),
  ];
}

async function main(args: string[]) {
  const deployed = args[0] === "--deployed" ? args[1] : undefined;
  if (!deployed || args.length !== 2) {
    console.error("Usage: bun scripts/runner-compat.ts --deployed <paws-ref>");
    return 2;
  }
  const minimum = `v${MINIMUM_RUNNER_VERSION.join(".")}`;
  const pairs = [
    { paws: deployed, runner: "." },
    { paws: ".", runner: minimum },
  ];
  const root = mkdtempSync(join(tmpdir(), "paws-runner-compat-"));
  let failed = false;
  try {
    for (const [index, pair] of pairs.entries()) {
      const label = `runner ${pair.runner === "." ? "candidate" : pair.runner} against Paws ${pair.paws === "." ? "candidate" : pair.paws}`;
      const dir = join(root, String(index));
      mkdirSync(dir);
      const failures = compatibilityFailures(
        await checkRunnerCompatibility({
          pawsTree: await checkout(pair.paws, dir, "paws"),
          runnerTree: await checkout(pair.runner, dir, "runner"),
          root: dir,
        }),
      );
      failed ||= failures.length > 0;
      console.log(failures.length ? `FAIL ${label}\n  ${failures.join("\n  ")}` : `PASS ${label}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
