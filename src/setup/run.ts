import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ensureBareMirror, mirrorPath } from "../acp";
import { DEFAULT_LINEAR_MODE } from "../comments";
import {
  closeoutPolicyRoot,
  ensureLayout,
  isImplementer,
  pawsPaths,
  loadConfigFile,
  loadRuntime,
  writeConfigFile,
  type ImplementerName,
  type PawsSetupConfig,
} from "../config";
import { DEFAULT_MAX_AWAKE_MS, DEFAULT_MAX_TURNS } from "../core";
import { assertLinearQueue } from "../db";
import {
  checkGhPushPermission,
  ghDoctorChecks,
  githubHttpsUrl,
  inferGitHubRepository,
} from "../github";
import {
  LINEAR_ACTOR,
  LINEAR_APP_SCOPES,
  authorizeLinear,
  linearTokenPath,
  type StoredLinearToken,
} from "../linear";
import { GITHUB_REAUTH_MESSAGE } from "../auth";
import {
  chooseGitHubRepo,
  cloneGitHubMirror,
  ensureGitHubSignIn,
  resolveSetupGitHubClientId,
  tokenStore,
} from "./github";
import { HELP, parseArgs, type LinearModeFlag, type SetupFlags } from "./args";
import { ensureCloseoutPolicy } from "./closeout";
import { chooseTeam, connectLinear, ensurePawsLabel } from "./linear";
import { createIO, definedEnv, withProcessPath, type SetupIO, type SetupOptions } from "./io";
import { writeLinearOAuth, writeSecretFile } from "./secrets";
import { SetupStopped, stop } from "./stop";
import { detectCandidates, loginLine, selectImplementer } from "./setup";
import {
  ensureBun,
  ensureDeveloperLogin,
  ensureGhLogin,
  ensureGit,
  ensureGrokLogin,
} from "./tools";

const API_KEY_FILE = "secrets/linear-api-key";
const CLIENT_FILE = "secrets/linear-client.json";
const OAUTH_FILE = "secrets/linear-oauth.json";

const KEY_PROMPT = "Comment mode needs a Linear personal API key. Pass --linear-api-key.";
const APP_PROMPT =
  "Agent mode needs a Linear OAuth app. Pass --linear-client-id and --linear-client-secret.";
const TOKEN_PROMPT = "Agent mode needs a Linear access token. Pass --linear-access-token.";

/**
 * Interactive local setup. `--yes` reads flags and exits on the first failed check.
 * QM-20 wires this into `paws setup`. Login commands are printed, never run.
 */
export async function runSetup(argv: readonly string[], options?: SetupOptions): Promise<number> {
  const io = createIO(options);
  const secrets: string[] = [];
  try {
    await run(argv, io, secrets);
    return 0;
  } catch (error) {
    const line = error instanceof SetupStopped ? error.line : fallbackLine(error);
    io.stderr(redact(line, secrets));
    return 1;
  }
}

