import { Database } from "bun:sqlite";
import { readSecretFile } from "../credentials";
import { existsSync } from "node:fs";
import { resolveAdapter } from "../acp";
import {
  createGitHubTokenProvider,
  createTokenStore,
  DEVICE_SCOPE_MESSAGE,
  GITHUB_REAUTH_MESSAGE,
  missingGitHubClientId,
  scopesGrantRepoAndOrg,
  type GitHubTokenProvider,
} from "../auth";
import { createPersonalLinearClient, type CommentFetch } from "../comments";
import {
  closeoutPolicyRoot,
  loadRuntime,
  pawsPaths,
  type AgentProfiles,
  type EnvSource,
  type GitHubConfigAuth,
  type LinearConfigMode,
  type RuntimeConfig,
  type TrackerKind,
} from "../config";
import { validate } from "../closeout-spec";
import { latestGitHubDelivery, linearWebhookWarning, type LinearWebhookWarning } from "../db";
import { checkGhAuthStatus, ghDoctorChecks } from "../github";
import { checkDeveloperLogin, grokLoginStatus, type GrokLoginStatus } from "../install";
import { doctorAgentProfiles } from "./agents";

/** Core REST calls left after a signed-in doctor check. Below this, doctor reports no headroom. */
export const GITHUB_RATE_HEADROOM = 100;

export type GitHubDoctorFacts = {
  /** `github.oauth_client_id` is still the setup placeholder. */
  placeholder: boolean;
  storeKind: "keychain" | "libsecret" | "file" | "gh" | "app";
  storeWarning: string | null;
  signedIn: { ok: boolean; detail: string };
  push: { ok: boolean; detail: string };
  label: { ok: boolean; detail: string };
  rate: { ok: boolean; detail: string };
};

export type ProbeFacts = {
  configError: string | null;
  agentProfiles?: AgentProfiles[];
  grokLogin?: GrokLoginStatus | null;
  configured: boolean;
  linearMode: LinearConfigMode;
  githubAuth: GitHubConfigAuth;
  trackerKind: TrackerKind;
  oauthClientId: string | null;
  githubDoctor: GitHubDoctorFacts;
  webhooks: boolean;
  linearWebhook?: LinearWebhookWarning | null;
  githubDelivery?: { event: string; receivedAt: number } | null;
  publicUrl: string | null;
  repo: string | null;
  team: string | null;
  teamId: string | null;
  ghLogin: { ok: boolean; detail: string };
  ghPush: { ok: boolean; detail: string };
  claudeAdapter: { ok: boolean; detail: string };
  codexAdapter: { ok: boolean; detail: string };
  claudeLogin: { ok: boolean; detail: string };
  codexLogin: { ok: boolean; detail: string };
  closeout: {
    ok: boolean;
    detail: string;
    /** One next step when the policy did not load. */
    fix: string | null;
  };
  linear: {
    attempted: boolean;
    reachable: boolean;
    viewerId: string | null;
    viewerMatches: boolean;
    teamFound: boolean;
    labelFound: boolean;
    error: string | null;
  };
};

const LOGIN_TIMEOUT_MS = 2_500;

