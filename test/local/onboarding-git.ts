import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type GitRequest = {
  at: number;
  path: string;
  method: string;
  service: string | null;
  credential: string;
  status: number;
};

export type OnboardingGitRemote = {
  head: string;
  pid: number;
  requests: GitRequest[];
  grant(kind: "user" | "repository" | "metadata", token: string): void;
  stop(): Promise<number | string | null>;
};

export async function startOnboardingGitRemote(options: {
  root: string;
  repository: string;
  certPath: string;
  keyPath: string;
}): Promise<OnboardingGitRemote> {
  const projects = join(options.root, "projects");
  const bare = join(projects, `${options.repository}.git`);
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: process.env.HOME!,
    KYOTOAGENT_ROOT: process.env.KYOTOAGENT_ROOT!,
    TMPDIR: process.env.TMPDIR!,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  mkdirSync(projects, { recursive: true, mode: 0o700 });
  const seed = mkdtempSync(join(options.root, "seed-"));
  git(seed, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(seed, "README.md"), "widgets\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "--quiet", "-m", "Initial widgets");
  const head = git(seed, "rev-parse", "HEAD");
  git(options.root, "clone", "--quiet", "--bare", seed, bare);
  rmSync(seed, { recursive: true, force: true });

  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "onboarding-git-server.ts"),
      projects,
      options.repository,
      options.certPath,
      options.keyPath,
    ],
    { cwd: options.root, env, stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  const requests: GitRequest[] = [];
  let ready: () => void = () => {};
  const started = new Promise<void>((resolve) => (ready = resolve));
  void (async () => {
    let buffered = "";
    for await (const chunk of child.stdout) {
      buffered += new TextDecoder().decode(chunk);
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = JSON.parse(line) as GitRequest | { ready: true };
        if ("ready" in parsed) ready();
        else requests.push(parsed);
      }
    }
  })();
  const startup = await Promise.race([
    started.then(() => "ready"),
    child.exited.then((code) => `exited ${code}`),
    Bun.sleep(15_000).then(() => "timed out"),
  ]);
  if (startup !== "ready") {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([child.exited, Bun.sleep(5_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    throw new Error(`Fixture git remote did not start (${startup}).`);
  }
  return {
    head,
    pid: child.pid,
    requests,
    grant(kind, token) {
      child.stdin.write(`${kind} ${createHash("sha256").update(token).digest("hex")}\n`);
      child.stdin.flush();
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([child.exited, Bun.sleep(5_000)]);
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      return child.exitCode ?? child.signalCode ?? "running";
    },
  };
}
