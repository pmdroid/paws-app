import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BootstrapError,
  createExeDev,
  createExeDevBootstrap,
  createFakeExeDev,
  type ExeDevBootstrapOptions,
  type FakeExeDev,
} from "../src/provisioning";

const VM = "ada-paws";
const TOKEN = "tok_0123456789abcdefABCDEF-_xyz";
const RUNNER_VERSION = "1.4.0";
const MISE_VERSION = "2026.10.18";
const MISE_SHA = "e97c38973336aa2ff350fea50f47b412b266fe263b102b7200ff1e9b118c6942";
const INSTALLER = '#!/bin/sh\nset -eu\necho "installing $1"\n';
const CONFIG = JSON.stringify({
  controlPlaneUrl: "https://paws.example.com",
  runnerApiUrl: "https://paws.example.com:8788",
  allowedRepositories: [],
  concurrency: 2,
});
const CONFIG_SHA = createHash("sha256").update(`${CONFIG}\n`).digest("hex");

function q(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const PROBE = `sudo sh -c ${q(
  "systemctl show --property=LoadState,ActiveState,SubState,Result paws-bootstrap-install.service 2>/dev/null; " +
    "printf 'Version=%s\\n' \"$(dpkg-query -W -f='${db:Status-Status} ${Version}' paws-runner 2>/dev/null)\"; " +
    "printf 'Config=%s\\n' \"$(sha256sum /etc/paws-runner/config.json 2>/dev/null | cut -d' ' -f1)\"; " +
    "printf 'Mise=%s\\n' \"$(sha256sum /usr/local/bin/mise 2>/dev/null | cut -d' ' -f1)\"",
)}`;

const RUN_SCRIPT = [
  "#!/bin/sh",
  "set -eu",
  "stage=/var/lib/paws-bootstrap",
  `sh "$stage/install-runner.sh" '1.4.0'`,
  "mise=$(mktemp)",
  `trap 'rm -f "$mise"' EXIT`,
  `curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 1 -o "$mise" 'https://github.com/jdx/mise/releases/download/v2026.10.18/mise-v2026.10.18-linux-x64'`,
  `printf '%s  %s\\n' '${MISE_SHA}' "$mise" | sha256sum --strict --check -`,
  `install -o root -g root -m 0755 "$mise" /usr/local/bin/mise`,
  "install -d -o root -g root -m 0755 /etc/paws-runner",
  `install -o root -g paws-runner -m 0640 "$stage/config.json" /etc/paws-runner/config.json`,
  "",
].join("\n");

const STAGE = [
  "sudo install -d -o root -g root -m 0700 /var/lib/paws-bootstrap",
  `printf '%s' ${q(INSTALLER)} | sudo install -o root -g root -m 0700 /dev/stdin /var/lib/paws-bootstrap/install-runner.sh`,
  `printf '%s' ${q(RUN_SCRIPT)} | sudo install -o root -g root -m 0700 /dev/stdin /var/lib/paws-bootstrap/run.sh`,
  `printf '%s\\n' ${q(CONFIG)} | sudo install -o root -g root -m 0600 /dev/stdin /var/lib/paws-bootstrap/config.json`,
  `printf '%s\\n' '${TOKEN}' | sudo install -o root -g root -m 0600 /dev/stdin /var/lib/paws-bootstrap/enrollment-token`,
].join(" && ");

const START_INSTALL =
  "sudo systemctl stop paws-bootstrap-install.service 2>/dev/null || true; " +
  "sudo systemctl reset-failed paws-bootstrap-install.service 2>/dev/null || true; " +
  "sudo systemd-run --unit=paws-bootstrap-install.service --description='Paws runner bootstrap' --property=RemainAfterExit=yes /bin/sh /var/lib/paws-bootstrap/run.sh";

const ENROLL =
  "sudo /opt/paws-runner/bin/paws-runner runner enroll --config /etc/paws-runner/config.json --name 'ada-paws' --token-file /var/lib/paws-bootstrap/enrollment-token && sudo rm -f /var/lib/paws-bootstrap/enrollment-token";

const START_RUNNER = "sudo systemctl enable --now paws-runner.service";

function probe(state: {
  active?: string;
  sub?: string;
  version?: string;
  config?: string;
  mise?: string;
}): string {
  return [
    `LoadState=${state.active ? "loaded" : "not-found"}`,
    `ActiveState=${state.active ?? "inactive"}`,
    `SubState=${state.sub ?? "dead"}`,
    "Result=success",
    `Version=${state.version ?? ""}`,
    `Config=${state.config ?? ""}`,
    `Mise=${state.mise ?? ""}`,
    "",
  ].join("\n");
}

const INSTALLED = { version: `installed ${RUNNER_VERSION}`, config: CONFIG_SHA, mise: MISE_SHA };

function options(exeDev: ExeDevBootstrapOptions["exeDev"]): ExeDevBootstrapOptions {
  return {
    exeDev,
    runnerVersion: RUNNER_VERSION,
    installer: INSTALLER,
    mise: { version: MISE_VERSION, sha256: MISE_SHA },
    runnerApiUrl: "https://paws.example.com:8788/",
    controlPlaneUrl: "https://paws.example.com",
    serverCa: null,
  };
}

function setup(): FakeExeDev {
  const exe = createFakeExeDev();
  exe.addVm(VM);
  return exe;
}

function commands(exe: FakeExeDev): string[] {
  return exe.calls.flatMap((call) => (call.operation === "execVm" ? [call.command] : []));
}

async function bootstrapError(promise: Promise<unknown>): Promise<BootstrapError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BootstrapError);
    return error as BootstrapError;
  }
  throw new Error("expected a BootstrapError");
}

