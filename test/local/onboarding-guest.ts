import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRepositoryPolicyReader,
  openRunnerDaemon,
  REPOSITORY_POLICY_PATH,
  readRepositoryPolicy,
  type RunnerDaemon,
} from "../../src/runner-daemon";
import type { ExeDevGuest } from "./onboarding-exe-dev";

type GuestConfig = {
  controlPlaneUrl: string;
  runnerApiUrl: string;
  allowedRepositories: string[];
  repositoryPolicy: string;
  serverCa?: string;
};

type GuestVm = {
  installer: string | null;
  provision: string | null;
  config: GuestConfig | null;
  configText: string | null;
  version: string | null;
  mise: string | null;
  installed: "none" | "succeeded" | "failed";
  runner: RunnerDaemon | null;
  heartbeat: ReturnType<typeof setInterval> | null;
};

export type GuestEvent = {
  vmName: string;
  marker: string;
  exitCode: number;
  detail?: unknown;
};

export type OnboardingGuest = {
  run: ExeDevGuest;
  events: GuestEvent[];
  heartbeats: { vmName: string; ok: boolean; at: number }[];
  failInstallStatus: number;
  config(vmName: string): GuestConfig | null;
  installerDigest(vmName: string): string | null;
  runner(vmName: string): RunnerDaemon | null;
  policy(vmName: string): ReturnType<typeof readRepositoryPolicy> | null;
  stop(): Promise<void>;
};

const PAIR =
  /\/usr\/bin\/timeout (\d+) \/opt\/paws-runner\/bin\/paws-runner runner pair --config \/etc\/paws-runner\/config\.json --name '([a-z0-9-]+)'$/;
const STAGED =
  /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d \| sudo tee \/var\/lib\/paws-provision\/(install-runner\.sh|config\.json|provision\.sh|config\.next) >\/dev\/null/g;
const INSTALL_UNIT =
  "sudo systemd-run --quiet --unit=paws-provision-install.service --remain-after-exit --property=Type=exec /bin/sh /var/lib/paws-provision/provision.sh";
const RUNNER_START =
  "sudo systemctl enable --now paws-runner.service && systemctl is-active --quiet paws-runner.service";

function staged(command: string) {
  return new Map(
    [...command.matchAll(STAGED)].map((match) => [
      match[2]!,
      Buffer.from(match[1]!, "base64").toString("utf8"),
    ]),
  );
}

