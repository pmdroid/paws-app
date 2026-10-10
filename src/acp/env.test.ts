import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { isBlockedEnv, minimalAgentEnv } from "./env";
import { TerminalRegistry } from "./host-tools";
import { checkOwnLogin } from "./run";

const roots: string[] = [];
const credentials = Object.fromEntries(
  [
    "LINEAR_API_KEY",
    "LINEAR_ACCESS_TOKEN",
    "LINEAR_WEBHOOK_SECRET",
    "PAWS_LINEAR_TOKEN",
    "NGROK_AUTHTOKEN",
    "CLOUDFLARE_API_TOKEN",
    "TUNNEL_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AZURE_CLIENT_SECRET",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "KUBECONFIG",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_APP_PRIVATE_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "XAI_API_KEY",
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "SLACK_BOT_TOKEN",
    "SENTRY_AUTH_TOKEN",
    "DATABASE_URL",
    "UNRECOGNIZED_INTEGRATION_SECRET",
    "linear_api_key",
    "gh_token",
    "xai_api_key",
  ].map((key) => [key, `synthetic-${key.toLowerCase()}`]),
);
const injection = Object.fromEntries(
  [
    "NODE_OPTIONS",
    "NODE_PATH",
    "BUN_OPTIONS",
    "BUN_ENV_FILE",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "BASH_ENV",
    "ENV",
    "ZDOTDIR",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "RUBYOPT",
    "PERL5OPT",
    "GIT_ASKPASS",
    "GIT_SSH_COMMAND",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "npm_config_node_options",
    "npm_config_userconfig",
    "CLAUDE_CODE_EXECUTABLE",
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "SSLKEYLOGFILE",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "LC_SECRET",
  ].map((key) => [key, `synthetic-${key.toLowerCase()}`]),
);

const benign = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  LANG: "en_US.UTF-8",
  LC_ALL: "C.UTF-8",
  LC_CTYPE: "C.UTF-8",
  TERM: "xterm-256color",
  TZ: "UTC",
  USER: "synthetic-user",
  LOGNAME: "synthetic-user",
  SHELL: "/bin/sh",
  TMPDIR: "/tmp",
  TMP: "/tmp",
  TEMP: "/tmp",
  XDG_CACHE_HOME: "/tmp/synthetic-cache",
  XDG_CONFIG_HOME: "/tmp/synthetic-config",
  XDG_DATA_HOME: "/tmp/synthetic-data",
  XDG_STATE_HOME: "/tmp/synthetic-state",
  XDG_RUNTIME_DIR: "/tmp/synthetic-runtime",
  CODEX_HOME: "/tmp/synthetic-codex",
  CLAUDE_CONFIG_DIR: "/tmp/synthetic-claude",
  BUN_INSTALL: "/tmp/synthetic-bun",
  BUN_INSTALL_CACHE_DIR: "/tmp/synthetic-bun-cache",
  npm_config_cache: "/tmp/synthetic-npm-cache",
  NODE_COMPILE_CACHE: "/tmp/synthetic-node-cache",
  HTTP_PROXY: "http://127.0.0.1:8080",
  https_proxy: "https://proxy.example.test:443",
  ALL_PROXY: "socks5h://127.0.0.1:1080",
  NO_PROXY: "localhost,127.0.0.1,.example.test",
  NODE_EXTRA_CA_CERTS: "/tmp/synthetic-ca.pem",
  SystemRoot: "C:\\Windows",
  ComSpec: "C:\\Windows\\System32\\cmd.exe",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  USERPROFILE: "C:\\Users\\Synthetic",
  APPDATA: "C:\\Users\\Synthetic\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\Synthetic\\AppData\\Local",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("only explicitly required runtime and own-login environment survives", () => {
  const base = { ...benign, HOME: "/tmp/synthetic-home", ...credentials, ...injection };
  expect(minimalAgentEnv(base)).toEqual({ ...benign, HOME: base.HOME });
  for (const key of [...Object.keys(credentials), ...Object.keys(injection), "FUTURE_ENV"]) {
    expect(isBlockedEnv(key)).toBe(true);
  }
  expect(minimalAgentEnv({ HOME: undefined, PATH: "", FUTURE_ENV: "synthetic-future" })).toEqual({
    PATH: "",
  });
});

