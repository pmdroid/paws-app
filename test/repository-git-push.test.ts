import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { git } from "../src/acp";
import { createRepositoryGit } from "../src/loop";

test("repository git pushes one commit to one branch only when push is allowed", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-repository-push-"));
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  try {
    await git(["init", "--bare", "-b", "main", origin], { env });
    await git(["init", "-b", "main", work], { env });
    writeFileSync(join(work, "README.md"), "Fixture\n");
    await git(["-C", work, "add", "."], { env });
    await git(["-C", work, "commit", "-m", "Fixture"], { env });
    const head = (await git(["-C", work, "rev-parse", "HEAD"], { env })).trim();
    const options = {
      remoteUrl: origin,
      token: async () => "",
      signal: new AbortController().signal,
      assert: async () => {},
      onCleanupFailure: () => {},
      env,
    };
    const push = (args: string[]) => ["-C", work, "push", ...args];
    const reader = createRepositoryGit(options);
    await expect(reader(push(["--", origin, `${head}:refs/heads/paws/item`]))).rejects.toThrow(
      "bound clone or fetch",
    );
    const writer = createRepositoryGit({ ...options, push: true });
    for (const args of [
      ["--force", "--", origin, `${head}:refs/heads/paws/item`],
      ["--", origin, `+${head}:refs/heads/paws/item`],
      ["--", origin, `${head}:refs/tags/v1`],
      ["--", origin, "HEAD:refs/heads/paws/item"],
      ["--", origin, `${head}:refs/heads/paws/item`, `${head}:refs/heads/main`],
    ])
      await expect(writer(push(args))).rejects.toThrow("without force");
    await writer(push(["--", origin, `${head}:refs/heads/paws/item`]));
    expect(
      (await git(["--git-dir", origin, "rev-parse", "refs/heads/paws/item"], { env })).trim(),
    ).toBe(head);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