test("startInstall stages the installer, run script, config and token, then starts the unit", async () => {
  const exe = setup();
  exe.scriptExec(VM, PROBE, { stdout: probe({}) });
  exe.scriptExec(VM, STAGE, {});
  exe.scriptExec(VM, START_INSTALL, {
    stdout: "Running as unit: paws-bootstrap-install.service\n",
  });

  expect(await createExeDevBootstrap(options(exe)).startInstall(VM, TOKEN)).toBe("started");
  expect(exe.calls).toEqual([
    { operation: "execVm", vm: VM, command: PROBE, timeoutMs: 30_000 },
    { operation: "execVm", vm: VM, command: STAGE, timeoutMs: 60_000 },
    { operation: "execVm", vm: VM, command: START_INSTALL, timeoutMs: 60_000 },
  ]);
  // The token is only ever an argument to the shell's printf builtin, piped into a 0600 file.
  expect(commands(exe).filter((command) => command.includes(TOKEN))).toEqual([STAGE]);
});

test("startInstall is a no-op while the install runs or after it succeeded", async () => {
  for (const state of [
    { active: "active", sub: "running" },
    { active: "activating", sub: "start" },
  ]) {
    const exe = setup();
    exe.scriptExec(VM, PROBE, { stdout: probe(state) });
    expect(await createExeDevBootstrap(options(exe)).startInstall(VM, TOKEN)).toBe("running");
    expect(commands(exe)).toEqual([PROBE]);
  }
  for (const state of [{ active: "active", sub: "exited", ...INSTALLED }, INSTALLED]) {
    const exe = setup();
    exe.scriptExec(VM, PROBE, { stdout: probe(state) });
    expect(await createExeDevBootstrap(options(exe)).startInstall(VM, TOKEN)).toBe("succeeded");
    expect(commands(exe)).toEqual([PROBE]);
  }
});

