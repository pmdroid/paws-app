import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { mirrorPath } from "../src/acp";
import { pawsPaths, loadConfigFile, renderConfigToml } from "../src/config";
import { DEFAULT_MAX_AWAKE_MS, DEFAULT_MAX_TURNS } from "../src/core";
import { closeoutBinPath } from "../src/install";
import { linearTokenPath } from "../src/linear";
import { runSetup, type SetupFetch } from "../src/setup";

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
        repo: "acme/widgets",
        closeoutBin: closeoutBinPath(scene.home),
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
      closeoutBin: closeoutBinPath(scene.home),
      checkout: scene.checkout,
      maxTurns: DEFAULT_MAX_TURNS,
      maxAwakeMs: DEFAULT_MAX_AWAKE_MS,
    });

    const secretPath = join(scene.paths.secretsDir, "linear-api-key");
    expect(readFileSync(secretPath, "utf8")).toBe(`${API_KEY}\n`);
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    expect(statSync(scene.paths.secretsDir).mode & 0o777).toBe(0o700);
    expect(readFileSync(closeoutBinPath(scene.home))).toEqual(readFileSync(scene.closeoutSource));
    expect(statSync(closeoutBinPath(scene.home)).mode & 0o777).toBe(0o755);
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
      "--home",
      scene.home,
      "--checkout",
      scene.checkout,
      "--closeout-path",
      scene.closeoutSource,
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
    expect(readFileSync(clientPath, "utf8")).toBe(
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
    expect(scene.linear.creates).toHaveLength(1);
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
      {
        name: "closeout has no release assets",
        tweak: {
          args: (scene) =>
            happyArgs(scene).filter(
              (arg) => arg !== scene.closeoutSource && arg !== "--closeout-path",
            ),
        },
        line: "pmdroid/closeout has no published release assets yet. Re-run with --closeout-path set to a local closeout binary.",
      },
      {
        name: "closeout path missing",
        tweak: {
          args: (scene) => [
            ...happyArgs(scene).filter((arg) => arg !== scene.closeoutSource),
            "/tmp/paws-closeout-missing",
          ],
        },
        line: "--closeout-path is not a file (/tmp/paws-closeout-missing). Pass a local closeout binary.",
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
  closeoutSource: string;
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
  const closeoutSource = join(root, "closeout-local");
  writeFileSync(closeoutSource, "#!/bin/sh\necho closeout 0.1.0\n", { mode: 0o755 });
  chmodSync(closeoutSource, 0o755);

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
    closeoutSource,
    mirror: mirrorPath(home, "acme", "widgets"),
    paths: pawsPaths(home),
    linear,
  };
}

function happyArgs(scene: Scene): string[] {
  return [
    "--yes",
    "--home",
    scene.home,
    "--checkout",
    scene.checkout,
    "--linear-api-key",
    API_KEY,
    "--closeout-path",
    scene.closeoutSource,
  ];
}

async function run(
  scene: Scene,
  args: string[],
  extra?: { readLine?: () => Promise<string | null> },
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: scene.bin };
  delete env.PAWS_GITHUB_REPOSITORY;
  delete env.PAWS_HOME;
  const code = await runSetup(args, {
    env,
    cwd: scene.checkout,
    fetch: scene.linear.fetch,
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
    closeoutBinPath(scene.home),
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
