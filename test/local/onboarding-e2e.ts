import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { startPaws, type PawsProcess } from "../../src/index";
import { INSTALLATION_PERMISSIONS } from "../../src/github";
import { createExeDev } from "../../src/provisioning";
import type { RunnerDaemon } from "../../src/runner-daemon";
import { createFakeRunnerTranscriptObjects } from "../../src/runner-transcripts";
import { issueWorkspaceBootstrap } from "../../src/workspace";
import { startOnboardingExeDev } from "./onboarding-exe-dev";
import { startOnboardingGitRemote } from "./onboarding-git";
import { freshPermissionDenial, startOnboardingGitHub } from "./onboarding-github";
import { createOnboardingGuest } from "./onboarding-guest";

const repositoryRoot = resolve(import.meta.dir, "../..");
function finearRoot() {
  const configured = process.env.PAWS_FINEAR_ROOT;
  if (configured) return resolve(configured);
  const common = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: process.env.PATH },
  });
  const candidates = [resolve(repositoryRoot, "../finear")];
  if (common.exitCode === 0)
    candidates.push(resolve(dirname(common.stdout.toString().trim()), "../finear"));
  const found = candidates.find((path) => existsSync(join(path, "src/application.ts")));
  if (!found)
    throw new Error(
      `Set PAWS_FINEAR_ROOT to a Finear checkout. Looked in ${candidates.join(", ")}.`,
    );
  return found;
}
const FINEAR = finearRoot();
if (!existsSync(join(FINEAR, "src/application.ts")))
  throw new Error(`PAWS_FINEAR_ROOT has no src/application.ts: ${FINEAR}`);
const CONTROL_TOKEN = "local-control-token";
const PRIMARY_KEY = "finear-fixture-primary-key";
const PRIMARY = {
  organization: "10000000-0000-4000-8000-000000000001",
  member: "10000000-0000-4000-8000-000000000002",
  team: "10000000-0000-4000-8000-000000000003",
};

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Pass a disposable proof directory.");
mkdirSync(root, { recursive: true, mode: 0o700 });
const realRoot = realpathSync(root);
const inside = (path: string | undefined) =>
  path !== undefined && existsSync(path) && realpathSync(path).startsWith(realRoot + "/");
const home = realpathSync(process.env.HOME ?? "/");
const agentRoot = resolve(process.env.KYOTOAGENT_ROOT ?? "/");
const tmpDir = process.env.TMPDIR;
const pawsHomeDir = resolve(process.env.PAWS_HOME ?? join(root, "paws"));
mkdirSync(pawsHomeDir, { recursive: true, mode: 0o700 });
if (
  !inside(home) ||
  agentRoot !== join(home, ".kyotoagent") ||
  !inside(agentRoot) ||
  realpathSync(agentRoot) !== agentRoot ||
  !inside(tmpDir)
)
  throw new Error(
    "Use a disposable HOME, KYOTOAGENT_ROOT=$HOME/.kyotoagent and TMPDIR inside the proof directory.",
  );
if (!inside(pawsHomeDir)) throw new Error("PAWS_HOME must be inside the proof directory.");
const pathEntries = (process.env.PATH ?? "").split(":");
const nodeVersion = Bun.spawnSync(["node", "--version"], {
  stdout: "pipe",
  stderr: "ignore",
  env: { PATH: process.env.PATH },
})
  .stdout.toString()
  .trim();
if (
  Bun.version !== "1.4.2" ||
  pathEntries[0] !== dirname(process.execPath) ||
  pathEntries.some((entry) => entry.includes("/mise/shims")) ||
  nodeVersion !== "v24.21.0"
)
  throw new Error(
    `Run with Bun 1.4.2 first on PATH, Node 24.21.0 and no mise shims (bun ${Bun.version}, node ${nodeVersion}, PATH head ${pathEntries[0]}).`,
  );
const interfaces = readFileSync("/proc/self/net/dev", "utf8")
  .split("\n")
  .slice(2)
  .map((line) => line.split(":")[0]!.trim())
  .filter(Boolean)
  .sort();
const githubHost = Bun.spawnSync(["/usr/bin/getent", "hosts", "github.com"], {
  stdout: "pipe",
  stderr: "ignore",
  env: { PATH: "/usr/bin:/bin" },
})
  .stdout.toString()
  .trim()
  .split(/\s+/)[0];
if (interfaces.join(",") !== "lo" || githubHost !== "127.0.0.1")
  throw new Error(
    `Run inside a network namespace with only loopback and github.com mapped to 127.0.0.1 (interfaces ${interfaces.join(",")}, github.com ${githubHost ?? "unresolved"}).`,
  );
const environment = {
  root: realRoot,
  network: { interfaces, githubCom: githubHost },
  home,
  kyotoagentRoot: agentRoot,
  pawsHome: realpathSync(pawsHomeDir),
  tmpdir: realpathSync(tmpDir!),
  finear: FINEAR,
  bun: { version: Bun.version, path: process.execPath },
  node: nodeVersion,
  pid: process.pid,
};

type Step = {
  step: string;
  status: "passed" | "stopped" | "skipped";
  observed: unknown;
};
const steps: Step[] = [];
const outbound: { at: number; host: string; path: string; method: string; status?: number }[] = [];
let stoppedAt: string | null = null;
const passed = new Set<string>();
const cancellation = new AbortController();
const cancel = (reason: string) => {
  if (!cancellation.signal.aborted) {
    record("execution.cancelled", "stopped", { reason });
    cancellation.abort(new Error("Onboarding verification cancelled."));
  }
};
const cancellationTimer = setInterval(() => {
  const path = join(root, "cancel.json");
  if (existsSync(path)) cancel("launcher");
}, 100);
process.once("SIGINT", () => cancel("SIGINT"));
process.once("SIGTERM", () => cancel("SIGTERM"));
function record(step: string, status: Step["status"], observed: unknown) {
  steps.push({ step, status, observed });
  console.log(`${status.padEnd(8)} ${step}`);
  if (status === "passed") passed.add(step);
  if (status === "stopped" && stoppedAt === null) stoppedAt = step;
}
async function attempt<T>(
  step: string,
  requires: string[],
  run: () => Promise<{ value: T; observed: unknown }>,
  timeoutMs = 240_000,
) {
  const missing = requires.filter((name) => !passed.has(name));
  if (cancellation.signal.aborted) {
    record(step, "skipped", { blockedBy: ["execution.cancelled"] });
    return undefined;
  }
  if (missing.length > 0) {
    record(step, "skipped", { blockedBy: missing });
    return undefined;
  }
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { value, observed } = await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new StepStop(`Step exceeded ${timeoutMs} ms.`, null)),
          timeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    record(step, "passed", observed);
    return value;
  } catch (error) {
    record(step, "stopped", {
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof StepStop ? { detail: error.detail } : {}),
    });
    return undefined;
  }
}
class StepStop extends Error {
  constructor(
    message: string,
    readonly detail: unknown,
  ) {
    super(message);
  }
}
function stop(message: string, detail: unknown = null): never {
  throw new StepStop(message, detail);
}

const nativeFetch = globalThis.fetch;
const tls = join(root, "tls");
mkdirSync(tls, { recursive: true, mode: 0o700 });
const keyPath = join(tls, "server.key");
const certPath = join(tls, "server.pem");
const appKeyPath = join(tls, "github-app.pem");
const gitKeyPath = join(tls, "github-git.key");
const gitCertPath = join(tls, "github-git.pem");
for (const args of [
  [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    gitKeyPath,
    "-out",
    gitCertPath,
    "-days",
    "1",
    "-subj",
    "/CN=github.com",
    "-config",
    "/dev/null",
    "-addext",
    "subjectAltName=DNS:github.com",
  ],
  [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-config",
    "/dev/null",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ],
  ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", appKeyPath],
]) {
  const generated = Bun.spawnSync(["/usr/bin/openssl", ...args], {
    stdout: "ignore",
    stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", HOME: home },
  });
  if (generated.exitCode !== 0) throw new Error(generated.stderr.toString());
}
chmodSync(keyPath, 0o600);
chmodSync(appKeyPath, 0o600);
chmodSync(gitKeyPath, 0o600);
process.env.GIT_SSL_CAINFO = gitCertPath;
const ca = readFileSync(certPath, "utf8");

async function reservePort() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = server.port!;
  await server.stop(true);
  return port;
}
const pawsPort = await reservePort();
const runnerPort = await reservePort();
const origin = `https://127.0.0.1:${pawsPort}`;

const GITHUB_APP = {
  appId: "4242",
  clientId: "Iv1.fixtureclient",
  clientSecret: "fixture-github-client-secret",
  installationId: "777",
};
let github!: ReturnType<typeof startOnboardingGitHub>;
let gitRemote!: Awaited<ReturnType<typeof startOnboardingGitRemote>>;
let exeDev!: ReturnType<typeof startOnboardingExeDev>;
let guest!: ReturnType<typeof createOnboardingGuest>;
let githubOrigin = "";
const exeDevToken = `exe${crypto.randomUUID()}`;
const secretsIn = (text: string, values: string[] = github?.issued() ?? []) =>
  values.filter((value) => text.includes(value)).length;
