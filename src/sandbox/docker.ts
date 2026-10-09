import { spawn } from "node:child_process";
import { isAbsolute, resolve, sep } from "node:path";
import type { AllowProxy } from "./proxy";
import { startAllowProxy } from "./proxy";

export type DockerAgent = "claude" | "codex";

/** In-container home. The host `$HOME` is never passed through. */
export const AUTH_MOUNT = "/paws-auth";

export const DEFAULT_SANDBOX_IMAGE = "paws-sandbox:local";

const CLIENT_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM"] as const;

const DENIED_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".azure",
  "Keychains",
  "docker.sock",
]);

export interface DockerRunSpec {
  agent: DockerAgent;
  /** Absolute host path. The only bind mount. */
  worktree: string;
  /** In-container command. For an ACP run this is the adapter executable. */
  command: string;
  args?: string[];
  /** Allow-list proxy URL injected as `HTTP_PROXY` and `HTTPS_PROXY`. */
  proxyUrl: string;
  image?: string;
  /** Docker CLI. Defaults to `docker`. Tests pass a fake binary. */
  bin?: string;
  /** Scrubbed down to a docker-client environment. Tokens and `$HOME` are dropped. */
  hostEnv?: NodeJS.ProcessEnv;
  uid?: number;
  gid?: number;
}

export interface DockerRunPlan {
  bin: string;
  args: string[];
  /** Environment for the docker client, not the container. */
  env: Record<string, string>;
}

export interface DockerLoginPlan {
  volume: string;
  volumeArgs: string[];
  runArgs: string[];
  env: Record<string, string>;
}

export interface LoginDockerOptions {
  /** Docker CLI. Defaults to `docker`. Tests pass a fake binary. */
  dockerBin?: string;
  image?: string;
  /** When omitted, an allow-list proxy is started for the login container. */
  proxyUrl?: string;
  hostEnv?: NodeJS.ProcessEnv;
  /** Allocate a TTY (`--tty`). Defaults to whether stdout is a TTY. */
  tty?: boolean;
  stdio?: "inherit" | "pipe";
  /** Bind address for the proxy started when `proxyUrl` is omitted. */
  proxyHost?: string;
}

export interface LoginDockerResult {
  agent: DockerAgent;
  volume: string;
  /** `docker run` argv for the login container. */
  args: string[];
}

/**
 * Shell probe that must print `probe ok: no host credentials`.
 * It checks the container, not the host: no token env, no SSH agent, no Docker
 * socket, and `$HOME` is the login volume.
 */
export const CREDENTIAL_PROBE_SCRIPT = `
fail=0
flag() {
  printf '%s\\n' "$1"
  fail=1
}
flag_if_set() {
  if [ -n "$2" ]; then
    flag "host credential in env: $1"
  fi
}
flag_if_set ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
flag_if_set ANTHROPIC_AUTH_TOKEN "$ANTHROPIC_AUTH_TOKEN"
flag_if_set CLAUDE_API_KEY "$CLAUDE_API_KEY"
flag_if_set OPENAI_API_KEY "$OPENAI_API_KEY"
flag_if_set CODEX_API_KEY "$CODEX_API_KEY"
flag_if_set GITHUB_TOKEN "$GITHUB_TOKEN"
flag_if_set GH_TOKEN "$GH_TOKEN"
flag_if_set GH_ENTERPRISE_TOKEN "$GH_ENTERPRISE_TOKEN"
flag_if_set GITHUB_PAT "$GITHUB_PAT"
flag_if_set NPM_TOKEN "$NPM_TOKEN"
flag_if_set NODE_AUTH_TOKEN "$NODE_AUTH_TOKEN"
flag_if_set AWS_ACCESS_KEY_ID "$AWS_ACCESS_KEY_ID"
flag_if_set AWS_SECRET_ACCESS_KEY "$AWS_SECRET_ACCESS_KEY"
flag_if_set SSH_AUTH_SOCK "$SSH_AUTH_SOCK"
flag_if_set SSH_AGENT_PID "$SSH_AGENT_PID"
flag_if_set SSH_ASKPASS "$SSH_ASKPASS"
flag_if_set KUBECONFIG "$KUBECONFIG"
flag_if_set GOOGLE_APPLICATION_CREDENTIALS "$GOOGLE_APPLICATION_CREDENTIALS"
if [ -S /var/run/docker.sock ] || [ -S /run/docker.sock ]; then
  flag "docker socket is mounted"
fi
if [ "$HOME" != "/paws-auth" ]; then
  flag "HOME is not the sandbox auth volume"
fi
if [ -r /proc/self/mountinfo ]; then
  while IFS= read -r line; do
    case "$line" in
      *docker.sock*|*'/.ssh'*|*Keychains*) flag "host credential path is mounted" ;;
    esac
  done < /proc/self/mountinfo
fi
if [ "$fail" -ne 0 ]; then
  printf '%s\\n' "probe failed: host credentials visible"
  exit 1
fi
printf '%s\\n' "probe ok: no host credentials"
`.trim();

