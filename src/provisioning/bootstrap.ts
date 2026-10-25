import { constants, createHash, createPublicKey, publicEncrypt } from "node:crypto";
import { z } from "zod";
import { isExeDevVmName, shellQuote } from "./names";
import { isProvisioningError, type ExeDev, type ExeDevExecResult } from "./types";

/**
 * The guest side of VM provisioning: install the Paws runner on an exe.dev VM, write its config,
 * enroll it with a member's single-use token and start the runner service. Every step is one
 * command through `execVm`, idempotent and safe to re-run after a Paws restart. The exe.dev token
 * stays in the client; nothing here sends it to the VM.
 *
 * The enrollment token never appears in a command line. exe.dev runs each command through SSH,
 * so the remote shell's argv holds the whole command and any process on the VM could read it.
 * Instead the VM makes an RSA key pair in its root-only stage directory and prints the public
 * key. Paws sends the token encrypted to that key, and the VM decrypts it through a pipe into the
 * root-owned mode 0600 token file. Only ciphertext crosses a command line.
 *
 * When Paws is reachable only inside a Tailscale tailnet, the `tailnet` step installs a pinned
 * Tailscale release and joins the VM with the auth key from `~/.paws/secrets/tailscale-authkey`,
 * sent the same way: encrypted to a fresh VM key and decrypted into a root-only file that is
 * removed after `tailscale up`, whatever its outcome.
 */

export type BootstrapStep =
  | "config"
  | "install"
  | "status"
  | "tailnet"
  | "token"
  | "enroll"
  | "reset"
  | "start";

export class BootstrapError extends Error {
  readonly step: BootstrapStep;

  constructor(step: BootstrapStep, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BootstrapError";
    this.step = step;
  }
}

export function isBootstrapError(value: unknown): value is BootstrapError {
  return value instanceof BootstrapError;
}

export type MisePlatform = "linux-x64" | "linux-arm64";

/** A pinned mise release: an exact version and the SHA-256 of its binary for `platform`. */
export type MiseRelease = {
  version: string;
  sha256: string;
  /** Defaults to `linux-x64`, the exe.dev VM architecture. */
  platform?: MisePlatform;
};

export type TailscalePlatform = "amd64" | "arm64";

/** A pinned Tailscale static release: an exact version and the SHA-256 of its `.tgz`. */
export type TailscaleRelease = {
  version: string;
  sha256: string;
  /** Defaults to `amd64`, the exe.dev VM architecture. */
  platform?: TailscalePlatform;
};

export type ExeDevBootstrapTailnet = {
  /**
   * Reads the auth key at join time, from `~/.paws/secrets/tailscale-authkey`. Null skips the
   * `tailnet` step, so a Paws on a public URL provisions as before.
   */
  authKey: () => string | null | Promise<string | null>;
  release: TailscaleRelease;
};

export type ExeDevBootstrapOptions = {
  exeDev: ExeDev;
  /** The exact runner release to install, like `1.4.0`. */
  runnerVersion: string;
  /** The contents of `deploy/linux/install-runner.sh`. */
  installer: string;
  mise: MiseRelease;
  /** Where the runner reaches this Paws' runner API (mTLS listener). */
  runnerApiUrl: string;
  /** This Paws' public origin, where the runner posts its enrollment. */
  controlPlaneUrl: string;
  /** The PEM CA the runner trusts for this Paws, or null when public TLS suffices. */
  serverCa: string | null;
  /** Repositories the runner may check out. Defaults to none; a run gets a scoped credential. */
  allowedRepositories?: readonly string[];
  /** Join the VM to the Paws tailnet before enrollment. Absent skips the `tailnet` step. */
  tailnet?: ExeDevBootstrapTailnet;
};

export type InstallStatus = "running" | "succeeded" | "failed";

export type StartInstallResult = "started" | "running" | "succeeded";

export type EnrolledRunner = { runnerId: string; workspaceId: string };

/** `skipped`: no auth key. `joined`: this call joined. `member`: the VM was already on the tailnet. */
export type JoinTailnetResult = "skipped" | "joined" | "member";