export function createOnboardingGuest(root: string): OnboardingGuest {
  const vms = new Map<string, GuestVm>();
  const pendingHeartbeats = new Set<Promise<void>>();
  const vm = (name: string) => {
    let found = vms.get(name);
    if (!found) {
      found = {
        installer: null,
        provision: null,
        config: null,
        configText: null,
        version: null,
        mise: null,
        installed: "none",
        runner: null,
        heartbeat: null,
      };
      vms.set(name, found);
    }
    return found;
  };
  const daemonRoot = (name: string) => {
    const path = join(root, name, "var/lib/paws-runner");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  };
  const policyPath = (name: string) => {
    if (vms.size !== 1 || !vms.has(name))
      throw new Error("The isolated guest policy filesystem belongs to exactly one VM.");
    return REPOSITORY_POLICY_PATH;
  };
  const open = (name: string, config: GuestConfig) => {
    if (config.repositoryPolicy !== REPOSITORY_POLICY_PATH)
      throw new Error("Guest configuration does not select the protected repository policy.");
    return openRunnerDaemon({
      root: daemonRoot(name),
      controlPlaneUrl: config.controlPlaneUrl,
      runnerApiUrl: config.runnerApiUrl,
      allowedRepositories: config.allowedRepositories,
      repositoryPolicy: createRepositoryPolicyReader(policyPath(name), process.getgid!()),
      ...(config.serverCa === undefined ? {} : { serverCa: config.serverCa }),
      concurrency: 2,
    });
  };
  function startService(name: string, state: GuestVm, config: GuestConfig) {
    const runner = open(name, config);
    state.runner = runner;
    const beat = async () => {
      try {
        await runner.heartbeat();
        guest.heartbeats.push({ vmName: name, ok: true, at: Date.now() });
      } catch {
        guest.heartbeats.push({ vmName: name, ok: false, at: Date.now() });
      }
    };
    const tick = () => {
      const pending = beat();
      pendingHeartbeats.add(pending);
      void pending.finally(() => pendingHeartbeats.delete(pending));
    };
    tick();
    state.heartbeat = setInterval(tick, 2_000);
  }
  function stopService(state: GuestVm) {
    if (state.heartbeat) clearInterval(state.heartbeat);
    state.heartbeat = null;
    state.runner?.close();
    state.runner = null;
  }
  async function pair(name: string, seconds: number) {
    const state = vm(name);
    if (state.installed !== "succeeded" || !state.config)
      return { exitCode: 1, stderr: "Runner command failed.\n" };
    const daemon = open(name, state.config);
    const lines: string[] = [];
    const deadline = Date.now() + seconds * 1000;
    try {
      const pending = await daemon.beginPairing(name);
      if (pending.phase !== "pending") throw new Error("Pairing is not pending");
      lines.push(JSON.stringify(pending));
      while (Date.now() < deadline) {
        const status = await daemon.pollPairing();
        if (status.phase === "paired") {
          lines.push(
            JSON.stringify({
              paired: true,
              runnerId: status.runnerId,
              workspaceId: status.workspaceId,
            }),
          );
          return { exitCode: 0, stdout: lines.join("\n") + "\n" };
        }
        await Bun.sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
      }
      return { exitCode: 124, stdout: lines.join("\n") + "\n" };
    } catch {
      return {
        exitCode: 1,
        stdout: lines.length ? lines.join("\n") + "\n" : "",
        stderr: "Runner command failed. Check the service identity, configuration and pairing.\n",
      };
    } finally {
      daemon.close();
    }
  }
  const guest: OnboardingGuest = {
    events: [],
    heartbeats: [],
    failInstallStatus: 0,
    config: (name) => vms.get(name)?.config ?? null,
    installerDigest: (name) => {
      const installer = vms.get(name)?.installer;
      return installer ? createHash("sha256").update(installer).digest("hex") : null;
    },
    runner: (name) => vms.get(name)?.runner ?? null,
    policy: (name) =>
      vms.has(name) && existsSync(policyPath(name))
        ? readRepositoryPolicy(policyPath(name), process.getgid!())
        : null,
    async run({ vmName, command }) {
      const marker = /^: (paws-[a-z-]+);/.exec(command)?.[1] ?? "unknown";
      const state = vm(vmName);
      let result: { exitCode: number; stdout?: string; stderr?: string };
      let detail: unknown;
      if (marker === "paws-install-start") {
        const files = staged(command);
        const config = files.get("config.json");
        state.installer = files.get("install-runner.sh") ?? null;
        state.provision = files.get("provision.sh") ?? null;
        state.configText = config ?? null;
        state.config = config ? (JSON.parse(config) as GuestConfig) : null;
        state.version =
          /\/install-runner\.sh (\d+\.\d+\.\d+)\n/.exec(state.provision ?? "")?.[1] ?? null;
        state.mise =
          /\[ "\$installed" = (\d{4}\.\d+\.\d+) \]/.exec(state.provision ?? "")?.[1] ?? null;
        const ok =
          state.installer !== null &&
          state.config !== null &&
          state.config.repositoryPolicy === REPOSITORY_POLICY_PATH &&
          state.version !== null &&
          state.mise !== null &&
          command.endsWith(INSTALL_UNIT);
        if (ok && guest.failInstallStatus > 0) {
          guest.failInstallStatus -= 1;
          state.installed = "failed";
        } else state.installed = ok ? "succeeded" : "failed";
        if (state.installed === "succeeded" && !existsSync(policyPath(vmName))) {
          if (process.getuid!() !== 0 || statfsSync("/etc").type !== 0x01021994)
            throw new Error(
              "Guest policy writes require namespace root and a disposable tmpfs /etc.",
            );
          mkdirSync("/etc/paws-runner", { recursive: true, mode: 0o755 });
          writeFileSync(
            policyPath(vmName),
            JSON.stringify({ revision: 0, fence: 0, repositories: [] }),
            {
              mode: 0o640,
            },
          );
          chmodSync(policyPath(vmName), 0o640);
        }
        detail = {
          installation: "emulated; package and mise commands were not executed",
          staged: [...files.keys()],
          version: state.version,
          mise: state.mise,
          allowedRepositories: state.config?.allowedRepositories ?? null,
          installed: state.installed,
        };
        result = { exitCode: ok ? 0 : 1 };
      } else if (marker === "paws-install-status") {
        const mise = state.mise ?? "";
        result = {
          exitCode: 0,
          stdout:
            state.installed === "succeeded"
              ? `active\nexited\nsuccess\n${state.version}\nconfigured\n${mise}\n${mise}\n`
              : state.installed === "failed"
                ? "failed\nfailed\nexit-code\nnone\nmissing\n\n\n"
                : "inactive\ndead\nsuccess\nnone\nmissing\n\n\n",
        };
        detail = { installed: state.installed };
      } else if (marker === "paws-pair-request" || marker === "paws-pair-complete") {
        const matched = PAIR.exec(command);
        result =
          matched && matched[2] === vmName
            ? await pair(vmName, Number(matched[1]))
            : { exitCode: 2, stderr: "unexpected pair command\n" };
        detail = { timeoutSeconds: matched ? Number(matched[1]) : null };
      } else if (marker === "paws-runner-start" && command.endsWith(RUNNER_START)) {
        if (state.installed !== "succeeded" || !state.config) result = { exitCode: 1 };
        else {
          if (!state.runner) startService(vmName, state, state.config);
          result = { exitCode: 0 };
        }
      } else if (marker === "paws-runner-policy") {
        const matched =
          /^: paws-runner-policy; sudo \/usr\/bin\/python3 -c ('(?:[^']|'\\'')*')$/s.exec(command);
        if (state.installed !== "succeeded" || !matched) result = { exitCode: 1 };
        else {
          if (process.getuid!() !== 0 || statfsSync("/etc").type !== 0x01021994)
            throw new Error("Guest policy publication requires a disposable namespace filesystem.");
          const program = matched[1]!.slice(1, -1).replaceAll("'\\''", "'");
          const before = state.runner;
          const child = Bun.spawn(["/usr/bin/python3", "-c", program], {
            env: {
              PATH: "/usr/bin:/bin",
              HOME: process.env.HOME!,
              KYOTOAGENT_ROOT: process.env.KYOTOAGENT_ROOT!,
              TMPDIR: process.env.TMPDIR!,
            },
            stdout: "pipe",
            stderr: "pipe",
          });
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          result = { exitCode, stdout, stderr };
          detail = {
            publication: "production Python flock/fsync/replace",
            policy: guest.policy(vmName),
            sameDaemon: before === state.runner,
            restarted: false,
          };
        }
      } else result = { exitCode: 127, stderr: "unknown guest command\n" };
      guest.events.push({ vmName, marker, exitCode: result.exitCode, detail });
      return result;
    },
    async stop() {
      for (const state of vms.values()) stopService(state);
      await Promise.all(pendingHeartbeats);
    },
  };
  return guest;
}
