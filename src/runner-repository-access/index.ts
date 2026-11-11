import { journal, journalCaught } from "../journal";
import { z } from "zod";
import {
  MAX_TOKEN_TTL_MS,
  TOKEN_TTL_SKEW_MS,
  type GitHubApp,
  type InstallationToken,
} from "../github";
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
    installationForRepository(repository: string): Promise<string | null>;
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
        if (input.access === "agent_read") return options.github.mintInstallationToken(input);
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
          checkpointBot: async (repository: string) =>
            remember(
              bots,
              `${await options.installationForRepository(repository)}:${repository}`,
              () => checkpointBot(repository),
            ),
        }
      : {}),
  };
}

export function createRunnerRepositoryAccess(options: {
  work: RunnerWork;
  github: GitHubApp;
  installationForRepository(repository: string): Promise<string | null>;
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
      const initial = await options.work.authorizeAsync(access);
      if (!initial.command.repository) return denied();
      if (input.access === "write" && (initial.command.type !== "run" || !initial.branch))
        return denied();
      const repository = `${initial.command.repository.owner}/${initial.command.repository.repo}`;
      const installationId = await options.installationForRepository(repository);
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
      await options.work.authorizeAsync(access);
      if ((await options.installationForRepository(repository)) !== installationId) return denied();
      const credential = await github(() =>
        options.github.mintInstallationToken({
          access: input.access,
          repository,
          installationId,
        }),
      );
      if (!(await matchesBot())) return denied();
      const current = await options.work.authorizeAsync(access);
      const checkedAt = now();
      if ((await options.installationForRepository(repository)) !== installationId) return denied();
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

export const AGENT_READ_REFRESH_MS = 10 * 60_000;

type AgentReadLease = {
  itemId: string;
  runId: string;
  repository: string;
  installationId: string;
  current: { token: string; expiresAt: number };
  minted: string[];
  refreshes: number;
  refreshing?: Promise<{ token: string; expiresAt: number }>;
  mintFailed?: boolean;
};

export type AgentReadTokens = ReturnType<typeof createAgentReadTokens>;

export function createAgentReadTokens(options: {
  github: GitHubApp;
  installationForRepository(repository: string): Promise<string | null>;
  revoke(token: string): Promise<void>;
  store?: { read(): readonly string[]; write(tokens: readonly string[]): void };
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const leases = new Map<string, AgentReadLease>();
  const leftover = (() => {
    try {
      return [...(options.store?.read() ?? [])];
    } catch (error) {
      journalCaught(error, "runner-repository-access.agentRead.read", null);
      return [];
    }
  })();
  const save = () => {
    try {
      options.store?.write([...leftover, ...[...leases.values()].flatMap((lease) => lease.minted)]);
    } catch (error) {
      journalCaught(error, "runner-repository-access.agentRead.write", null);
    }
  };
  const label = (lease: { itemId: string; runId: string; repository: string }) =>
    `agent-read item=${lease.itemId} run=${lease.runId} repositories=${lease.repository}`;
  async function mint(repository: string, installationId: string) {
    const credential = await options.github.mintInstallationToken({
      access: "agent_read",
      repository,
      installationId,
    });
    const checkedAt = now();
    if (!usableCredential(credential, repository, checkedAt))
      throw new Error("GitHub returned an unusable read token");
    return {
      token: credential.token,
      expiresAt: Math.min(credential.expiresAt, checkedAt + MAX_TOKEN_TTL_MS),
    };
  }
  return {
    async open(input: {
      commandId: string;
      itemId: string;
      runId: string;
      repository: string | null;
    }): Promise<boolean> {
      const lease = { ...input, repository: input.repository ?? "none" };
      try {
        if (!input.repository) throw new Error("the item has no repository");
        const installationId = await options.installationForRepository(input.repository);
        if (!installationId) throw new Error("no GitHub App installation covers the repository");
        const current = await mint(input.repository, installationId);
        leases.set(input.commandId, {
          ...lease,
          repository: input.repository,
          installationId,
          current,
          minted: [current.token],
          refreshes: 0,
        });
        save();
        journal(`${label(lease)} minted expires=${new Date(current.expiresAt).toISOString()}`);
        return true;
      } catch (error) {
        journal(
          `${label(lease)} mint failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    },
    async credential(commandId: string): Promise<{ token: string; expiresAt: number } | null> {
      const lease = leases.get(commandId);
      if (!lease) return null;
      if (lease.current.expiresAt - now() > AGENT_READ_REFRESH_MS + 60_000) return lease.current;
      lease.refreshing ??= mint(lease.repository, lease.installationId)
        .then((next) => {
          if (leases.get(commandId) !== lease) {
            void options.revoke(next.token).catch((caught) => {
              journalCaught(caught, "runner-repository-access.agentRead.lateRevoke", lease.itemId);
            });
            throw new Error("The turn ended");
          }
          lease.current = next;
          lease.minted.push(next.token);
          lease.refreshes += 1;
          save();
          journal(
            `${label(lease)} refreshed refresh=${lease.refreshes} expires=${new Date(next.expiresAt).toISOString()}`,
          );
          return next;
        })
        .finally(() => {
          lease.refreshing = undefined;
        });
      try {
        return await lease.refreshing;
      } catch (error) {
        if (!lease.mintFailed && leases.get(commandId) === lease)
          journal(
            `${label(lease)} mint failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        lease.mintFailed = true;
        return lease.current.expiresAt > now() ? lease.current : null;
      }
    },
    async recover(): Promise<void> {
      const tokens = leftover.splice(0);
      if (tokens.length === 0) return;
      const results = await Promise.allSettled(tokens.map((token) => options.revoke(token)));
      const failed = results.filter((result) => result.status === "rejected").length;
      journal(
        failed
          ? `agent-read revoke failed for ${failed} of ${tokens.length} tokens left from before a restart`
          : `agent-read revoked ${tokens.length} tokens left from before a restart`,
      );
      save();
    },
    tokens(commandId: string): readonly string[] {
      return leases.get(commandId)?.minted ?? [];
    },
    async close(commandId: string): Promise<void> {
      const lease = leases.get(commandId);
      if (!lease) return;
      leases.delete(commandId);
      const results = await Promise.allSettled(lease.minted.map((token) => options.revoke(token)));
      save();
      const failed = results.find((result) => result.status === "rejected");
      if (failed)
        journal(
          `${label(lease)} revoke failed: ${failed.reason instanceof Error ? failed.reason.message : String(failed.reason)}`,
        );
      else journal(`${label(lease)} revoked refreshes=${lease.refreshes}`);
    },
  };
}

export function createAgentReadAccess(options: { work: RunnerWork; agentRead: AgentReadTokens }) {
  return async (request: Request, runnerId: string): Promise<Response | null> => {
    const path = /^\/v1\/runs\/([^/]+)\/github-read-credential$/.exec(
      new URL(request.url).pathname,
    );
    if (!path) return null;
    try {
      const received = await credentialRequest(request);
      if (!received) return denied();
      const input = inputSchema.pick({ generation: true }).parse(received.body);
      const { command } = await options.work.authorizeAsync({
        runnerId,
        runId: idSchema.parse(decodeURIComponent(path[1]!)),
        generation: input.generation,
        token: received.token,
      });
      if (command.type !== "run" || !command.githubRead) return denied();
      const credential = await options.agentRead.credential(command.id);
      if (!credential) return denied();
      return Response.json(credential, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      journalCaught(error, "runner-repository-access.createAgentReadAccess", null);
      if (error instanceof RunnerWorkFencedError)
        return Response.json(
          { error: "Runner work is fenced.", code: "fenced" },
          { status: 409, headers: { "cache-control": "no-store" } },
        );
      return denied();
    }
  };
}

export function createRepositoryCommandAccess(options: {
  store: Parameters<typeof authorizeRepositoryCommand>[0];
  github: GitHubApp;
  installationForRepository(repository: string): Promise<string | null>;
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
      const authorize = () => authorizeRepositoryCommand(options.store, access, now());
      const command = await authorize();
      if (!/^paws\//.test(command.branch)) return denied();
      const repository = `${command.repository.owner}/${command.repository.repo}`;
      const installationId = await options.installationForRepository(repository);
      const checkpointBot = options.checkpointBot;
      if (!installationId || !checkpointBot) return denied();
      const matchesBot = async () =>
        sameBot(await github(() => checkpointBot(repository)), command.bot);
      if (!(await matchesBot())) return denied();
      await authorize();
      if ((await options.installationForRepository(repository)) !== installationId) return denied();
      const credential = await github(() =>
        options.github.mintInstallationToken({ access: "write", repository, installationId }),
      );
      if (!(await matchesBot())) return denied();
      const current = await authorize();
      const checkedAt = now();
      if (
        (await options.installationForRepository(repository)) !== installationId ||
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