export async function realProbeFacts(env: EnvSource): Promise<ProbeFacts> {
  const runtime = loadRuntime(env);
  const repo = splitRepo(runtime.repo);
  const agentProfiles = doctorAgentProfiles(runtime.file);
  const agents = new Set(
    agentProfiles.flatMap((profile) => [profile.implementer.agent, profile.reviewer.agent]),
  );
  const unused = { ok: true, detail: "not required by configured agent profiles" };
  const [gh, claudeLogin, codexLogin, grokLogin, linear, githubDoctor] = await Promise.all([
    ghFacts(repo),
    agents.has("claude") ? loginFact("claude", env) : unused,
    agents.has("codex") ? loginFact("codex", env) : unused,
    agents.has("grok")
      ? grokLoginStatus({ env, agents: runtime.file.agents, timeoutMs: LOGIN_TIMEOUT_MS })
      : null,
    linearFact(runtime),
    githubDoctorFact(runtime, repo),
  ]);
  return {
    configError: runtime.configError,
    agentProfiles,
    grokLogin,
    configured: runtime.configured,
    linearMode: runtime.linearMode,
    githubAuth: runtime.githubAuth,
    trackerKind: runtime.trackerKind,
    oauthClientId: runtime.oauthClientId,
    githubDoctor: applyGhFallback(runtime, githubDoctor, gh),
    webhooks: runtime.webhooks,
    linearWebhook: readPawsDb(runtime.env.home, (db) => linearWebhookWarning(db, Date.now())),
    githubDelivery: readPawsDb(runtime.env.home, latestGitHubDelivery),
    publicUrl: runtime.publicUrl,
    repo: runtime.repo,
    team: runtime.linearTeam,
    teamId: runtime.linearTeamId,
    ghLogin: gh.login,
    ghPush: gh.push,
    claudeAdapter: agents.has("claude") ? adapterFact("implementer") : unused,
    codexAdapter: agents.has("codex") ? adapterFact("reviewer") : unused,
    claudeLogin,
    codexLogin,
    closeout: closeoutPolicyFact(
      runtime.checkout,
      runtime.env.home,
      closeoutPolicyRoot(runtime.file, runtime.env.home, runtime.repo),
    ),
    linear,
  };
}