export type ExeDevBootstrap = {
  /** Stage the installer, mise, config and token, then run the install as a transient unit. */
  startInstall(vm: string, token: string): Promise<StartInstallResult>;
  /** Read the unit's state and confirm the installed runner, config and mise are the pinned ones. */
  installStatus(vm: string): Promise<InstallStatus>;
  /**
   * Stage a fresh enrollment token without touching the install, for a retry after `enroll`
   * failed and removed the previous one. `startInstall` stages the first token itself.
   */
  stageToken(vm: string, token: string): Promise<void>;
  /**
   * Join the Paws tailnet when an auth key is configured, then wait until the VM resolves the
   * Paws host and its `/health` answers. A VM already on the tailnet only gets the reach check.
   */
  joinTailnet(vm: string): Promise<JoinTailnetResult>;
  /** Enroll the runner with the staged token, then delete the token file whatever the outcome. */
  enroll(vm: string): Promise<EnrolledRunner>;
  /** Enable and start the runner service. */
  startRunner(vm: string): Promise<void>;
  resetIdentity(vm: string): Promise<void>;
};

export const BOOTSTRAP_STAGE_DIR = "/var/lib/paws-bootstrap";
export const BOOTSTRAP_UNIT = "paws-bootstrap-install.service";
export const BOOTSTRAP_TOKEN_FILE = `${BOOTSTRAP_STAGE_DIR}/enrollment-token`;
export const BOOTSTRAP_TOKEN_KEY = `${BOOTSTRAP_STAGE_DIR}/token-key.pem`;
export const RUNNER_CONFIG_PATH = "/etc/paws-runner/config.json";
export const BOOTSTRAP_MISE_PATH = "/usr/local/bin/mise";
export const BOOTSTRAP_TAILNET_KEY = `${BOOTSTRAP_STAGE_DIR}/tailnet-key.pem`;
export const BOOTSTRAP_AUTHKEY_FILE = `${BOOTSTRAP_STAGE_DIR}/tailscale-authkey`;
const TAILSCALE_BINARY = "/usr/bin/tailscale";
const TAILSCALED_BINARY = "/usr/sbin/tailscaled";
const TAILSCALED_SERVICE = "tailscaled.service";
const AUTHKEY_SECRET = "~/.paws/secrets/tailscale-authkey";
const RUNNER_BINARY = "/opt/paws-runner/bin/paws-runner";
const RUNNER_SERVICE = "paws-runner.service";
export const RUNNER_STATE_DIR = "/var/lib/paws-runner";

const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
/** A Tailscale auth key; RSA-OAEP with a 3072-bit key carries at most 318 bytes. */
const AUTHKEY = /^tskey-[A-Za-z0-9_-]{8,240}$/;
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const MAX_INSTALLER_BYTES = 48 * 1024;
const MAX_CA_BYTES = 32768;
const MIN_TOKEN_KEY_BITS = 3072;

const PROBE_TIMEOUT_MS = 30_000;
const STAGE_TIMEOUT_MS = 60_000;
const ENROLL_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 60_000;
const RESET_TIMEOUT_MS = 60_000;
const TAILSCALE_INSTALL_TIMEOUT_MS = 300_000;
const TAILSCALE_JOIN_TIMEOUT_MS = 180_000;
/** `systemctl enable --now` plus about 30 s for the tailscaled socket to answer. */
const TAILSCALED_START_TIMEOUT_MS = 90_000;
const TAILNET_REACH_TIMEOUT_MS = 240_000;

const Enrolled = z.strictObject({
  paired: z.literal(true),
  runnerId: z.string().min(1).max(200),
  workspaceId: z.string().min(1).max(200),
});