test("startInstall restarts a failed install or one that installed something else", async () => {
  for (const state of [
    { active: "failed", sub: "failed", ...INSTALLED },
    { active: "active", sub: "exited", ...INSTALLED, version: "installed 1.3.9" },
    { active: "active", sub: "exited", ...INSTALLED, config: "0".repeat(64) },
    { ...INSTALLED, mise: "" },
  ]) {
    const exe = setup();
    exe.scriptExec(VM, PROBE, { stdout: probe(state) });
    exe.scriptExec(VM, STAGE, {});
    exe.scriptExec(VM, START_INSTALL, {});
    expect(await createExeDevBootstrap(options(exe)).startInstall(VM, TOKEN)).toBe("started");
    expect(commands(exe)).toEqual([PROBE, STAGE, START_INSTALL]);
  }
});

test("startInstall fails with BootstrapError('install') when staging or the unit fails", async () => {
  const exe = setup();
  exe.scriptExec(VM, PROBE, { stdout: probe({}) });
  exe.scriptExec(VM, STAGE, { exitCode: 1, stderr: "sudo: a password is required\n" });
  const error = await bootstrapError(createExeDevBootstrap(options(exe)).startInstall(VM, TOKEN));
  expect(error.step).toBe("install");
  expect(error.message).toBe(
    "ada-paws: could not stage the install (exit 1): sudo: a password is required",
  );

  const unit = setup();
  unit.scriptExec(VM, PROBE, { stdout: probe({}) });
  unit.scriptExec(VM, STAGE, {});
  unit.scriptExec(VM, START_INSTALL, { exitCode: 1 });
  expect(
    (await bootstrapError(createExeDevBootstrap(options(unit)).startInstall(VM, TOKEN))).step,
  ).toBe("install");

  const transport = setup();
  transport.fail("execVm", "timeout");
  const wrapped = await bootstrapError(
    createExeDevBootstrap(options(transport)).startInstall(VM, TOKEN),
  );
  expect(wrapped.step).toBe("install");
});

test("startInstall refuses a token that is not a minted token before any command", async () => {
  const exe = setup();
  const bootstrap = createExeDevBootstrap(options(exe));
  for (const token of ["short", `${TOKEN}'; reboot`, `${TOKEN}\n`, "x".repeat(257)]) {
    expect((await bootstrapError(bootstrap.startInstall(VM, token))).step).toBe("install");
  }
  expect((await bootstrapError(bootstrap.startInstall("Bad VM", TOKEN))).step).toBe("install");
  expect(exe.calls).toEqual([]);
});

test("installStatus reports running, succeeded or failed from the unit and the installed files", async () => {
  const cases: [Parameters<typeof probe>[0], string][] = [
    [{ active: "active", sub: "running" }, "running"],
    [{ active: "deactivating", sub: "stop-sigterm" }, "running"],
    [{ active: "active", sub: "exited", ...INSTALLED }, "succeeded"],
    [INSTALLED, "succeeded"],
    [{ active: "failed", sub: "failed" }, "failed"],
    [{ active: "active", sub: "exited", ...INSTALLED, mise: "1".repeat(64) }, "failed"],
    [{ ...INSTALLED, version: `deinstall ${RUNNER_VERSION}` }, "failed"],
    [{}, "failed"],
  ];
  for (const [state, expected] of cases) {
    const exe = setup();
    exe.scriptExec(VM, PROBE, { stdout: probe(state) });
    expect(await createExeDevBootstrap(options(exe)).installStatus(VM)).toBe(expected as never);
    expect(exe.calls).toEqual([{ operation: "execVm", vm: VM, command: PROBE, timeoutMs: 30_000 }]);
  }

  const broken = setup();
  broken.scriptExec(VM, PROBE, { exitCode: 255 });
  expect(
    (await bootstrapError(createExeDevBootstrap(options(broken)).installStatus(VM))).step,
  ).toBe("status");
});