function readPawsDb<T>(home: string, read: (db: Database) => T): T | null {
  const file = pawsPaths(home).db;
  if (!existsSync(file)) return null;
  try {
    const db = new Database(file, { readonly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

async function ghFacts(repo: { owner: string; repo: string } | null): Promise<{
  login: { ok: boolean; detail: string };
  push: { ok: boolean; detail: string };
}> {
  if (repo === null) {
    try {
      const login = await checkGhAuthStatus({ owner: "paws", repo: "local" });
      return {
        login: { ok: login.ok, detail: login.message },
        push: { ok: false, detail: "repository must be owner/name" },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "gh auth status failed";
      return {
        login: { ok: false, detail: message },
        push: { ok: false, detail: "repository must be owner/name" },
      };
    }
  }
  try {
    const checks = await ghDoctorChecks(repo);
    const login = checks[0];
    const push = checks[1];
    return {
      login: {
        ok: login?.ok === true,
        detail: login?.message ?? "gh auth status did not return a result",
      },
      push: {
        ok: push?.ok === true,
        detail: push?.message ?? "gh push permission did not return a result",
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "gh auth status failed";
    return {
      login: { ok: false, detail: message },
      push: { ok: false, detail: message },
    };
  }
}

async function loginFact(
  cli: "claude" | "codex",
  env: EnvSource,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const check = await checkDeveloperLogin({
      cli,
      env: env as NodeJS.ProcessEnv,
      timeoutMs: LOGIN_TIMEOUT_MS,
    });
    return { ok: check.loggedIn, detail: check.summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : `${cli} login check failed`;
    return { ok: false, detail: message };
  }
}

function adapterFact(role: "implementer" | "reviewer"): { ok: boolean; detail: string } {
  const bin = role === "implementer" ? "claude-agent-acp" : "codex-acp";
  try {
    const command = resolveAdapter(role).command;
    if (!existsSync(command)) {
      return { ok: false, detail: `${bin} is not installed at ${command}` };
    }
    return { ok: true, detail: `${bin} at ${command}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : `${bin} is not installed`;
    return { ok: false, detail: message };
  }
}

function closeoutPolicyFact(
  checkout: string | null,
  home: string,
  policyRoot?: string,
): ProbeFacts["closeout"] {
  if (checkout === null || checkout.trim().length === 0) {
    return {
      ok: false,
      detail: "checkout is not configured",
      fix: "Configure the repository checkout path.",
    };
  }
  const loaded = validate(checkout, home, policyRoot);
  if (!loaded.ok) {
    return {
      ok: false,
      detail: policyRoot
        ? "configured local Closeout policy is invalid"
        : "policy on origin/main is malformed",
      fix: oneLine(loaded.message),
    };
  }
  if (loaded.absent) {
    return {
      ok: false,
      detail: "origin/main has no closeout policy",
      fix: "Commit .agents/closeout.yaml on origin/main.",
    };
  }
  return {
    ok: true,
    detail: policyRoot ? `local policy loads from ${policyRoot}` : "policy loads on origin/main",
    fix: null,
  };
}

function oneLine(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length > 0 ? line : "Fix .agents/closeout.yaml on origin/main.";
}

async function linearFact(runtime: ReturnType<typeof loadRuntime>): Promise<ProbeFacts["linear"]> {
  const empty = {
    attempted: false,
    reachable: false,
    viewerId: null,
    viewerMatches: false,
    teamFound: false,
    labelFound: false,
    error: null,
  };
  const credential =
    runtime.linearMode === "comments" ? runtime.linearApiKey : runtime.linearAccessToken;
  if (credential === null) return empty;
  const header = runtime.linearMode === "comments" ? credential : `Bearer ${credential}`;
  const fetchImpl: CommentFetch = (input, init) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(8_000) });
  try {
    const client = createPersonalLinearClient({ apiKey: header, fetch: fetchImpl });
    const teamId = runtime.linearTeamId;
    const data =
      teamId === null
        ? await client.query("query Viewer { viewer { id } }")
        : await client.query(
            `query ViewerTeam($id: String!) {
              viewer { id }
              team(id: $id) { id key labels(first: 50) { nodes { name } } }
            }`,
            { id: teamId },
          );
    const root = isRecord(data) ? data : {};
    const viewer = isRecord(root["viewer"]) ? readString(root["viewer"], "id") : null;
    const team = isRecord(root["team"]) ? root["team"] : null;
    const labels = team === null ? [] : labelNames(team["labels"]);
    const viewerMatches =
      viewer !== null && (runtime.linearViewerId === null || runtime.linearViewerId === viewer);
    return {
      attempted: true,
      reachable: viewer !== null,
      viewerId: viewer,
      viewerMatches,
      teamFound: teamId !== null && team !== null,
      labelFound: labels.some((name) => name.toLowerCase() === "paws"),
      error: viewer === null ? "Linear viewer id was missing" : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Linear could not be reached";
    return { ...empty, attempted: true, error: message };
  }
}

function labelNames(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value["nodes"])) return [];
  const names: string[] = [];
  for (const node of value["nodes"]) {
    if (!isRecord(node)) continue;
    const name = readString(node, "name");
    if (name !== null) names.push(name);
  }
  return names;
}

function splitRepo(value: string | null): { owner: string; repo: string } | null {
  if (value === null) return null;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash !== value.lastIndexOf("/")) return null;
  const owner = value.slice(0, slash);
  const repo = value.slice(slash + 1);
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return { owner, repo };
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyGhFallback(
  runtime: RuntimeConfig,
  facts: GitHubDoctorFacts,
  gh: { login: { ok: boolean; detail: string }; push: { ok: boolean; detail: string } },
): GitHubDoctorFacts {
  if (runtime.githubAuth !== "gh" || facts.placeholder) {
    return facts;
  }
  return {
    ...facts,
    signedIn: gh.login,
    push: gh.push,
  };
}

async function githubDoctorFact(
  runtime: RuntimeConfig,
  repo: { owner: string; repo: string } | null,
): Promise<GitHubDoctorFacts> {
  const unused = idleGitHubFacts();
  if (runtime.githubAuth === "gh") return unused;
  const placeholder =
    runtime.githubAuth === "oauth" && missingGitHubClientId(runtime.oauthClientId);
  const store =
    runtime.githubAuth === "oauth" ? createTokenStore({ home: runtime.env.home }) : null;
  const facts: GitHubDoctorFacts = {
    placeholder,
    storeKind:
      store === null
        ? runtime.githubAuth === "app"
          ? "app"
          : "gh"
        : store.backend === "secret-tool"
          ? "libsecret"
          : store.backend,
    storeWarning: store?.warning ?? null,
    signedIn: { ok: false, detail: GITHUB_REAUTH_MESSAGE },
    push: {
      ok: false,
      detail: repo === null ? "repository must be owner/name" : "repository is not pushable",
    },
    label: { ok: false, detail: "paws label is missing" },
    rate: { ok: false, detail: "rate limit was not read" },
  };
  if (placeholder || repo === null) return facts;
  try {
    const provider = githubProvider(runtime, repo);
    const token = await provider.token();
    if (runtime.githubAuth === "app") {
      const bot = await provider.user();
      facts.signedIn = { ok: true, detail: `connected as ${bot.login}` };
      const repository = await githubGet(token, `/repos/${repo.owner}/${repo.repo}`);
      facts.push = {
        ok: repository.ok,
        detail: repository.ok
          ? `app access to ${repo.owner}/${repo.repo}`
          : `no app access to ${repo.owner}/${repo.repo}`,
      };
    }
    if (runtime.githubAuth === "oauth") {
      const user = await githubGet(token, "/user");
      const login = readString(user.body, "login");
      const scopes = user.header("x-oauth-scopes") ?? "";
      if (!user.ok || !scopesGrantRepoAndOrg(scopes)) {
        facts.signedIn = {
          ok: false,
          detail: user.ok ? DEVICE_SCOPE_MESSAGE : GITHUB_REAUTH_MESSAGE,
        };
      } else {
        facts.signedIn = { ok: true, detail: `signed in as ${login ?? "github"}` };
      }
      const repoBody = await githubGet(token, `/repos/${repo.owner}/${repo.repo}`);
      const permissions = isRecord(repoBody.body) ? repoBody.body["permissions"] : null;
      const push = repoBody.ok && isRecord(permissions) && permissions["push"] === true;
      facts.push = {
        ok: push,
        detail: push
          ? `push access to ${repo.owner}/${repo.repo}`
          : `no push access to ${repo.owner}/${repo.repo}`,
      };
    }
    const rate = await githubGet(token, "/rate_limit");
    const remaining = coreRemaining(rate.body);
    if (!rate.ok || remaining === null) {
      facts.rate = { ok: false, detail: "rate limit was not read" };
    } else if (remaining < GITHUB_RATE_HEADROOM) {
      facts.rate = { ok: false, detail: `${remaining} remaining` };
    } else {
      facts.rate = { ok: true, detail: `${remaining} remaining` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub could not be reached";
    if (!facts.signedIn.ok) facts.signedIn = { ok: false, detail: message };
  }
  return facts;
}

function idleGitHubFacts(): GitHubDoctorFacts {
  return {
    placeholder: false,
    storeKind: "gh",
    storeWarning: null,
    signedIn: { ok: true, detail: "not used" },
    push: { ok: true, detail: "not used" },
    label: { ok: true, detail: "not used" },
    rate: { ok: true, detail: "not used" },
  };
}

function githubProvider(
  runtime: RuntimeConfig,
  repo: { owner: string; repo: string },
): GitHubTokenProvider {
  const env = runtime.env;
  let privateKeyPem: string | null = null;
  if (runtime.githubAuth === "app" && env.githubAppPrivateKeyPath !== null) {
    try {
      privateKeyPem = readSecretFile(env.githubAppPrivateKeyPath, false);
    } catch {
      privateKeyPem = null;
    }
  }
  return createGitHubTokenProvider({
    auth: runtime.githubAuth,
    oauthClientId: runtime.oauthClientId,
    repo: `${repo.owner}/${repo.repo}`,
    home: env.home,
    env: process.env,
    appId: env.githubAppId,
    installationId: env.githubAppInstallationId,
    privateKeyPem,
  });
}

type GitHubGet = {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  header(name: string): string | null;
};

async function githubGet(token: string, path: string): Promise<GitHubGet> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "paws",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(8_000),
  });
  const text = await response.text();
  let parsed: unknown = {};
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {};
    }
  }
  const body = isRecord(parsed) ? parsed : {};
  return {
    ok: response.ok,
    status: response.status,
    body,
    header(name: string) {
      return response.headers.get(name);
    },
  };
}

function coreRemaining(body: Record<string, unknown>): number | null {
  const resources = isRecord(body["resources"]) ? body["resources"] : null;
  const core = resources !== null && isRecord(resources["core"]) ? resources["core"] : null;
  if (core === null) return null;
  const remaining = core["remaining"];
  return typeof remaining === "number" && Number.isFinite(remaining) ? remaining : null;
}