export function createExeDevBootstrap(options: ExeDevBootstrapOptions): ExeDevBootstrap {
  const pinned = validate(options);
  const { exeDev } = options;

  async function exec(
    step: BootstrapStep,
    vm: string,
    command: string,
    timeoutMs: number,
  ): Promise<ExeDevExecResult> {
    try {
      return await exeDev.execVm(vm, command, { timeoutMs });
    } catch (error) {
      if (isProvisioningError(error))
        throw new BootstrapError(step, `${vm}: ${error.message}`, { cause: error });
      throw error;
    }
  }

  async function probe(step: BootstrapStep, vm: string): Promise<InstallStatus> {
    const result = await exec(step, vm, PROBE_COMMAND, PROBE_TIMEOUT_MS);
    if (result.exitCode !== 0) throw failure(step, vm, "could not read the install state", result);
    return classify(parseProbe(result.stdout), pinned);
  }

  /** Make the VM's token key, encrypt `token` to it, and have the VM decrypt it into its file. */
  async function stageToken(vm: string, token: string): Promise<void> {
    const key = await exec("token", vm, TOKEN_KEY_COMMAND, STAGE_TIMEOUT_MS);
    if (key.exitCode !== 0) throw failure("token", vm, "could not create the token key", key);
    const ciphertext = encryptSecret("token", vm, key.stdout, token);
    const staged = await exec("token", vm, tokenCommand(ciphertext), STAGE_TIMEOUT_MS);
    if (staged.exitCode !== 0) throw failure("token", vm, "could not stage the token", staged);
  }

  function checkToken(step: BootstrapStep, token: unknown): asserts token is string {
    if (typeof token !== "string" || !TOKEN.test(token))
      throw new BootstrapError(step, "The enrollment token is not a minted token.");
  }

  async function readAuthKey(tailnet: ExeDevBootstrapTailnet): Promise<string | null> {
    let key: unknown;
    try {
      key = await tailnet.authKey();
    } catch {
      throw new BootstrapError("tailnet", `tailnet: could not read ${AUTHKEY_SECRET}.`);
    }
    if (key === null) return null;
    if (typeof key !== "string" || !AUTHKEY.test(key))
      throw new BootstrapError(
        "tailnet",
        `tailnet: ${AUTHKEY_SECRET} does not hold a Tailscale auth key (tskey-…).`,
      );
    return key;
  }

  /** Send the auth key encrypted to a fresh VM key and run `tailscale up`; the VM drops the file. */
  async function join(vm: string, authKey: string): Promise<void> {
    const key = await exec("tailnet", vm, TAILNET_KEY_COMMAND, STAGE_TIMEOUT_MS);
    if (key.exitCode !== 0)
      throw failure("tailnet", vm, "tailnet: could not create the auth key key", key);
    const ciphertext = encryptSecret("tailnet", vm, key.stdout, authKey);
    const joined = await exec(
      "tailnet",
      vm,
      joinCommand(vm, ciphertext),
      TAILSCALE_JOIN_TIMEOUT_MS,
    );
    if (joined.exitCode !== 0)
      throw failure("tailnet", vm, "tailnet: tailscale up failed", joined, authKey);
  }

  return {
    async startInstall(vm, token) {
      checkVm("install", vm);
      checkToken("install", token);
      const status = await probe("install", vm);
      if (status !== "failed") return status;
      const stage = await exec("install", vm, stageCommand(pinned), STAGE_TIMEOUT_MS);
      if (stage.exitCode !== 0) throw failure("install", vm, "could not stage the install", stage);
      await stageToken(vm, token);
      const start = await exec("install", vm, START_INSTALL_COMMAND, STAGE_TIMEOUT_MS);
      if (start.exitCode !== 0) throw failure("install", vm, "could not start the install", start);
      return "started";
    },

    async installStatus(vm) {
      checkVm("status", vm);
      return probe("status", vm);
    },

    async stageToken(vm, token) {
      checkVm("token", vm);
      checkToken("token", token);
      await stageToken(vm, token);
    },

    async joinTailnet(vm) {
      checkVm("tailnet", vm);
      const tailnet = options.tailnet;
      if (tailnet === undefined || pinned.tailscale === null) return "skipped";
      const authKey = await readAuthKey(tailnet);
      if (authKey === null) return "skipped";
      const probed = await exec("tailnet", vm, TAILNET_PROBE_COMMAND, PROBE_TIMEOUT_MS);
      if (probed.exitCode !== 0)
        throw failure("tailnet", vm, "tailnet: could not read the Tailscale state", probed);
      const state = parseTailnetProbe(probed.stdout);
      if (state.version !== pinned.tailscale.version) {
        const installed = await exec(
          "tailnet",
          vm,
          tailscaleInstallCommand(pinned.tailscale),
          TAILSCALE_INSTALL_TIMEOUT_MS,
        );
        if (installed.exitCode !== 0)
          throw failure("tailnet", vm, "tailnet: could not install Tailscale", installed);
      }
      let result: JoinTailnetResult = "member";
      if (state.backend !== "Running") {
        // A matching version skips the install, which is what starts tailscaled. On a retry, after a
        // reboot, or with a stopped daemon, start it here and wait for its socket before the join.
        const started = await exec(
          "tailnet",
          vm,
          TAILSCALED_START_COMMAND,
          TAILSCALED_START_TIMEOUT_MS,
        );
        if (started.exitCode !== 0)
          throw failure("tailnet", vm, "tailnet: tailscaled did not start", started, authKey);
        // A daemon that kept its login (a reboot) can come back already on the tailnet.
        if (parseTailscaleStatus(started.stdout) !== "Running") {
          await join(vm, authKey);
          result = "joined";
        }
      }
      const reached = await exec(
        "tailnet",
        vm,
        reachCommand(pinned.controlPlaneUrl, pinned.serverCa),
        TAILNET_REACH_TIMEOUT_MS,
      );
      if (reached.exitCode !== 0)
        throw failure("tailnet", vm, "tailnet: the VM cannot reach this Paws", reached);
      return result;
    },

    async enroll(vm) {
      checkVm("enroll", vm);
      const result = await exec("enroll", vm, enrollCommand(vm), ENROLL_TIMEOUT_MS);
      if (result.exitCode !== 0) throw failure("enroll", vm, "enrollment failed", result);
      const line = result.stdout.trim().split("\n").at(-1) ?? "";
      let parsed: z.infer<typeof Enrolled>;
      try {
        parsed = Enrolled.parse(JSON.parse(line));
      } catch (error) {
        throw new BootstrapError("enroll", `${vm}: enrollment printed no paired runner.`, {
          cause: error,
        });
      }
      return { runnerId: parsed.runnerId, workspaceId: parsed.workspaceId };
    },

    async startRunner(vm) {
      checkVm("start", vm);
      const result = await exec("start", vm, START_RUNNER_COMMAND, START_TIMEOUT_MS);
      if (result.exitCode !== 0)
        throw failure("start", vm, "could not start the runner service", result);
    },

    async resetIdentity(vm) {
      checkVm("reset", vm);
      const result = await exec("reset", vm, RESET_IDENTITY_COMMAND, RESET_TIMEOUT_MS);
      if (result.exitCode !== 0)
        throw failure("reset", vm, "could not remove the runner identity", result);
    },
  };
}