test("enroll runs the enroll command with the token file and returns the runner", async () => {
  const exe = setup();
  const paired = JSON.stringify({ paired: true, runnerId: "run_01", workspaceId: "ws_01" });
  exe.scriptExec(VM, ENROLL, { stdout: `${paired}\n` });
  const bootstrap = createExeDevBootstrap(options(exe));

  expect(await bootstrap.enroll(VM)).toEqual({ runnerId: "run_01", workspaceId: "ws_01" });
  // A retry after the token file is gone: the daemon is already paired and prints the same JSON.
  expect(await bootstrap.enroll(VM)).toEqual({ runnerId: "run_01", workspaceId: "ws_01" });
  expect(exe.calls).toEqual([
    { operation: "execVm", vm: VM, command: ENROLL, timeoutMs: 120_000 },
    { operation: "execVm", vm: VM, command: ENROLL, timeoutMs: 120_000 },
  ]);
  expect(ENROLL).not.toContain(TOKEN);
});

test("enroll fails with BootstrapError('enroll') on anything but a paired runner", async () => {
  const outputs = [
    {
      exitCode: 1,
      stderr: "Runner command failed. Check the service identity, configuration and pairing.\n",
    },
    { stdout: "" },
    { stdout: "not json\n" },
    { stdout: `${JSON.stringify({ paired: false, runnerId: "run_01", workspaceId: "ws_01" })}\n` },
    { stdout: `${JSON.stringify({ phase: "pending", code: "ABCD" })}\n` },
    { stdout: `${JSON.stringify({ paired: true, runnerId: "", workspaceId: "ws_01" })}\n` },
  ];
  for (const output of outputs) {
    const exe = setup();
    exe.scriptExec(VM, ENROLL, output);
    const error = await bootstrapError(createExeDevBootstrap(options(exe)).enroll(VM));
    expect(error.step).toBe("enroll");
  }
  const transport = setup();
  transport.fail("execVm", "unauthorized");
  expect((await bootstrapError(createExeDevBootstrap(options(transport)).enroll(VM))).step).toBe(
    "enroll",
  );
});

test("startRunner enables and starts the runner service", async () => {
  const exe = setup();
  exe.scriptExec(VM, START_RUNNER, {});
  await createExeDevBootstrap(options(exe)).startRunner(VM);
  expect(exe.calls).toEqual([
    { operation: "execVm", vm: VM, command: START_RUNNER, timeoutMs: 60_000 },
  ]);

  const failing = setup();
  failing.scriptExec(VM, START_RUNNER, { exitCode: 1, stderr: "Unit not found\n" });
  const error = await bootstrapError(createExeDevBootstrap(options(failing)).startRunner(VM));
  expect(error.step).toBe("start");
});

test("unpinned or invalid inputs are refused before any command runs", () => {
  const exe = setup();
  const base = options(exe);
  const invalid: Partial<ExeDevBootstrapOptions>[] = [
    { runnerVersion: "latest" },
    { runnerVersion: "v1.4.0" },
    { mise: { version: "latest", sha256: MISE_SHA } },
    { mise: { version: MISE_VERSION, sha256: "" } },
    { mise: { version: MISE_VERSION, sha256: MISE_SHA.toUpperCase() } },
    { mise: { version: MISE_VERSION } as never },
    { mise: { version: MISE_VERSION, sha256: MISE_SHA, platform: "darwin-arm64" as never } },
    { installer: "" },
    { runnerApiUrl: "http://paws.example.com:8788" },
    { controlPlaneUrl: "not a url" },
    { serverCa: "secret" },
    { allowedRepositories: ["no-slash"] },
  ];
  for (const change of invalid) {
    let step: string | null = null;
    try {
      createExeDevBootstrap({ ...base, ...change });
    } catch (error) {
      expect(error).toBeInstanceOf(BootstrapError);
      step = (error as BootstrapError).step;
    }
    expect(step).toBe("config");
  }
  expect(exe.calls).toEqual([]);
});

