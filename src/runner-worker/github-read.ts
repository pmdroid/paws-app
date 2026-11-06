import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { journalCaught } from "../journal";

export type GitHubReadSource = (sequence: number) => { token: string; expiresAt: number } | null;

export type GitHubReadConfig = {
  directory: string;
  tokens(): readonly string[];
  close(): void;
};

export function openGitHubReadConfig(
  directory: string,
  read: GitHubReadSource,
  intervalMs = 5_000,
  maxTokens = 64,
): GitHubReadConfig {
  let sequence = 0;
  let first: { token: string } | null = null;
  for (let candidate = 1; candidate <= maxTokens; candidate++) {
    const found = read(candidate);
    if (found) [sequence, first] = [candidate, found];
  }
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const tokens: string[] = [];
  if (first) {
    tokens.push(first.token);
    writeHosts(directory, first.token);
  }
  const timer = setInterval(() => {
    try {
      const next = sequence < maxTokens ? read(sequence + 1) : null;
      if (!next) return;
      writeHosts(directory, next.token);
      tokens.push(next.token);
      sequence += 1;
    } catch (error) {
      journalCaught(error, "runner-worker.githubRead.refresh", null);
    }
  }, intervalMs);
  timer.unref();
  return {
    directory,
    tokens: () => tokens,
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