export function authVolumeName(agent: DockerAgent): string {
  assertAgent(agent);
  return agent === "claude" ? "paws-claude-auth" : "paws-codex-auth";
}

/**
 * `docker run` for an ACP agent.
 * The only bind mount is the worktree (same absolute path inside the container).
 * `--network none` drops every route. The allow-list proxy URL is still set so
 * the container has one named egress and no token, `$HOME`, or SSH agent.
 */
export function buildDockerRun(spec: DockerRunSpec): DockerRunPlan {
  assertAgent(spec.agent);
  if (!spec.command.trim()) throw new Error("container command is required");
  const worktree = assertSafeWorktree(spec.worktree, spec.hostEnv);
  const proxyUrl = assertProxyUrl(spec.proxyUrl);
  const image = resolveImage(spec.image, spec.hostEnv);
  const uid = spec.uid ?? hostUid();
  const gid = spec.gid ?? hostGid();
  const args = [
    "run",
    "--rm",
    "--interactive",
    "--init",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,size=256m",
    "--mount",
    `type=bind,src=${worktree},dst=${worktree}`,
    "--mount",
    `type=volume,src=${authVolumeName(spec.agent)},dst=${AUTH_MOUNT}`,
    "--workdir",
    worktree,
    ...userArgs(uid, gid),
    ...proxyEnvArgs(proxyUrl),
    "--env",
    `HOME=${AUTH_MOUNT}`,
    image,
    spec.command,
    ...(spec.args ?? []),
  ];
  return {
    bin: spec.bin ?? "docker",
    args,
    env: dockerClientEnv(spec.hostEnv ?? {}),
  };
}

/** Same isolation as `buildDockerRun`, with `sh` running the credential probe. */
export function buildCredentialProbe(spec: Omit<DockerRunSpec, "command" | "args">): DockerRunPlan {
  return buildDockerRun({
    ...spec,
    command: "sh",
    args: ["-c", CREDENTIAL_PROBE_SCRIPT],
  });
}

/**
 * Login container argv. Unlike the agent run, this uses the bridge network so
 * the CLI can reach the allow-list proxy. It does not mount the worktree, the
 * host home, the SSH agent, or the Docker socket.
 */
export function buildDockerLogin(spec: {
  agent: DockerAgent;
  proxyUrl: string;
  image?: string;
  hostEnv?: NodeJS.ProcessEnv;
  tty?: boolean;
}): DockerLoginPlan {
  assertAgent(spec.agent);
  const proxyUrl = assertProxyUrl(spec.proxyUrl);
  const image = resolveImage(spec.image, spec.hostEnv);
  const volume = authVolumeName(spec.agent);
  const runArgs = [
    "run",
    "--rm",
    "--interactive",
    ...(spec.tty ? ["--tty"] : []),
    "--network",
    "bridge",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--mount",
    `type=volume,src=${volume},dst=${AUTH_MOUNT}`,
    ...proxyEnvArgs(proxyUrl),
    "--env",
    `HOME=${AUTH_MOUNT}`,
    image,
    "sh",
    "-c",
    loginShell(spec.agent),
  ];
  return {
    volume,
    volumeArgs: ["volume", "create", volume],
    runArgs,
    env: dockerClientEnv(spec.hostEnv ?? {}),
  };
}

/**
 * One-time Claude or Codex login into a Docker volume.
 * `paws login claude --docker` calls `loginDocker("claude")`.
 * `paws login codex --docker` calls `loginDocker("codex")`.
 * macOS Keychain logins stay on the host; the container only sees this volume.
 */
export async function loginDocker(
  agent: DockerAgent,
  options?: LoginDockerOptions,
): Promise<LoginDockerResult> {
  assertAgent(agent);
  const bin = options?.dockerBin ?? "docker";
  const hostEnv = options?.hostEnv ?? process.env;
  let proxy: AllowProxy | undefined;
  let proxyUrl = options?.proxyUrl;
  if (!proxyUrl) {
    proxy = await startAllowProxy({ host: options?.proxyHost ?? "0.0.0.0" });
    proxyUrl = `http://host.docker.internal:${proxy.port}`;
  }
  const tty = options?.tty ?? process.stdout.isTTY === true;
  const plan = buildDockerLogin({
    agent,
    proxyUrl,
    ...(options?.image ? { image: options.image } : {}),
    hostEnv,
    tty,
  });
  const stdio = options?.stdio ?? (tty ? "inherit" : "pipe");
  try {
    await execDocker(bin, plan.volumeArgs, plan.env, "pipe");
    await execDocker(bin, plan.runArgs, plan.env, stdio);
    return { agent, volume: plan.volume, args: plan.runArgs };
  } finally {
    if (proxy) await proxy.close();
  }
}

