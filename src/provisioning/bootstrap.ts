import { createHash } from "node:crypto";
import { z } from "zod";
import { isExeDevVmName, shellQuote } from "./names";
import { isProvisioningError, type ExeDev, type ExeDevExecResult } from "./types";

/**
 * The guest side of VM provisioning: install the Paws runner on an exe.dev VM, write its config,
 * enroll it with a member's single-use token and start the runner service. Every step is one
 * command through `execVm`, idempotent and safe to re-run after a Paws restart. The exe.dev token
 * stays in the client; nothing here sends it to the VM.
 */

export type BootstrapStep = "config" | "install" | "status" | "enroll" | "start";

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
};

export type InstallStatus = "running" | "succeeded" | "failed";

export type StartInstallResult = "started" | "running" | "succeeded";

export type EnrolledRunner = { runnerId: string; workspaceId: string };

export type ExeDevBootstrap = {
  /** Stage the installer, mise, config and token, then run the install as a transient unit. */
  startInstall(vm: string, token: string): Promise<StartInstallResult>;
  /** Read the unit's state and confirm the installed runner, config and mise are the pinned ones. */
  installStatus(vm: string): Promise<InstallStatus>;
  /** Enroll the runner with the staged token, then delete the token file. */
  enroll(vm: string): Promise<EnrolledRunner>;
  /** Enable and start the runner service. */
  startRunner(vm: string): Promise<void>;
};

export const BOOTSTRAP_STAGE_DIR = "/var/lib/paws-bootstrap";
export const BOOTSTRAP_UNIT = "paws-bootstrap-install.service";
export const BOOTSTRAP_TOKEN_FILE = `${BOOTSTRAP_STAGE_DIR}/enrollment-token`;
export const RUNNER_CONFIG_PATH = "/etc/paws-runner/config.json";
export const BOOTSTRAP_MISE_PATH = "/usr/local/bin/mise";
const RUNNER_BINARY = "/opt/paws-runner/bin/paws-runner";
const RUNNER_SERVICE = "paws-runner.service";

const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const MAX_INSTALLER_BYTES = 48 * 1024;
const MAX_CA_BYTES = 32768;

const PROBE_TIMEOUT_MS = 30_000;
const STAGE_TIMEOUT_MS = 60_000;
const ENROLL_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 60_000;

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

  return {
    async startInstall(vm, token) {
      checkVm("install", vm);
      if (typeof token !== "string" || !TOKEN.test(token))
        throw new BootstrapError("install", "The enrollment token is not a minted token.");
      const status = await probe("install", vm);
      if (status !== "failed") return status;
      const stage = await exec("install", vm, stageCommand(pinned, token), STAGE_TIMEOUT_MS);
      if (stage.exitCode !== 0) throw failure("install", vm, "could not stage the install", stage);
      const start = await exec("install", vm, START_INSTALL_COMMAND, STAGE_TIMEOUT_MS);
      if (start.exitCode !== 0) throw failure("install", vm, "could not start the install", start);
      return "started";
    },

    async installStatus(vm) {
      checkVm("status", vm);
      return probe("status", vm);
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
  };
}

type Pinned = {
  runnerVersion: string;
  installer: string;
  mise: Required<MiseRelease>;
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
): BootstrapError {
  const detail = result.stderr.trim().slice(-300);
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

function enrollCommand(vm: string): string {
  return [
    `sudo ${RUNNER_BINARY} runner enroll --config ${RUNNER_CONFIG_PATH} --name ${shellQuote(vm)} --token-file ${BOOTSTRAP_TOKEN_FILE}`,
    `sudo rm -f ${BOOTSTRAP_TOKEN_FILE}`,
  ].join(" && ");
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

/**
 * Write the installer, unit script, config and token into the root-only stage directory. Each
 * reaches its file through the shell's printf builtin piped into `install`, so the token is never
 * in a child process's argv and its file is root-owned mode 0600 from the start.
 */
function stageCommand(pinned: Pinned, token: string): string {
  const write = (format: string, content: string, mode: string, name: string) =>
    `printf '${format}' ${shellQuote(content)} | sudo install -o root -g root -m ${mode} /dev/stdin ${BOOTSTRAP_STAGE_DIR}/${name}`;
  return [
    `sudo install -d -o root -g root -m 0700 ${BOOTSTRAP_STAGE_DIR}`,
    write("%s", pinned.installer, "0700", "install-runner.sh"),
    write("%s", runScript(pinned), "0700", "run.sh"),
    write("%s\\n", pinned.config, "0600", "config.json"),
    write("%s\\n", token, "0600", "enrollment-token"),
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