test("only intentional Grok opt-in admits a nonempty XAI_API_KEY", () => {
  expect(minimalAgentEnv(credentials)).toEqual({});
  expect(minimalAgentEnv(credentials, { allowXaiApiKey: true })).toEqual({
    XAI_API_KEY: credentials.XAI_API_KEY!,
  });
  expect(minimalAgentEnv({ XAI_API_KEY: "" }, { allowXaiApiKey: true })).toEqual({});
  expect(minimalAgentEnv({}, { allowXaiApiKey: true })).toEqual({});
});

test("proxy settings cannot forward embedded credentials or token parameters", () => {
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    for (const value of [
      "http://synthetic-user:synthetic-password@proxy.example.test:8080",
      "http://synthetic-token@proxy.example.test:8080",
      "http://proxy.example.test:8080?token=synthetic-token",
      "http://proxy.example.test:8080/synthetic-token",
      "http://proxy.example.test:8080#synthetic-token",
      "not-a-proxy",
      "file:///tmp/synthetic-token",
    ]) {
      expect(minimalAgentEnv({ [key]: value })).toEqual({});
    }
  }
});

test.each([false, true])(
  "ACP child preserves own-login home with Grok opt-in %s",
  async (allowXaiApiKey) => {
    const root = await tempRoot();
    const home = join(root, "home");
    const resultPath = join(root, "child-env.json");
    const fakePath = join(root, "fake-agent.ts");
    await mkdir(home);
    await writeFile(
      join(home, "own-login.json"),
      JSON.stringify({ account: "synthetic-own-login" }),
    );
    await writeFile(
      fakePath,
      `import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const login = JSON.parse(readFileSync(process.env.HOME + "/own-login.json", "utf8"));
writeFileSync(process.argv[2], JSON.stringify({ env: process.env, login }));
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "own-login", name: "Own login" }]
  } }) + "\\n");
});
`,
    );
    const base = { ...benign, HOME: home, ...credentials };
    const auth = await checkOwnLogin({
      role: "implementer",
      command: process.execPath,
      args: ["--no-env-file", fakePath, resultPath],
      env: base,
      timeoutMs: 5_000,
      allowXaiApiKey,
    });
    expect(auth.authMethods.map((method) => method.id)).toEqual(["own-login"]);
    const observed = JSON.parse(await readFile(resultPath, "utf8"));
    expect(observed.login).toEqual({ account: "synthetic-own-login" });
    expect(observed.env).toEqual({
      ...benign,
      HOME: home,
      ...(allowXaiApiKey ? { XAI_API_KEY: credentials.XAI_API_KEY } : {}),
    });
  },
);

test("host terminal child cannot inherit or reintroduce rejected environment", async () => {
  const root = await tempRoot();
  const terminals = new TerminalRegistry(
    { worktree: root, home: root, pawsRoot: join(root, ".paws") },
    { HOME: root, PATH: benign.PATH, ...credentials, ...injection },
  );
  const { terminalId } = terminals.create({
    sessionId: "synthetic-session",
    command: "printenv",
    env: Object.entries({
      ...credentials,
      ...injection,
      HTTPS_PROXY: "http://synthetic-user:synthetic-password@proxy.example.test:8080",
      LANG: "C.UTF-8",
    }).map(([name, value]) => ({ name, value })),
  });
  try {
    expect((await terminals.wait({ sessionId: "synthetic-session", terminalId })).exitCode).toBe(0);
    const output = terminals.output({ sessionId: "synthetic-session", terminalId }).output;
    expect(output.split("\n").filter(Boolean).sort()).toEqual(
      [`HOME=${root}`, `PATH=${benign.PATH}`, "LANG=C.UTF-8"].sort(),
    );
  } finally {
    terminals.release({ sessionId: "synthetic-session", terminalId });
  }
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "paws-env-test-"));
  roots.push(root);
  return root;
}