type Pinned = {
  runnerVersion: string;
  installer: string;
  mise: Required<MiseRelease>;
  tailscale: Required<TailscaleRelease> | null;
  controlPlaneUrl: string;
  serverCa: string | null;
  config: string;
  configSha256: string;
};

function validate(options: ExeDevBootstrapOptions): Pinned {
  const refuse = (message: string): never => {
    throw new BootstrapError("config", message);
  };
  if (typeof options.runnerVersion !== "string" || !SEMVER.test(options.runnerVersion))
    refuse("The runner version must be an exact release like 1.2.3.");
  const mise = options.mise;
  if (
    mise === null ||
    typeof mise !== "object" ||
    typeof mise.version !== "string" ||
    !SEMVER.test(mise.version) ||
    typeof mise.sha256 !== "string" ||
    !SHA256.test(mise.sha256)
  )
    refuse("The mise release must be pinned to an exact version and a lowercase SHA-256.");
  const platform = mise.platform ?? "linux-x64";
  if (platform !== "linux-x64" && platform !== "linux-arm64")
    refuse("The mise platform must be linux-x64 or linux-arm64.");
  if (
    typeof options.installer !== "string" ||
    !options.installer.startsWith("#!") ||
    options.installer.includes("\0") ||
    Buffer.byteLength(options.installer) > MAX_INSTALLER_BYTES
  )
    refuse("The runner installer must be the install-runner.sh script.");
  const runnerApiUrl = origin(options.runnerApiUrl) ?? refuse("The runner API URL must be https.");
  const controlPlaneUrl =
    origin(options.controlPlaneUrl) ?? refuse("The control plane URL must be https.");
  const serverCa = options.serverCa;
  if (
    serverCa !== null &&
    (typeof serverCa !== "string" ||
      !serverCa.includes("-----BEGIN CERTIFICATE-----") ||
      serverCa.length > MAX_CA_BYTES)
  )
    refuse("The server CA must be a PEM certificate.");
  let tailscale: Required<TailscaleRelease> | null = null;
  if (options.tailnet !== undefined) {
    const release = options.tailnet?.release;
    if (
      release === null ||
      typeof release !== "object" ||
      typeof release.version !== "string" ||
      !SEMVER.test(release.version) ||
      typeof release.sha256 !== "string" ||
      !SHA256.test(release.sha256) ||
      typeof options.tailnet.authKey !== "function"
    )
      refuse("The Tailscale release must be pinned to an exact version and a lowercase SHA-256.");
    const arch = release.platform ?? "amd64";
    if (arch !== "amd64" && arch !== "arm64")
      refuse("The Tailscale platform must be amd64 or arm64.");
    tailscale = { version: release.version, sha256: release.sha256, platform: arch };
  }
  const repositories = [...(options.allowedRepositories ?? [])];
  if (repositories.length > 256 || repositories.some((name) => !REPOSITORY.test(name)))
    refuse("Allowed repositories must be owner/name, at most 256.");
  const config = JSON.stringify({
    controlPlaneUrl,
    runnerApiUrl,
    allowedRepositories: repositories,
    ...(serverCa !== null ? { serverCa } : {}),
    concurrency: 2,
  });
  return {
    runnerVersion: options.runnerVersion,
    installer: options.installer,
    mise: { version: mise.version, sha256: mise.sha256, platform },
    tailscale,
    controlPlaneUrl,
    serverCa,
    config,
    // The staged file ends with the newline printf adds.
    configSha256: createHash("sha256").update(`${config}\n`).digest("hex"),
  };
}

