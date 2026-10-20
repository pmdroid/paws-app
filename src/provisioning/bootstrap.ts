import { quote } from "./commands";
import type { ExeDev } from "./types";

export type BootstrapOperation = "install" | "pair" | "runner";

export class BootstrapError extends Error {
  override name = "BootstrapError";

  constructor(
    readonly operation: BootstrapOperation,
    readonly code: "exit" | "output",
  ) {
    super(`Guest ${operation}: ${code}`);
  }
}

export type PairingChallenge = { code: string; requestFingerprint: string; expiresAt: number };
export type GuestPairing =
  | { phase: "paired"; runnerId: string }
  | { phase: "pending"; challenge?: PairingChallenge };
export type InstallStatus = "running" | "succeeded" | "failed";

export interface MemberVmBootstrap {
  startInstall(vmName: string): Promise<void>;
  installStatus(vmName: string): Promise<InstallStatus>;
  requestPairing(vmName: string): Promise<PairingChallenge>;
  completePairing(vmName: string): Promise<GuestPairing>;
  startRunner(vmName: string): Promise<void>;
}

export type MiseRelease = {
  version: string;
  sha256: { amd64?: string; arm64?: string };
};

export type BootstrapOptions = {
  exeDev: ExeDev;
  runnerVersion: string;
  installer: string;
  controlPlaneUrl: string;
  runnerApiUrl: string;
  serverCa?: string;
  mise: MiseRelease;
};

export const MISE_PATH = "/usr/local/bin/mise";
export const RUNNER_SERVICE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const AGENT_TASK_PATH = "/opt/paws-runner/bin:/usr/local/bin:/usr/bin:/bin";

const UNIT = "paws-provision-install.service";
const STAGING = "/var/lib/paws-provision";
const CONFIG = "/etc/paws-runner/config.json";
const RUNNER =
  "sudo /usr/sbin/runuser --user paws-runner -- /usr/bin/env -i --chdir=/var/lib/paws-runner HOME=/var/lib/paws-runner PATH=/opt/paws-runner/bin:/usr/bin:/bin LANG=C";
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const MISE_VERSION = /^[0-9]{4}\.(?:[1-9]|1[0-2])\.(?:0|[1-9][0-9]*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RUNNER_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function origin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Runner bootstrap endpoints must be HTTPS origins.");
  return url.origin;
}

