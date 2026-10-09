import { checkGhAuthStatus } from "../github";
import { checkDeveloperLogin, type DeveloperCli } from "../install";
import { definedEnv, type SetupIO } from "./io";
import { stop } from "./stop";

const LOGIN_COMMAND: Record<DeveloperCli, string> = {
  claude: "claude auth login",
  codex: "codex login",
};

/**
 * Placeholder names so `checkGhAuthStatus` can run before a repo is chosen.
 * The command itself is `gh auth status` and does not receive the names.
 */
const GH_STATUS_OWNER = "paws";
const GH_STATUS_REPO = "status";

export function ensureBun(env: NodeJS.ProcessEnv): void {
  const bin = Bun.which("bun", { PATH: env.PATH ?? "" });
  if (bin === null) {
    stop("Install Bun 1.4 or newer from https://bun.sh and ensure bun is on PATH.");
  }
  const result = Bun.spawnSync([bin, "--version"], {
    env: definedEnv(env),
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = result.stdout.toString().trim();
  const match = /^(\d+)\.(\d+)/.exec(text);
  const shown = text.split(/\s+/)[0] ?? text;
  if (match === null) {
    stop("bun --version did not print a version. Install Bun 1.4 or newer from https://bun.sh");
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 1 || (major === 1 && minor < 4)) {
    stop(`Bun 1.4 or newer is required (found ${shown}). Install it from https://bun.sh`);
  }
}

export function ensureGit(env: NodeJS.ProcessEnv): void {
  const bin = Bun.which("git", { PATH: env.PATH ?? "" });
  if (bin === null) stop("Install git and ensure git is on PATH.");
}

/** Prints the login command and waits. `--yes` exits. Never runs the login command. */
export async function ensureGhLogin(io: SetupIO, yes: boolean): Promise<void> {
  for (;;) {
    const status = await checkGhAuthStatus({
      owner: GH_STATUS_OWNER,
      repo: GH_STATUS_REPO,
      env: io.env,
    });
    if (status.ok) return;
    const line = status.message.includes("not on PATH")
      ? "gh is not on PATH. Install GitHub CLI, then run: gh auth login"
      : status.message;
    if (yes) stop(line);
    if ((await waitForLogin(io, line)) === null) stop(line);
  }
}

/** `claude auth status` / `codex login status`. Does not read credential files. */
export async function ensureDeveloperLogin(
  cli: DeveloperCli,
  io: SetupIO,
  yes: boolean,
): Promise<void> {
  for (;;) {
    const check = await checkDeveloperLogin({ cli, env: io.env });
    if (check.loggedIn) return;
    const command = LOGIN_COMMAND[cli];
    const line = check.summary.includes(command)
      ? check.summary
      : `${check.summary}. Run: ${command}`;
    if (yes) stop(line);
    if ((await waitForLogin(io, line)) === null) stop(line);
  }
}

async function waitForLogin(io: SetupIO, line: string): Promise<string | null> {
  io.stdout(line);
  io.stdout("Press Enter to check again.");
  return io.readLine();
}