function origin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function checkVm(step: BootstrapStep, vm: unknown): asserts vm is string {
  if (!isExeDevVmName(vm)) throw new BootstrapError(step, "The VM name is not an exe.dev name.");
}

function failure(
  step: BootstrapStep,
  vm: string,
  what: string,
  result: ExeDevExecResult,
  secret?: string,
): BootstrapError {
  const stderr = secret ? result.stderr.replaceAll(secret, "[redacted]") : result.stderr;
  const detail = stderr.trim().slice(-300);
  return new BootstrapError(
    step,
    `${vm}: ${what} (exit ${result.exitCode})${detail ? `: ${detail}` : "."}`,
  );
}

const PROBE_COMMAND = `sudo sh -c ${shellQuote(
  [
    `systemctl show --property=LoadState,ActiveState,SubState,Result ${BOOTSTRAP_UNIT} 2>/dev/null`,
    `printf 'Version=%s\\n' "$(dpkg-query -W -f='\${db:Status-Status} \${Version}' paws-runner 2>/dev/null)"`,
    `printf 'Config=%s\\n' "$(sha256sum ${RUNNER_CONFIG_PATH} 2>/dev/null | cut -d' ' -f1)"`,
    `printf 'Mise=%s\\n' "$(sha256sum ${BOOTSTRAP_MISE_PATH} 2>/dev/null | cut -d' ' -f1)"`,
  ].join("; "),
)}`;

/** Stop a finished or failed earlier unit so the transient name is free, then start the install. */
const START_INSTALL_COMMAND = [
  `sudo systemctl stop ${BOOTSTRAP_UNIT} 2>/dev/null || true`,
  `sudo systemctl reset-failed ${BOOTSTRAP_UNIT} 2>/dev/null || true`,
  `sudo systemd-run --unit=${BOOTSTRAP_UNIT} --description='Paws runner bootstrap' --property=RemainAfterExit=yes /bin/sh ${BOOTSTRAP_STAGE_DIR}/run.sh`,
].join("; ");

const START_RUNNER_COMMAND = `sudo systemctl enable --now ${RUNNER_SERVICE}`;

const RESET_IDENTITY_COMMAND = [
  `sudo systemctl stop ${RUNNER_SERVICE}`,
  `sudo rm -rf ${RUNNER_STATE_DIR}/identity ${RUNNER_STATE_DIR}/commands.db ${RUNNER_STATE_DIR}/commands.db-wal ${RUNNER_STATE_DIR}/commands.db-shm`,
].join(" && ");

