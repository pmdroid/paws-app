import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { GitError, git } from "../acp";
import { isTransient } from "../core";
import { createRepositoryGit, repositoryGitEnv } from "./repository-git";

const token = "acme-repository-token";

function reader(remoteUrl: string) {
  return createRepositoryGit({
    remoteUrl,
    token: async () => token,
    signal: new AbortController().signal,
    assert: async () => {},
    onCleanupFailure: () => {},
  });
}

async function fetchError(remoteUrl: string, mirror: string): Promise<unknown> {
  return reader(remoteUrl)([
    "--git-dir",
    mirror,
    "fetch",
    "--prune",
    remoteUrl,
    "+refs/heads/*:refs/remotes/origin/*",
  ]).then(
    () => null,
    (error: unknown) => error,
  );
}

test("the credentialed fetch gives up on a connection that moves under 1 KB/s for 60 s", async () => {
  const env = repositoryGitEnv("https://github.com/acme/widgets.git", {}, "credential");
  expect((await git(["config", "--get", "http.lowSpeedLimit"], { env })).trim()).toBe("1000");
  expect((await git(["config", "--get", "http.lowSpeedTime"], { env })).trim()).toBe("60");
  expect(
    (
      await git(["config", "--get", "http.https://github.com/acme/widgets.git.extraHeader"], {
        env,
      })
    )
      .trim()
      .startsWith("Authorization: Basic "),
  ).toBe(true);
});

test("a mirror fetch that cannot reach the host stays a transient Git error without the token", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-repository-git-"));
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  try {
    const mirror = join(root, "widgets.git");
    await git(["init", "--bare", mirror]);
    const error = await fetchError(`https://127.0.0.1:${port}/acme/widgets.git`, mirror);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).stderr).toMatch(/connect/i);
    expect(isTransient(error)).toBe(true);
    expect(String((error as Error).message)).not.toContain(token);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a mirror fetch from a missing repository is not transient", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-repository-git-"));
  try {
    const mirror = join(root, "widgets.git");
    await git(["init", "--bare", mirror]);
    const error = await fetchError(join(root, "missing.git"), mirror);
    expect(error).toBeInstanceOf(GitError);
    expect(isTransient(error)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
