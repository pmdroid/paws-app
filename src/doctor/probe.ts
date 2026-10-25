import { Database } from "bun:sqlite";
import { readSecretFile } from "../credentials";
import { existsSync } from "node:fs";
import { resolveAdapter } from "../acp";
import {
  closeoutPolicyRoot,
  exeDevTokenStatus,
  loadRuntime,
  pawsPaths,
  type AgentProfiles,
  type EnvSource,
  type ExeDevTokenStatus,
  type RuntimeConfig,
  type TrackerKind,
} from "../config";
import { validate } from "../closeout-spec";
import { latestGitHubDelivery, linearWebhookWarning, type LinearWebhookWarning } from "../db";
import { createFetchGitHubClient, mintInstallationToken, signAppJwt } from "../github";
import { checkDeveloperLogin, grokLoginStatus, type GrokLoginStatus } from "../install";
import { createLinearClient } from "../linear";
import { doctorAgentProfiles } from "./agents";

/** Core REST calls left for the App installation. Below this, doctor reports no headroom. */
export const GITHUB_RATE_HEADROOM = 100;

/** GitHub App checks against the configured repository. */
export type GitHubDoctorFacts = {
  /** GitHub App id from the environment or `secrets/github-app.json`. */
  appId: string | null;
  /** Configured installation id. Doctor also finds it from the repository. */
  installationId: string | null;
  privateKeyPath: string | null;
  installation: { ok: boolean; detail: string };
  push: { ok: boolean; detail: string };
  rate: { ok: boolean; detail: string };
};

export type ProbeFacts = {
  configError: string | null;
  agentProfiles?: AgentProfiles[];
  grokLogin?: GrokLoginStatus | null;
  configured: boolean;
  linearCommentMode: boolean;
  trackerKind: TrackerKind;
  githubDoctor: GitHubDoctorFacts;
  webhooks: boolean;
  linearWebhook?: LinearWebhookWarning | null;
  workspace?: string | null;
  githubDelivery?: { event: string; receivedAt: number } | null;
  exeDevToken?: ExeDevTokenStatus;
  publicUrl: string | null;
  repo: string | null;
  team: string | null;
  teamId: string | null;
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
  const [claudeLogin, codexLogin, grokLogin, linear, githubDoctor] = await Promise.all([
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
    linearCommentMode: runtime.linearCommentMode,
    trackerKind: runtime.trackerKind,
    githubDoctor,
    webhooks: runtime.webhooks,
    linearWebhook: readPawsDb(runtime.env.home, (db) => linearWebhookWarning(db, Date.now())),
    githubDelivery: readPawsDb(runtime.env.home, latestGitHubDelivery),
    workspace: readPawsDb(
      runtime.env.home,
      (db) =>
        db
          .query<{ name: string }, []>("SELECT name FROM workspace ORDER BY created_at LIMIT 1")
          .get()?.name ?? null,
    ),
    publicUrl: runtime.publicUrl,
    repo: runtime.repo,
    team: runtime.linearTeam,
    teamId: runtime.linearTeamId,
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
    exeDevToken: exeDevTokenStatus(runtime.env.home),
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
    error: null,
  };
  const credential = runtime.linearAccessToken;
  if (credential === null) return empty;
  const token = async () => credential;
  try {
    const client = createLinearClient({
      auth: { hasToken: () => true, ensureFresh: token, forceRefresh: token },
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8_000) }),
    });
    const teamId = runtime.linearTeamId;
    const data =
      teamId === null
        ? await client.query("query Viewer { viewer { id } }")
        : await client.query(
            `query ViewerTeam($id: String!) {
              viewer { id }
              team(id: $id) { id key }
            }`,
            { id: teamId },
          );
    const root = isRecord(data) ? data : {};
    const viewer = isRecord(root["viewer"]) ? readString(root["viewer"], "id") : null;
    const team = isRecord(root["team"]) ? root["team"] : null;
    const viewerMatches =
      viewer !== null && (runtime.linearViewerId === null || runtime.linearViewerId === viewer);
    return {
      attempted: true,
      reachable: viewer !== null,
      viewerId: viewer,
      viewerMatches,
      teamFound: teamId !== null && team !== null,
      error: viewer === null ? "Linear viewer id was missing" : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Linear could not be reached";
    return { ...empty, attempted: true, error: message };
  }
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

async function githubDoctorFact(
  runtime: RuntimeConfig,
  repo: { owner: string; repo: string } | null,
): Promise<GitHubDoctorFacts> {
  const env = runtime.env;
  const name = repo === null ? null : `${repo.owner}/${repo.repo}`;
  const facts: GitHubDoctorFacts = {
    appId: env.githubAppId,
    installationId: env.githubAppInstallationId,
    privateKeyPath: env.githubAppPrivateKeyPath,
    installation: { ok: false, detail: "GitHub App credentials are missing" },
    push: { ok: false, detail: "GitHub App installation was not checked" },
    rate: { ok: false, detail: "rate limit was not read" },
  };
  const appId = env.githubAppId;
  if (appId === null || env.githubAppPrivateKeyPath === null) return facts;
  if (repo === null || name === null) {
    facts.installation = { ok: false, detail: "repository must be owner/name" };
    return facts;
  }
  let privateKeyPem: string | null = null;
  try {
    privateKeyPem = readSecretFile(env.githubAppPrivateKeyPath, false);
  } catch {
    privateKeyPem = null;
  }
  if (!privateKeyPem) {
    facts.installation = { ok: false, detail: "GitHub App private key could not be read" };
    return facts;
  }
  try {
    const client = createFetchGitHubClient((input, init) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(8_000) }),
    );
    const installed = await client.request({
      method: "GET",
      path: `/repos/${repo.owner}/${repo.repo}/installation`,
      token: signAppJwt(appId, privateKeyPem),
    });
    const body = isRecord(installed.body) ? installed.body : {};
    if (installed.status !== 200 || typeof body["id"] !== "number") {
      facts.installation = { ok: false, detail: `the GitHub App is not installed on ${name}` };
      return facts;
    }
    const installationId = String(body["id"]);
    if (body["suspended_at"] != null) {
      facts.installation = { ok: false, detail: `installation ${installationId} is suspended` };
      return facts;
    }
    if (env.githubAppInstallationId !== null && env.githubAppInstallationId !== installationId) {
      facts.installation = {
        ok: false,
        detail: `GITHUB_APP_INSTALLATION_ID ${env.githubAppInstallationId} does not match installation ${installationId} on ${name}`,
      };
      return facts;
    }
    facts.installation = { ok: true, detail: `installation ${installationId} on ${name}` };
    facts.push = { ok: false, detail: `no push access to ${name}` };
    const minted = await mintInstallationToken({
      client,
      appId,
      installationId,
      privateKeyPem,
      owner: repo.owner,
      repo: repo.repo,
      access: "write",
    });
    facts.push = { ok: true, detail: `push access to ${name}` };
    const rate = await githubGet(minted.token, "/rate_limit");
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
    if (!facts.installation.ok) facts.installation = { ok: false, detail: message };
    else if (!facts.push.ok) facts.push = { ok: false, detail: `${facts.push.detail}: ${message}` };
  }
  return facts;
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