/** Enroll, then remove the token file whether or not enrollment succeeded, keeping its status. */
function enrollCommand(vm: string): string {
  return [
    `sudo ${RUNNER_BINARY} runner enroll --config ${RUNNER_CONFIG_PATH} --name ${shellQuote(vm)} --token-file ${BOOTSTRAP_TOKEN_FILE}`,
    "code=$?",
    `sudo rm -f ${BOOTSTRAP_TOKEN_FILE}`,
    'exit "$code"',
  ].join("; ");
}

/**
 * Replace any earlier key at `key` (and the `stale` files) with a fresh RSA key the VM keeps
 * root-only, and print its public half.
 */
function keyCommand(key: string, ...stale: string[]): string {
  return [
    `sudo install -d -o root -g root -m 0700 ${BOOTSTRAP_STAGE_DIR}`,
    `sudo rm -f ${[key, ...stale].join(" ")}`,
    `sudo sh -c ${shellQuote(`umask 077 && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:${MIN_TOKEN_KEY_BITS} -out ${key} 2>/dev/null`)}`,
    `sudo openssl pkey -in ${key} -pubout`,
  ].join(" && ");
}

const TOKEN_KEY_COMMAND = keyCommand(BOOTSTRAP_TOKEN_KEY);

/** A fresh key for the auth key, dropping any auth key file an interrupted join left behind. */
const TAILNET_KEY_COMMAND = keyCommand(BOOTSTRAP_TAILNET_KEY, BOOTSTRAP_AUTHKEY_FILE);

const OAEP =
  "-pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256";

/**
 * Decrypt the token on the VM straight into its root-owned mode 0600 file, drop the key, and fail
 * when the file came out empty (a pipeline's status is only its last command's).
 */
function tokenCommand(ciphertext: string): string {
  return [
    `printf '%s' ${shellQuote(ciphertext)} | base64 -d | sudo openssl pkeyutl -decrypt -inkey ${BOOTSTRAP_TOKEN_KEY} ${OAEP} | sudo install -o root -g root -m 0600 /dev/stdin ${BOOTSTRAP_TOKEN_FILE}`,
    `sudo rm -f ${BOOTSTRAP_TOKEN_KEY}`,
    `sudo test -s ${BOOTSTRAP_TOKEN_FILE}`,
  ].join(" && ");
}

/**
 * Decrypt the auth key into its root-owned mode 0600 file, join the tailnet with it, then remove
 * the file and the key whether or not the join succeeded, keeping `tailscale up`'s status.
 */
function joinCommand(vm: string, ciphertext: string): string {
  return [
    [
      `printf '%s' ${shellQuote(ciphertext)} | base64 -d | sudo openssl pkeyutl -decrypt -inkey ${BOOTSTRAP_TAILNET_KEY} ${OAEP} | sudo install -o root -g root -m 0600 /dev/stdin ${BOOTSTRAP_AUTHKEY_FILE}`,
      `sudo rm -f ${BOOTSTRAP_TAILNET_KEY}`,
      `sudo test -s ${BOOTSTRAP_AUTHKEY_FILE}`,
      `sudo ${TAILSCALE_BINARY} up --auth-key=file:${BOOTSTRAP_AUTHKEY_FILE} --hostname=${shellQuote(vm)} --timeout=120s`,
    ].join(" && "),
    "code=$?",
    `sudo rm -f ${BOOTSTRAP_AUTHKEY_FILE} ${BOOTSTRAP_TAILNET_KEY}`,
    'exit "$code"',
  ].join("; ");
}

/** Print the installed Tailscale version, then `tailscale status` as JSON (empty when absent). */
const TAILNET_PROBE_COMMAND = `sudo sh -c ${shellQuote(
  [
    `printf 'Version=%s\\n' "$(${TAILSCALE_BINARY} version 2>/dev/null | head -n 1)"`,
    `${TAILSCALE_BINARY} status --json --peers=false 2>/dev/null || true`,
  ].join("; "),
)}`;

type TailnetProbe = { version: string; backend: string };

function parseTailnetProbe(stdout: string): TailnetProbe {
  const newline = stdout.indexOf("\n");
  const first = newline === -1 ? stdout : stdout.slice(0, newline);
  const version = first.startsWith("Version=") ? first.slice("Version=".length).trim() : "";
  return {
    version,
    backend: parseTailscaleStatus(newline === -1 ? "" : stdout.slice(newline + 1)),
  };
}

