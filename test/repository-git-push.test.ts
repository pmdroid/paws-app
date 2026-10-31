import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { git } from "../src/acp";
import { createRepositoryGit } from "../src/loop";

test.each(["sha1", "sha256"])(
  "repository git binds a %s push to the item branch",
  async (format) => {
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
      await git(["init", "--bare", "-b", "main", `--object-format=${format}`, origin], { env });
      await git(["init", "-b", "main", `--object-format=${format}`, work], { env });
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
      await expect(reader(push(["--", origin, `${head}:refs/heads/pas-1-c++`]))).rejects.toThrow(
        "bound clone or fetch",
      );
      const writer = createRepositoryGit({ ...options, pushBranch: "pas-1-c++" });
      for (const args of [
        ["--force", "--", origin, `${head}:refs/heads/pas-1-c++`],
        ["--", origin, `+${head}:refs/heads/pas-1-c++`],
        ["--", origin, `${head}:refs/tags/v1`],
        ["--", origin, `${head}:refs/heads/main`],
        ["--", origin, "HEAD:refs/heads/pas-1-c++"],
        ["--", origin, `${head}:refs/heads/pas-1-c++`, `${head}:refs/heads/main`],
      ])
        await expect(writer(push(args))).rejects.toThrow("without force");
      await writer(push(["--", origin, `${head}:refs/heads/pas-1-c++`]));
      expect(
        (await git(["--git-dir", origin, "rev-parse", "refs/heads/pas-1-c++"], { env })).trim(),
      ).toBe(head);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
