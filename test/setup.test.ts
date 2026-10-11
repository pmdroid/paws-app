import { readSecretFile } from "../src/credentials";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { mirrorPath } from "../src/acp";
import {
  createTokenStore,
  GITHUB_REAUTH_MESSAGE,
  MISSING_GITHUB_CLIENT_ID_MESSAGE,
} from "../src/auth";
import { pawsPaths, loadConfigFile, loadRuntime, renderConfigToml } from "../src/config";
import { DEFAULT_MAX_AWAKE_MS, DEFAULT_MAX_TURNS } from "../src/core";
import {
  LINEAR_APP_SCOPES,
  LINEAR_REDIRECT_URI,
  linearTokenPath,
  readStoredToken,
} from "../src/linear";
import { runSetup, type SetupFetch, type SetupOptions } from "../src/setup";
import { INSTALLATION_PERMISSIONS } from "../src/github";

const REAL_GIT = "/usr/bin/git";
const API_KEY = "lin_api_test_key_123";
const ACCESS_TOKEN = "lin_oauth_access_token_123";
const CLIENT_SECRET = "lin_oauth_client_secret_123";

const roots: string[] = [];

afterEach(async () => {
  const pending = roots.splice(0);
  await Promise.all(pending.map((root) => rm(root, { recursive: true, force: true })));
});