test("the config carries the server CA and allowed repositories but no secret", async () => {
  const exe = setup();
  const ca = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
  exe.scriptExec(VM, PROBE, { stdout: probe({}) });
  exe.scriptExec(VM, /^sudo install -d /, {});
  exe.scriptExec(VM, START_INSTALL, {});
  await createExeDevBootstrap({
    ...options(exe),
    serverCa: ca,
    allowedRepositories: ["pmdroid/paws-app"],
  }).startInstall(VM, TOKEN);
  const config = JSON.stringify({
    controlPlaneUrl: "https://paws.example.com",
    runnerApiUrl: "https://paws.example.com:8788",
    allowedRepositories: ["pmdroid/paws-app"],
    serverCa: ca,
    concurrency: 2,
  });
  expect(commands(exe)[1]).toContain(
    `printf '%s\\n' ${q(config)} | sudo install -o root -g root -m 0600 /dev/stdin /var/lib/paws-bootstrap/config.json`,
  );
});

test("the exe.dev token never appears in a command sent to the VM", async () => {
  const secret = "exe-secret-token-123";
  const bodies: string[] = [];
  const headers: string[] = [];
  const exe = createExeDev({
    readToken: () => secret,
    fetch: async (_url, init) => {
      bodies.push(String(init.body));
      headers.push(new Headers(init.headers).get("authorization") ?? "");
      const stdout = Buffer.from(probe({})).toString("base64");
      return new Response(`{"stdout":"${stdout}"}\n{"exit_code":0}\n`, { status: 200 });
    },
  });
  expect(await createExeDevBootstrap(options(exe)).startInstall(VM, TOKEN)).toBe("started");
  expect(bodies).toHaveLength(3);
  expect(bodies.every((body) => body.startsWith(`ssh ${VM} `) && !body.includes(secret))).toBe(
    true,
  );
  expect(headers.every((header) => header === `Bearer ${secret}`)).toBe(true);
});

test("the staged files land with the right modes and the commands are valid shell", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-bootstrap-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const files = join(root, "files");
  mkdirSync(files);
  const executable = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  executable("sudo", '#!/bin/sh\nexec "$@"\n');
  executable(
    "install",
    [
      "#!/bin/sh",
      'mode=""; dir=0',
      "while [ $# -gt 0 ]; do",
      "  case $1 in -d) dir=1 ;; -o|-g) shift ;; -m) shift; mode=$1 ;; *) break ;; esac",
      "  shift",
      "done",
      'if [ "$dir" = 1 ]; then mkdir -p "$FAKE_ROOT$1"; exit 0; fi',
      'cat "$1" > "$FAKE_ROOT$2"',
      'printf \'%s %s\\n\' "$mode" "$2" >> "$FAKE_ROOT/modes"',
      "",
    ].join("\n"),
  );
  const result = Bun.spawnSync(["/bin/sh", "-c", STAGE], {
    env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_ROOT: files },
  });
  expect(result.exitCode).toBe(0);
  const stage = join(files, "var/lib/paws-bootstrap");
  expect(readFileSync(join(stage, "install-runner.sh"), "utf8")).toBe(INSTALLER);
  expect(readFileSync(join(stage, "run.sh"), "utf8")).toBe(RUN_SCRIPT);
  expect(readFileSync(join(stage, "config.json"), "utf8")).toBe(`${CONFIG}\n`);
  expect(readFileSync(join(stage, "enrollment-token"), "utf8")).toBe(`${TOKEN}\n`);
  expect(readFileSync(join(files, "modes"), "utf8")).toBe(
    [
      "0700 /var/lib/paws-bootstrap/install-runner.sh",
      "0700 /var/lib/paws-bootstrap/run.sh",
      "0600 /var/lib/paws-bootstrap/config.json",
      "0600 /var/lib/paws-bootstrap/enrollment-token",
      "",
    ].join("\n"),
  );
  for (const script of [RUN_SCRIPT, PROBE, START_INSTALL, ENROLL, START_RUNNER]) {
    expect(Bun.spawnSync(["/bin/sh", "-n", "-c", script]).exitCode).toBe(0);
  }
});
