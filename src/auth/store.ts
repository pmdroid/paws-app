import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pawsPaths } from "../config";
import { FILE_TOKEN_STORE_DOCTOR_WARNING } from "./messages";

export const KEYCHAIN_SERVICE = "paws-github";
export const OAUTH_FILE_NAME = "github-oauth.json";

export type TokenBackend = "keychain" | "secret-tool" | "file";

export type StoredGitHubOAuth = {
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs: number | null;
  scope: string;
  login: string;
  id: number;
  invalid: boolean;
};

export type CommandResult = { code: number; stdout: string; stderr: string };

export type CommandRunner = (
  command: string,
  args: readonly string[],
  stdin?: string,
) => Promise<CommandResult>;

export type GitHubTokenStore = {
  readonly backend: TokenBackend;
  /** Set when the token file is the fallback. Doctor prints this. */
  readonly warning: string | null;
  load(): Promise<StoredGitHubOAuth | null>;
  save(token: StoredGitHubOAuth): Promise<void>;
  markInvalid(): Promise<void>;
  delete(): Promise<void>;
};

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export function githubOAuthPath(home: string): string {
  return join(pawsPaths(home).secretsDir, OAUTH_FILE_NAME);
}

export function createTokenStore(options: {
  home: string;
  platform?: NodeJS.Platform;
  which?: (bin: string) => string | null;
  run?: CommandRunner;
}): GitHubTokenStore {
  const platform = options.platform ?? process.platform;
  const which = options.which ?? ((bin: string) => Bun.which(bin));
  const run = options.run ?? runCommand;
  const preferred = selectBackend(platform, which);
  let backend = existsSync(githubOAuthPath(options.home)) ? ("file" as const) : preferred;
  const store: GitHubTokenStore = {
    get backend() {
      return existsSync(githubOAuthPath(options.home)) ? "file" : backend;
    },
    get warning() {
      return store.backend === "file" ? FILE_TOKEN_STORE_DOCTOR_WARNING : null;
    },
    load: () => loadToken(options.home, store.backend, run),
    async save(token) {
      try {
        await saveToken(options.home, store.backend, run, token);
      } catch (error) {
        if (!(error instanceof SecretServiceUnavailableError)) throw error;
        await saveToken(options.home, "file", run, token);
        backend = "file";
      }
    },
    async markInvalid() {
      const current = await store.load();
      if (current !== null) await store.save({ ...current, invalid: true });
    },
    delete: () => deleteToken(options.home, preferred, run),
  };
  return store;
}

