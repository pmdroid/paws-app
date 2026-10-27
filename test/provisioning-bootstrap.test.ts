import { expect, test } from "bun:test";
import { constants, createHash, generateKeyPairSync, privateDecrypt } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOTSTRAP_EXEC_TIMEOUT_MS,
  BootstrapError,
  createExeDev,
  createExeDevBootstrap,
  createFakeExeDev,
  EXE_DEV_EXEC_LIMIT_MS,
  type ExeDevBootstrapOptions,
  type FakeExeDev,
} from "../src/provisioning";
import { runnerFailureLine } from "../src/runner-cli";
import { transportFailure } from "../src/runner-daemon";
import {
  detachCommand,
  detaching,
  fakeClock,
  pollCommand,
  stopCommand,
} from "./provisioning-detached";

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
].join(" && ");

const TOKEN_KEY = [
  "sudo install -d -o root -g root -m 0700 /var/lib/paws-bootstrap",
  "sudo rm -f /var/lib/paws-bootstrap/token-key.pem",
  `sudo sh -c 'umask 077 && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out /var/lib/paws-bootstrap/token-key.pem 2>/dev/null'`,
  "sudo openssl pkey -in /var/lib/paws-bootstrap/token-key.pem -pubout",
].join(" && ");

const TOKEN_PREFIX = "printf '%s' '";
const TOKEN_SUFFIX =
  "' | base64 -d | sudo openssl pkeyutl -decrypt -inkey /var/lib/paws-bootstrap/token-key.pem " +
  "-pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 " +
  "| sudo install -o root -g root -m 0600 /dev/stdin /var/lib/paws-bootstrap/enrollment-token" +
  " && sudo rm -f /var/lib/paws-bootstrap/token-key.pem" +
  " && sudo test -s /var/lib/paws-bootstrap/enrollment-token";
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The token command: fixed text around base64 ciphertext, which RSA-OAEP makes random. */
const TOKEN_COMMAND = new RegExp(
  `^${escape(TOKEN_PREFIX)}([A-Za-z0-9+/=]+)${escape(TOKEN_SUFFIX)}$`,
);

/** The VM's token key pair, as the token key command would print its public half. */
const KEY = generateKeyPairSync("rsa", { modulusLength: 3072 });
const PUBLIC_PEM = KEY.publicKey.export({ type: "spki", format: "pem" }).toString();

