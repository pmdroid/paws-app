import { journalCaught } from "../journal";
import { z } from "zod";
import {
  MAX_TOKEN_TTL_MS,
  TOKEN_TTL_SKEW_MS,
  type GitHubApp,
  type InstallationToken,
} from "../github";
import type { Database } from "bun:sqlite";
import { authorizeRepositoryCommand } from "../runner-repository-commands";
import { RunnerWorkFencedError, type RunnerWork } from "../runner-work";

const inputSchema = z.strictObject({
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  access: z.enum(["read", "write"]),
});
const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);

class GitHubUnavailableError extends Error {}

async function github<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new GitHubUnavailableError(error instanceof Error ? error.message : String(error));
  }
}

type Bot = { appId: string; login: string; id: number };

function denied() {
  return Response.json(
    { error: "Runner repository access is denied." },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}

function unavailable() {
  return Response.json(
    { error: "GitHub is unavailable. Try again." },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

async function credentialRequest(request: Request) {
  if (
    request.method !== "POST" ||
    request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
  )
    return null;
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) return null;
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > 4096) return null;
  return { token: authorization.slice(7), body: JSON.parse(new TextDecoder().decode(bytes)) };
}

function usableCredential(credential: InstallationToken, repository: string, checkedAt: number) {
  return (
    credential.repository === repository &&
    /^[\x21-\x7e]{1,4096}$/.test(credential.token) &&
    Number.isFinite(credential.expiresAt) &&
    credential.expiresAt > checkedAt &&
    credential.expiresAt <= checkedAt + MAX_TOKEN_TTL_MS + TOKEN_TTL_SKEW_MS
  );
}

function sameBot(bot: Bot | undefined, expected: Bot) {
  return bot?.appId === expected.appId && bot?.login === expected.login && bot?.id === expected.id;
}

export const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;

function remember<V>(cache: Map<string, Promise<V>>, key: string, load: () => Promise<V>) {
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = load();
  cache.set(key, pending);
  pending.catch((caughtError1) => {
    journalCaught(caughtError1, "runner-repository-access.remember", null);
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}

export function cacheRepositoryCredentials<
  T extends {
    github: GitHubApp;
    installationForRepository(repository: string): string | null;
    checkpointBot?: (repository: string) => Promise<Bot>;
  },
>(options: T, now: () => number = Date.now): T {
  const tokens = new Map<string, Promise<InstallationToken>>();
  const bots = new Map<string, Promise<Bot>>();
  const checkpointBot = options.checkpointBot;
  return {
    ...options,
    github: {
      async mintInstallationToken(input) {
        const key = `${input.installationId}:${input.repository}:${input.access ?? "write"}`;
        const cached = tokens.get(key);
        if (cached) {
          const token = await cached;
          if (token.expiresAt - now() > TOKEN_REUSE_MARGIN_MS) return token;
          if (tokens.get(key) === cached) tokens.delete(key);
        }
        return remember(tokens, key, () => options.github.mintInstallationToken(input));
      },
    },
    ...(checkpointBot
      ? {
          checkpointBot: (repository: string) =>
            remember(bots, `${options.installationForRepository(repository)}:${repository}`, () =>
              checkpointBot(repository),
            ),
        }
      : {}),
  };
}

export function createRunnerRepositoryAccess(options: {
  work: RunnerWork;
  github: GitHubApp;
  installationForRepository(repository: string): string | null;
  checkpointBot?: (repository: string) => Promise<{ appId: string; login: string; id: number }>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  return async (request: Request, runnerId: string): Promise<Response | null> => {
    const path = /^\/v1\/runs\/([^/]+)\/repository-credential$/.exec(new URL(request.url).pathname);
    if (!path) return null;
    try {
      const received = await credentialRequest(request);
      if (!received) return denied();
      const input = inputSchema.parse(received.body);
      const access = {
        runnerId,
        runId: idSchema.parse(decodeURIComponent(path[1]!)),
        generation: input.generation,
        token: received.token,
      };
      const initial = options.work.authorize(access);
      if (!initial.command.repository) return denied();
      if (input.access === "write" && (initial.command.type !== "run" || !initial.branch))
        return denied();
      const repository = `${initial.command.repository.owner}/${initial.command.repository.repo}`;
      const installationId = options.installationForRepository(repository);
      if (!installationId) return denied();
      const expectedBot =
        initial.command.type === "run"
          ? (initial.command.commitPolicy?.bot ?? initial.command.checkpointBot)
          : undefined;
      const matchesBot = async () => {
        if (!expectedBot) return input.access !== "write" || !options.checkpointBot;
        return sameBot(await github(async () => options.checkpointBot?.(repository)), expectedBot);
      };
      if (!(await matchesBot())) return denied();
      options.work.authorize(access);
      if (options.installationForRepository(repository) !== installationId) return denied();
      const credential = await github(() =>
        options.github.mintInstallationToken({
          access: input.access,
          repository,
          installationId,
        }),
      );
      if (!(await matchesBot())) return denied();
      const current = options.work.authorize(access);
      const checkedAt = now();
      if (options.installationForRepository(repository) !== installationId) return denied();
      if (
        current.command.id !== initial.command.id ||
        !current.command.repository ||
        current.branch !== initial.branch ||
        !usableCredential(credential, repository, checkedAt)
      )
        return denied();
      return Response.json(
        {
          token: credential.token,
          expiresAt: Math.min(credential.expiresAt, checkedAt + MAX_TOKEN_TTL_MS),
          remoteUrl: current.command.repository.remoteUrl,
          branch: input.access === "write" ? current.branch : null,
        },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (error) {
      journalCaught(error, "runner-repository-access.createRunnerRepositoryAccess.trim", null);
      if (error instanceof RunnerWorkFencedError)
        return Response.json(
          { error: "Runner work is fenced.", code: "fenced" },
          { status: 409, headers: { "cache-control": "no-store" } },
        );
      if (error instanceof GitHubUnavailableError) return unavailable();
      return denied();
    }
  };
}

export function createRepositoryCommandAccess(options: {
  db: Database;
  github: GitHubApp;
  installationForRepository(repository: string): string | null;
  checkpointBot?: (repository: string) => Promise<Bot>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  return async (request: Request, runnerId: string): Promise<Response | null> => {
    const path = /^\/v1\/repository-commands\/([^/]+)\/repository-credential$/.exec(
      new URL(request.url).pathname,
    );
    if (!path) return null;
    try {
      const received = await credentialRequest(request);
      if (!received) return denied();
      z.strictObject({}).parse(received.body);
      const access = {
        runnerId,
        commandId: idSchema.parse(decodeURIComponent(path[1]!)),
        token: received.token,
      };
      const authorize = () => authorizeRepositoryCommand(options.db, access, now());
      const command = authorize();
      if (!/^paws\//.test(command.branch)) return denied();
      const repository = `${command.repository.owner}/${command.repository.repo}`;
      const installationId = options.installationForRepository(repository);
      const checkpointBot = options.checkpointBot;
      if (!installationId || !checkpointBot) return denied();
      const matchesBot = async () =>
        sameBot(await github(() => checkpointBot(repository)), command.bot);
      if (!(await matchesBot())) return denied();
      authorize();
      if (options.installationForRepository(repository) !== installationId) return denied();
      const credential = await github(() =>
        options.github.mintInstallationToken({ access: "write", repository, installationId }),
      );
      if (!(await matchesBot())) return denied();
      const current = authorize();
      const checkedAt = now();
      if (
        options.installationForRepository(repository) !== installationId ||
        current.id !== command.id ||
        current.branch !== command.branch ||
        !usableCredential(credential, repository, checkedAt)
      )
        return denied();
      return Response.json(
        {
          token: credential.token,
          expiresAt: Math.min(credential.expiresAt, checkedAt + MAX_TOKEN_TTL_MS),
          remoteUrl: current.repository.remoteUrl,
          branch: current.branch,
        },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (error) {
      journalCaught(error, "runner-repository-access.createRepositoryCommandAccess", null);
      if (error instanceof GitHubUnavailableError) return unavailable();
      return denied();
    }
  };
}
