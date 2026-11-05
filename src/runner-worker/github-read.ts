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
): GitHubReadConfig | undefined {
  const first = read(1);
  if (!first) return undefined;
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const tokens = [first.token];
  writeHosts(directory, first.token);
  const timer = setInterval(() => {
    try {
      const next = read(tokens.length + 1);
      if (!next) return;
      writeHosts(directory, next.token);
      tokens.push(next.token);
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
      `github.com:\n    oauth_token: ${token}\n    git_protocol: https\n    user: paws\n`,
      { mode: 0o600, flag: "wx" },
    );
    chmodSync(temporary, 0o600);
    renameSync(temporary, join(directory, "hosts.yml"));
  } finally {
    rmSync(temporary, { force: true });
  }
}