export async function runCommand(
  command: string,
  args: readonly string[],
  stdin?: string,
): Promise<CommandResult> {
  const proc = Bun.spawn([command, ...args], {
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin);
    await proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function selectBackend(
  platform: NodeJS.Platform,
  which: (bin: string) => string | null,
): TokenBackend {
  if (platform === "darwin" && which("security") !== null) return "keychain";
  if (which("secret-tool") !== null) return "secret-tool";
  return "file";
}

async function loadToken(
  home: string,
  backend: TokenBackend,
  run: CommandRunner,
): Promise<StoredGitHubOAuth | null> {
  if (backend === "file") return readFileToken(home);
  if (backend === "keychain") {
    const result = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
    if (result.code !== 0) return null;
    return parseStored(result.stdout);
  }
  const result = await runSecretTool(run, ["lookup", "service", KEYCHAIN_SERVICE]);
  if (result.code === 1 && result.stdout.trim() === "" && result.stderr.trim() === "") return null;
  if (result.code !== 0) throw new Error("Could not load the GitHub token with secret-tool");
  return parseStored(result.stdout);
}

async function saveToken(
  home: string,
  backend: TokenBackend,
  run: CommandRunner,
  token: StoredGitHubOAuth,
): Promise<void> {
  assertLogin(token.login);
  const payload = `${JSON.stringify(token)}\n`;
  if (backend === "file") {
    writeFileToken(home, payload);
    return;
  }
  if (backend === "keychain") {
    const result = await run(
      "security",
      ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", token.login, "-w"],
      payload,
    );
    if (result.code !== 0) throw new Error("Could not save the GitHub token to the keychain");
    return;
  }
  const result = await runSecretTool(
    run,
    ["store", "--label=paws-github", "service", KEYCHAIN_SERVICE, "account", token.login],
    payload,
  );
  if (result.code !== 0) throw new Error("Could not save the GitHub token with secret-tool");
}

class SecretServiceUnavailableError extends Error {
  constructor() {
    super(
      "Secret Service is unavailable. Restore the session service and retry, or sign in again to save a private file fallback.",
    );
  }
}

async function runSecretTool(
  run: CommandRunner,
  args: readonly string[],
  stdin?: string,
): Promise<CommandResult> {
  let result: CommandResult;
  try {
    result = await run("secret-tool", args, stdin);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") throw new SecretServiceUnavailableError();
    throw error;
  }
  if (result.code !== 0 && secretServiceUnavailable(result.stderr)) {
    throw new SecretServiceUnavailableError();
  }
  return result;
}

function secretServiceUnavailable(stderr: string): boolean {
  if (
    /permission denied|accessdenied|not authorized|authentication|cancelled|canceled|islocked|locked/i.test(
      stderr,
    )
  )
    return false;
  return /(?:cannot|unable to) autolaunch (?:a )?(?:d-?bus|dbus-daemon)|could not connect: (?:no such file or directory|connection refused)|org\.freedesktop\.DBus\.Error\.(?:ServiceUnknown|NoServer)|the name org\.freedesktop\.secrets was not provided by any \.service files|(?:StartServiceByName for org\.freedesktop\.secrets|Process org\.freedesktop\.secrets).*exited with status/i.test(
    stderr,
  );
}

async function deleteToken(home: string, backend: TokenBackend, run: CommandRunner): Promise<void> {
  if (backend === "keychain") {
    const current = await loadToken(home, backend, run);
    if (current !== null) {
      const result = await run("security", [
        "delete-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        current.login,
      ]);
      if (result.code !== 0) throw new Error("Could not delete the GitHub token from the keychain");
    }
  } else if (backend === "secret-tool") {
    const result = await runSecretTool(run, ["clear", "service", KEYCHAIN_SERVICE]);
    if (result.code !== 0 && !(result.code === 1 && result.stderr.trim() === "")) {
      throw new Error("Could not delete the GitHub token with secret-tool");
    }
  }
  const path = githubOAuthPath(home);
  if (existsSync(path)) rmSync(path);
}

function readFileToken(home: string): StoredGitHubOAuth | null {
  const path = githubOAuthPath(home);
  if (!existsSync(path)) return null;
  return parseStored(readFileSync(path, "utf8"));
}

function writeFileToken(home: string, payload: string): void {
  const path = githubOAuthPath(home);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const staging = mkdtempSync(join(dir, ".github-oauth-"));
  try {
    const temporary = join(staging, OAUTH_FILE_NAME);
    writeFileSync(temporary, payload, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function parseStored(text: string): StoredGitHubOAuth | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    const accessToken = parsed.accessToken;
    const login = parsed.login;
    const id = parsed.id;
    if (typeof accessToken !== "string" || accessToken.length === 0) return null;
    if (typeof login !== "string" || !LOGIN.test(login)) return null;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return null;
    const refresh = parsed.refreshToken;
    const expires = parsed.expiresAtMs;
    return {
      accessToken,
      refreshToken: typeof refresh === "string" && refresh.length > 0 ? refresh : null,
      expiresAtMs: typeof expires === "number" && Number.isFinite(expires) ? expires : null,
      scope: typeof parsed.scope === "string" ? parsed.scope : "",
      login,
      id,
      invalid: parsed.invalid === true,
    };
  } catch {
    return null;
  }
}

function assertLogin(login: string): void {
  if (!LOGIN.test(login)) throw new Error("GitHub login is not a usable account name");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