describe("paws setup", () => {
  test("scripted run writes config.toml and 0600 secrets, then a rerun changes nothing", async () => {
    const scene = await arrange();
    const first = await run(scene, happyArgs(scene));
    expect(first.code).toBe(0);
    expect(first.stderr).toEqual([]);
    expect(first.stdout).toEqual([`paws setup wrote ${scene.paths.configFile}`]);

    const config = readFileSync(scene.paths.configFile, "utf8");
    expect(config).toBe(
      renderConfigToml({
        linearMode: "comments",
        linearTeam: "ENG",
        linearTeamId: "team-1",
        linearViewerId: "user-1",
        linearSecret: "secrets/linear-api-key",
        linearClientFile: null,
        githubAuth: "gh",
        trackerKind: "linear",
        repo: "acme/widgets",
        checkout: scene.checkout,
        maxTurns: DEFAULT_MAX_TURNS,
        maxAwakeMs: DEFAULT_MAX_AWAKE_MS,
        implementer: "claude",
      }),
    );
    expect(config).not.toContain(API_KEY);
    expect(first.stdout.join("\n")).not.toContain(API_KEY);
    expect(first.stderr.join("\n")).not.toContain(API_KEY);
    expect(loadConfigFile(scene.paths.configFile)).toMatchObject({
      linearMode: "comments",
      linearTeam: "ENG",
      linearTeamId: "team-1",
      linearViewerId: "user-1",
      linearSecret: "secrets/linear-api-key",
      githubAuth: "gh",
      repo: "acme/widgets",
      checkout: scene.checkout,
      maxTurns: DEFAULT_MAX_TURNS,
      maxAwakeMs: DEFAULT_MAX_AWAKE_MS,
    });

    const secretPath = join(scene.paths.secretsDir, "linear-api-key");
    expect(readSecretFile(secretPath)).toBe(`${API_KEY}\n`);
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    expect(statSync(scene.paths.secretsDir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(scene.checkout, ".agents", "closeout.yaml"), "utf8")).toContain(
      'exec: ["bun", "test"]',
    );
    expect(
      execFileSync(
        REAL_GIT,
        ["config", "--file", join(scene.mirror, "config"), "--get", "remote.origin.url"],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("https://github.com/acme/widgets.git");
    expect(scene.linear.creates).toEqual([
      {
        name: "paws",
        color: "#5E6AD2",
        description: "Delegated to Paws",
        teamId: "team-1",
      },
    ]);
    expect(scene.linear.auths.every((header) => header === API_KEY)).toBe(true);

    const before = stamp(scene);
    const second = await run(scene, happyArgs(scene));
    expect(second.code).toBe(0);
    expect(second.stderr).toEqual([]);
    expect(stamp(scene)).toEqual(before);
    expect(scene.linear.creates).toHaveLength(1);
    expect(originUrl(scene)).toBe("https://github.com/acme/widgets.git");
  });

  test("an existing closeout policy is left in place", async () => {
    const scene = await arrange({ policy: "custom: true\n" });
    const result = await run(scene, happyArgs(scene));
    expect(result.code).toBe(0);
    expect(readFileSync(join(scene.checkout, ".agents", "closeout.yaml"), "utf8")).toBe(
      "custom: true\n",
    );
  });

  test("agent mode stores the oauth token and client secret at mode 0600", async () => {
    const scene = await arrange({ bearer: true });
    const args = [
      "--yes",
      "--tracker",
      "linear",
      "--home",
      scene.home,
      "--checkout",
      scene.checkout,
      "--linear-mode",
      "agent",
      "--linear-client-id",
      "client-id",
      "--linear-client-secret",
      CLIENT_SECRET,
      "--linear-access-token",
      ACCESS_TOKEN,
    ];
    const first = await run(scene, args);
    expect(first.code).toBe(0);
    expect(first.stderr).toEqual([]);
    const tokenPath = linearTokenPath(scene.paths.secretsDir);
    const clientPath = join(scene.paths.secretsDir, "linear-client.json");
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(clientPath).mode & 0o777).toBe(0o600);
    expect(readSecretFile(clientPath)).toBe(
      `${JSON.stringify({ clientId: "client-id", clientSecret: CLIENT_SECRET })}\n`,
    );
    const config = readFileSync(scene.paths.configFile, "utf8");
    expect(config).toContain('mode = "agent-session"');
    expect(config).toContain('auth = "gh"');
    expect(config).not.toContain(ACCESS_TOKEN);
    expect(config).not.toContain(CLIENT_SECRET);
    expect(first.stdout.join("\n")).not.toContain(CLIENT_SECRET);
    expect(scene.linear.auths.every((header) => header === `Bearer ${ACCESS_TOKEN}`)).toBe(true);
    const before = stamp(scene, ["linear-oauth.json", "linear-client.json"]);
    const second = await run(scene, args);
    expect(second.code).toBe(0);
    expect(stamp(scene, ["linear-oauth.json", "linear-client.json"])).toEqual(before);
    expect(scene.linear.creates).toHaveLength(0);
  });

  test("interactive agent setup saves OAuth credentials when the app cannot create labels", async () => {
    const scene = await arrange({ bearer: true, policy: "custom: true\n" });
    const started = Date.now();
    let redirectUri = "";
    let exchanges = 0;
    const args = browserAgentArgs(scene).filter(
      (arg) =>
        !["--linear-client-id", "client-id", "--linear-client-secret", CLIENT_SECRET].includes(arg),
    );
    const result = await run(scene, args, {
      env: {
        LINEAR_CLIENT_ID: "client-id",
        LINEAR_CLIENT_SECRET: CLIENT_SECRET,
        LINEAR_WEBHOOK_SECRET: "synthetic-linear-webhook-secret",
      },
      fetch: async (url, init) => {
        if (url !== "https://api.linear.app/oauth/token") return scene.linear.fetch(url, init);
        exchanges += 1;
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("client_id")).toBe("client-id");
        expect(body.get("client_secret")).toBe(CLIENT_SECRET);
        expect(body.get("code")).toBe("fake-browser-code");
        expect(body.get("redirect_uri")).toBe(redirectUri);
        return Response.json({
          access_token: ACCESS_TOKEN,
          refresh_token: "fake-browser-refresh-token",
          expires_in: 3600,
          scope: LINEAR_APP_SCOPES,
        });
      },
      linear: {
        port: 0,
        timeoutMs: 2_000,
        async onAuthorize(link) {
          const auth = new URL(link);
          expect(auth.searchParams.get("actor")).toBe("app");
          redirectUri = auth.searchParams.get("redirect_uri")!;
          const callback = new URL(redirectUri);
          callback.searchParams.set("state", auth.searchParams.get("state")!);
          callback.searchParams.set("code", "fake-browser-code");
          const response = await fetch(callback);
          expect(response.status).toBe(200);
          expect(await response.text()).toContain("Return to Paws setup");
        },
      },
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(exchanges).toBe(1);
    expect(loadRuntime({ PAWS_HOME: scene.home }).env.linearWebhookSecret).toBe(
      "synthetic-linear-webhook-secret",
    );
    expect(readFileSync(join(scene.paths.secretsDir, "linear-webhook"), "utf8")).not.toContain(
      "synthetic-linear-webhook-secret",
    );
    expect(LINEAR_REDIRECT_URI).toBe("http://localhost:3000/oauth/callback");
    const tokenPath = linearTokenPath(scene.paths.secretsDir);
    const token = readStoredToken(tokenPath);
    expect(token).toMatchObject({
      accessToken: ACCESS_TOKEN,
      refreshToken: "fake-browser-refresh-token",
      actor: "app",
      scope: LINEAR_APP_SCOPES,
    });
    expect(token!.expiresAtMs).toBeGreaterThanOrEqual(started + 3_600_000);
    expect(token!.expiresAtMs).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(scene.paths.secretsDir, "linear-client.json")).mode & 0o777).toBe(0o600);
    expect(statSync(scene.paths.secretsDir).mode & 0o777).toBe(0o700);
    expect(loadConfigFile(scene.paths.configFile).linearMode).toBe("agent-session");
    expect(loadConfigFile(scene.paths.configFile).trackerKind).toBe("linear");
    expect(scene.linear.creates).toHaveLength(0);
    expect(scene.linear.auths.every((header) => header === `Bearer ${ACCESS_TOKEN}`)).toBe(true);
    const output = [
      ...result.stdout,
      ...result.stderr,
      readFileSync(scene.paths.configFile, "utf8"),
    ].join("\n");
    for (const secret of [
      ACCESS_TOKEN,
      CLIENT_SECRET,
      "fake-browser-refresh-token",
      "fake-browser-code",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(result.stdout).toContain(`Linear redirect URI: ${redirectUri}`);
    await expect(fetch(redirectUri)).rejects.toThrow();
  });

  test.each([
    { query: "Viewer", operation: "checking the Linear viewer", status: 200 },
    { query: "Teams", operation: "listing Linear teams", status: 400 },
  ])("browser setup reports $operation errors and redacts credentials", async (failure) => {
    const scene = await arrange({ bearer: true, policy: "custom: true\n" });
    const refreshToken = "fake-browser-refresh-token";
    const detail = `Permission denied: ${ACCESS_TOKEN} ${CLIENT_SECRET} ${refreshToken}`;
    const result = await run(scene, browserAgentArgs(scene), {
      fetch: async (url, init) => {
        if (url === "https://api.linear.app/oauth/token") {
          return Response.json({
            access_token: ACCESS_TOKEN,
            refresh_token: refreshToken,
            expires_in: 3600,
          });
        }
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (new RegExp(`^(query|mutation) ${failure.query}[ (]`).test(body.query)) {
          return Response.json({ errors: [{ message: detail }] }, { status: failure.status });
        }
        return scene.linear.fetch(url, init);
      },
      linear: {
        port: 0,
        timeoutMs: 2_000,
        async onAuthorize(link) {
          const auth = new URL(link);
          const callback = new URL(auth.searchParams.get("redirect_uri")!);
          callback.searchParams.set("state", auth.searchParams.get("state")!);
          callback.searchParams.set("code", "fake-browser-code");
          const response = await fetch(callback);
          expect(response.status).toBe(200);
        },
      },
    });
    expect(result.code).toBe(1);
    const status = failure.status === 200 ? "" : ` HTTP ${failure.status}`;
    expect(result.stderr).toEqual([
      `Linear request failed while ${failure.operation}. Linear GraphQL${status}: Permission denied: [redacted] [redacted] [redacted]`,
    ]);
    expect(existsSync(scene.paths.configFile)).toBe(false);
    expect(existsSync(linearTokenPath(scene.paths.secretsDir))).toBe(false);
  });

  test.each([
    { query: "TeamLabels", operation: "reading team labels" },
    { query: "IssueLabelCreate", operation: "creating the paws label" },
  ])("comment setup reports errors while $operation", async (failure) => {
    const scene = await arrange();
    const result = await run(scene, happyArgs(scene), {
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes(failure.query)) {
          return Response.json({ errors: [{ message: "not allowed to take action" }] });
        }
        return scene.linear.fetch(url, init);
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toEqual([
      `Linear request failed while ${failure.operation}. Linear GraphQL: not allowed to take action`,
    ]);
  });

  test("a non-JSON Linear HTTP error retains its status", async () => {
    const scene = await arrange({ policy: "custom: true\n" });
    const result = await run(
      scene,
      [...browserAgentArgs(scene), "--yes", "--linear-access-token", ACCESS_TOKEN],
      {
        fetch: async () => new Response("Bad gateway", { status: 502 }),
      },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toEqual([
      "Linear request failed while checking the Linear viewer. Linear GraphQL HTTP 502",
    ]);
  });

  test("comment setup preserves Linear errors and redacts the API key", async () => {
    const scene = await arrange();
    const result = await run(scene, happyArgs(scene), {
      fetch: async () => Response.json({ errors: [{ message: `Permission denied: ${API_KEY}` }] }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toEqual([
      "Linear request failed while checking the Linear viewer. Linear GraphQL: Permission denied: [redacted]",
    ]);
  });

  test("denied browser authorization leaves setup credentials and config unwritten", async () => {
    const scene = await arrange({ bearer: true, policy: "custom: true\n" });
    const result = await run(scene, browserAgentArgs(scene), {
      linear: {
        port: 0,
        timeoutMs: 2_000,
        async onAuthorize(link) {
          const auth = new URL(link);
          const callback = new URL(auth.searchParams.get("redirect_uri")!);
          callback.searchParams.set("state", auth.searchParams.get("state")!);
          callback.searchParams.set("error", "access_denied");
          await fetch(callback);
        },
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toEqual(["Linear authorization was denied. Run paws setup again."]);
    expect(existsSync(linearTokenPath(scene.paths.secretsDir))).toBe(false);
    expect(existsSync(join(scene.paths.secretsDir, "linear-client.json"))).toBe(false);
    expect(existsSync(scene.paths.configFile)).toBe(false);
    expect(scene.linear.auths).toEqual([]);
  });

  test("a logged-out claude waits for Enter and does not run the login command", async () => {
    const scene = await arrange({
      claude: statusThenLogin("claude-auth"),
      policy: "custom: true\n",
    });
    let reads = 0;
    const result = await run(
      scene,
      [...happyArgs(scene).filter((arg) => arg !== "--yes"), "--implementer", "claude"],
      {
        readLine: async () => {
          reads += 1;
          if (reads > 1) throw new Error("unexpected extra prompt");
          return "";
        },
      },
    );
    expect(result.code).toBe(0);
    expect(reads).toBe(1);
    expect(result.stdout).toContain("claude is not logged in. Run: claude auth login");
    expect(result.stdout).toContain("Press Enter to check again.");
    expect(existsMarker(scene, "claude-login")).toBe(false);
  });

  test("each failed check prints one actionable line and exits non-zero", async () => {
    const cases: { name: string; tweak: Tweak; line: string | ((scene: Scene) => string) }[] = [
      {
        name: "bun missing",
        tweak: { bun: null },
        line: "Install Bun 1.4 or newer from https://bun.sh and ensure bun is on PATH.",
      },
      {
        name: "bun too old",
        tweak: { bun: "#!/bin/sh\necho 1.0.0\n" },
        line: "Bun 1.4 or newer is required (found 1.0.0). Install it from https://bun.sh",
      },
      {
        name: "git missing",
        tweak: { git: null },
        line: "Install git and ensure git is on PATH.",
      },
      {
        name: "gh logged out",
        tweak: { gh: '#!/bin/sh\nif [ "$1" = "auth" ]; then exit 1; fi\nexit 1\n' },
        line: "gh auth status failed: not logged in to GitHub. Run gh auth login.",
      },
      {
        name: "gh missing",
        tweak: { gh: null },
        line: "gh is not on PATH. Install GitHub CLI, then run: gh auth login",
      },
      {
        name: "claude logged out",
        tweak: { claude: refuseLogin("auth", "login", "claude-login") },
        line: "claude is not logged in. Run: claude auth login",
      },
      {
        name: "claude missing",
        tweak: { claude: null },
        line: "claude is not installed. Run: claude auth login",
      },
      {
        name: "codex logged out",
        tweak: {
          codex: `#!/bin/sh
PATH="/usr/bin:/bin:$PATH"
if [ "$1" = "login" ] && [ "$2" != "status" ]; then
  echo login > "$(dirname "$0")/../codex-login"
  exit 0
fi
exit 1
`,
        },
        line: "codex is not logged in. Run: codex login",
      },
      {
        name: "codex missing",
        tweak: { codex: null },
        line: "codex is not installed. Run: codex login",
      },
      {
        name: "linear key missing",
        tweak: {
          args: (scene) =>
            happyArgs(scene).filter((arg) => arg !== API_KEY && arg !== "--linear-api-key"),
        },
        line: "Comment mode needs a Linear personal API key. Pass --linear-api-key.",
      },
      {
        name: "linear key rejected",
        tweak: { unauthorized: true },
        line: "Linear rejected the API key. Create a personal API key in Linear settings and pass --linear-api-key.",
      },
      {
        name: "several linear teams",
        tweak: {
          teams: [
            { id: "team-1", key: "ENG", name: "Engineering" },
            { id: "team-2", key: "OPS", name: "Operations" },
          ],
        },
        line: "More than one Linear team is visible (ENG, OPS). Pass --linear-team with a team key.",
      },
      {
        name: "unknown linear team",
        tweak: {
          args: (scene) => [...happyArgs(scene), "--linear-team", "NOPE"],
        },
        line: "Linear team NOPE was not found. Pass --linear-team with one of: ENG.",
      },
      {
        name: "repo not inferred",
        tweak: { remote: false },
        line: (scene) =>
          `Could not infer a GitHub repository from ${scene.checkout}. Pass --repo owner/name.`,
      },
      {
        name: "gh cannot push",
        tweak: { gh: pushDenied },
        line: "gh login does not have push permission on acme/widgets",
      },
    ];

    for (const item of cases) {
      const scene = await arrange(item.tweak);
      const args = item.tweak.args?.(scene) ?? happyArgs(scene);
      const result = await run(scene, args);
      const line = typeof item.line === "function" ? item.line(scene) : item.line;
      expect({ name: item.name, code: result.code, stderr: result.stderr }).toEqual({
        name: item.name,
        code: 1,
        stderr: [line],
      });
      if (item.name === "claude logged out")
        expect(existsMarker(scene, "claude-login")).toBe(false);
      if (item.name === "codex logged out") expect(existsMarker(scene, "codex-login")).toBe(false);
    }
  });
});

type Team = { id: string; key: string; name: string };

type Tweak = {
  bun?: string | null;
  git?: string | null;
  gh?: string | null;
  claude?: string | null;
  codex?: string | null;
  teams?: Team[];
  unauthorized?: boolean;
  bearer?: boolean;
  remote?: boolean;
  policy?: string;
  args?: (scene: Scene) => string[];
};

type Scene = {
  root: string;
  home: string;
  checkout: string;
  bin: string;
  mirror: string;
  paths: ReturnType<typeof pawsPaths>;
  linear: FakeLinear;
};

class FakeLinear {
  creates: Record<string, unknown>[] = [];
  auths: string[] = [];
  labels: { id: string; name: string }[] = [];

  constructor(
    private readonly options: {
      key: string;
      teams: Team[];
      unauthorized: boolean;
      bearer: boolean;
    },
  ) {}

  readonly fetch: SetupFetch = async (input, init) => {
    const auth = authorization(init);
    this.auths.push(auth);
    if (!input.includes("api.linear.app")) return new Response("missing", { status: 404 });
    if (this.options.unauthorized || !this.matches(auth)) {
      return new Response("unauthorized", { status: 401 });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      query?: string;
      variables?: { input?: Record<string, unknown> };
    };
    const query = body.query ?? "";
    if (query.includes("issueLabelCreate")) {
      const created = body.variables?.input ?? {};
      this.creates.push(created);
      if (this.options.bearer) {
        return Response.json({ errors: [{ message: "not allowed to take action" }] });
      }
      this.labels.push({ id: "label-1", name: "paws" });
      return Response.json({
        data: {
          issueLabelCreate: { success: true, issueLabel: { id: "label-1", name: "paws" } },
        },
      });
    }
    if (query.includes("TeamLabels")) {
      return Response.json({ data: { team: { labels: { nodes: this.labels } } } });
    }
    if (query.includes("viewer")) {
      return Response.json({ data: { viewer: { id: "user-1" } } });
    }
    if (query.includes("teams")) {
      return Response.json({ data: { teams: { nodes: this.options.teams } } });
    }
    return Response.json({ errors: [{ message: "unexpected query" }] });
  };

  private matches(auth: string): boolean {
    if (this.options.bearer) return auth === `Bearer ${this.options.key}`;
    return auth === this.options.key;
  }
}

const pushDenied = `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "api" ]; then
  printf '%s\\n' '{"permissions":{"push":false}}'
  exit 0
fi
exit 1
`;

function refuseLogin(command: string, second: string, marker: string): string {
  return `#!/bin/sh
PATH="/usr/bin:/bin:$PATH"
if [ "$1" = "${command}" ] && [ "$2" = "${second}" ]; then
  echo login > "$(dirname "$0")/../${marker}"
  exit 0
fi
exit 1
`;
}

function statusThenLogin(marker: string): string {
  return `#!/bin/sh
PATH="/usr/bin:/bin:$PATH"
flag="$(dirname "$0")/../${marker}"
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  echo login > "$(dirname "$0")/../claude-login"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -f "$flag" ]; then
    echo '{"authMethod":"claude.ai"}'
    exit 0
  fi
  echo pending > "$flag"
  exit 1
fi
exit 1
`;
}

async function arrange(tweak: Tweak = {}): Promise<Scene> {
  const root = await mkdtemp(join(tmpdir(), "paws-setup-"));
  roots.push(root);
  const home = join(root, "home");
  const checkout = join(root, "checkout");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(checkout, { recursive: true });

  const bun =
    tweak.bun === undefined
      ? '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.4.2; exit 0; fi\nexit 1\n'
      : tweak.bun;
  const git = tweak.git === undefined ? gitFake() : tweak.git;
  const gh = tweak.gh === undefined ? ghFake() : tweak.gh;
  const claude = tweak.claude === undefined ? claudeFake() : tweak.claude;
  const codex = tweak.codex === undefined ? codexFake() : tweak.codex;
  if (bun !== null) writeBin(bin, "bun", bun);
  if (git !== null) writeBin(bin, "git", git);
  if (gh !== null) writeBin(bin, "gh", gh);
  if (claude !== null) writeBin(bin, "claude", claude);
  if (codex !== null) writeBin(bin, "codex", codex);

  execFileSync(REAL_GIT, ["init", "-q"], { cwd: checkout });
  if (tweak.remote !== false) {
    execFileSync(REAL_GIT, ["remote", "add", "origin", "https://github.com/acme/widgets.git"], {
      cwd: checkout,
    });
  }
  if (tweak.policy !== undefined) {
    mkdirSync(join(checkout, ".agents"), { recursive: true });
    writeFileSync(join(checkout, ".agents", "closeout.yaml"), tweak.policy);
  }

  const linear = new FakeLinear({
    key: tweak.bearer ? ACCESS_TOKEN : API_KEY,
    teams: tweak.teams ?? [{ id: "team-1", key: "ENG", name: "Engineering" }],
    unauthorized: tweak.unauthorized ?? false,
    bearer: tweak.bearer ?? false,
  });
  return {
    root,
    home,
    checkout,
    bin,
    mirror: mirrorPath(home, "acme", "widgets"),
    paths: pawsPaths(home),
    linear,
  };
}

function happyArgs(scene: Scene): string[] {
  return [
    "--yes",
    "--tracker",
    "linear",
    "--home",
    scene.home,
    "--checkout",
    scene.checkout,
    "--linear-api-key",
    API_KEY,
  ];
}

async function run(
  scene: Scene,
  args: string[],
  extra?: Pick<SetupOptions, "readLine" | "linear" | "fetch" | "env">,
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: scene.bin, ...extra?.env };
  delete env.PAWS_GITHUB_REPOSITORY;
  delete env.PAWS_HOME;
  const code = await runSetup(args, {
    env,
    cwd: scene.checkout,
    fetch: extra?.fetch ?? scene.linear.fetch,
    ...(extra?.linear ? { linear: extra.linear } : {}),
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    readLine:
      extra?.readLine ??
      (async () => {
        throw new Error("setup prompted in a --yes run");
      }),
  });
  return { code, stdout, stderr };
}

function browserAgentArgs(scene: Scene): string[] {
  return [
    "--tracker",
    "linear",
    "--home",
    scene.home,
    "--checkout",
    scene.checkout,
    "--implementer",
    "claude",
    "--linear-mode",
    "agent-session",
    "--linear-client-id",
    "client-id",
    "--linear-client-secret",
    CLIENT_SECRET,
  ];
}

function originUrl(scene: Scene): string {
  return execFileSync(
    REAL_GIT,
    ["config", "--file", join(scene.mirror, "config"), "--get", "remote.origin.url"],
    { encoding: "utf8" },
  ).trim();
}

function stamp(scene: Scene, secretNames = ["linear-api-key"]): Record<string, string | number> {
  const files = [
    scene.paths.configFile,
    join(scene.checkout, ".agents", "closeout.yaml"),
    ...secretNames.map((name) => join(scene.paths.secretsDir, name)),
  ];
  const out: Record<string, string | number> = {};
  for (const file of files) {
    const stat = statSync(file);
    out[`${file}:bytes`] = readFileSync(file).toString("base64");
    out[`${file}:mtime`] = stat.mtimeMs;
    out[`${file}:mode`] = stat.mode & 0o777;
  }
  return out;
}

function existsMarker(scene: Scene, name: string): boolean {
  try {
    statSync(join(scene.root, name));
    return true;
  } catch {
    return false;
  }
}

function writeBin(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function acceptHeader(init: RequestInit | undefined): string {
  const headers = init?.headers;
  if (headers === undefined) return "";
  if (headers instanceof Headers) return headers.get("accept") ?? "";
  if (Array.isArray(headers)) {
    const found = headers.find((entry) => entry[0]?.toLowerCase() === "accept");
    return found?.[1] ?? "";
  }
  const record = headers as Record<string, string>;
  return record.Accept ?? record.accept ?? "";
}

function authorization(init: RequestInit | undefined): string {
  const headers = init?.headers;
  if (headers === undefined) return "";
  if (headers instanceof Headers) return headers.get("authorization") ?? "";
  if (Array.isArray(headers)) {
    const found = headers.find((entry) => entry[0]?.toLowerCase() === "authorization");
    return found?.[1] ?? "";
  }
  const record = headers as Record<string, string>;
  return record.authorization ?? record.Authorization ?? "";
}

function gitFake(): string {
  return `#!/bin/sh
real=${REAL_GIT}
if [ "$1" = "--version" ]; then
  echo "git version 2.43.0"
  exit 0
fi
if [ "$1" = "clone" ] && [ "$2" = "--bare" ]; then
  "$real" init --bare "$4" >/dev/null
  "$real" --git-dir "$4" remote add origin "$3"
  exit 0
fi
for arg in "$@"; do
  if [ "$arg" = "fetch" ]; then
    exit 0
  fi
done
exec "$real" "$@"
`;
}

function ghFake(): string {
  return `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "api" ]; then
  printf '%s\\n' '{"permissions":{"push":true}}'
  exit 0
fi
exit 1
`;
}

function claudeFake(): string {
  return `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo '{"authMethod":"claude.ai"}'
  exit 0
fi
exit 1
`;
}

function codexFake(): string {
  return `#!/bin/sh
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  exit 0
fi
exit 1
`;
}

const SETUP_TOKEN = "gho_setup_secret_token_value";

describe("paws setup github", () => {
  test("GitHub App setup keeps bot auth for GitHub and Linear without gh", async () => {
    for (const tracker of ["github", "linear"]) {
      const scene = await arrange({ policy: "custom: true\n", gh: null });
      writeBin(scene.bin, "git", recordingGit(join(scene.root, "git.log")));
      const keyPath = join(scene.root, "app.pem");
      writeFileSync(
        keyPath,
        generateKeyPairSync("rsa", {
          modulusLength: 2048,
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
          publicKeyEncoding: { type: "spki", format: "pem" },
        }).privateKey,
      );
      const github = new FakeGitHubApi();
      const botRequests: string[] = [];
      const errors: string[] = [];
      const args = [
        "--tracker",
        tracker,
        "--repo",
        "acme/widgets",
        "--home",
        scene.home,
        "--checkout",
        scene.checkout,
        "--implementer",
        "claude",
        ...(tracker === "linear" ? ["--linear-api-key", API_KEY, "--linear-team", "ENG"] : []),
      ];
      const options: SetupOptions = {
        env: {
          ...setupEnv(scene),
          GITHUB_AUTH: "app",
          GITHUB_APP_ID: "99",
          GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
          PAWS_GITHUB_CLIENT_ID: "Iv1.real-client",
          PAWS_GITHUB_CLIENT_SECRET: "fake-app-client-secret",
        },
        cwd: scene.checkout,
        stdout: () => {},
        stderr: (line) => errors.push(line),
        async fetch(url, init) {
          if (url.includes("api.linear.app")) return scene.linear.fetch(url, init);
          const path = new URL(url).pathname;
          const token = new Headers(init?.headers).get("authorization");
          if (path === "/app")
            return Response.json({ client_id: "Iv1.real-client", slug: "paws-test" });
          if (path.endsWith("/installation")) return Response.json({ id: 22 });
          if (path === "/app/installations/22/access_tokens")
            return Response.json(
              {
                token: "fake-bot-token",
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
                repository_selection: "selected",
                repositories: [{ name: "widgets", full_name: "acme/widgets" }],
                permissions: INSTALLATION_PERMISSIONS,
              },
              { status: 201 },
            );
          if (path === "/user") expect(token).toBe(`Bearer ${SETUP_TOKEN}`);
          if (token === "Bearer fake-bot-token") botRequests.push(path);
          return github.fetch(url, init);
        },
        github: {
          store: createTokenStore({ home: scene.home, which: () => null }),
          port: 0,
          timeoutMs: 2_000,
          async openBrowser(link) {
            const auth = new URL(link);
            const callback = new URL(auth.searchParams.get("redirect_uri")!);
            callback.searchParams.set("state", auth.searchParams.get("state")!);
            callback.searchParams.set("code", "fake-code");
            expect((await fetch(callback)).status).toBe(200);
          },
        },
      };
      const code = await runSetup(args, options);
      expect(errors).toEqual([]);
      expect(code).toBe(0);
      expect(loadConfigFile(scene.paths.configFile).githubAuth).toBe("app");
      expect(botRequests).toContain("/repos/acme/widgets");
      expect(github.labels.length).toBe(tracker === "github" ? 4 : 0);
      expect(originUrl(scene)).toBe("https://github.com/acme/widgets.git");
      options.env = setupEnv(scene);
      const restarted = await runSetup(["--yes", ...args], options);
      expect(errors).toEqual([]);
      expect(restarted).toBe(0);
    }
  });

  test("--yes while signed out without a client id names the OAuth App", async () => {
    const scene = await arrange({ policy: "custom: true\n" });
    const stderr: string[] = [];
    const code = await runSetup(
      ["--yes", "--home", scene.home, "--checkout", scene.checkout, "--implementer", "claude"],
      {
        env: setupEnv(scene),
        cwd: scene.checkout,
        fetch: scene.linear.fetch,
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        github: {
          store: createTokenStore({ home: scene.home, which: () => null, platform: "linux" }),
        },
      },
    );
    expect(code).toBe(1);
    expect(stderr).toEqual([MISSING_GITHUB_CLIENT_ID_MESSAGE]);
    expect(stderr[0]).not.toContain("login github");
  });

  test("--yes while signed out with a client id still asks for login", async () => {
    const scene = await arrange({ policy: "custom: true\n" });
    const github = new FakeGitHubApi();
    const stderr: string[] = [];
    const code = await runSetup(
      ["--yes", "--home", scene.home, "--checkout", scene.checkout, "--implementer", "claude"],
      {
        env: { ...setupEnv(scene), PAWS_GITHUB_CLIENT_ID: "Iv1.real-client" },
        cwd: scene.checkout,
        fetch: github.fetch,
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        github: {
          store: createTokenStore({ home: scene.home, which: () => null, platform: "linux" }),
        },
      },
    );
    expect(code).toBe(1);
    expect(stderr).toEqual([GITHUB_REAUTH_MESSAGE]);
    expect(github.deviceCodes).toBe(0);
  });

  test("a placeholder client id fails before GitHub is called", async () => {
    const scene = await arrange({ policy: "custom: true\n" });
    const github = new FakeGitHubApi();
    const stderr: string[] = [];
    const code = await runSetup(
      ["--home", scene.home, "--checkout", scene.checkout, "--implementer", "claude"],
      {
        env: setupEnv(scene),
        cwd: scene.checkout,
        fetch: github.fetch,
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        readLine: async () => {
          throw new Error("setup prompted");
        },
        github: {
          store: createTokenStore({ home: scene.home, which: () => null, platform: "linux" }),
          sleep: async () => undefined,
          openBrowser: async () => undefined,
        },
      },
    );
    expect(code).toBe(1);
    expect(stderr).toEqual([MISSING_GITHUB_CLIENT_ID_MESSAGE]);
    expect(github.deviceCodes).toBe(0);
  });

  test("device flow, repo picker, bare mirror, tracker, and labels", async () => {
    const scene = await arrange({ policy: "custom: true\n" });
    const gitLog = join(scene.root, "git.log");
    writeFileSync(join(scene.bin, "git"), recordingGit(gitLog), { mode: 0o755 });
    chmodSync(join(scene.bin, "git"), 0o755);
    const store = createTokenStore({
      home: scene.home,
      which: () => null,
      platform: "linux",
    });
    const github = new FakeGitHubApi();
    const opened: string[] = [];
    const stdout: string[] = [];
    const lines = ["", "1"];
    const result = await runSetup(
      ["--home", scene.home, "--checkout", scene.checkout, "--implementer", "claude"],
      {
        env: { ...setupEnv(scene, gitLog), PAWS_GITHUB_CLIENT_ID: "Iv1.real-client" },
        cwd: scene.checkout,
        fetch: github.fetch,
        stdout: (line) => stdout.push(line),
        stderr: (line) => {
          throw new Error(line);
        },
        readLine: async () => lines.shift() ?? null,
        github: {
          store,
          sleep: async () => undefined,
          openBrowser: async (url) => {
            opened.push(url);
          },
        },
      },
    );
    expect(result).toBe(0);
    expect(stdout).toContain("Signed in as octocat");
    expect(stdout.join("\n")).toContain("PAWS-1234");
    expect(stdout.join("\n")).not.toContain(SETUP_TOKEN);
    expect(lines).toEqual([]);
    expect(opened).toEqual(["https://github.com/login/device"]);
    expect(github.repoPages).toBe(2);
    expect(github.labels).toEqual(["paws", "paws:running", "paws:awaiting-input", "paws:done"]);
    expect(github.bodies.join("\n")).not.toContain("client_secret");
    const parsed = loadConfigFile(scene.paths.configFile);
    expect(parsed.githubAuth).toBe("oauth");
    expect(parsed.oauthClientId).toBe("Iv1.real-client");
    expect(github.deviceAccepts).toEqual(["application/json"]);
    expect(parsed.trackerKind).toBe("github");
    expect(parsed.trackerGithub).toMatchObject({
      triggerLabel: "paws",
      mention: "@paws",
      statusLabels: true,
      trusted: ["OWNER", "MEMBER", "COLLABORATOR"],
      repos: [],
    });
    expect(parsed.repo).toBe("acme/widgets");
    expect(originUrl(scene)).toBe("https://github.com/acme/widgets.git");
    const recorded = readFileSync(gitLog, "utf8");
    expect(recorded).toContain("https://github.com/acme/widgets.git");
    expect(recorded).toContain("credential.helper=");
    expect(recorded).not.toContain(SETUP_TOKEN);
    expect(statSync(join(scene.paths.secretsDir, "github-oauth.json")).mode & 0o777).toBe(0o600);
  });

  test("--repo skips the repository list", async () => {
    const scene = await arrange({ policy: "custom: true\n" });
    const gitLog = join(scene.root, "git.log");
    writeFileSync(join(scene.bin, "git"), recordingGit(gitLog), { mode: 0o755 });
    chmodSync(join(scene.bin, "git"), 0o755);
    const store = createTokenStore({
      home: scene.home,
      which: () => null,
      platform: "linux",
    });
    await store.save({
      accessToken: SETUP_TOKEN,
      refreshToken: null,
      expiresAtMs: null,
      scope: "repo, read:org",
      login: "octocat",
      id: 7,
      invalid: false,
    });
    const github = new FakeGitHubApi();
    const code = await runSetup(
      [
        "--yes",
        "--repo",
        "acme/widgets",
        "--home",
        scene.home,
        "--checkout",
        scene.checkout,
        "--implementer",
        "claude",
      ],
      {
        env: setupEnv(scene, gitLog),
        cwd: scene.checkout,
        fetch: github.fetch,
        stdout: () => undefined,
        stderr: (line) => {
          throw new Error(line);
        },
        readLine: async () => {
          throw new Error("setup prompted");
        },
        github: { store, sleep: async () => undefined, openBrowser: async () => undefined },
      },
    );
    expect(code).toBe(0);
    expect(github.repoPages).toBe(0);
    expect(github.repoReads).toEqual(["acme/widgets"]);
    expect(github.deviceCodes).toBe(0);
    expect(loadConfigFile(scene.paths.configFile).repo).toBe("acme/widgets");
  });

  test("github.oauth_client_id in config.toml is sent and kept", async () => {
    const scene = await arrange({ policy: "custom: true\n" });
    const gitLog = join(scene.root, "git.log");
    writeFileSync(join(scene.bin, "git"), recordingGit(gitLog), { mode: 0o755 });
    chmodSync(join(scene.bin, "git"), 0o755);
    mkdirSync(scene.home, { recursive: true });
    writeFileSync(
      scene.paths.configFile,
      '[github]\nauth = "oauth"\noauth_client_id = "Iv1.from-file"\n',
      { mode: 0o600 },
    );
    const store = createTokenStore({
      home: scene.home,
      which: () => null,
      platform: "linux",
    });
    const github = new FakeGitHubApi();
    const lines = ["", "1"];
    const code = await runSetup(
      ["--home", scene.home, "--checkout", scene.checkout, "--implementer", "claude"],
      {
        env: setupEnv(scene, gitLog),
        cwd: scene.checkout,
        fetch: github.fetch,
        stdout: () => undefined,
        stderr: (line) => {
          throw new Error(line);
        },
        readLine: async () => lines.shift() ?? null,
        github: { store, sleep: async () => undefined, openBrowser: async () => undefined },
      },
    );
    expect(code).toBe(0);
    expect(github.bodies.join("\n")).toContain("client_id=Iv1.from-file");
    expect(github.deviceAccepts).toEqual(["application/json"]);
    expect(loadConfigFile(scene.paths.configFile).oauthClientId).toBe("Iv1.from-file");
  });

  test("a GitHub device-code error is the setup line", async () => {
    const scene = await arrange({ policy: "custom: true\n" });
    const github = new FakeGitHubApi();
    github.deviceCodeResponse = () =>
      Response.json(
        {
          error: "device_flow_disabled",
          error_description: "Device flow must be explicitly enabled for this App",
        },
        { status: 400 },
      );
    const stderr: string[] = [];
    const code = await runSetup(
      ["--home", scene.home, "--checkout", scene.checkout, "--implementer", "claude"],
      {
        env: { ...setupEnv(scene), PAWS_GITHUB_CLIENT_ID: "Iv1.real-client" },
        cwd: scene.checkout,
        fetch: github.fetch,
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        readLine: async () => {
          throw new Error("setup prompted");
        },
        github: {
          store: createTokenStore({ home: scene.home, which: () => null, platform: "linux" }),
          sleep: async () => undefined,
          openBrowser: async () => undefined,
        },
      },
    );
    expect(code).toBe(1);
    expect(stderr).toEqual([
      "GitHub device-code error (device_flow_disabled: Device flow must be explicitly enabled for this App). Enable Device Flow on the OAuth App.",
    ]);
    expect(stderr[0]).not.toContain("login github");
    expect(github.deviceAccepts).toEqual(["application/json"]);
    expect(github.polls).toBe(0);
  });
});

class FakeGitHubApi {
  repoPages = 0;
  deviceCodes = 0;
  polls = 0;
  labels: string[] = [];
  bodies: string[] = [];
  repoReads: string[] = [];
  deviceAccepts: string[] = [];
  deviceCodeResponse: (() => Response) | null = null;

  readonly fetch: SetupFetch = async (input, init) => {
    const url = String(input);
    const body =
      init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
    this.bodies.push(body);
    if (url.includes("/login/device/code")) {
      this.deviceCodes += 1;
      this.deviceAccepts.push(acceptHeader(init));
      if (this.deviceCodeResponse !== null) return this.deviceCodeResponse();
      return Response.json({
        device_code: "device-1",
        user_code: "PAWS-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 0,
      });
    }
    if (url.includes("/login/oauth/access_token")) {
      this.polls += 1;
      return Response.json({
        access_token: SETUP_TOKEN,
        token_type: "bearer",
        scope: "repo read:org",
      });
    }
    if (url.includes("/user/repos")) {
      this.repoPages += 1;
      if (!url.includes("page=2")) {
        return Response.json(
          [
            { full_name: "no-push/hidden", permissions: { push: false } },
            { full_name: "acme/widgets", permissions: { push: true } },
          ],
          { headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } },
        );
      }
      return Response.json([
        { full_name: "acme/other", permissions: { push: true } },
        { full_name: "secret/no", permissions: { push: false } },
      ]);
    }
    if (url.includes("/repos/acme/widgets") && (init?.method ?? "GET") === "GET") {
      this.repoReads.push("acme/widgets");
      return Response.json({ permissions: { push: true } });
    }
    if (url.endsWith("/labels")) {
      const parsed = JSON.parse(body) as { name?: string };
      if (parsed.name) this.labels.push(parsed.name);
      return Response.json({ name: parsed.name }, { status: 201 });
    }
    if (url.endsWith("/user")) {
      return Response.json(
        { login: "octocat", id: 7 },
        { headers: { "X-OAuth-Scopes": "repo, read:org" } },
      );
    }
    return new Response("missing", { status: 404 });
  };
}

function setupEnv(scene: Scene, gitLog?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: scene.bin };
  delete env.PAWS_HOME;
  delete env.PAWS_GITHUB_REPOSITORY;
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.PAWS_GITHUB_TOKEN;
  delete env.PAWS_GITHUB_CLIENT_ID;
  if (gitLog !== undefined) env.GIT_FAKE_LOG = gitLog;
  return env;
}

function recordingGit(log: string): string {
  return `#!/bin/sh
real=${REAL_GIT}
printf '%s\\n' "$*" >> "${log}"
printf 'env PAWS_GITHUB_TOKEN=%s GH_TOKEN=%s GITHUB_TOKEN=%s\\n' "\${PAWS_GITHUB_TOKEN-}" "\${GH_TOKEN-}" "\${GITHUB_TOKEN-}" >> "${log}"
env >> "${log}"
for arg in "$@"; do
  case "$arg" in
    credential.helper=/*)
      script="\${arg#credential.helper=}"
      if [ -f "$script" ]; then
        echo HELPER >> "${log}"
        cat "$script" >> "${log}"
      fi
      ;;
  esac
done
args=""
skip=0
for arg in "$@"; do
  if [ "$skip" = "1" ]; then
    skip=0
    continue
  fi
  if [ "$arg" = "-c" ]; then
    skip=1
    continue
  fi
  args="$args $arg"
done
set -- $args
if [ "$1" = "clone" ] && [ "$2" = "--bare" ]; then
  "$real" init --bare "$4" >/dev/null
  "$real" --git-dir "$4" remote add origin "$3"
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "git version 2.43.0"
  exit 0
fi
if [ "$1" = "fetch" ] || [ "$3" = "fetch" ]; then
  exit 0
fi
exec "$real" "$@"
`;
}
