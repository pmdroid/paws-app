export type DeveloperCli = "claude" | "codex";

export type LoginCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

/** Runs the developer CLI. Tests pass a fake. The default spawn does not read files. */
export type LoginCommandRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<LoginCommandResult>;

export type LoginCheck = {
  cli: DeveloperCli;
  command: string;
  args: string[];
  loggedIn: boolean;
  exitCode: number | null;
  /** Known `claude auth status` authMethod. Tokens and paths are not copied. */
  authMethod?: string;
  summary: string;
  /** This check does not read credential files. */
  credentialsRead: false;
};

const CLAUDE_AUTH_METHODS = new Set([
  "none",
  "claude.ai",
  "oauth_token",
  "api_key",
  "api_key_helper",
  "third_party",
]);

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Ask the developer's own `claude` or `codex` CLI whether it is logged in.
 * The command is fixed (`claude auth status` / `codex login status`).
 * Paws does not read credential files and does not accept a command override. `executable`
 * only says where that CLI lives, for the runner, whose launchers are not on the task `PATH`.
 */
export async function checkDeveloperLogin(options: {
  cli: DeveloperCli;
  executable?: string;
  env?: NodeJS.ProcessEnv;
  run?: LoginCommandRunner;
  timeoutMs?: number;
}): Promise<LoginCheck> {
  const spec = developerLoginCommand(options.cli, options.executable);
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run =
    options.run ?? ((command, args, runEnv) => spawnLogin(command, args, runEnv, timeoutMs));
  let outcome: LoginCommandResult;
  try {
    outcome = await run(spec.command, spec.args, env);
  } catch (error) {
    if (isMissingExecutable(error)) {
      return {
        cli: options.cli,
        command: spec.command,
        args: [...spec.args],
        loggedIn: false,
        exitCode: null,
        summary: `${options.cli} is not installed`,
        credentialsRead: false,
      };
    }
    throw error;
  }
  return interpretLogin(options.cli, spec, outcome);
}

export async function checkDeveloperLogins(options?: {
  env?: NodeJS.ProcessEnv;
  run?: LoginCommandRunner;
  timeoutMs?: number;
}): Promise<{ claude: LoginCheck; codex: LoginCheck }> {
  const [claude, codex] = await Promise.all([
    checkDeveloperLogin({ cli: "claude", ...options }),
    checkDeveloperLogin({ cli: "codex", ...options }),
  ]);
  return { claude, codex };
}

export function developerLoginCommand(
  cli: DeveloperCli,
  executable: string = cli,
): { command: string; args: string[] } {
  switch (cli) {
    case "claude":
      return { command: executable, args: ["auth", "status"] };
    case "codex":
      return { command: executable, args: ["login", "status"] };
  }
}

function interpretLogin(
  cli: DeveloperCli,
  spec: { command: string; args: string[] },
  outcome: LoginCommandResult,
): LoginCheck {
  const base = {
    cli,
    command: spec.command,
    args: [...spec.args],
    exitCode: outcome.exitCode,
    credentialsRead: false as const,
  };
  if (outcome.timedOut) {
    return {
      ...base,
      loggedIn: false,
      summary: `${spec.command} ${spec.args.join(" ")} timed out`,
    };
  }
  if (outcome.exitCode === 0) {
    const authMethod = cli === "claude" ? authMethodFrom(outcome.stdout) : undefined;
    return {
      ...base,
      loggedIn: true,
      summary: `${cli} is logged in`,
      ...(authMethod ? { authMethod } : {}),
    };
  }
  return {
    ...base,
    loggedIn: false,
    summary: `${cli} is not logged in`,
  };
}

function authMethodFrom(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") || trimmed.length > 8_000) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || !("authMethod" in parsed))
      return undefined;
    const method = parsed.authMethod;
    if (typeof method !== "string" || !CLAUDE_AUTH_METHODS.has(method)) return undefined;
    return method;
  } catch {
    return undefined;
  }
}

async function spawnLogin(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<LoginCommandResult> {
  const child = Bun.spawn([command, ...args], {
    env: definedEnv(env),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  try {
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (typeof stdoutStream === "number" || typeof stderrStream === "number") {
      child.kill();
      throw new Error("login status pipes were not captured");
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(stdoutStream).text(),
      new Response(stderrStream).text(),
      child.exited,
    ]);
    return {
      exitCode,
      stdout: stdout.slice(0, 64_000),
      stderr: stderr.slice(0, 4_000),
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function isMissingExecutable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}