/** `BackendState` from `tailscale status --json`, or empty when it printed none. */
function parseTailscaleStatus(json: string): string {
  try {
    const status: unknown = JSON.parse(json);
    const state = (status as { BackendState?: unknown } | null)?.BackendState;
    if (typeof state === "string") return state;
  } catch {
    // No tailscaled yet, or it printed no status: the VM is not on the tailnet.
  }
  return "";
}

/**
 * Enable and start tailscaled (a no-op when it already runs), then try 15 times, two seconds
 * apart, for `tailscale status --json` to answer and print it. When the daemon never answers, print
 * the last journal lines and the unit's state to stderr; the failure keeps only their last 300
 * characters. The auth key is not on the VM yet, so these lines cannot hold it.
 */
const TAILSCALED_START_COMMAND = `sudo sh -c ${shellQuote(
  [
    `systemctl enable --now ${TAILSCALED_SERVICE} >/dev/null 2>&1`,
    "i=0",
    `until out=$(${TAILSCALE_BINARY} status --json --peers=false 2>/dev/null); do i=$((i+1)); if [ "$i" -ge 15 ]; then { journalctl -u ${TAILSCALED_SERVICE} --no-pager --lines=3 --output=cat; systemctl status ${TAILSCALED_SERVICE} --no-pager --lines=0 | head -n 3; } >&2 2>&1; exit 4; fi; sleep 2; done`,
    `printf '%s\\n' "$out"`,
  ].join("; "),
)}`;

/**
 * Download the pinned static release, check its SHA-256 before unpacking, install the two
 * binaries and the shipped systemd unit, and (re)start tailscaled. No install script runs.
 */
function tailscaleInstallCommand(release: Required<TailscaleRelease>): string {
  const { version, sha256, platform } = release;
  const name = `tailscale_${version}_${platform}`;
  const url = `https://pkgs.tailscale.com/stable/${name}.tgz`;
  const script = [
    "set -eu",
    `tgz=$(mktemp); dir=$(mktemp -d); trap 'rm -rf "$tgz" "$dir"' EXIT`,
    `curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 1 -o "$tgz" ${shellQuote(url)}`,
    `printf '%s  %s\\n' ${shellQuote(sha256)} "$tgz" | sha256sum --strict --check -`,
    `tar -xzf "$tgz" -C "$dir" --strip-components=1 ${name}/tailscale ${name}/tailscaled ${name}/systemd/tailscaled.service ${name}/systemd/tailscaled.defaults`,
    `install -o root -g root -m 0755 "$dir/tailscaled" ${TAILSCALED_BINARY}`,
    `install -o root -g root -m 0755 "$dir/tailscale" ${TAILSCALE_BINARY}`,
    `install -o root -g root -m 0644 "$dir/systemd/tailscaled.service" /etc/systemd/system/${TAILSCALED_SERVICE}`,
    `[ -e /etc/default/tailscaled ] || install -o root -g root -m 0644 "$dir/systemd/tailscaled.defaults" /etc/default/tailscaled`,
    "systemctl daemon-reload",
    `systemctl enable ${TAILSCALED_SERVICE}`,
    `systemctl restart ${TAILSCALED_SERVICE}`,
  ].join("\n");
  return `sudo sh -c ${shellQuote(script)}`;
}

/**
 * Try 30 times, two seconds apart, for the VM to resolve the Paws host and for `/health` to answer, then
 * name which of the two failed. With a private Paws CA, curl trusts that CA (it is public).
 */
function reachCommand(controlPlaneUrl: string, serverCa: string | null): string {
  const url = new URL(controlPlaneUrl);
  const health = `${url.origin}/health`;
  const trust = serverCa === null ? "" : '--cacert "$ca" ';
  return [
    `host=${shellQuote(url.hostname)}`,
    `url=${shellQuote(health)}`,
    ...(serverCa === null
      ? []
      : [
          `ca=$(mktemp)`,
          `trap 'rm -f "$ca"' EXIT`,
          `printf '%s\\n' ${shellQuote(serverCa)} > "$ca"`,
        ]),
    "i=0",
    `until getent hosts "$host" >/dev/null 2>&1 && curl --proto '=https' --tlsv1.2 ${trust}-fsS --max-time 5 -o /dev/null "$url" 2>/dev/null; do i=$((i+1)); if [ "$i" -ge 30 ]; then if getent hosts "$host" >/dev/null 2>&1; then echo "$url did not answer" >&2; exit 3; fi; echo "cannot resolve $host" >&2; exit 2; fi; sleep 2; done`,
  ].join("; ");
}

