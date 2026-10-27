import { git } from "../acp";
import { isAbsolute } from "node:path";

export function createRepositoryGit(input: {
  remoteUrl: string;
  token: (signal: AbortSignal) => Promise<string>;
  signal: AbortSignal;
  assert: () => Promise<void>;
  onCleanupFailure: () => void;
  env?: NodeJS.ProcessEnv;
  /** Allows a fast-forward push of one commit to a branch, for a token with write access. */
  push?: boolean;
}) {
  const local = isAbsolute(input.remoteUrl);
  if (!local) {
    const url = new URL(input.remoteUrl);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Repository reads require an HTTPS URL without credentials.");
  }
  return async (args: string[]): Promise<string> => {
    const operation = args.findIndex(
      (arg) => arg === "clone" || arg === "fetch" || (input.push === true && arg === "push"),
    );
    if (operation < 0 || !args.slice(operation + 1).includes(input.remoteUrl))
      throw new Error("Repository reads require the bound clone or fetch destination.");
    if (args[operation] === "push") {
      const [separator, remote, refspec, ...rest] = args.slice(operation + 1);
      if (
        separator !== "--" ||
        remote !== input.remoteUrl ||
        rest.length ||
        !refspec ||
        !/^[a-f0-9]{40}:refs\/heads\/[^:+\s]+$/.test(refspec)
      )
        throw new Error("Repository pushes take one commit to one branch without force.");
    }
    input.signal.throwIfAborted();
    await input.assert();
    input.signal.throwIfAborted();
    const token = local ? "" : await input.token(input.signal);
    input.signal.throwIfAborted();
    await input.assert();
    input.signal.throwIfAborted();
    if (!local && (!token || /\s/.test(token))) throw new Error("GitHub sign-in is required.");
    const base = input.env ?? process.env;
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: local ? "file" : "https",
      GIT_CONFIG_COUNT: local ? "4" : "5",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "http.followRedirects",
      GIT_CONFIG_VALUE_2: "false",
      GIT_CONFIG_KEY_3: "http.sslVerify",
      GIT_CONFIG_VALUE_3: "true",
    };
    for (const key of ["HOME", "TMPDIR", "LANG", "LC_ALL", "GIT_SSL_CAINFO"])
      if (base[key] !== undefined) env[key] = base[key];
    const credential = Buffer.from(`x-access-token:${token}`).toString("base64");
    if (!local) {
      env.GIT_CONFIG_KEY_4 = `http.${input.remoteUrl}.extraHeader`;
      env.GIT_CONFIG_VALUE_4 = `Authorization: Basic ${credential}`;
    }
    try {
      return await git(args, {
        env,
        signal: input.signal,
        onCleanupFailure: input.onCleanupFailure,
      });
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason;
      throw repositoryGitError(error, token, credential);
    }
  };
}

function repositoryGitError(error: unknown, token: string, credential: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    message
      .split(token || "\0")
      .join("[redacted]")
      .split(credential)
      .join("[redacted]"),
  );
}