async function run(argv: readonly string[], io: SetupIO, secrets: string[]): Promise<void> {
  const flags = parseArgs(argv);
  if (flags.help) {
    io.stdout(HELP);
    return;
  }
  flags.linearClientId ??= io.env.LINEAR_CLIENT_ID ?? null;
  flags.linearClientSecret ??= io.env.LINEAR_CLIENT_SECRET ?? null;
  remember(secrets, flags.linearApiKey);
  remember(secrets, flags.linearClientSecret);
  remember(secrets, flags.linearAccessToken);
  remember(secrets, flags.linearRefreshToken);

  ensureBun(io.env);
  ensureGit(io.env);
  const home = resolveHome(flags, io);
  const paths = pawsPaths(home);
  assertLinearQueue(paths.db);
  ensureLayout(paths);
  const oauthClientId = resolveSetupGitHubClientId(home, io.env);
  const previous = loadRuntime({ ...io.env, PAWS_HOME: home });
  if (previous.configError !== null) loadConfigFile(paths.configFile);
  const githubAuth =
    previous.configured ||
    previous.githubAuth === "app" ||
    io.env.GITHUB_AUTH ||
    io.env.PAWS_GITHUB_AUTH
      ? previous.githubAuth
      : "oauth";
  const useGitHubApp = githubAuth === "app";
  let githubToken: string | null = null;
  if (githubAuth !== "gh") {
    const signedIn = await ensureGitHubSignIn({
      yes: flags.yes,
      home,
      env: io.env,
      io,
      secrets,
      oauthClientId,
      app: useGitHubApp,
      repo: flags.repo,
    });
    githubToken = signedIn.token;
  }
  if (githubAuth === "gh") await ensureGhLogin(io, flags.yes);
  const implementer = await chooseImplementer(flags, io);
  if (implementer === "claude") await ensureDeveloperLogin("claude", io, flags.yes);
  if (implementer === "grok") await ensureGrokLogin(io, flags.yes);
  await ensureDeveloperLogin("codex", io, flags.yes);

  const checkout = resolve(io.cwd, flags.checkout ?? io.cwd);
  if (!existsSync(checkout) || !statSync(checkout).isDirectory()) {
    stop(`Checkout ${checkout} does not exist. Pass --checkout pointing at a local clone.`);
  }

  const mode = flags.linearMode ?? DEFAULT_LINEAR_MODE;
  const reconnect = mode === "agent-session" ? io.linearReconnect?.(home) : undefined;
  let linear: LinearSecrets | null = null;
  let team: { key: string; id: string } | null = null;
  let viewerId = "";
  {
    linear = await resolveLinear(flags, io, mode, secrets);
    const connected = await connectLinear({ mode, secret: linear.apiSecret, fetch: io.fetch });
    team = await chooseTeam({
      client: connected.client,
      mode,
      wanted: flags.linearTeam,
      yes: flags.yes,
      io,
    });
    viewerId = connected.viewerId;
    if (mode === "comments") await ensurePawsLabel(connected.client, team.id, mode);
  }

  let repository: { owner: string; repo: string };
  if (githubAuth !== "gh") {
    if (githubToken === null) stop(GITHUB_REAUTH_MESSAGE);
    const store = tokenStore(home, io.github);
    repository = await chooseGitHubRepo({
      token: githubToken,
      repo: flags.repo,
      yes: flags.yes,
      io,
      store,
    });
    await cloneGitHubMirror({
      home,
      owner: repository.owner,
      repo: repository.repo,
      token: githubToken,
      env: io.env,
    });
  } else {
    repository = await withProcessPath(io.env.PATH, () => resolveRepository(flags, io, checkout));
    const remoteUrl = githubHttpsUrl(repository.owner, repository.repo);
    const permission = await checkGhPushPermission({
      owner: repository.owner,
      repo: repository.repo,
      env: io.env,
    });
    if (!permission.ok) stop(permission.message);
    const mirror = mirrorPath(home, repository.owner, repository.repo);
    try {
      await withProcessPath(io.env.PATH, () =>
        ensureBareMirror({
          remoteUrl,
          owner: repository.owner,
          repo: repository.repo,
          pawsRoot: home,
        }),
      );
      await keepCleanOrigin(mirror, remoteUrl, io.env);
    } catch (error) {
      if (error instanceof SetupStopped) throw error;
      stop(
        `Could not create the bare mirror of ${repository.owner}/${repository.repo}. Confirm gh can reach the repo and try again.`,
      );
    }
  }

  const policyRoot = closeoutPolicyRoot(
    previous.file,
    home,
    `${repository.owner}/${repository.repo}`,
  );
  await ensureCloseoutPolicy({ checkout, policyRoot, yes: flags.yes, io });

  if (linear !== null) {
    const token = linearToken(linear);
    const stored =
      reconnect !== undefined &&
      (await reconnect.complete({ clientId: linear.clientId ?? "", token }));
    writeLinearSecrets(paths.secretsDir, mode, linear, token, stored);
  }
  const webhookSecret = io.env.LINEAR_WEBHOOK_SECRET;
  if (webhookSecret) writeSecretFile(join(paths.secretsDir, "linear-webhook"), webhookSecret);
  const config: PawsSetupConfig = {
    linearMode: mode,
    linearTeam: team?.key ?? "",
    linearTeamId: team?.id ?? "",
    linearViewerId: viewerId,
    linearSecret: mode === "comments" ? API_KEY_FILE : OAUTH_FILE,
    linearClientFile: mode === "agent-session" ? CLIENT_FILE : null,
    githubAuth,
    ...(githubAuth !== "gh" ? { oauthClientId } : {}),
    trackerKind: "linear",
    repo: `${repository.owner}/${repository.repo}`,
    checkout,
    maxTurns: DEFAULT_MAX_TURNS,
    maxAwakeMs: DEFAULT_MAX_AWAKE_MS,
    implementer,
  };
  writeConfigFile(paths.configFile, config);
  if (linear !== null) {
    assertSecretMode(join(home, config.linearSecret));
    if (config.linearClientFile !== null) assertSecretMode(join(home, config.linearClientFile));
  }

  if (githubAuth === "gh") {
    const doctor = await ghDoctorChecks({
      owner: repository.owner,
      repo: repository.repo,
      env: io.env,
    });
    for (const check of doctor) {
      if (!check.ok) stop(check.message);
    }
  }
  const policy = join(policyRoot ?? checkout, ".agents", "closeout.yaml");
  if (!existsSync(policy)) {
    stop(`Create ${policy} before running Paws.`);
  }
  io.stdout(`paws setup wrote ${paths.configFile}`);
}

