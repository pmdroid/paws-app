import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GitExec } from "./types";

export function publicationEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "https:file",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TEMPLATE_DIR: "/dev/null",
  };
  for (const key of [
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ]) {
    if (base[key] !== undefined) env[key] = base[key];
  }
  return env;
}

export function publicationRemote(url: string): void {
  if (path.isAbsolute(url)) return;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(
      "publication requires an HTTPS URL without credentials or an absolute local path",
    );
  }
}

export function publicationExec(
  gitExec: GitExec,
  credential?: { path: string; token: string },
): GitExec {
  return async (args, options) => {
    const operation = args.findIndex((arg) =>
      ["clone", "push", "fetch", "ls-remote"].includes(arg),
    );
    if (operation < 0) throw new Error("unsupported credentialed Git operation");
    const command = args[operation];
    const remote = args.slice(operation + 1).find((arg) => !arg.startsWith("-"));
    if (!remote) throw new Error("publication needs an explicit remote");
    publicationRemote(remote);
    const dir = await mkdtemp(path.join(tmpdir(), "paws-publication-"));
    const repository = path.join(dir, "repo.git");
    const bundle = path.join(dir, "candidate.bundle");
    const publicationArgs = command === "clone" ? args : ["--git-dir", repository, ...args];
    const env = publicationEnv(options.env);
    env.HOME = dir;
    const run = (argv: string[], cwd = dir) => gitExec(argv, { cwd, env });
    try {
      if (command !== "clone") await run(["init", "--bare", "--template=", repository]);
      if (command === "push") {
        await run(["bundle", "create", bundle, "--branches", "--tags", "HEAD"], options.cwd);
        await run([
          "--git-dir",
          repository,
          "fetch",
          bundle,
          "+refs/heads/*:refs/heads/*",
          "+refs/tags/*:refs/tags/*",
        ]);
        await run(["--git-dir", repository, "fetch", bundle, "HEAD"]);
        await run(["--git-dir", repository, "update-ref", "HEAD", "FETCH_HEAD"]);
      }
      if (credential && !path.isAbsolute(remote))
        await writeFile(credential.path, credential.token, { mode: 0o600 });
      const result = await gitExec(publicationArgs, {
        cwd: dir,
        env: {
          ...env,
          ...(path.isAbsolute(remote) ? {} : { PAWS_GITHUB_TOKEN: options.env.PAWS_GITHUB_TOKEN }),
        },
      });
      if (credential) await rm(credential.path, { force: true });
      if (command === "fetch") {
        const refspec = args.at(-1);
        const ref = refspec?.split(":")[1];
        if (!ref) throw new Error("publication fetch needs an explicit destination ref");
        await run(["fetch", "--prune", repository, `+${ref}:${ref}`], options.cwd);
      }
      return result;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