function encoded(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function pair(seconds: number, name: string): string {
  return `${RUNNER} /usr/bin/timeout ${seconds} /opt/paws-runner/bin/paws-runner runner pair --config ${CONFIG} --name ${quote(name)}`;
}

function miseCheck(user: string, home: string, path: string): string {
  return `printf '%s\n' "$(sudo runuser --user ${user} -- env -i HOME=${home} PATH=${path} LANG=C /bin/sh -c 'cd / && command -v mise >/dev/null && mise --version' 2>/dev/null | cut -d' ' -f1)"`;
}

export function validMiseRelease(mise: MiseRelease): boolean {
  const hashes = [mise.sha256.amd64, mise.sha256.arm64].filter((value) => value !== undefined);
  return (
    MISE_VERSION.test(mise.version) &&
    hashes.length > 0 &&
    hashes.every((value) => SHA256.test(value)) &&
    Object.keys(mise.sha256).every((key) => key === "amd64" || key === "arm64")
  );
}

function provisionScript(options: BootstrapOptions): string {
  const { version, sha256 } = options.mise;
  return [
    "#!/bin/sh",
    "set -eu",
    "umask 022",
    `/bin/sh ${STAGING}/install-runner.sh ${options.runnerVersion}`,
    `install -o root -g paws-runner -m 0640 ${STAGING}/config.json ${CONFIG}`,
    "arch=$(dpkg --print-architecture)",
    'case "$arch" in',
    `  amd64) asset=x64; expected=${quote(sha256.amd64 ?? "")} ;;`,
    `  arm64) asset=arm64; expected=${quote(sha256.arm64 ?? "")} ;;`,
    "  *) echo 'Unsupported architecture for mise' >&2; exit 1 ;;",
    "esac",
    `[ -n "$expected" ] || { echo "No pinned mise checksum for $arch" >&2; exit 1; }`,
    "download=$(mktemp -d)",
    `trap 'rm -rf "$download"' EXIT`,
    `curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 1 -o "$download/mise" "https://github.com/jdx/mise/releases/download/v${version}/mise-v${version}-linux-$asset"`,
    `printf '%s  %s\\n' "$expected" "$download/mise" | sha256sum --strict --check - >/dev/null`,
    `install -o root -g root -m 0755 "$download/mise" ${MISE_PATH}`,
    `printf '%s  %s\\n' "$expected" ${MISE_PATH} | sha256sum --strict --check - >/dev/null`,
    `installed=$(cd / && ${MISE_PATH} --version | cut -d' ' -f1)`,
    `[ "$installed" = ${version} ] || { echo 'Installed mise version does not match the pin' >&2; exit 1; }`,
    `service=$(systemd-run --quiet --wait --pipe --collect --property=User=paws-runner --property=Group=paws-runner --property=WorkingDirectory=/ /bin/sh -c 'command -v mise >/dev/null && mise --version' | cut -d' ' -f1)`,
    `[ "$service" = ${version} ] || { echo 'mise is not on the runner service PATH' >&2; exit 1; }`,
    `task=$(runuser --user paws-agent -- env -i HOME=/var/lib/paws-agent PATH=${AGENT_TASK_PATH} LANG=C /bin/sh -c 'cd / && command -v mise >/dev/null && mise --version' | cut -d' ' -f1)`,
    `[ "$task" = ${version} ] || { echo 'mise is not on the agent task PATH' >&2; exit 1; }`,
    "",
  ].join("\n");
}

function runnerConfig(options: BootstrapOptions, repositories: readonly string[]) {
  return `${JSON.stringify({
    controlPlaneUrl: origin(options.controlPlaneUrl),
    runnerApiUrl: origin(options.runnerApiUrl),
    allowedRepositories: repositories,
    ...(options.serverCa === undefined ? {} : { serverCa: options.serverCa }),
  })}\n`;
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function pendingChallenge(line: string): PairingChallenge | null {
  const parsed = parseJson(line);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("phase" in parsed) ||
    parsed.phase !== "pending" ||
    !("code" in parsed) ||
    typeof parsed.code !== "string" ||
    !/^[0-9A-F]{16}$/.test(parsed.code) ||
    !("requestFingerprint" in parsed) ||
    typeof parsed.requestFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(parsed.requestFingerprint) ||
    !("expiresAt" in parsed) ||
    typeof parsed.expiresAt !== "number" ||
    !Number.isSafeInteger(parsed.expiresAt)
  )
    return null;
  return {
    code: parsed.code,
    requestFingerprint: parsed.requestFingerprint,
    expiresAt: parsed.expiresAt,
  };
}

export function createExeDevBootstrap(options: BootstrapOptions): MemberVmBootstrap {
  if (!SEMVER.test(options.runnerVersion)) throw new Error("Runner version must look like 1.2.3.");
  if (!options.installer.trim() || Buffer.byteLength(options.installer) > 32_768)
    throw new Error("Runner installer is missing or too large.");
  if (!validMiseRelease(options.mise))
    throw new Error("mise must be pinned to a release version and SHA-256 checksum.");
  const initial = runnerConfig(options, []);
  const script = provisionScript(options);
  const exec = (vmName: string, command: string) => options.exeDev.execVm({ vmName, command });
  return {
    async startInstall(vmName) {
      const result = await exec(
        vmName,
        [
          ": paws-install-start",
          "set -eu",
          `active=$(systemctl show -p ActiveState --value ${UNIT} 2>/dev/null || true)`,
          `sub=$(systemctl show -p SubState --value ${UNIT} 2>/dev/null || true)`,
          'case "$active" in activating|deactivating|reloading) exit 0;; esac',
          'if [ "$active" = active ] && [ "$sub" != exited ]; then exit 0; fi',
          `if [ "$active" = active ]; then sudo systemctl stop ${UNIT}; fi`,
          `sudo systemctl reset-failed ${UNIT} >/dev/null 2>&1 || true`,
          `sudo install -d -m 0700 ${STAGING}`,
          `printf %s ${quote(encoded(options.installer))} | base64 -d | sudo tee ${STAGING}/install-runner.sh >/dev/null`,
          `printf %s ${quote(encoded(initial))} | base64 -d | sudo tee ${STAGING}/config.json >/dev/null`,
          `printf %s ${quote(encoded(script))} | base64 -d | sudo tee ${STAGING}/provision.sh >/dev/null`,
          `sudo systemd-run --quiet --unit=${UNIT} --remain-after-exit --property=Type=exec /bin/sh ${STAGING}/provision.sh`,
        ].join("; "),
      );
      if (result.exitCode !== 0) throw new BootstrapError("install", "exit");
    },
    async installStatus(vmName) {
      const result = await exec(
        vmName,
        [
          ": paws-install-status",
          `systemctl show -p ActiveState --value ${UNIT}`,
          `systemctl show -p SubState --value ${UNIT}`,
          `systemctl show -p Result --value ${UNIT}`,
          "dpkg-query -W -f='${Version}\\n' paws-runner 2>/dev/null || echo none",
          `if sudo test -f ${CONFIG}; then echo configured; else echo missing; fi`,
          miseCheck("paws-runner", "/var/lib/paws-runner", RUNNER_SERVICE_PATH),
          miseCheck("paws-agent", "/var/lib/paws-agent", AGENT_TASK_PATH),
        ].join("; "),
      );
      if (result.exitCode !== 0) throw new BootstrapError("install", "exit");
      const [active, sub, outcome, version, configured, runnerMise, agentMise] = result.stdout
        .split("\n")
        .map((line) => line.trim());
      if (
        ["activating", "deactivating", "reloading"].includes(active ?? "") ||
        (active === "active" && sub === "running")
      )
        return "running";
      return active === "active" &&
        sub === "exited" &&
        outcome === "success" &&
        version === options.runnerVersion &&
        configured === "configured" &&
        runnerMise === options.mise.version &&
        agentMise === options.mise.version
        ? "succeeded"
        : "failed";
    },
    async requestPairing(vmName) {
      const result = await exec(vmName, `: paws-pair-request; ${pair(15, vmName)}`);
      if (![0, 124].includes(result.exitCode)) throw new BootstrapError("pair", "exit");
      const challenge = pendingChallenge(result.stdout.split("\n", 1)[0] ?? "");
      if (!challenge) throw new BootstrapError("pair", "output");
      return challenge;
    },
    async completePairing(vmName) {
      const result = await exec(vmName, `: paws-pair-complete; ${pair(20, vmName)}`);
      if (![0, 124].includes(result.exitCode)) throw new BootstrapError("pair", "exit");
      const challenge = pendingChallenge(result.stdout.split("\n", 1)[0] ?? "");
      for (const line of result.stdout.split("\n")) {
        const parsed = parseJson(line);
        if (
          parsed &&
          typeof parsed === "object" &&
          "paired" in parsed &&
          parsed.paired === true &&
          "runnerId" in parsed &&
          typeof parsed.runnerId === "string" &&
          RUNNER_ID.test(parsed.runnerId)
        )
          return { phase: "paired", runnerId: parsed.runnerId };
      }
      if (result.exitCode === 0) throw new BootstrapError("pair", "output");
      return challenge ? { phase: "pending", challenge } : { phase: "pending" };
    },
    async startRunner(vmName) {
      const result = await exec(
        vmName,
        ": paws-runner-start; sudo systemctl enable --now paws-runner.service && systemctl is-active --quiet paws-runner.service",
      );
      if (result.exitCode !== 0) throw new BootstrapError("runner", "exit");
    },
  };
}