async function chooseImplementer(flags: SetupFlags, io: SetupIO): Promise<ImplementerName> {
  if (flags.implementer !== null) return flags.implementer;
  if (flags.yes) return "claude";
  const candidates = detectCandidates({
    env: io.env,
    which: (bin) => Bun.which(bin, { PATH: io.env.PATH ?? "" }),
  });
  const selected = await selectImplementer({
    candidates,
    readLine: () => io.readLine(),
    write: (text) => {
      for (const line of text.split("\n")) {
        if (line.length > 0) io.stdout(line);
      }
    },
  });
  if (selected === null || !isImplementer(selected.id)) {
    stop("Choose an installed implementer: claude, grok, or codex.");
  }
  const line = loginLine(selected);
  for (const row of line.split("\n")) {
    if (row.length > 0) io.stdout(row);
  }
  return selected.id;
}

type LinearSecrets = {
  apiSecret: string;
  clientId: string | null;
  clientSecret: string | null;
  refreshToken: string | null;
  oauthToken?: StoredLinearToken;
};

async function resolveLinear(
  flags: SetupFlags,
  io: SetupIO,
  mode: LinearModeFlag,
  secrets: string[],
): Promise<LinearSecrets> {
  if (mode === "comments") {
    const apiSecret = await askSecret(
      flags.linearApiKey,
      flags.yes,
      io,
      "Linear personal API key:",
      KEY_PROMPT,
    );
    remember(secrets, apiSecret);
    return { apiSecret, clientId: null, clientSecret: null, refreshToken: null };
  }
  const clientId = await askSecret(
    flags.linearClientId,
    flags.yes,
    io,
    "Linear OAuth client id:",
    APP_PROMPT,
  );
  const clientSecret = await askSecret(
    flags.linearClientSecret,
    flags.yes,
    io,
    "Linear OAuth client secret:",
    APP_PROMPT,
  );
  remember(secrets, clientSecret);
  let oauthToken: StoredLinearToken | undefined;
  if (!flags.linearAccessToken?.trim() && !flags.yes) {
    oauthToken = await authorizeLinear({
      clientId,
      clientSecret,
      ...(io.fetch ? { fetch: (url, init) => io.fetch!(String(url), init) } : {}),
      ...(io.linear?.port !== undefined ? { port: io.linear.port } : {}),
      ...(io.linear?.timeoutMs !== undefined ? { timeoutMs: io.linear.timeoutMs } : {}),
      async onAuthorize(url) {
        io.stdout(`Linear redirect URI: ${new URL(url).searchParams.get("redirect_uri")}`);
        io.stdout("Open this link to install Paws in Linear:");
        io.stdout(url);
        await io.linear?.onAuthorize?.(url);
      },
    });
  }
  const apiSecret = await askSecret(
    oauthToken?.accessToken ?? flags.linearAccessToken,
    flags.yes,
    io,
    "Linear access token:",
    TOKEN_PROMPT,
  );
  let refreshToken = oauthToken?.refreshToken ?? flags.linearRefreshToken?.trim() ?? "";
  if (refreshToken.length === 0 && !flags.yes && oauthToken === undefined) {
    io.stdout("Linear refresh token (optional):");
    refreshToken = (await io.readLine())?.trim() ?? "";
  }
  remember(secrets, clientSecret);
  remember(secrets, apiSecret);
  remember(secrets, refreshToken);
  return {
    apiSecret,
    clientId,
    clientSecret,
    refreshToken: refreshToken.length > 0 ? refreshToken : null,
    ...(oauthToken ? { oauthToken } : {}),
  };
}

async function askSecret(
  given: string | null,
  yes: boolean,
  io: SetupIO,
  prompt: string,
  missing: string,
): Promise<string> {
  const provided = given?.trim() ?? "";
  if (provided.length > 0) return provided;
  if (yes) stop(missing);
  io.stdout(prompt);
  const answer = (await io.readLine())?.trim() ?? "";
  if (answer.length === 0) stop(missing);
  return answer;
}