const captured: string[] = [];
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    captured.push(
      args
        .map((value) =>
          typeof value === "string"
            ? value
            : value instanceof Error
              ? `${value.message}\n${value.stack ?? ""}`
              : Bun.inspect(value),
        )
        .join(" "),
    );
    original(...args);
  };
}
const githubChecks = () =>
  github.requests.filter(
    (entry) => entry.path === "/repos/acme/widgets" && entry.credential === "user",
  ).length;

let finearOrigin = "";
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw);
    let target: string | null = null;
    if (url.origin === "https://api.linear.app") target = `${finearOrigin}${url.pathname}`;
    if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token")
      target = `${githubOrigin}${url.pathname}`;
    if (url.origin === "https://api.github.com") target = `${githubOrigin}${url.pathname}`;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (target === null) {
      outbound.push({ at: Date.now(), host: url.host, path: url.pathname, method });
      throw new Error(`Probe refused unexpected outbound request to ${url.host}`);
    }
    const response =
      input instanceof Request
        ? await nativeFetch(new Request(target + url.search, input), init)
        : await nativeFetch(target + url.search, init);
    outbound.push({
      at: Date.now(),
      host: url.host,
      path: url.pathname,
      method,
      status: response.status,
    });
    return response;
  },
  { preconnect: () => undefined },
) as typeof fetch;

const RUNNER_VERSION = "1.0.0";
const MISE_VERSION = "2026.10.15";
type VmProjection = {
  revision: number;
  state: string;
  ready: boolean;
  detail: string;
  machine: { name: string; reused: boolean } | null;
  steps: { name: string; state: string; detail: string }[];
  retry: string | null;
  runner: { id: string; name: string } | null;
};
const exeDevCount = (operation: string) =>
  exeDev.calls.filter((call) => call.operation === operation).length;

class Browser {
  cookies = new Map<string, string>();
  requests: { method: string; path: string; status: number }[] = [];
  constructor(readonly name: string) {}
  header() {
    return [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
  }
  absorb(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const index = pair!.indexOf("=");
      const key = pair!.slice(0, index);
      const value = pair!.slice(index + 1);
      if (value === "" || /Max-Age=0/i.test(cookie)) this.cookies.delete(key);
      else this.cookies.set(key, value);
    }
  }
  async paws(path: string, init: RequestInit & { csrf?: string } = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", this.header());
    if (init.method && init.method !== "GET") headers.set("origin", origin);
    if (init.csrf) headers.set("x-paws-csrf", init.csrf);
    const response = await nativeFetch(new URL(path, origin), {
      ...init,
      headers,
      redirect: "manual",
      tls: { ca },
    } as RequestInit);
    this.absorb(response);
    this.requests.push({
      method: init.method ?? "GET",
      path: new URL(path, origin).pathname,
      status: response.status,
    });
    return response;
  }
  async json(path: string, body: unknown, csrf: string, method = "POST") {
    const response = await this.paws(path, {
      method,
      csrf,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: response.status, body: parsed as Record<string, unknown> };
  }
  async linearConsent(authorize: string, userId: string) {
    const upstream = new URL(authorize);
    if (upstream.origin !== "https://linear.app" || upstream.pathname !== "/oauth/authorize")
      stop("Paws did not redirect to the Linear authorization endpoint.", {
        location: upstream.origin + upstream.pathname,
      });
    const local = new URL(`/oauth/authorize${upstream.search}`, finearOrigin);
    const page = await nativeFetch(local);
    const html = await page.text();
    if (page.status !== 200)
      stop("Finear rejected the authorization request.", { status: page.status, body: html });
    const consent = /name="consent" value="([^"]+)"/.exec(html)?.[1];
    const forms = [...html.matchAll(/name="user_id" value="([^"]+)"/g)].map((match) => match[1]);
    if (!consent || !forms.includes(userId))
      stop("Finear consent did not offer the expected human.", { offered: forms });
    const approval = await nativeFetch(new URL("/oauth/authorize", finearOrigin), {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams([
        ["consent", consent],
        ["decision", "allow"],
        ["user_id", userId],
        ["workspace_id", PRIMARY.organization],
        ["team_id", PRIMARY.team],
      ]),
    });
    const location = approval.headers.get("location");
    if (approval.status !== 302 || !location)
      stop("Finear consent approval did not redirect.", { status: approval.status });
    return {
      callback: new URL(location),
      actor: upstream.searchParams.get("actor"),
      scope: upstream.searchParams.get("scope"),
    };
  }
  async session() {
    const response = await this.paws("/api/auth/session");
    const body = (await response.json()) as {
      csrfToken?: string;
      userId?: string;
      role?: string;
    };
    if (response.status !== 200 || !body.csrfToken)
      stop("Paws session is unavailable.", { status: response.status });
    return body as { csrfToken: string; userId: string; role: string; workspaceId: string };
  }
}

async function finearGraphQL(query: string, variables: Record<string, unknown> = {}) {
  const response = await nativeFetch(new URL("/graphql", finearOrigin), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: PRIMARY_KEY },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { data?: Record<string, unknown>; errors?: unknown };
  if (body.errors) stop("Finear GraphQL rejected the probe query.", body.errors);
  return body.data!;
}
async function finearControl(path: string, body?: unknown) {
  const response = await nativeFetch(new URL(path, finearOrigin), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${CONTROL_TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}
function executionId() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `01${[...bytes].map((byte) => alphabet[byte % 32]).join("")}`;
}
async function until<T>(
  read: () => T | Promise<T>,
  timeoutMs: number,
): Promise<Exclude<T, null | undefined | false> | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    cancellation.signal.throwIfAborted();
    const value = await read();
    if (value !== null && value !== undefined && value !== false)
      return value as Exclude<T, null | undefined | false>;
    if (Date.now() > deadline) return null;
    await Bun.sleep(250);
  }
}

const clientId = crypto.randomUUID();
const clientSecret = crypto.randomUUID();
const webhookSecret = crypto.randomUUID();
const installCallback = "http://127.0.0.1:9/paws-install";
const finearDir = join(root, "finear");
mkdirSync(finearDir, { recursive: true, mode: 0o700 });
const launcher = join(finearDir, "launch.ts");
writeFileSync(
  launcher,
  `import { createApplication } from ${JSON.stringify(`${FINEAR}/src/application.ts`)};
const application = await createApplication({
databasePath: process.env.DATABASE_PATH!,
hostname: "127.0.0.1",
port: 0,
controlToken: process.env.CONTROL_TOKEN,
clients: JSON.parse(process.env.FINEAR_CLIENTS!),
});
console.log(\`Finear listening at \${application.url}\`);
const shutdown = () => void application.close().then(() => process.exit(0));
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
`,
);
const finearLog = join(finearDir, "finear.log");
let finear: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
let paws: PawsProcess | undefined;
let finearLogWritten: Promise<void> = Promise.resolve();
let sessionId = "";
let linearAppToken = "";
let linearAppUserId = "";
let generation = 0;
let issueId = "";
let assignmentUrl = "";
let runnerId = "";
let vmName = "";
const daemon = () => {
  const current = guest.runner(vmName);
  if (!current) stop("The provisioned VM runner service is not running.", { vmName });
  return current;
};
const readinessSeen: unknown[] = [];
const member = new Browser("member");
const owner = member;

const transcriptObjects = createFakeRunnerTranscriptObjects();
const catalogued = () =>
  paws!.db
    .query<{ repository: string }, []>("SELECT repository FROM repository_catalog")
    .all()
    .map((row) => row.repository);
