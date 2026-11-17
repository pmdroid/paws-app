import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { journalCaught } from "../journal";
import type { GitHubReadFailure } from "../runner-protocol";

export type GitHubReadSource = (sequence: number) => { token: string; expiresAt: number } | null;

/** Why the runner could not hand the worker a token, and where each reason is reported once. */
export type GitHubReadFailures = {
  read(): readonly GitHubReadFailure[];
  report(reason: GitHubReadFailure): void;
};

export type GitHubReadConfig = {
  directory: string;
  tokens(): readonly string[];
  /** Resolves true once a token is in gh's config, or false when `ms` pass without one. */
  delivered(ms: number, signal?: AbortSignal): Promise<boolean>;
  close(): void;
};

export function openGitHubReadConfig(
  directory: string,
  read: GitHubReadSource,
  intervalMs = 5_000,
  maxTokens = 64,
  failures?: GitHubReadFailures,
): GitHubReadConfig {
  const reported = new Set<GitHubReadFailure>();
  const fail = (reason: GitHubReadFailure) => {
    if (reported.has(reason)) return;
    reported.add(reason);
    failures?.report(reason);
  };
  const poll = () => {
    try {
      for (const reason of failures?.read() ?? []) fail(reason);
    } catch (error) {
      journalCaught(error, "runner-worker.githubRead.failures", null);
    }
  };
  // A token the worker cannot read counts as `format`, one it cannot write as `write`.
  const take = (sequence: number) => {
    try {
      return read(sequence);
    } catch (error) {
      fail("format");
      throw error;
    }
  };
  const store = (token: string) => {
    try {
      writeHosts(directory, token);
    } catch (error) {
      fail("write");
      throw error;
    }
  };
  let sequence = 0;
  let first: { token: string } | null = null;
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const tokens: string[] = [];
  try {
    for (let candidate = 1; candidate <= maxTokens; candidate++) {
      const found = take(candidate);
      if (found) [sequence, first] = [candidate, found];
    }
    if (first) {
      store(first.token);
      tokens.push(first.token);
    }
  } catch (error) {
    journalCaught(error, "runner-worker.githubRead.open", null);
  }
  poll();
  const refresh = () => {
    poll();
    try {
      const next = sequence < maxTokens ? take(sequence + 1) : null;
      if (!next) return;
      store(next.token);
      tokens.push(next.token);
      sequence += 1;
    } catch (error) {
      journalCaught(error, "runner-worker.githubRead.refresh", null);
    }
  };
  const timer = setInterval(refresh, intervalMs);
  timer.unref();
  return {
    directory,
    tokens: () => tokens,
    async delivered(ms, signal) {
      const until = Date.now() + ms;
      for (;;) {
        if (tokens.length > 0 || Date.now() >= until || signal?.aborted) break;
        await delay(Math.min(250, Math.max(0, until - Date.now())));
        refresh();
      }
      return tokens.length > 0;
    },
    close() {
      clearInterval(timer);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function writeHosts(directory: string, token: string): void {
  const temporary = join(directory, `.hosts-${randomUUID()}.yml`);
  try {
    writeFileSync(
      temporary,
      `github.com:\n    oauth_token: ${JSON.stringify(token)}\n    git_protocol: https\n    user: paws\n`,
      { mode: 0o600, flag: "wx" },
    );
    chmodSync(temporary, 0o600);
    renameSync(temporary, join(directory, "hosts.yml"));
  } finally {
    rmSync(temporary, { force: true });
  }
}