async function resolveRepository(
  flags: SetupFlags,
  io: SetupIO,
  checkout: string,
): Promise<{ owner: string; repo: string }> {
  try {
    return await inferGitHubRepository({
      cwd: checkout,
      env: inferenceEnv(io.env, flags.repo),
    });
  } catch {
    if (flags.yes || flags.repo !== null) {
      stop(
        flags.repo !== null
          ? "Pass --repo as owner/name."
          : `Could not infer a GitHub repository from ${checkout}. Pass --repo owner/name.`,
      );
    }
  }
  io.stdout("GitHub repo (owner/name):");
  const typed = (await io.readLine())?.trim() ?? "";
  if (typed.length === 0) {
    stop(`Could not infer a GitHub repository from ${checkout}. Pass --repo owner/name.`);
  }
  try {
    return await inferGitHubRepository({
      cwd: checkout,
      env: inferenceEnv(io.env, typed),
    });
  } catch {
    stop("Pass --repo as owner/name.");
  }
}

function inferenceEnv(env: NodeJS.ProcessEnv, repo: string | null): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  if (repo !== null && repo.trim().length > 0) next.PAWS_GITHUB_REPOSITORY = repo.trim();
  else delete next.PAWS_GITHUB_REPOSITORY;
  return next;
}

function writeLinearSecrets(
  secretsDir: string,
  mode: LinearModeFlag,
  linear: LinearSecrets,
  token: StoredLinearToken,
  stored: boolean,
): void {
  if (mode === "comments") {
    writeSecretFile(join(secretsDir, "linear-api-key"), `${linear.apiSecret}\n`);
    return;
  }
  const clientId = linear.clientId ?? "";
  const clientSecret = linear.clientSecret ?? "";
  writeSecretFile(
    join(secretsDir, "linear-client.json"),
    `${JSON.stringify({ clientId, clientSecret })}\n`,
  );
  if (!stored) writeLinearOAuth(linearTokenPath(secretsDir), token);
}

function linearToken(linear: LinearSecrets): StoredLinearToken {
  if (linear.oauthToken !== undefined) return linear.oauthToken;
  const now = Date.now();
  return {
    accessToken: linear.apiSecret,
    refreshToken: linear.refreshToken,
    expiresAtMs:
      linear.refreshToken === null ? now + 365 * 24 * 60 * 60 * 1000 : now + 23 * 60 * 60 * 1000,
    scope: LINEAR_APP_SCOPES,
    actor: LINEAR_ACTOR,
  };
}

function assertSecretMode(path: string): void {
  if (!existsSync(path) || (statSync(path).mode & 0o777) !== 0o600) {
    stop(`Linear secret must be mode 0600 (${path}).`);
  }
}

function resolveHome(flags: SetupFlags, io: SetupIO): string {
  const fromFlag = flags.home?.trim() ?? "";
  const fromEnv = io.env.PAWS_HOME?.trim() ?? "";
  let raw = join(homedir(), ".paws");
  if (fromFlag.length > 0) raw = fromFlag;
  else if (fromEnv.length > 0) raw = fromEnv;
  return isAbsolute(raw) ? raw : resolve(io.cwd, raw);
}

/** A credential rewrite must not leave a token in the bare mirror's origin URL. */
async function keepCleanOrigin(
  gitDir: string,
  remoteUrl: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const read = Bun.spawn(["git", "--git-dir", gitDir, "config", "--get", "remote.origin.url"], {
    env: definedEnv(env),
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const stdout = await new Response(read.stdout).text();
  const code = await read.exited;
  if (code !== 0)
    stop("Could not read the bare mirror remote. Confirm git can see the mirror and try again.");
  if (stdout.trim() === remoteUrl) return;
  const write = Bun.spawn(["git", "--git-dir", gitDir, "config", "remote.origin.url", remoteUrl], {
    env: definedEnv(env),
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  const written = await write.exited;
  if (written !== 0) {
    stop("Could not record the bare mirror remote. Confirm git can see the mirror and try again.");
  }
}

function remember(secrets: string[], value: string | null | undefined): void {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length >= 8 && !secrets.includes(trimmed)) secrets.push(trimmed);
}

function redact(line: string, secrets: readonly string[]): string {
  let out = line;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out.replace(/\s+/g, " ").trim();
}

function fallbackLine(error: unknown): string {
  const message =
    error instanceof Error && error.message.length > 0 ? error.message : "Setup failed.";
  return message;
}

if (import.meta.main) {
  const code = await runSetup(process.argv.slice(2));
  process.exit(code);
}