async function launchPaws() {
  paws = startPaws(
    {
      PATH: process.env.PATH,
      HOME: home,
      KYOTOAGENT_ROOT: agentRoot,
      PAWS_HOME: pawsHomeDir,
      TMPDIR: tmpDir,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-paws-verification-bus",
      PAWS_PORT: String(pawsPort),
      PAWS_HOST: "127.0.0.1",
      PAWS_PUBLIC_URL: origin,
      PAWS_PUBLIC_DASHBOARD: "1",
      PAWS_TLS_KEY_PATH: keyPath,
      PAWS_TLS_CERT_PATH: certPath,
      PAWS_RUNNER_HOST: "127.0.0.1",
      PAWS_RUNNER_PORT: String(runnerPort),
      LINEAR_MODE: "agent-session",
      LINEAR_CLIENT_ID: clientId,
      LINEAR_CLIENT_SECRET: clientSecret,
      LINEAR_ACCESS_TOKEN: linearAppToken,
      LINEAR_APP_USER_ID: linearAppUserId,
      LINEAR_WEBHOOKS: "true",
      LINEAR_WEBHOOK_SECRET: webhookSecret,
      GITHUB_AUTH: "app",
      GITHUB_APP_ID: GITHUB_APP.appId,
      PAWS_GITHUB_CLIENT_ID: GITHUB_APP.clientId,
      PAWS_GITHUB_CLIENT_SECRET: GITHUB_APP.clientSecret,
      GITHUB_APP_PRIVATE_KEY_PATH: appKeyPath,
    },
    {
      noTunnel: true,
      refreshRepositories: true,
      memberVm: {
        exeDev: createExeDev({
          fetch: (_url, init) => nativeFetch(`${exeDev.origin}/exec`, init),
          readToken: async () => exeDevToken,
        }),
        resources: { cpu: 2, memoryGB: 4 },
        runnerVersion: RUNNER_VERSION,
        runnerApiUrl: `https://127.0.0.1:${runnerPort}`,
        serverCa: ca,
        mise: {
          version: MISE_VERSION,
          sha256: { amd64: new Bun.CryptoHasher("sha256").update("fixture mise").digest("hex") },
        },
        pollMs: 500,
      },
      runnerTranscriptObjects: transcriptObjects,
    },
  );
  await Promise.race([
    paws.ready,
    Bun.sleep(30_000).then(() => stop("Paws readiness timed out.")),
  ]).catch((error: unknown) =>
    stop("Paws composition did not become ready.", {
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

try {
  github = startOnboardingGitHub({
    ...GITHUB_APP,
    privateKeyPem: readFileSync(appKeyPath, "utf8"),
    repository: "acme/widgets",
    user: { id: 4242, login: "fixture-member" },
  });
  githubOrigin = github.origin;
  gitRemote = await startOnboardingGitRemote({
    root: join(root, "git"),
    repository: "acme/widgets",
    certPath: gitCertPath,
    keyPath: gitKeyPath,
  });
  github.onToken = (kind, token) => gitRemote.grant(kind, token);
  exeDev = startOnboardingExeDev(exeDevToken);
  guest = createOnboardingGuest(join(root, "guests"));
  exeDev.guest = guest.run;
  guest.failInstallStatus = 1;
  await attempt("finear.start", [], async () => {
    finear = Bun.spawn([process.execPath, "--no-env-file", launcher], {
      stdin: "ignore",
      cwd: FINEAR,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        KYOTOAGENT_ROOT: agentRoot,
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        CONTROL_TOKEN,
        DATABASE_PATH: join(finearDir, "finear.sqlite"),
        NODE_EXTRA_CA_CERTS: certPath,
        FINEAR_CLIENTS: JSON.stringify([
          {
            id: clientId,
            name: "Paws",
            secret: clientSecret,
            redirectUris: [`${origin}/auth/linear/callback`, installCallback],
            scopes: ["read", "write", "app:assignable", "app:mentionable"],
            webhook: {
              url: `${origin}/webhooks/linear`,
              secret: webhookSecret,
              resourceTypes: ["Issue", "Comment", "Project"],
              agentSessionEvents: true,
            },
          },
        ]),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = finear.stdout.getReader();
    let text = "";
    const deadline = Date.now() + 20_000;
    while (!/Finear listening at (\S+)/.test(text) && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    finearLogWritten = new Response(finear.stderr)
      .text()
      .then((value) => writeFileSync(finearLog, value));
    const printed = /Finear listening at (\S+)/.exec(text)?.[1];
    if (!printed) stop("Finear did not print its URL.", { output: text });
    finearOrigin = new URL(printed).origin;
    const health = await nativeFetch(new URL("/health", finearOrigin));
    if (health.status !== 200) stop("Finear health failed.", { status: health.status });
    return {
      value: true,
      observed: {
        url: finearOrigin,
        health: health.status,
        database: join(finearDir, "finear.sqlite"),
        human: PRIMARY.member,
        note: "Finear consent accepts only its fixed fixture human per workspace, so one human is both workspace owner and delegating member.",
      },
    };
  });

  const install = await attempt("finear.app_install", ["finear.start"], async () => {
    const state = crypto.randomUUID();
    const authorize = new URL("/oauth/authorize", finearOrigin);
    authorize.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: installCallback,
      response_type: "code",
      scope: "read,write,app:assignable,app:mentionable",
      actor: "app",
      state,
    }).toString();
    const consent = await owner.linearConsent(
      `https://linear.app/oauth/authorize${authorize.search}`,
      PRIMARY.member,
    );
    if (consent.callback.searchParams.get("state") !== state) stop("OAuth state changed.");
    const exchange = await nativeFetch(new URL("/oauth/token", finearOrigin), {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: installCallback,
        code: consent.callback.searchParams.get("code")!,
      }),
    });
    const tokens = (await exchange.json()) as { access_token?: string; refresh_token?: string };
    if (!tokens.access_token)
      stop("Finear app token exchange failed.", { status: exchange.status });
    linearAppToken = tokens.access_token;
    const viewer = await nativeFetch(new URL("/graphql", finearOrigin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({ query: "query { viewer { id name app } }" }),
    });
    const identity = (await viewer.json()) as {
      data?: { viewer: { id: string; app?: boolean } };
    };
    if (!identity.data?.viewer.id) stop("Finear app viewer is unavailable.", identity);
    linearAppUserId = identity.data.viewer.id;
    return {
      value: { accessToken: tokens.access_token, appUserId: identity.data.viewer.id },
      observed: {
        actor: "app",
        installedBy: PRIMARY.member,
        appViewer: identity.data.viewer.id,
        appFlag: identity.data.viewer.app ?? null,
      },
    };
  });

  await attempt("paws.start", ["finear.app_install"], async () => {
    const pawsHome = pawsHomeDir;
    const initialized = Bun.spawnSync(
      [process.execPath, "--no-env-file", "src/index.ts", "runner-authority", "init"],
      {
        cwd: repositoryRoot,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          KYOTOAGENT_ROOT: agentRoot,
          PAWS_HOME: pawsHome,
          TMPDIR: tmpDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (initialized.exitCode !== 0)
      stop("Runner authority init failed.", initialized.stderr.toString().slice(0, 400));
    await launchPaws();
    const health = await nativeFetch(`${origin}/health`, { tls: { ca } } as RequestInit);
    return {
      value: true,
      observed: { origin, runnerPort, health: health.status, onboardingEnabled: true },
    };
  });

  await attempt("workspace.owner_bootstrap", ["paws.start"], async () => {
    const code = issueWorkspaceBootstrap(paws!.db, PRIMARY.organization);
    const begin = await owner.paws("/auth/linear", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ bootstrap: code }).toString(),
    });
    const location = begin.headers.get("location");
    if (!location) stop("Paws did not start Linear sign-in.", { status: begin.status });
    const consent = await owner.linearConsent(location, PRIMARY.member);
    const callback = await owner.paws(consent.callback.pathname + consent.callback.search);
    if (callback.status !== 303)
      stop("Paws rejected the owner callback.", {
        status: callback.status,
        body: await callback.text(),
      });
    const session = await owner.session();
    return {
      value: true,
      observed: {
        consentActor: consent.actor,
        consentScope: consent.scope,
        callback: callback.status,
        destination: callback.headers.get("location"),
        role: session.role,
      },
    };
  });

  await attempt("workspace.github_app_setup", ["workspace.owner_bootstrap"], async () => {
    github.access = "admin";
    const session = await owner.session();
    const begin = await owner.json("/api/workspaces/github-setup", {}, session.csrfToken);
    const authorizationUrl = begin.body?.authorizationUrl;
    if (begin.status !== 200 || typeof authorizationUrl !== "string")
      stop("Paws did not start owner GitHub App setup.", begin);
    const callback = await github.consent(authorizationUrl);
    if (callback.origin !== origin) stop("GitHub setup callback left Paws.", callback.origin);
    const completed = await owner.paws(callback.pathname + callback.search);
    if (completed.status !== 303)
      stop("Paws rejected the GitHub setup callback.", {
        status: completed.status,
        body: await completed.text(),
      });
    const choicesResponse = await owner.paws("/api/workspaces/github-setup");
    const choices = (await choicesResponse.json()) as {
      setupId?: string;
      installationId?: string | null;
      repositories?: { repository: string }[];
      teams?: { id: string }[];
    };
    if (
      choicesResponse.status !== 200 ||
      !choices.setupId ||
      !choices.installationId ||
      !choices.repositories?.some((entry) => entry.repository === "acme/widgets") ||
      !choices.teams?.some((team) => team.id === PRIMARY.team)
    )
      stop("GitHub setup did not offer acme/widgets for the Finear team.", {
        status: choicesResponse.status,
        choices,
      });
    const saved = await owner.json(
      "/api/workspaces/github-setup",
      {
        installationId: choices.installationId,
        setupId: choices.setupId,
        mappings: [{ repository: "acme/widgets", teamId: PRIMARY.team }],
      },
      (await owner.session()).csrfToken,
      "PUT",
    );
    if (saved.status !== 200) stop("Owner GitHub App setup was not saved.", saved);
    const connection = await owner.paws("/api/workspaces/github-connect");
    const connect = (await connection.json()) as { status?: string };
    if (connect.status !== "connected")
      stop("The workspace GitHub App is not connected after setup.", connect);
    return {
      value: true,
      observed: {
        callback: completed.status,
        installationId: choices.installationId,
        offered: choices.repositories,
        saved: saved.status,
        connect: connect.status,
        githubRequests: github.requests.map(({ path, method, credential, status }) => ({
          path,
          method,
          credential,
          status,
        })),
      },
    };
  });

  await attempt("workspace.repository_catalog", ["workspace.github_app_setup"], async () => {
    const listed = await until(
      () => (catalogued().includes("acme/widgets") ? catalogued() : null),
      20_000,
    );
    if (!listed)
      stop(
        "GitHub App setup did not refresh repository_catalog, so onboarding preparation offers no repository.",
        { catalog: catalogued() },
      );
    return { value: true, observed: { catalog: listed } };
  });
  await attempt("linear.delegate_issue", ["workspace.repository_catalog"], async () => {
    github.access = "pull";
    const created = await finearGraphQL(
      `mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }`,
      {
        input: {
          teamId: PRIMARY.team,
          title: "Add a widgets health endpoint",
          description: "Return 200 from /health in acme/widgets.",
          assigneeId: PRIMARY.member,
        },
      },
    );
    const issue = (created.issueCreate as { issue: { id: string; identifier: string } }).issue;
    issueId = issue.id;
    const delegated = await finearControl("/__test/agents/delegate", {
      fixture: "primary",
      issueId,
      appUserId: install!.appUserId,
    });
    if (delegated.status !== 200) stop("Finear delegation failed.", delegated);
    const held = await until(
      () =>
        paws!.db
          .query<{ sessionId: string; generation: number; status: string }, []>(
            "SELECT session_id AS sessionId,generation,status FROM workspace_assignment ORDER BY rowid DESC LIMIT 1",
          )
          .get(),
      30_000,
    );
    const deliveries = await finearControl("/__test/deliveries");
    if (!held)
      stop("Paws created no assignment hold for the delegated session.", {
        delegated: delegated.body,
        deliveries: deliveries.body,
        inbox: paws!.db.query("SELECT delivery_id,action,handled FROM inbox_event").all(),
      });
    sessionId = held.sessionId;
    generation = held.generation;
    return {
      value: true,
      observed: {
        issue: issue.identifier,
        delegation: delegated.body,
        hold: held,
        signedDeliveries: deliveries.body,
      },
    };
  });

  await attempt("linear.assignment_link", ["linear.delegate_issue"], async () => {
    const found = await until(() => {
      const row = paws!.db
        .query<{ status: string; attempts: number; error: string | null }, []>(
          "SELECT status,attempts,error FROM outbox WHERE op='elicitation' ORDER BY id DESC LIMIT 1",
        )
        .get();
      return row && row.status !== "pending" ? row : null;
    }, 30_000);
    const activities = await finearGraphQL(
      `query Session($id: String!) { agentSession(id: $id) { status activities { nodes { signal signalMetadata content { __typename ... on AgentActivityElicitationContent { body } } } } } }`,
      { id: sessionId },
    );
    const session = activities.agentSession as {
      status: string;
      activities: { nodes: { signal: string | null; signalMetadata: { url?: string } | null }[] };
    };
    for (const node of session.activities.nodes)
      if (typeof node.signalMetadata === "string")
        node.signalMetadata = JSON.parse(node.signalMetadata) as { url?: string };
    const auth = session.activities.nodes.find(
      (node) => node.signal === "auth" && node.signalMetadata?.url,
    );
    if (!auth?.signalMetadata?.url) {
      stop("No auth elicitation reached the Finear session.", {
        outbox: found,
        session,
        pawsActivities: paws!.db
          .query(
            "SELECT op,status,error,json_extract(payload,'$.kind') AS kind,json_extract(payload,'$.body') AS body FROM outbox WHERE ordering_key=? ORDER BY id",
          )
          .all(sessionId),
        hold: paws!.db
          .query("SELECT status FROM workspace_assignment WHERE session_id=?")
          .get(sessionId),
      });
    }
    assignmentUrl = auth.signalMetadata.url;
    const link = new URL(assignmentUrl);
    return {
      value: true,
      observed: {
        outbox: found,
        sessionStatus: session.status,
        linkPath: link.pathname,
        linkOrigin: link.origin,
      },
    };
  });

  await attempt("member.sign_in_from_assignment", ["linear.assignment_link"], async () => {
    const link = new URL(assignmentUrl);
    if (link.origin !== origin) stop("The delivered assignment link leaves Paws.", link.origin);
    const begin = await member.paws(link.pathname + link.search);
    const location = begin.headers.get("location");
    if (!location)
      stop("Paws refused the assignment sign-in link.", {
        status: begin.status,
        body: await begin.text(),
      });
    const consent = await member.linearConsent(location, PRIMARY.member);
    const callback = await member.paws(consent.callback.pathname + consent.callback.search);
    const destination = callback.headers.get("location");
    if (callback.status !== 303 || !destination?.startsWith("/status/onboarding/"))
      stop("Member did not land on the onboarding page.", {
        status: callback.status,
        destination,
      });
    const page = await member.paws(destination);
    const state = await member.paws(
      `/api/workspaces/onboarding?session=${encodeURIComponent(sessionId)}&generation=${generation}`,
    );
    return {
      value: true,
      observed: {
        destination,
        page: { status: page.status, type: page.headers.get("content-type") },
        onboarding: await state.json(),
        hold: paws!.db
          .query("SELECT status FROM workspace_assignment WHERE session_id=?")
          .get(sessionId),
      },
    };
  });

  await attempt("member.onboarding_page", ["member.sign_in_from_assignment"], async () => {
    const path = `/status/onboarding/${encodeURIComponent(sessionId)}/${generation}`;
    const route = "assignment sign-in destination";
    const page = await member.paws(path);
    const state = await member.paws(
      `/api/workspaces/onboarding?session=${encodeURIComponent(sessionId)}&generation=${generation}`,
    );
    if (state.status !== 200)
      stop("Onboarding state is unavailable.", {
        status: state.status,
        body: await state.text(),
      });
    return {
      value: true,
      observed: {
        route,
        page: { status: page.status, type: page.headers.get("content-type") },
        onboarding: await state.json(),
      },
    };
  });

  await attempt("member.connect_github", ["member.onboarding_page"], async () => {
    const session = await member.session();
    const begin = await member.json(
      "/api/workspaces/member-github",
      { onboarding: { sessionId, generation } },
      session.csrfToken,
    );
    const authorizeUrl = begin.body?.authorizeUrl;
    if (begin.status !== 200 || typeof authorizeUrl !== "string")
      stop("Paws did not start member GitHub sign-in.", begin);
    const callback = await github.consent(authorizeUrl);
    if (callback.origin !== origin) stop("Member GitHub callback left Paws.", callback.origin);
    const completed = await member.paws(callback.pathname + callback.search);
    if (completed.status !== 303)
      stop("Paws rejected the GitHub callback.", {
        status: completed.status,
        body: await completed.text(),
      });
    const status = await member.paws("/api/workspaces/member-github");
    return {
      value: true,
      observed: {
        callback: completed.status,
        destination: new URL(completed.headers.get("location")!).pathname,
        identity: ((await status.json()) as { identity: unknown }).identity,
        exchange: github.requests.filter((entry) => entry.path === "/login/oauth/access_token")
          .length,
      },
    };
  });

  const onboardingVm = async () => {
    const response = await member.paws(
      `/api/workspaces/onboarding?session=${encodeURIComponent(sessionId)}&generation=${generation}`,
    );
    const body = (await response.json()) as { vm?: VmProjection };
    return body.vm ?? null;
  };
  const memberVmRow = () =>
    paws!.db
      .query<
        {
          id: string;
          provider_name: string;
          run: number;
          step: string;
          state: string;
          failure: string | null;
          create_outcome: string;
          runner_id: string | null;
        },
        []
      >("SELECT id,provider_name,run,step,state,failure,create_outcome,runner_id FROM member_vm")
      .all();

  await attempt("vm.automatic_create", ["member.onboarding_page"], async () => {
    const created = await until(
      () => (exeDevCount("create") > 0 && memberVmRow().length === 1 ? memberVmRow()[0] : null),
      60_000,
    );
    if (!created)
      stop("Paws did not ask exe.dev to create a member VM.", {
        exeDevCalls: exeDev?.calls ?? [],
        memberVm: memberVmRow(),
        vm: await onboardingVm(),
      });
    vmName = created.provider_name;
    return {
      value: true,
      observed: {
        providerName: vmName,
        exeDevCalls: exeDev.calls.slice(),
        vmsAtProvider: [...exeDev.vms.keys()],
      },
    };
  });

  await attempt("vm.install_failure_visible", ["vm.automatic_create"], async () => {
    const failed = await until(async () => {
      const vm = await onboardingVm();
      return vm?.state === "failed" ? vm : null;
    }, 60_000);
    if (!failed)
      stop("The injected guest install failure never surfaced on the onboarding page.", {
        vm: await onboardingVm(),
        memberVm: memberVmRow(),
        guest: guest.events,
      });
    if (
      failed.retry !== "install" ||
      failed.steps.find((entry) => entry.name === "install")?.state !== "failed" ||
      failed.steps.find((entry) => entry.name === "create")?.state !== "done"
    )
      stop("The install failure is not a retryable install failure.", failed);
    return {
      value: true,
      observed: {
        vm: failed,
        creates: exeDevCount("create"),
        memberVm: memberVmRow(),
        guest: guest.events.slice(),
      },
    };
  });

  await attempt("member.retry_vm", ["vm.install_failure_visible"], async () => {
    const createsBefore = exeDevCount("create");
    const runBefore = memberVmRow()[0]?.run ?? null;
    const before = await onboardingVm();
    const retried = await member.json(
      "/api/workspaces/onboarding/vm/retry",
      { session: sessionId, generation, revision: before?.revision, step: before?.retry },
      (await member.session()).csrfToken,
    );
    if (retried.status !== 200) stop("Paws refused the member's VM retry.", retried);
    return {
      value: true,
      observed: {
        status: retried.status,
        vm: retried.body,
        createsBefore,
        runBefore,
        runAfter: memberVmRow()[0]?.run ?? null,
      },
    };
  });

  await attempt(
    "vm.ready_without_selection",
    ["member.retry_vm"],
    async () => {
      const ready = await until(async () => {
        const vm = await onboardingVm();
        return vm?.ready ? vm : null;
      }, 150_000);
      const row = memberVmRow()[0];
      const paired = guest.runner(vmName)?.status();
      if (!ready || !row || paired?.phase !== "paired")
        stop("The provisioned VM did not become the ready assignment runner.", {
          vm: await onboardingVm(),
          memberVm: memberVmRow(),
          guest: guest.events,
          heartbeats: guest.heartbeats.length,
          exeDevCalls: exeDev?.calls ?? [],
        });
      runnerId = paired.runnerId;
      const manualSelections = member.requests.filter(
        (entry) =>
          (entry.method === "POST" && entry.path === "/api/workspaces/onboarding/vm") ||
          entry.path === "/api/runner-pairings" ||
          entry.path === "/api/runners/pairings/approve",
      );
      if (
        ready.state !== "ready" ||
        ready.machine?.name !== vmName ||
        ready.machine.reused ||
        ready.runner?.id !== runnerId ||
        row.runner_id !== runnerId ||
        exeDevCount("create") !== 1 ||
        manualSelections.length !== 0
      )
        stop("The ready VM is not the single automatically provisioned runner.", {
          ready,
          row,
          runnerId,
          creates: exeDevCount("create"),
          manualSelections,
        });
      const markers = guest.events.map((event) => `${event.marker}:${event.exitCode}`);
      return {
        value: true,
        observed: {
          vm: ready,
          runnerId,
          memberVm: row,
          creates: exeDevCount("create"),
          exeDevOperations: exeDev.calls.map((call) => call.operation),
          guestMarkers: markers,
          stagedConfig: {
            ...guest.config(vmName),
            serverCa: guest.config(vmName)?.serverCa ? "present" : null,
          },
          installerSha256: guest.installerDigest(vmName),
          heartbeats: (guest?.heartbeats ?? []).filter((beat) => beat.ok).length,
          manualSelections: manualSelections.length,
        },
      };
    },
    200_000,
  );

  await attempt("member.agent_sign_in", ["vm.ready_without_selection"], async () => {
    const session = await member.session();
    const results: Record<string, unknown> = {};
    for (const agent of ["claude", "codex"] as const) {
      const challenge = await member.json(
        `/api/workspaces/onboarding/agents/${agent}/login`,
        { session: sessionId, generation, runnerId },
        session.csrfToken,
      );
      if (challenge.status !== 200 || typeof challenge.body.id !== "string")
        stop(`Paws did not start ${agent} sign-in.`, challenge);
      const exchanged = await daemon().exchangeLogin(challenge.body.id, {
        state: "connected",
        terminal: "",
        authorization: null,
        inputId: null,
      });
      let check: unknown = null;
      for (let tries = 0; tries < 40 && check === null; tries++) {
        await daemon().pollCommands();
        const command = daemon()
          .pendingCommands()
          .find((entry) => entry.type === "login_check" && entry.agent === agent);
        if (command)
          check = await daemon().postHealth({
            executionId: executionId(),
            commandId: command.id,
            role: "implementer",
            stopReason: "end_turn",
            timedOut: false,
            cancelled: false,
            authRequired: false,
            agentExited: true,
            login: { agent, authenticated: true, method: "subscription" },
          } as Parameters<RunnerDaemon["postHealth"]>[0]);
        else await Bun.sleep(500);
      }
      results[agent] = {
        challenge: { status: challenge.status, state: challenge.body.state },
        runnerExchange: exchanged,
        loginCheck: check ?? "no login_check command",
      };
    }
    const state = await member.paws(
      `/api/workspaces/onboarding/agents?session=${encodeURIComponent(sessionId)}&generation=${generation}`,
    );
    const body = (await state.json()) as { ready?: boolean; agents?: unknown };
    if (!body.ready) stop("Agent sign-in did not reach ready.", { results, state: body });
    return { value: true, observed: { results, state: body } };
  });

  const projectionNow = () => {
    const row = paws!.db
      .query<{ projection: string; revision: number }, [string]>(
        "SELECT projection,revision FROM onboarding_readiness WHERE session_id=?",
      )
      .get(sessionId);
    return row
      ? {
          revision: row.revision,
          ...(JSON.parse(row.projection) as {
            state: string;
            reason: string | null;
            memberGitHub: unknown;
            prepared?: { state?: string } | null;
          }),
        }
      : null;
  };

  await attempt("readiness.first_check", ["member.agent_sign_in"], async () => {
    const projection = await until(projectionNow, 60_000);
    readinessSeen.push(projection);
    const job = paws!.db
      .query(
        "SELECT status,attempts,last_error FROM job WHERE queue='workspace.assignment' ORDER BY id DESC LIMIT 1",
      )
      .get();
    if (!projection) stop("No onboarding readiness projection was written.", { job });
    return {
      value: true,
      observed: {
        projection,
        expectedWait:
          projection.reason === "metadata" && projection.prepared?.state === "waiting_mode",
        job,
      },
    };
  });

  await attempt(
    "member.choose_mode",
    ["readiness.first_check", "member.connect_github"],
    async () => {
      const before = projectionNow()?.revision ?? 0;
      const prepared = await member.paws(
        `/api/workspaces/onboarding/preparation?session=${sessionId}&generation=${generation}`,
      );
      const current = (await prepared.json()) as {
        revision?: number;
        state?: string;
        offered?: { owner: string; repo: string }[];
      };
      if (!current.revision)
        stop("Preparation was not readable.", { status: prepared.status, current });
      if (current.state !== "waiting_mode")
        return { value: true, observed: { asked: false, preparedState: current.state ?? null } };
      const offered = current.offered?.find(
        (entry) => entry.owner === "acme" && entry.repo === "widgets",
      );
      if (!offered) stop("Preparation did not offer acme/widgets.", current);
      const answered = await member.json(
        "/api/workspaces/onboarding/preparation",
        {
          session: sessionId,
          generation,
          revision: current.revision,
          mode: "code",
          repository: `${offered.owner}/${offered.repo}`,
        },
        (await member.session()).csrfToken,
      );
      if (answered.status !== 200) stop("The member could not answer the task mode.", answered);
      const projection = await until(() => {
        const value = projectionNow();
        return value && value.revision > before && value.reason !== "metadata" ? value : null;
      }, 90_000);
      readinessSeen.push(projection);
      if (!projection)
        stop("Readiness stayed on metadata after the member answered.", projectionNow());
      return {
        value: true,
        observed: { preparedState: current.state ?? null, answered: answered.body, projection },
      };
    },
  );

  await attempt("readiness.github_denied", ["member.choose_mode"], async () => {
    github.access = "pull";
    const before = githubChecks();
    const revisionBefore = projectionNow()?.revision ?? 0;
    const projection = await until(() => {
      const value = projectionNow();
      return freshPermissionDenial(value, revisionBefore, githubChecks() - before) ? value : null;
    }, 90_000);
    if (!projection)
      stop("No fresh GitHub permission denial was observed.", {
        permissionChecks: githubChecks() - before,
        revisionBefore,
        latest: projectionNow(),
      });
    const latest = projection;
    readinessSeen.push(latest);
    const items = paws!.db.query("SELECT id,state FROM work_item").all();
    if (latest?.state === "ready")
      stop("Readiness passed while member GitHub permission was denied.", { latest, items });
    if (items.length > 0) stop("Work was created while member GitHub was denied.", { items });
    return {
      value: true,
      observed: {
        projection: latest,
        permissionChecks: githubChecks(),
        workItems: items.length,
      },
    };
  });

  await attempt("readiness.after_github_permission", ["readiness.github_denied"], async () => {
    github.access = "push";
    const started = performance.now();
    const journal: unknown[] = [];
    let last = "";
    const projection = await until(() => {
      const value = projectionNow();
      const row = paws!.db
        .query<{ revision: number; fingerprint: string }, [string]>(
          "SELECT revision,fingerprint FROM onboarding_readiness WHERE session_id=?",
        )
        .get(sessionId);
      const state = {
        policy: paws!.db
          .query(
            "SELECT policy_revision,policy_applied_revision,policy_fence,policy_applied_fence,updated_at FROM member_vm",
          )
          .get(),
        assignment: paws!.db
          .query(
            "SELECT status,run_at,fire_count FROM job WHERE queue='workspace.assignment' AND json_extract(payload,'$.sessionId')=? ORDER BY id DESC LIMIT 1",
          )
          .get(sessionId),
        readiness: row
          ? {
              revision: row.revision,
              fingerprintSha256: createHash("sha256").update(row.fingerprint).digest("hex"),
              state: value?.state,
              reason: value?.reason,
            }
          : null,
      };
      const serialized = JSON.stringify(state);
      if (serialized !== last) {
        journal.push({ elapsedMs: performance.now() - started, at: Date.now(), ...state });
        last = serialized;
      }
      return value?.state === "ready" ? value : null;
    }, 180_000);
    readinessSeen.push({ projection: projection ?? projectionNow(), journal });
    if (!projection)
      stop("Readiness did not become ready after GitHub permission flipped.", {
        projection: projectionNow(),
        journal,
      });
    return { value: true, observed: { projection, journal } };
  });

  let boundItem = "";
  await attempt("work.created_and_bound", ["readiness.after_github_permission"], async () => {
    const binding = await until(
      () =>
        paws!.db
          .query<{ item_id: string; snapshot: string }, []>(
            "SELECT item_id,snapshot FROM onboarding_item_binding",
          )
          .get(),
      60_000,
    );
    if (!binding)
      stop("No onboarding-bound work item was created.", {
        finearSession: (
          await finearGraphQL(
            `query Session($id: String!) { agentSession(id: $id) { status startedAt endedAt } }`,
            { id: sessionId },
          )
        ).agentSession,
        assignmentJob: paws!.db
          .query(
            "SELECT status,attempts,last_error FROM job WHERE queue='workspace.assignment' ORDER BY id DESC LIMIT 1",
          )
          .get(),
        items: paws!.db.query("SELECT id,state FROM work_item").all(),
        hold: paws!.db.query("SELECT status FROM workspace_assignment").all(),
        classifications: paws!.db.query("SELECT task_key,classification FROM task_request").all(),
        outbox: paws!.db
          .query(
            "SELECT op,status,json_extract(payload,'$.kind') AS kind,json_extract(payload,'$.body') AS body FROM outbox WHERE ordering_key=? ORDER BY id",
          )
          .all(sessionId),
      });
    boundItem = binding.item_id;
    return {
      value: true,
      observed: {
        itemId: binding.item_id,
        snapshot: JSON.parse(binding.snapshot),
        item: paws!.db
          .query(
            "SELECT id,state,task_key,session_key,current_run_id,owner_user_id FROM work_item WHERE id=?",
          )
          .get(binding.item_id),
      },
    };
  });

  await attempt("member.github_attribution_consent", ["work.created_and_bound"], async () => {
    const begin = await member.json(
      "/api/workspaces/github-attribution",
      { consent: true },
      (await member.session()).csrfToken,
    );
    const authorizeUrl = begin.body?.authorizeUrl;
    if (begin.status !== 200 || typeof authorizeUrl !== "string")
      stop("Paws did not start GitHub attribution consent.", begin);
    const callback = await github.consent(authorizeUrl);
    if (callback.origin !== origin) stop("Attribution callback left Paws.", callback.origin);
    const completed = await member.paws(callback.pathname + callback.search);
    if (completed.status !== 303)
      stop("Paws rejected the attribution callback.", {
        status: completed.status,
        body: await completed.text(),
      });
    const identity = await member.paws("/api/workspaces/github-attribution");
    return {
      value: true,
      observed: {
        callback: completed.status,
        identity: ((await identity.json()) as { identity?: unknown }).identity ?? null,
      },
    };
  });

  const provisionedDaemon = guest.runner(vmName);
  let placed: Record<string, unknown> | undefined;
  const seenCommands = new Set<string>();
  const rejections = new Map<string, number>();
  const deniedRepositories = new Set<string>();
  const awaitPlacement = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    let pollError: string | null = null;
    while (!placed && Date.now() < deadline) {
      try {
        const polled = await daemon().pollCommands();
        for (const reason of polled.rejected)
          rejections.set(reason, (rejections.get(reason) ?? 0) + 1);
        for (const repository of polled.deniedRepositories) deniedRepositories.add(repository);
        pollError = null;
      } catch (error) {
        pollError = error instanceof Error ? error.message : String(error);
      }
      const commands = daemon().pendingCommands() as unknown as Record<string, unknown>[];
      for (const command of commands) seenCommands.add(`${command.type}:${command.id}`);
      placed = commands.find(
        (command) => command.type === "run" && command.itemId === boundItem && command.runId,
      );
      if (!placed) await Bun.sleep(1_000);
    }
    if (!placed)
      stop("No run command for the bound item was accepted by the provisioned runner.", {
        commandsSeen: [...seenCommands],
        rejected: Object.fromEntries(rejections),
        deniedRepositories: [...deniedRepositories],
        provisionedAllowedRepositories: guest.config(vmName)?.allowedRepositories ?? null,
        pollError,
        item: paws!.db
          .query("SELECT id,state,current_run_id FROM work_item WHERE id=?")
          .get(boundItem),
        runs: paws!.db.query("SELECT id,status FROM run WHERE item_id=?").all(boundItem),
        lastActivities: paws!.db
          .query(
            "SELECT op,status,json_extract(payload,'$.kind') AS kind,json_extract(payload,'$.body') AS body FROM outbox WHERE ordering_key=? ORDER BY id DESC LIMIT 3",
          )
          .all(sessionId),
        jobs: paws!.db
          .query(
            "SELECT queue,status,attempts,last_error FROM job WHERE status!='done' ORDER BY id DESC LIMIT 20",
          )
          .all(),
      });
    if (placed.runnerId !== runnerId)
      stop("The bound item was placed on a runner other than the provisioned VM.", {
        placedRunner: placed.runnerId ?? null,
        provisionedRunner: runnerId,
      });
    const run = paws!.db
      .query<{ id: string; status: string }, [string]>(
        "SELECT run.id,run.status FROM run JOIN work_item ON work_item.current_run_id=run.id WHERE work_item.id=?",
      )
      .get(boundItem);
    const repository = placed.repository as { remoteUrl?: string; baseSha?: string } | undefined;
    if (
      run?.id !== placed.runId ||
      run?.status !== "active" ||
      repository?.remoteUrl !== "https://github.com/acme/widgets.git" ||
      repository.baseSha !== gitRemote.head
    )
      stop("The accepted run does not match the current item and private repository.", {
        run,
        commandRun: placed.runId,
        repository,
        expectedBase: gitRemote.head,
      });
    const policy = guest.policy(vmName);
    const applied = paws!.db
      .query<
        {
          policy_revision: number;
          policy_applied_revision: number;
          policy_fence: number;
          policy_applied_fence: number;
        },
        [string]
      >(
        "SELECT policy_revision,policy_applied_revision,policy_fence,policy_applied_fence FROM member_vm WHERE runner_id=?",
      )
      .get(runnerId);
    if (
      !policy?.repositories.includes("acme/widgets") ||
      policy.revision !== applied?.policy_revision ||
      policy.revision !== applied.policy_applied_revision ||
      policy.fence !== applied.policy_fence ||
      policy.fence !== applied.policy_applied_fence ||
      daemon() !== provisionedDaemon
    )
      stop("Placement did not use the exact applied policy on the original running daemon.", {
        policy,
        applied,
        sameDaemon: daemon() === provisionedDaemon,
      });
    const serialized = JSON.stringify(placed);
    if (secretsIn(serialized, [...(github?.issued() ?? []), exeDevToken]) !== 0)
      stop("The accepted run command contains provider credentials.");
    return {
      value: true,
      observed: {
        type: placed.type,
        runId: placed.runId,
        runnerId: placed.runnerId,
        provisionedRunner: runnerId,
        repository: placed.repository ?? null,
        policy,
        appliedPolicy: applied,
        sameDaemon: daemon() === provisionedDaemon,
        rejectedBeforeAcceptance: Object.fromEntries(rejections),
        issuedSecretsInCommand: secretsIn(serialized, [...(github?.issued() ?? []), exeDevToken]),
      },
    };
  };
  await attempt(
    "work.placed_after_ready",
    ["work.created_and_bound", "member.github_attribution_consent"],
    () => awaitPlacement(60_000),
  );
  if (!passed.has("work.placed_after_ready") && passed.has("work.created_and_bound")) {
    await attempt("work.placed_on_member_vm", ["member.github_attribution_consent"], () =>
      awaitPlacement(150_000),
    );
  }
  const placementStep = passed.has("work.placed_after_ready")
    ? "work.placed_after_ready"
    : "work.placed_on_member_vm";

  const failure = (error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: (error as { status?: unknown }).status ?? null,
  });
  const credential = async () => {
    const runId = String(placed!.runId);
    const runGeneration = Number(placed!.generation);
    const grant = await daemon()
      .issueRunGrant(runId, { commandId: String(placed!.id), generation: runGeneration })
      .then((value) => ({ ok: true as const, token: value.token }), failure);
    if (!("token" in grant)) return { grant, credential: null };
    const result = await daemon()
      .repositoryCredential(runId, runGeneration, "write", grant.token)
      .then((value) => ({ ok: true as const, body: value }), failure);
    return { grant: { ok: true }, credential: result };
  };

  await attempt("credential.member_denied", [placementStep], async () => {
    github.access = "pull";
    const mintedBefore = github.minted.length;
    const checksBefore = githubChecks();
    const result = await credential();
    const observed = {
      grant: result.grant,
      credential: result.credential && "ok" in result.credential ? "issued" : result.credential,
      appTokensMinted: github.minted.length - mintedBefore,
      memberPermissionChecks: githubChecks() - checksBefore,
    };
    if (result.credential && "ok" in result.credential)
      stop(
        "The provisioned runner received a repository credential while member GitHub access was revoked.",
        observed,
      );
    if (
      !("ok" in result.grant) ||
      !result.credential ||
      !("status" in result.credential) ||
      result.credential.status !== 403 ||
      observed.memberPermissionChecks < 1 ||
      observed.appTokensMinted !== 0
    )
      stop(
        "Credential denial did not prove a live member-permission refusal before token mint.",
        observed,
      );
    return { value: true, observed };
  });

  const runtimePolicy = () => {
    const row = paws!.db
      .query<
        {
          policy_revision: number;
          policy_applied_revision: number;
          policy_fence: number;
          policy_applied_fence: number;
        },
        [string]
      >(
        "SELECT policy_revision,policy_applied_revision,policy_fence,policy_applied_fence FROM member_vm WHERE runner_id=?",
      )
      .get(runnerId);
    return {
      durable: row,
      guest: guest.policy(vmName),
      grants: paws!.db
        .query<{ repository: string }, [string, number]>(
          "SELECT repository FROM member_vm_repository_grant WHERE session_id=? AND generation=?",
        )
        .all(sessionId, generation),
      sameDaemon: guest.runner(vmName) === provisionedDaemon,
    };
  };
  await attempt("policy.runtime_denial_withdrawn", ["credential.member_denied"], async () => {
    const withdrawn = await until(() => {
      const state = runtimePolicy();
      return state.guest &&
        !state.guest.repositories.includes("acme/widgets") &&
        state.grants.length === 0 &&
        state.durable &&
        state.guest.revision === state.durable.policy_revision &&
        state.guest.revision === state.durable.policy_applied_revision &&
        state.guest.fence === state.durable.policy_fence &&
        state.guest.fence === state.durable.policy_applied_fence
        ? state
        : null;
    }, 30_000);
    if (!withdrawn || !withdrawn.sameDaemon)
      stop(
        "Fresh runtime member denial did not withdraw the guest grant on the original daemon.",
        runtimePolicy(),
      );
    const pending = daemon().pendingCommands();
    if (pending.some((command) => command.id === placed?.id))
      stop(
        "The daemon still exposes the queued run after its repository policy was withdrawn.",
        withdrawn,
      );
    return { value: true, observed: { ...withdrawn, queuedRevokedRunVisible: false } };
  });

  await attempt(
    "credential.member_restored",
    ["credential.member_denied", "policy.runtime_denial_withdrawn"],
    async () => {
      github.access = "push";
      const mintedBefore = github.minted.length;
      const checksBefore = githubChecks();
      const requestBefore = github.requests.length;
      const result = await credential();
      const body = result.credential && "body" in result.credential ? result.credential.body : null;
      const tokenSha256 = body ? createHash("sha256").update(body.token).digest("hex") : null;
      const minted = github.minted.slice(mintedBefore);
      const matched = minted.filter((entry) => entry.tokenSha256 === tokenSha256);
      const requests = github.requests.slice(requestBefore).sort((a, b) => a.sequence - b.sequence);
      const checks = requests.filter(
        (entry) =>
          entry.path === "/repos/acme/widgets" &&
          entry.credential === "user" &&
          entry.status === 200 &&
          entry.memberPush === true,
      );
      const identityMints = minted.filter((entry) => entry.tokenSha256 !== tokenSha256);
      const observed = {
        grant: result.grant,
        credential: body ? "issued" : result.credential,
        minted,
        matchedDeliveredMints: matched.length,
        requestedAccess: "write",
        branch: body?.branch ?? null,
        deliveredTokenSha256: tokenSha256,
        requestSequence: requests,
        memberPermissionChecks: githubChecks() - checksBefore,
        remoteUrl: body?.remoteUrl ?? null,
        memberSecretsReturned: secretsIn(
          JSON.stringify(body ?? ""),
          github.issued().filter((value) => value.startsWith("ghu_")),
        ),
      };
      if (!body)
        stop("The provisioned runner received no repository credential after restore.", observed);
      if (observed.memberSecretsReturned !== 0)
        stop("The repository credential carried the member's GitHub token.", observed);
      if (
        observed.memberPermissionChecks < 2 ||
        matched.length !== 1 ||
        matched[0]?.installationId !== GITHUB_APP.installationId ||
        JSON.stringify(matched[0]?.repositories) !== JSON.stringify(["widgets"]) ||
        JSON.stringify(matched[0]?.permissions) !== JSON.stringify(INSTALLATION_PERMISSIONS) ||
        checks.length < 2 ||
        minted.some((entry) => !checks.some((check) => check.sequence < entry.sequence)) ||
        minted.some((entry) => !checks.some((check) => check.sequence > entry.sequence)) ||
        identityMints.some(
          (entry) =>
            entry.installationId !== GITHUB_APP.installationId ||
            JSON.stringify(entry.repositories) !== JSON.stringify(["widgets"]) ||
            JSON.stringify(entry.permissions) !==
              JSON.stringify({ contents: "read", metadata: "read" }) ||
            !requests.some(
              (request) =>
                request.sequence > entry.sequence &&
                request.status === 200 &&
                request.tokenSha256 === entry.tokenSha256 &&
                request.path === "/users/paws-fixture%5Bbot%5D",
            ),
        ) ||
        body.remoteUrl !== "https://github.com/acme/widgets.git" ||
        body.branch !==
          paws!.db
            .query<{ branch_name: string }, [string]>(
              "SELECT branch_name FROM work_item WHERE id=?",
            )
            .get(boundItem)?.branch_name ||
        !github.issued().includes(body.token) ||
        !body.token.startsWith("ghs_")
      )
        stop(
          "Credential restoration did not match the delivered scoped token and freshly authorized identity mints.",
          observed,
        );
      return { value: true, observed };
    },
  );

  await attempt(
    "reuse.second_assignment",
    ["member.agent_sign_in"],
    async () => {
      const createsBefore = exeDevCount("create");
      const created = await finearGraphQL(
        `mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }`,
        {
          input: {
            teamId: PRIMARY.team,
            title: "Document the widgets health endpoint",
            description: "Describe /health in acme/widgets README.",
            assigneeId: PRIMARY.member,
          },
        },
      );
      const issue = (created.issueCreate as { issue: { id: string; identifier: string } }).issue;
      const delegated = await finearControl("/__test/agents/delegate", {
        fixture: "primary",
        issueId: issue.id,
        appUserId: linearAppUserId,
      });
      if (delegated.status !== 200)
        stop("Finear delegation of the second issue failed.", delegated);
      const held = await until(
        () =>
          paws!.db
            .query<{ sessionId: string; generation: number }, [string]>(
              "SELECT session_id AS sessionId,generation FROM workspace_assignment WHERE session_id!=? ORDER BY rowid DESC LIMIT 1",
            )
            .get(sessionId),
        30_000,
      );
      if (!held) stop("Paws created no hold for the second assignment.", delegated.body);
      const url = await until(async () => {
        const data = await finearGraphQL(
          `query Session($id: String!) { agentSession(id: $id) { activities { nodes { signal signalMetadata } } } }`,
          { id: held.sessionId },
        );
        const nodes = (
          data.agentSession as {
            activities: { nodes: { signal: string | null; signalMetadata: unknown }[] };
          }
        ).activities.nodes;
        for (const node of nodes) {
          const metadata =
            typeof node.signalMetadata === "string"
              ? (JSON.parse(node.signalMetadata) as { url?: string })
              : (node.signalMetadata as { url?: string } | null);
          if (node.signal === "auth" && metadata?.url) return metadata.url;
        }
        return null;
      }, 30_000);
      if (!url) stop("No auth elicitation reached the second Finear session.");
      const link = new URL(url);
      if (link.origin !== origin) stop("The second assignment link leaves Paws.", link.origin);
      const begin = await member.paws(link.pathname + link.search);
      const location = begin.headers.get("location");
      if (!location)
        stop("Paws refused the second assignment link.", {
          status: begin.status,
          body: await begin.text(),
        });
      const consent = await member.linearConsent(location, PRIMARY.member);
      const callback = await member.paws(consent.callback.pathname + consent.callback.search);
      const destination = callback.headers.get("location");
      if (callback.status !== 303 || !destination?.startsWith("/status/onboarding/"))
        stop("Member did not land on the second onboarding page.", {
          status: callback.status,
          destination,
        });
      const reused = await until(async () => {
        const response = await member.paws(
          `/api/workspaces/onboarding?session=${encodeURIComponent(held.sessionId)}&generation=${held.generation}`,
        );
        const body = (await response.json()) as { vm?: VmProjection };
        return body.vm?.ready ? body.vm : null;
      }, 60_000);
      const rows = memberVmRow();
      if (
        !reused ||
        reused.runner?.id !== runnerId ||
        reused.machine?.name !== vmName ||
        reused.machine.reused !== true ||
        exeDevCount("create") !== createsBefore ||
        rows.length !== 1
      )
        stop("The second assignment did not reuse the provisioned VM.", {
          reused,
          runnerId,
          createsBefore,
          createsAfter: exeDevCount("create"),
          memberVm: rows,
        });
      return {
        value: true,
        observed: {
          issue: issue.identifier,
          session: held.sessionId,
          vm: reused,
          createsBefore,
          createsAfter: exeDevCount("create"),
          memberVmRows: rows.length,
        },
      };
    },
    180_000,
  );
} catch (error) {
  const sensitive = [
    ...(github?.issued() ?? []),
    GITHUB_APP.clientSecret,
    exeDevToken,
    clientSecret,
    webhookSecret,
    linearAppToken,
  ].filter((value) => value.length >= 8);
  const message = error instanceof Error ? error.message : "Unexpected verification exception.";
  record("execution.exception", "stopped", {
    name: error instanceof Error ? error.name : typeof error,
    error: sensitive.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), message),
  });
} finally {
  clearInterval(cancellationTimer);
  const db = paws?.db;
  const snapshot = db
    ? {
        assignments: db
          .query("SELECT session_id,generation,status FROM workspace_assignment")
          .all(),
        preparation: db
          .query(
            "SELECT session_id,generation,revision,mode,repository_context,repository FROM onboarding_preparation",
          )
          .all(),
        readiness: db
          .query("SELECT session_id,generation,revision,projection FROM onboarding_readiness")
          .all(),
        onboardingVm: db.query("SELECT * FROM onboarding_vm").all(),
        workItems: db.query("SELECT id,state,session_key FROM work_item").all(),
        bindings: db.query("SELECT item_id FROM onboarding_item_binding").all(),
        runs: db.query("SELECT id,item_id,status FROM run").all(),
        assignmentJobs: db
          .query(
            "SELECT queue,status,attempts,last_error FROM job WHERE queue LIKE 'workspace.assignment%'",
          )
          .all(),
        outbox: db
          .query(
            "SELECT op,status,attempts,error,json_extract(payload,'$.kind') AS kind,json_extract(payload,'$.body') AS body FROM outbox ORDER BY id",
          )
          .all(),
        inbox: db.query("SELECT delivery_id,action,handled FROM inbox_event").all(),
        memberGitHub: db
          .query("SELECT workspace_id,github_id,login,revoked FROM member_github_account")
          .all(),
        memberVm: db
          .query(
            "SELECT provider_name,run,step,state,failure,create_outcome,runner_id,session_id,generation FROM member_vm",
          )
          .all(),
        runners: db.query("SELECT id,status FROM runner").all(),
      }
    : null;
  const onboardingState =
    paws && sessionId
      ? await member
          .paws(
            `/api/workspaces/onboarding?session=${encodeURIComponent(sessionId)}&generation=${generation}`,
          )
          .then(async (response) => ({ status: response.status, body: await response.json() }))
          .catch((error: unknown) => ({ error: String(error) }))
      : null;
  const owned = {
    probe: process.pid,
    finear: finear?.pid ?? null,
    finearOrigin,
    pawsOrigin: origin,
    runnerPort,
    githubOrigin,
    gitRemote: {
      origin: "https://github.com:443 (namespace loopback)",
      pid: gitRemote?.pid ?? null,
    },
    exeDevOrigin: exeDev?.origin ?? null,
  };
  const pawsStopped = await Promise.race([
    (paws?.stop() ?? Promise.resolve()).then(
      () => "stopped",
      (error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`,
    ),
    Bun.sleep(30_000).then(() => "timed out"),
  ]);
  await guest?.stop();
  await github?.stop();
  const gitRemoteExit = await gitRemote?.stop();
  await exeDev?.stop();
  if (finear && finear.exitCode === null) {
    finear.kill("SIGTERM");
    await Promise.race([finear.exited, Bun.sleep(5_000)]);
  }
  if (finear && finear.exitCode === null && finear.signalCode === null) {
    finear.kill("SIGKILL");
    await finear.exited;
  }
  await Promise.race([finearLogWritten, Bun.sleep(2_000)]);
  const finearExit = finear ? (finear.exitCode ?? finear.signalCode ?? "running") : null;
  const pidState = (pid: number | undefined) => {
    if (pid === undefined) return "not-started";
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!;
    } catch {
      return "absent";
    }
  };
  const finearPidState = pidState(finear?.pid);
  const gitPidState = pidState(gitRemote?.pid);
  record(
    "cleanup.owned_processes_stopped",
    pawsStopped === "stopped" &&
      [finearPidState, gitPidState].every((state) =>
        ["absent", "Z", "X", "not-started"].includes(state),
      )
      ? "passed"
      : "stopped",
    { pawsStopped, finearExit, gitRemoteExit, finearPidState, gitPidState },
  );
  const sensitive = [
    ...(github?.issued() ?? []),
    GITHUB_APP.clientSecret,
    exeDevToken,
    clientSecret,
    webhookSecret,
    linearAppToken,
  ].filter((value) => value.length >= 8);
  const draft = {
    environment,
    owned,
    finearExit,
    stoppedAt,
    steps,
    readinessSeen,
    outbound,
    githubRequests: github?.requests ?? [],
    githubMinted: github?.minted ?? [],
    gitRemote: { head: gitRemote?.head, exit: gitRemoteExit, requests: gitRemote?.requests ?? [] },
    exeDevCalls: exeDev?.calls ?? [],
    guestEvents: guest?.events ?? [],
    guestHeartbeats: {
      ok: (guest?.heartbeats ?? []).filter((beat) => beat.ok).length,
      failed: (guest?.heartbeats ?? []).filter((beat) => !beat.ok).length,
    },
    memberRequests: member.requests,
    pawsStopped,
    finalOnboardingState: onboardingState,
    finalState: snapshot,
  };
  const leakedInLogs = secretsIn(
    captured.join("\n") + (existsSync(finearLog) ? readFileSync(finearLog, "utf8") : ""),
    sensitive,
  );
  const leakedInObservations = secretsIn(JSON.stringify(draft), sensitive);
  record(
    "secrets.absent_from_logs_and_observations",
    leakedInLogs + leakedInObservations === 0 ? "passed" : "stopped",
    { checkedSecrets: sensitive.length, leakedInLogs, leakedInObservations },
  );
  const failed = steps.filter((step) => step.status !== "passed").map((step) => step.step);
  const observations = {
    ...draft,
    result: failed.length === 0 ? "passed" : "failed",
    failed,
    steps,
  };
  writeFileSync(
    join(root, "observations.json"),
    leakedInObservations === 0
      ? JSON.stringify(observations, null, 2)
      : JSON.stringify(
          {
            result: "failed",
            failed,
            steps: steps.map(({ step, status }) => ({ step, status })),
          },
          null,
          2,
        ),
  );
  console.log(`observations: ${join(root, "observations.json")}`);
  console.log(`result: ${observations.result}; stopped at: ${stoppedAt ?? "none"}`);
  if (existsSync(finearLog)) console.log(`finear log: ${finearLog}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}
