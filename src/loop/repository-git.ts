import { GitError, git } from "../acp";
import { isAbsolute } from "node:path";

const LOW_SPEED_LIMIT_BYTES = 1_000;
const LOW_SPEED_TIME_SECONDS = 60;

export function createRepositoryGit(input: {
  remoteUrl: string;
  token: (signal: AbortSignal) => Promise<string>;
  signal: AbortSignal;
  assert: () => Promise<void>;
  onCleanupFailure: () => void;
  env?: NodeJS.ProcessEnv;
  /** Allows a fast-forward push of one commit to a branch, for a token with write access. */
  pushBranch?: string;
}) {
  const local = isAbsolute(input.remoteUrl);
  if (!local) {
    const url = new URL(input.remoteUrl);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Repository reads require an HTTPS URL without credentials.");
  }
  return async (args: string[]): Promise<string> => {
    const operation = args.findIndex(
      (arg) =>
        arg === "clone" || arg === "fetch" || (input.pushBranch !== undefined && arg === "push"),
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
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64}):/.test(refspec) ||
        refspec?.split(":")[1] !== `refs/heads/${input.pushBranch}` ||
        refspec?.split(":").length !== 2 ||
        operation !== 2 ||
        args[0] !== "-C"
      )
        throw new Error("Repository pushes take one commit to one branch without force.");
    }
    if (args[operation] === "push")
      await git(["check-ref-format", `refs/heads/${input.pushBranch}`], { signal: input.signal });
    input.signal.throwIfAborted();
    await input.assert();
    input.signal.throwIfAborted();
    const token = local ? "" : await input.token(input.signal);
    input.signal.throwIfAborted();
    await input.assert();
    input.signal.throwIfAborted();
    if (!local && (!token || /\s/.test(token))) throw new Error("GitHub sign-in is required.");
    const credential = Buffer.from(`x-access-token:${token}`).toString("base64");
    const env = repositoryGitEnv(
      input.remoteUrl,
      input.env ?? process.env,
      local ? null : credential,
    );
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
  const redact = (text: string) =>
    text
      .split(token || "\0")
      .join("[redacted]")
      .split(credential)
      .join("[redacted]");
  if (error instanceof GitError)
    return new GitError(error.args.map(redact), error.code, redact(error.stderr));
  return new Error(redact(error instanceof Error ? error.message : String(error)));
}

export function repositoryGitEnv(
  remoteUrl: string,
  base: NodeJS.ProcessEnv,
  credential: string | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: credential === null ? "file" : "https",
    GIT_CONFIG_COUNT: credential === null ? "6" : "7",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "http.followRedirects",
    GIT_CONFIG_VALUE_2: "false",
    GIT_CONFIG_KEY_3: "http.sslVerify",
    GIT_CONFIG_VALUE_3: "true",
    GIT_CONFIG_KEY_4: "http.lowSpeedLimit",
    GIT_CONFIG_VALUE_4: String(LOW_SPEED_LIMIT_BYTES),
    GIT_CONFIG_KEY_5: "http.lowSpeedTime",
    GIT_CONFIG_VALUE_5: String(LOW_SPEED_TIME_SECONDS),
  };
  for (const key of ["HOME", "TMPDIR", "LANG", "LC_ALL", "GIT_SSL_CAINFO"])
    if (base[key] !== undefined) env[key] = base[key];
  if (credential !== null) {
    env.GIT_CONFIG_KEY_6 = `http.${remoteUrl}.extraHeader`;
    env.GIT_CONFIG_VALUE_6 = `Authorization: Basic ${credential}`;
  }
  return env;
}
