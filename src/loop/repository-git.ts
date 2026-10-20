import { git } from "../acp";
import { isAbsolute } from "node:path";

export function createRepositoryGit(input: {
  remoteUrl: string;
  token: (signal: AbortSignal) => Promise<string>;
  signal: AbortSignal;
  assert: () => Promise<void>;
  onCleanupFailure: () => void;
  env?: NodeJS.ProcessEnv;
}) {
  const local = isAbsolute(input.remoteUrl);
  if (!local) {
    const url = new URL(input.remoteUrl);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Repository reads require an HTTPS URL without credentials.");
  }
  return async (args: string[]): Promise<string> => {
    const policyRead =
      args.length === 6 &&
      args[0] === "-C" &&
      (args[2] === "fetch" || args[2] === "ls-remote") &&
      args[3] === (args[2] === "fetch" ? "--no-tags" : "--exit-code") &&
      args[4] === input.remoteUrl &&
      args[5] === "refs/heads/main";
    const operation = args.findIndex((arg) => arg === "clone" || arg === "fetch");
    if (!policyRead && (operation < 0 || !args.slice(operation + 1).includes(input.remoteUrl)))
      throw new Error("Repository reads require the bound clone, fetch or policy destination.");
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
      const result = await git(args, {
        env,
        signal: input.signal,
        onCleanupFailure: input.onCleanupFailure,
      });
      input.signal.throwIfAborted();
      await input.assert();
      input.signal.throwIfAborted();
      return result;
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