/** The token the token command carries, decrypted with the VM's private key. */
function decryptToken(command: string): string {
  const ciphertext = TOKEN_COMMAND.exec(command)?.[1];
  if (ciphertext === undefined) throw new Error(`not a token command: ${command}`);
  return privateDecrypt(
    { key: KEY.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(ciphertext, "base64"),
  ).toString("utf8");
}

function scriptToken(exe: FakeExeDev): void {
  exe.scriptExec(VM, TOKEN_KEY, { stdout: PUBLIC_PEM });
  exe.scriptExec(VM, TOKEN_COMMAND, {});
}

/** Every command carries no token, and exactly one carries its RSA-OAEP ciphertext. */
function expectTokenOnlyEncrypted(sent: string[]): void {
  expect(sent.filter((command) => command.includes(TOKEN))).toEqual([]);
  const encrypted = sent.filter((command) => TOKEN_COMMAND.test(command));
  expect(encrypted).toHaveLength(1);
  expect(decryptToken(encrypted[0]!)).toBe(TOKEN);
}

const START_INSTALL =
  "sudo systemctl stop paws-bootstrap-install.service 2>/dev/null || true; " +
  "sudo systemctl reset-failed paws-bootstrap-install.service 2>/dev/null || true; " +
  "sudo systemd-run --unit=paws-bootstrap-install.service --description='Paws runner bootstrap' --property=RemainAfterExit=yes /bin/sh /var/lib/paws-bootstrap/run.sh";

const ENROLL =
  "sudo /opt/paws-runner/bin/paws-runner runner enroll --config /etc/paws-runner/config.json --name 'ada-paws' --token-file /var/lib/paws-bootstrap/enrollment-token; " +
  'code=$?; sudo rm -f /var/lib/paws-bootstrap/enrollment-token; exit "$code"';

const START_RUNNER = "sudo systemctl enable --now paws-runner.service";
const RESET_IDENTITY =
  "sudo systemctl stop paws-runner.service && sudo rm -rf /var/lib/paws-runner/identity /var/lib/paws-runner/commands.db /var/lib/paws-runner/commands.db-wal /var/lib/paws-runner/commands.db-shm";

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

/** Bootstrap options over `exeDev`; a fake exe.dev also runs detached steps, as a VM would. */
function options(exeDev: ExeDevBootstrapOptions["exeDev"] | FakeExeDev): ExeDevBootstrapOptions {
  return {
    exeDev: "scriptExec" in exeDev ? detaching(exeDev) : exeDev,
    clock: fakeClock(),
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
  scriptToken(exe);
  exe.scriptExec(VM, START_INSTALL, {
    stdout: "Running as unit: paws-bootstrap-install.service\n",
  });

  expect(await createExeDevBootstrap(options(exe)).startInstall(VM, TOKEN)).toBe("started");
  const sent = commands(exe);
  expect(sent).toHaveLength(5);
  expect(sent[3]).toMatch(TOKEN_COMMAND);
  expect(exe.calls).toEqual([
    { operation: "execVm", vm: VM, command: PROBE, timeoutMs: 25_000 },
    { operation: "execVm", vm: VM, command: STAGE, timeoutMs: 25_000 },
    { operation: "execVm", vm: VM, command: TOKEN_KEY, timeoutMs: 25_000 },
    { operation: "execVm", vm: VM, command: sent[3]!, timeoutMs: 25_000 },
    { operation: "execVm", vm: VM, command: START_INSTALL, timeoutMs: 25_000 },
  ]);
  // No command line carries the token: only its ciphertext for the VM's own key.
  expectTokenOnlyEncrypted(sent);
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
    scriptToken(exe);
    exe.scriptExec(VM, START_INSTALL, {});
    expect(await createExeDevBootstrap(options(exe)).startInstall(VM, TOKEN)).toBe("started");
    const sent = commands(exe);
    expect(sent).toEqual([PROBE, STAGE, TOKEN_KEY, sent[3]!, START_INSTALL]);
    expectTokenOnlyEncrypted(sent);
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
  scriptToken(unit);
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

test("token staging fails with BootstrapError('token') and never sends the token to a bad key", async () => {
  const weak = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
  for (const key of [
    { exitCode: 1, stderr: "openssl: not found\n" },
    { stdout: "" },
    { stdout: "-----BEGIN PUBLIC KEY-----\nnot a key\n-----END PUBLIC KEY-----\n" },
    { stdout: weak },
    { stdout: ec },
  ]) {
    const exe = setup();
    exe.scriptExec(VM, PROBE, { stdout: probe({}) });
    exe.scriptExec(VM, STAGE, {});
    exe.scriptExec(VM, TOKEN_KEY, key);
    const error = await bootstrapError(createExeDevBootstrap(options(exe)).startInstall(VM, TOKEN));
    expect(error.step).toBe("token");
    expect(commands(exe)).toEqual([PROBE, STAGE, TOKEN_KEY]);
  }

  const decrypt = setup();
  decrypt.scriptExec(VM, TOKEN_KEY, { stdout: PUBLIC_PEM });
  decrypt.scriptExec(VM, TOKEN_COMMAND, { exitCode: 1 });
  const error = await bootstrapError(createExeDevBootstrap(options(decrypt)).stageToken(VM, TOKEN));
  expect(error.step).toBe("token");
  expect(error.message).toBe("ada-paws: could not stage the token (exit 1).");
});

test("stageToken stages a fresh token without touching the install", async () => {
  const exe = setup();
  scriptToken(exe);
  const bootstrap = createExeDevBootstrap(options(exe));
  await bootstrap.stageToken(VM, TOKEN);
  const sent = commands(exe);
  expect(exe.calls).toEqual([
    { operation: "execVm", vm: VM, command: TOKEN_KEY, timeoutMs: 25_000 },
    { operation: "execVm", vm: VM, command: sent[1]!, timeoutMs: 25_000 },
  ]);
  expectTokenOnlyEncrypted(sent);

  for (const token of ["short", `${TOKEN}'; reboot`]) {
    expect((await bootstrapError(bootstrap.stageToken(VM, token))).step).toBe("token");
  }
  expect((await bootstrapError(bootstrap.stageToken("Bad VM", TOKEN))).step).toBe("token");
  expect(exe.calls).toHaveLength(2);
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
    expect(exe.calls).toEqual([{ operation: "execVm", vm: VM, command: PROBE, timeoutMs: 25_000 }]);
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
    { operation: "execVm", vm: VM, command: ENROLL, timeoutMs: null },
    { operation: "execVm", vm: VM, command: ENROLL, timeoutMs: null },
  ]);
  expect(ENROLL).not.toContain(TOKEN);
});

test("enroll fails with BootstrapError('enroll') on anything but a paired runner", async () => {
  const outputs = [
    {
      exitCode: 1,
      stderr: "Runner command failed. Check the service identity, configuration and enrollment.\n",
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

test("an enroll failure keeps the runner's cause in the step error", async () => {
  const url = new URL("https://paws.example.com/api/runner-enrollments");
  const dns = Object.assign(new Error(`getaddrinfo ENOTFOUND ${TOKEN}`), { code: "ENOTFOUND" });
  const line = runnerFailureLine(transportFailure(dns, url, "POST", url.pathname, 5), [TOKEN]);
  const exe = setup();
  exe.scriptExec(VM, ENROLL, { exitCode: 1, stderr: `${line}\n` });
  const error = await bootstrapError(createExeDevBootstrap(options(exe)).enroll(VM));
  expect(error.step).toBe("enroll");
  expect(error.message).toContain("Cause: DNS lookup failed for paws.example.com (ENOTFOUND).");
  expect(error.message).not.toContain(TOKEN);
  // The longest cause still survives the stderr tail the step error keeps.
  const long = `${line.slice(0, line.indexOf("Cause: "))}Cause: ${"x".repeat(299)}.`;
  const tail = setup();
  tail.scriptExec(VM, ENROLL, { exitCode: 1, stderr: `${long}\n` });
  const trimmed = await bootstrapError(createExeDevBootstrap(options(tail)).enroll(VM));
  expect(trimmed.message).toContain(`${"x".repeat(299)}.`);
});

test("startRunner enables and starts the runner service", async () => {
  const exe = setup();
  exe.scriptExec(VM, START_RUNNER, {});
  await createExeDevBootstrap(options(exe)).startRunner(VM);
  expect(exe.calls).toEqual([
    { operation: "execVm", vm: VM, command: START_RUNNER, timeoutMs: null },
  ]);

  const failing = setup();
  failing.scriptExec(VM, START_RUNNER, { exitCode: 1, stderr: "Unit not found\n" });
  const error = await bootstrapError(createExeDevBootstrap(options(failing)).startRunner(VM));
  expect(error.step).toBe("start");
});

test("resetIdentity stops the runner and removes its identity and command store", async () => {
  const exe = setup();
  exe.scriptExec(VM, RESET_IDENTITY, {});
  await createExeDevBootstrap(options(exe)).resetIdentity(VM);
  expect(exe.calls).toEqual([
    { operation: "execVm", vm: VM, command: RESET_IDENTITY, timeoutMs: null },
  ]);

  const failing = setup();
  failing.scriptExec(VM, RESET_IDENTITY, { exitCode: 1, stderr: "permission denied\n" });
  const error = await bootstrapError(createExeDevBootstrap(options(failing)).resetIdentity(VM));
  expect(error.step).toBe("reset");
  expect(error.message).toContain("permission denied");
  const invalid = await bootstrapError(
    createExeDevBootstrap(options(setup())).resetIdentity("Bad VM"),
  );
  expect(invalid.step).toBe("reset");
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
  exe.scriptExec(VM, /\/var\/lib\/paws-bootstrap\/install-runner\.sh/, {});
  scriptToken(exe);
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
      const body = String(init.body);
      bodies.push(body);
      headers.push(new Headers(init.headers).get("authorization") ?? "");
      const output = body.includes("-pubout") ? PUBLIC_PEM : probe({});
      const stdout = Buffer.from(output).toString("base64");
      return new Response(`{"stdout":"${stdout}"}\n{"exit_code":0}\n`, { status: 200 });
    },
  });
  expect(await createExeDevBootstrap(options(exe)).startInstall(VM, TOKEN)).toBe("started");
  expect(bodies).toHaveLength(5);
  expect(bodies.some((body) => body.includes(TOKEN))).toBe(false);
  expect(bodies.every((body) => body.startsWith(`ssh ${VM} `) && !body.includes(secret))).toBe(
    true,
  );
  expect(headers.every((header) => header === `Bearer ${secret}`)).toBe(true);
});

/**
 * A scratch root with stand-ins for `sudo` and `install` (no root needed), and `run` to execute
 * a bootstrap command locally with the stage directory moved under that root. `openssl`, `base64`
 * and the shell are real. The stand-in `sudo` makes the runner's enroll fail.
 */
function localVm() {
  const root = mkdtempSync(join(tmpdir(), "paws-bootstrap-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const executable = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  executable(
    "sudo",
    [
      "#!/bin/sh",
      'if [ "$1" = /opt/paws-runner/bin/paws-runner ]; then echo "Runner command failed." >&2; exit 1; fi',
      'exec "$@"',
      "",
    ].join("\n"),
  );
  executable(
    "install",
    [
      "#!/bin/sh",
      'mode=""; dir=0',
      "while [ $# -gt 0 ]; do",
      "  case $1 in -d) dir=1 ;; -o|-g) shift ;; -m) shift; mode=$1 ;; *) break ;; esac",
      "  shift",
      "done",
      'if [ "$dir" = 1 ]; then mkdir -p "$1"; exit 0; fi',
      'cat "$1" > "$2"',
      `printf '%s %s\\n' "$mode" "$2" >> ${q(join(root, "modes"))}`,
      "",
    ].join("\n"),
  );
  const stage = join(root, "var/lib/paws-bootstrap");
  const run = (command: string) => {
    const result = Bun.spawnSync(
      ["/bin/sh", "-c", command.replaceAll("/var/lib/paws-bootstrap", stage)],
      { env: { PATH: `${bin}:/usr/bin:/bin` } },
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };
  const modes = () => readFileSync(join(root, "modes"), "utf8").replaceAll(stage, "<stage>");
  return { stage, run, modes };
}

test("the staged files land with the right modes and the commands are valid shell", () => {
  const vm = localVm();
  expect(vm.run(STAGE).exitCode).toBe(0);
  expect(readFileSync(join(vm.stage, "install-runner.sh"), "utf8")).toBe(INSTALLER);
  expect(readFileSync(join(vm.stage, "run.sh"), "utf8")).toBe(
    RUN_SCRIPT.replaceAll("/var/lib/paws-bootstrap", vm.stage),
  );
  expect(readFileSync(join(vm.stage, "config.json"), "utf8")).toBe(`${CONFIG}\n`);
  expect(vm.modes()).toBe(
    ["0700 <stage>/install-runner.sh", "0700 <stage>/run.sh", "0600 <stage>/config.json", ""].join(
      "\n",
    ),
  );
  for (const script of [
    RUN_SCRIPT,
    PROBE,
    TOKEN_KEY,
    START_INSTALL,
    ENROLL,
    START_RUNNER,
    RESET_IDENTITY,
  ]) {
    expect(Bun.spawnSync(["/bin/sh", "-n", "-c", script]).exitCode).toBe(0);
  }
});

test("the VM's own openssl key receives the token, and a failed enroll still removes it", async () => {
  const vm = localVm();
  const exe = setup();
  exe.scriptExec(VM, /.*/, (command) => vm.run(command));
  const bootstrap = createExeDevBootstrap(options(exe));

  await bootstrap.stageToken(VM, TOKEN);
  // Encrypted to the key openssl made in the stage directory, so only the VM can read it.
  const sent = commands(exe);
  expect(sent[0]).toBe(TOKEN_KEY);
  expect(sent[1]).toMatch(TOKEN_COMMAND);
  expect(sent.some((command) => command.includes(TOKEN))).toBe(false);
  expect(readFileSync(join(vm.stage, "enrollment-token"), "utf8")).toBe(TOKEN);
  expect(vm.modes()).toBe("0600 <stage>/enrollment-token\n");
  expect(existsSync(join(vm.stage, "token-key.pem"))).toBe(false);

  const error = await bootstrapError(bootstrap.enroll(VM));
  expect(error.step).toBe("enroll");
  expect(error.message).toBe("ada-paws: enrollment failed (exit 1): Runner command failed.");
  expect(existsSync(join(vm.stage, "enrollment-token"))).toBe(false);
});

test("a slow step starts detached, is polled in calls under 30 s, and reports its status and log", async () => {
  const exe = setup();
  exe.scriptExec(VM, detachCommand("enroll", ENROLL), { stdout: "4242\n" });
  const log = "enrolling ada-paws\nRunner command failed. Cause: the token expired.\n";
  exe.scriptExec(VM, pollCommand("enroll"), [
    { stdout: "running\n" },
    { stdout: "running\n" },
    { stdout: "running\n" },
    { stdout: `exited 1\n${log}` },
  ]);
  const clock = fakeClock();
  const bootstrap = createExeDevBootstrap({ ...options(exe), exeDev: exe, clock });

  const error = await bootstrapError(bootstrap.enroll(VM));
  expect(error.step).toBe("enroll");
  expect(error.message).toBe(
    "ada-paws: enrollment failed (exit 1): enrolling ada-paws\nRunner command failed. Cause: the token expired.",
  );
  expect(commands(exe)).toEqual([
    detachCommand("enroll", ENROLL),
    ...Array<string>(4).fill(pollCommand("enroll")),
  ]);
  for (const call of exe.calls) {
    expect(call.operation === "execVm" && call.timeoutMs).toBe(BOOTSTRAP_EXEC_TIMEOUT_MS);
  }
  expect(BOOTSTRAP_EXEC_TIMEOUT_MS).toBeLessThan(EXE_DEV_EXEC_LIMIT_MS);
  expect(clock.sleeps).toEqual([2_000, 2_000, 2_000, 2_000]);

  // A step that finishes well hands its log back as its output.
  const paired = JSON.stringify({ paired: true, runnerId: "run_01", workspaceId: "ws_01" });
  exe.scriptExec(VM, pollCommand("enroll"), {
    stdout: `exited 0\nenrolling ada-paws\n${paired}\n`,
  });
  expect(await bootstrap.enroll(VM)).toEqual({ runnerId: "run_01", workspaceId: "ws_01" });
});

test("a detached step past its budget is stopped, and one that vanished says so", async () => {
  const exe = setup();
  exe.scriptExec(VM, detachCommand("runner-start", START_RUNNER), { stdout: "4242\n" });
  exe.scriptExec(VM, pollCommand("runner-start"), { stdout: "running\n" });
  exe.scriptExec(VM, stopCommand("runner-start"), {
    stdout: "Job for paws-runner.service is waiting\n",
  });
  const clock = fakeClock();
  const bootstrap = createExeDevBootstrap({ ...options(exe), exeDev: exe, clock });
  const late = await bootstrapError(bootstrap.startRunner(VM));
  expect(late.step).toBe("start");
  expect(late.message).toBe(
    "ada-paws: runner-start did not finish within 60 s and was stopped: Job for paws-runner.service is waiting",
  );
  expect(commands(exe).at(-1)).toBe(stopCommand("runner-start"));
  expect(clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(60_000);

  exe.scriptExec(VM, pollCommand("runner-start"), { stdout: "lost\nKilled\n" });
  const lost = await bootstrapError(bootstrap.startRunner(VM));
  expect(lost.message).toBe("ada-paws: runner-start stopped without an exit status: Killed");

  exe.scriptExec(VM, detachCommand("runner-start", START_RUNNER), {
    exitCode: 1,
    stderr: "install: cannot create directory\n",
  });
  const unstarted = await bootstrapError(bootstrap.startRunner(VM));
  expect(unstarted.message).toBe(
    "ada-paws: could not start runner-start (exit 1): install: cannot create directory",
  );
});

/** The shells a guest's `sh` may be: dash on Debian and Ubuntu, bash elsewhere. */
const GUEST_SHELLS = ["dash", "bash"].filter((name) => Bun.which(name) !== null);

/** A scratch root whose `sh` is `shell`, with stand-ins for `sudo` and `install`. */
function detachedVm(shell: string) {
  const root = mkdtempSync(join(tmpdir(), "paws-detached-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const executable = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  executable("sh", `#!/bin/sh\nexec ${Bun.which(shell)} "$@"\n`);
  executable("sudo", '#!/bin/sh\nexec "$@"\n');
  executable("install", '#!/bin/sh\nfor a; do last=$a; done\nmkdir -p "$last"\n');
  const logs = join(root, "log");
  const run = (command: string) => {
    const result = Bun.spawnSync(
      ["sh", "-c", command.replaceAll("/var/log/paws-bootstrap", logs)],
      {
        env: { PATH: `${bin}:/usr/bin:/bin` },
      },
    );
    return { exitCode: result.exitCode, stdout: result.stdout.toString() };
  };
  /** Live (not zombie) processes in the step's process group. */
  const live = (pid: string) =>
    Bun.spawnSync(["ps", "-o", "stat=", "-g", pid.trim()])
      .stdout.toString()
      .split("\n")
      .filter((stat) => stat.trim() !== "" && !stat.startsWith("Z")).length;
  return { run, live };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(50);
}

test("a detached step runs in the background on a real shell and its poll reads the status", async () => {
  expect(GUEST_SHELLS).toContain("dash");
  for (const shell of GUEST_SHELLS) {
    const vm = detachedVm(shell);
    const started = Date.now();
    const start = vm.run(detachCommand("enroll", "echo out; sleep 0.3; echo err >&2; exit 3"));
    expect(Date.now() - started).toBeLessThan(250);
    expect(start).toEqual({ exitCode: 0, stdout: expect.stringMatching(/^[1-9][0-9]*\n$/) });
    expect(vm.run(pollCommand("enroll")).stdout).toBe("running\n");
    let polled = "";
    await until(() => (polled = vm.run(pollCommand("enroll")).stdout).startsWith("exited"));
    expect(polled).toBe("exited 3\nout\nerr\n");
  }

  for (const command of [
    detachCommand("enroll", ENROLL),
    pollCommand("enroll"),
    stopCommand("enroll"),
  ])
    expect(Bun.spawnSync(["/bin/sh", "-n", "-c", command]).exitCode).toBe(0);
});

test("stopping a detached step, or starting it again, ends its whole process group", async () => {
  const long = "sleep 30 & sleep 30; echo late";
  for (const shell of GUEST_SHELLS) {
    const vm = detachedVm(shell);
    const first = vm.run(detachCommand("tailnet-join", long)).stdout;
    await until(() => vm.live(first) >= 3);
    expect(vm.live(first)).toBeGreaterThanOrEqual(3);
    expect(vm.run(stopCommand("tailnet-join")).exitCode).toBe(0);
    await until(() => vm.live(first) === 0);
    expect(vm.live(first)).toBe(0);
    expect(vm.run(pollCommand("tailnet-join")).stdout).toBe("lost\n");

    // A retry while an earlier run still goes stops that run before starting its own.
    const earlier = vm.run(detachCommand("tailnet-join", long)).stdout;
    await until(() => vm.live(earlier) >= 3);
    expect(vm.live(earlier)).toBeGreaterThanOrEqual(3);
    const retry = vm.run(detachCommand("tailnet-join", "echo again")).stdout;
    expect(retry).not.toBe(earlier);
    await until(() => vm.live(earlier) === 0);
    expect(vm.live(earlier)).toBe(0);
    let polled = "";
    await until(() => (polled = vm.run(pollCommand("tailnet-join")).stdout).startsWith("exited"));
    expect(polled).toBe("exited 0\nagain\n");
  }
});
