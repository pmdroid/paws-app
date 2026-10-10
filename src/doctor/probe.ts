import { existsSync, readFileSync, statSync } from "node:fs";
import { adapterVersions, resolveAdapter } from "../acp";
import { createPersonalLinearClient, type CommentFetch } from "../comments";
import {
  loadRuntime,
  type EnvSource,
  type GitHubConfigAuth,
  type LinearConfigMode,
} from "../config";
import { checkGhAuthStatus, ghDoctorChecks } from "../github";
import {
  checkDeveloperLogin,
  closeoutBinPath,
  closeoutPlatform,
  loadCloseoutManifest,
  sha256Hex,
} from "../install";

export type ProbeFacts = {
  configError: string | null;
  configured: boolean;
  linearMode: LinearConfigMode;
  githubAuth: GitHubConfigAuth;
  webhooks: boolean;
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
    path: string;
    present: boolean;
    executable: boolean;
    checksum: "match" | "mismatch" | "skipped" | "missing";
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
  const [gh, claudeLogin, codexLogin, linear] = await Promise.all([
    ghFacts(repo),
    loginFact("claude", env),
    loginFact("codex", env),
    linearFact(runtime),
  ]);
  return {
    configError: runtime.configError,
    configured: runtime.configured,
    linearMode: runtime.linearMode,
    githubAuth: runtime.githubAuth,
    webhooks: runtime.webhooks,
    publicUrl: runtime.publicUrl,
    repo: runtime.repo,
    team: runtime.linearTeam,
    teamId: runtime.linearTeamId,
    ghLogin: gh.login,
    ghPush: gh.push,
    claudeAdapter: adapterFact("implementer"),
    codexAdapter: adapterFact("reviewer"),
    claudeLogin,
    codexLogin,
    closeout: closeoutFact(runtime.closeoutBin, runtime.env.home),
    linear,
  };
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
    const versions = adapterVersions();
    const version = role === "implementer" ? versions.claudeAgentAcp : versions.codexAcp;
    const command = resolveAdapter(role).command;
    if (!existsSync(command)) {
      return { ok: false, detail: `${bin} is not installed at ${command}` };
    }
    return { ok: true, detail: `${bin} ${version}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : `${bin} is not installed`;
    return { ok: false, detail: message };
  }
}

function closeoutFact(configured: string | null, home: string): ProbeFacts["closeout"] {
  const path = configured ?? closeoutBinPath(home);
  let unreleased = true;
  let expected = "";
  try {
    const manifest = loadCloseoutManifest();
    const asset = manifest.assets[closeoutPlatform()];
    unreleased = asset.digestKind === "unreleased-placeholder";
    expected = asset.sha256;
  } catch {
    return { path, present: false, executable: false, checksum: "missing" };
  }
  if (!existsSync(path)) return { path, present: false, executable: false, checksum: "missing" };
  let executable = false;
  try {
    executable = (statSync(path).mode & 0o111) !== 0;
  } catch {
    return { path, present: false, executable: false, checksum: "missing" };
  }
  if (!executable) return { path, present: true, executable: false, checksum: "missing" };
  if (unreleased || expected.length === 0) {
    return { path, present: true, executable: true, checksum: "skipped" };
  }
  const actual = sha256Hex(new Uint8Array(readFileSync(path)));
  return {
    path,
    present: true,
    executable: true,
    checksum: actual === expected ? "match" : "mismatch",
  };
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