/** RSA-OAEP (SHA-256) a secret to the public key the VM printed, as base64. */
function encryptSecret(
  step: "token" | "tailnet",
  vm: string,
  stdout: string,
  secret: string,
): string {
  const pem = /-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\s]+-----END PUBLIC KEY-----/.exec(
    stdout,
  )?.[0];
  const what = step === "token" ? "the token key" : "tailnet: the auth key key";
  let key: ReturnType<typeof createPublicKey>;
  try {
    if (pem === undefined) throw new Error("no PEM public key");
    key = createPublicKey(pem);
  } catch (error) {
    throw new BootstrapError(step, `${vm}: ${what} is not a public key.`, {
      cause: error,
    });
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== "rsa" || bits < MIN_TOKEN_KEY_BITS)
    throw new BootstrapError(
      step,
      `${vm}: ${what} must be RSA of at least ${MIN_TOKEN_KEY_BITS} bits.`,
    );
  return publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(secret, "utf8"),
  ).toString("base64");
}

/** What the transient unit runs as root: the runner package, the pinned mise, then the config. */
function runScript(pinned: Pinned): string {
  const { version, sha256, platform } = pinned.mise;
  const url = `https://github.com/jdx/mise/releases/download/v${version}/mise-v${version}-${platform}`;
  return [
    "#!/bin/sh",
    "set -eu",
    `stage=${BOOTSTRAP_STAGE_DIR}`,
    `sh "$stage/install-runner.sh" ${shellQuote(pinned.runnerVersion)}`,
    "mise=$(mktemp)",
    `trap 'rm -f "$mise"' EXIT`,
    `curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 1 -o "$mise" ${shellQuote(url)}`,
    `printf '%s  %s\\n' ${shellQuote(sha256)} "$mise" | sha256sum --strict --check -`,
    `install -o root -g root -m 0755 "$mise" ${BOOTSTRAP_MISE_PATH}`,
    "install -d -o root -g root -m 0755 /etc/paws-runner",
    `install -o root -g paws-runner -m 0640 "$stage/config.json" ${RUNNER_CONFIG_PATH}`,
    "",
  ].join("\n");
}

/** Write the installer, unit script and config into the root-only stage directory. */
function stageCommand(pinned: Pinned): string {
  const write = (format: string, content: string, mode: string, name: string) =>
    `printf '${format}' ${shellQuote(content)} | sudo install -o root -g root -m ${mode} /dev/stdin ${BOOTSTRAP_STAGE_DIR}/${name}`;
  return [
    `sudo install -d -o root -g root -m 0700 ${BOOTSTRAP_STAGE_DIR}`,
    write("%s", pinned.installer, "0700", "install-runner.sh"),
    write("%s", runScript(pinned), "0700", "run.sh"),
    write("%s\\n", pinned.config, "0600", "config.json"),
  ].join(" && ");
}

type Probe = Record<string, string>;

function parseProbe(stdout: string): Probe {
  const probe: Probe = {};
  for (const line of stdout.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) probe[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return probe;
}

/**
 * A unit that is still starting or running is `running`; a failed unit is `failed`. Otherwise the
 * install counts as `succeeded` only when the runner, config and mise on disk are the pinned
 * ones, which also holds after a reboot has dropped the transient unit.
 */
function classify(probe: Probe, pinned: Pinned): InstallStatus {
  const active = probe.ActiveState ?? "inactive";
  const sub = probe.SubState ?? "";
  if (
    active === "activating" ||
    active === "deactivating" ||
    active === "reloading" ||
    (active === "active" && (sub === "running" || sub === "start"))
  )
    return "running";
  if (active === "failed") return "failed";
  const installed =
    probe.Version === `installed ${pinned.runnerVersion}` &&
    probe.Config === pinned.configSha256 &&
    probe.Mise === pinned.mise.sha256;
  return installed ? "succeeded" : "failed";
}