/** Docker client environment. Host `$HOME`, SSH agent, and tokens are omitted. */
export function dockerClientEnv(host: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CLIENT_ENV_KEYS) {
    const value = safeValue(host[key]);
    if (value) env[key] = value;
  }
  if (!env.PATH) env.PATH = "/usr/bin:/bin";
  return env;
}

export function assertSafeWorktree(worktree: string, hostEnv?: NodeJS.ProcessEnv): string {
  if (!isAbsolute(worktree)) throw new Error("worktree must be an absolute path");
  if (/[,:\s]/.test(worktree)) {
    throw new Error("worktree path cannot contain commas, colons, or whitespace");
  }
  const resolved = resolve(worktree);
  if (resolved === sep) throw new Error("refusing to mount the filesystem root");
  const segments = resolved.split(sep).filter((part) => part.length > 0);
  if (segments.some((part) => DENIED_SEGMENTS.has(part))) {
    throw new Error("refusing to mount host credentials or the Docker socket");
  }
  const ssh = hostEnv?.SSH_AUTH_SOCK;
  if (ssh && isAbsolute(ssh) && resolve(ssh) === resolved) {
    throw new Error("refusing to mount the SSH agent socket");
  }
  const home = hostEnv?.HOME;
  if (home && isAbsolute(home) && pathCovers(resolved, resolve(home))) {
    throw new Error("refusing to mount the host home directory");
  }
  return resolved;
}

function loginShell(agent: DockerAgent): string {
  const command = agent === "claude" ? "claude auth login" : "codex login";
  return `mkdir -p ${AUTH_MOUNT} && chmod 1777 ${AUTH_MOUNT} && export HOME=${AUTH_MOUNT} && exec ${command}`;
}

function proxyEnvArgs(proxyUrl: string): string[] {
  const pairs = [
    ["HTTP_PROXY", proxyUrl],
    ["HTTPS_PROXY", proxyUrl],
    ["http_proxy", proxyUrl],
    ["https_proxy", proxyUrl],
    ["NO_PROXY", "localhost,127.0.0.1"],
    ["no_proxy", "localhost,127.0.0.1"],
  ] as const;
  return pairs.flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

function userArgs(uid: number | undefined, gid: number | undefined): string[] {
  if (uid === undefined || gid === undefined) return [];
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid < 0 || gid < 0) {
    throw new Error("uid and gid must be non-negative integers");
  }
  return ["--user", `${uid}:${gid}`];
}

function resolveImage(image: string | undefined, hostEnv: NodeJS.ProcessEnv | undefined): string {
  const configured = image?.trim() || hostEnv?.PAWS_SANDBOX_IMAGE?.trim() || DEFAULT_SANDBOX_IMAGE;
  if (!configured || /\s/.test(configured) || configured.startsWith("-")) {
    throw new Error("sandbox image name is not valid");
  }
  return configured;
}

function assertProxyUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("proxy URL is not valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("proxy URL must be http or https");
  }
  if (url.username || url.password) throw new Error("proxy URL must not contain credentials");
  if (/[\s,]/.test(value)) throw new Error("proxy URL must be a single token");
  return value;
}

function assertAgent(agent: string): asserts agent is DockerAgent {
  if (agent !== "claude" && agent !== "codex") {
    throw new Error("agent must be claude or codex");
  }
}

function hostUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function hostGid(): number | undefined {
  return typeof process.getgid === "function" ? process.getgid() : undefined;
}

function safeValue(value: string | undefined): string | undefined {
  if (!value || /[\0\r\n]/.test(value)) return undefined;
  return value;
}

function pathCovers(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function execDocker(
  bin: string,
  args: string[],
  env: Record<string, string>,
  stdio: "inherit" | "pipe",
): Promise<void> {
  const piped = stdio === "pipe";
  const child = spawn(bin, args, {
    env,
    stdio: piped ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  let stderr = "";
  if (piped) {
    child.stdout?.resume();
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8_000);
    });
  }
  return new Promise((resolveExit, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.once("error", fail);
    child.once("exit", (code) => {
      if (code === 0) {
        if (settled) return;
        settled = true;
        resolveExit();
        return;
      }
      const detail = stderr.trim();
      const name = args[0] ?? "command";
      fail(new Error(`docker ${name} exited ${code ?? "null"}${detail ? `: ${detail}` : ""}`));
    });
  });
}
