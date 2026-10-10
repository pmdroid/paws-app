import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { createOAuthGitAuth, runGitHubGit } from "../src/github";

const TOKEN = "gho_git_operation_secret";

describe("oauth git credential helper", () => {
  test("clone, fetch, and push keep the token out of env, argv, and the remote URL", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paws-oauth-git-"));
    const bin = path.join(root, "bin");
    const log = path.join(root, "git.log");
    await mkdir(bin);
    const gitBin = path.join(bin, "git");
    await writeFile(gitBin, fakeGit(log), { mode: 0o755 });
    await chmod(gitBin, 0o755);
    const env = {
      PATH: bin,
      GH_TOKEN: "gho_parent_must_not_leak",
      GITHUB_TOKEN: "github_pat_parent_must_not_leak",
      PAWS_GITHUB_TOKEN: TOKEN,
    };
    const remote = "https://github.com/acme/widgets.git";
    try {
      for (const operation of ["clone", "fetch", "push"] as const) {
        await runGitHubGit({
          operation,
          remoteUrl: remote,
          token: TOKEN,
          cwd: root,
          dest: path.join(root, "widgets.git"),
          ...(operation === "push" ? { refspec: "HEAD:refs/heads/paws/demo" } : {}),
          env,
          gitBin,
        });
      }
      const provider = createOAuthGitAuth({
        owner: "acme",
        repo: "widgets",
        token: async () => TOKEN,
      });
      expect(provider.mode).toBe("oauth");
      expect(await provider.tokenFor("push")).toBe(TOKEN);
      const recorded = await Bun.file(log).text();
      expect(recorded).toContain(remote);
      expect(recorded).toContain("credential.helper=");
      expect(recorded).not.toContain(TOKEN);
      expect(recorded).not.toContain("gho_parent_must_not_leak");
      expect(recorded).not.toContain("github_pat_parent_must_not_leak");
      expect(recorded).not.toContain(`${TOKEN}@`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function fakeGit(log: string): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
printf 'env PAWS_GITHUB_TOKEN=%s GH_TOKEN=%s GITHUB_TOKEN=%s\\n' "\${PAWS_GITHUB_TOKEN-}" "\${GH_TOKEN-}" "\${GITHUB_TOKEN-}" >> "${log}"
env >> "${log}"
for arg in "$@"; do
  case "$arg" in
    credential.helper=/*)
      script="\${arg#credential.helper=}"
      if [ -f "$script" ]; then
        echo HELPER >> "${log}"
        cat "$script" >> "${log}"
      fi
      ;;
  esac
done
exit 0
`;
}
