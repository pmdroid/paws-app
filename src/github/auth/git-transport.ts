import { existsSync } from "node:fs";
import path from "node:path";
import { defaultGitExec, withCredential } from "../git";
import { GitCommandError } from "../types";

const MALFORMED_TOKEN_MESSAGE = "The GitHub token is malformed.";

export async function runGitHubGit(input: {
  operation: "clone" | "fetch" | "push";
  remoteUrl: string;
  token: string;
  cwd: string;
  dest?: string;
  refspec?: string;
  lease?: string;
  env?: NodeJS.ProcessEnv;
  gitBin?: string;
  signal?: AbortSignal;
}): Promise<void> {
  input.signal?.throwIfAborted();
  if (/\s/.test(input.token)) throw new Error(MALFORMED_TOKEN_MESSAGE);
  assertCleanRemote(input.remoteUrl, input.token);
  const gitExec = defaultGitExec(input.gitBin ?? trustedGitBin(input.env));
  await withCredential(
    input.token,
    gitExec,
    async (helper) => {
      let args: string[];
      let cwd = input.cwd;
      if (input.operation === "clone") {
        if (!input.dest) throw new Error("clone needs a destination");
        args = ["clone", "--bare", input.remoteUrl, path.resolve(input.cwd, input.dest)];
      } else if (input.operation === "fetch") {
        if (!input.dest) throw new Error("fetch needs a git dir");
        cwd = path.resolve(input.cwd, input.dest);
        args = ["fetch", input.remoteUrl, "+refs/heads/*:refs/heads/*"];
      } else {
        if (!input.refspec) throw new Error("push needs a refspec");
        args = input.lease
          ? [
              "push",
              `--force-with-lease=${input.refspec.split(":")[1]}:${input.lease}`,
              input.remoteUrl,
              input.refspec,
            ]
          : ["push", input.remoteUrl, input.refspec];
      }
      try {
        await helper.exec([...helper.argsPrefix, ...args], {
          cwd,
          env: helper.env,
          signal: input.signal,
        });
      } catch (error) {
        const detail = error instanceof GitCommandError ? error.stderr : String(error);
        throw new Error(redact(input.token, detail), { cause: error });
      }
    },
    { tokenInFile: true },
  );
}

function trustedGitBin(env: NodeJS.ProcessEnv | undefined): string {
  for (const dir of (env?.PATH ?? "/usr/bin:/bin").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const bin = path.join(dir, "git");
    if (existsSync(bin)) return bin;
  }
  return "/usr/bin/git";
}

function assertCleanRemote(remoteUrl: string, token: string): void {
  if (remoteUrl.includes(token) || /\/\/[^/\s@]+@/.test(remoteUrl)) {
    throw new Error("refusing a remote URL that contains credentials");
  }
}

function redact(token: string, text: string): string {
  if (token.length === 0) return text;
  return text.split(token).join("[redacted]");
}
