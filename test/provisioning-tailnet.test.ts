import { expect, test } from "bun:test";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import {
  BOOTSTRAP_AUTHKEY_FILE,
  BOOTSTRAP_TAILNET_KEY,
  BootstrapError,
  createExeDevBootstrap,
  createFakeExeDev,
  PINNED_TAILSCALE,
  type ExeDevBootstrapOptions,
  type FakeExeDev,
} from "../src/provisioning";

const VM = "ada-paws";
const AUTHKEY = "tskey-auth-kAbCdEf1CNTRL-0123456789abcdefGHIJKLmnopqrstuv";
const PAWS = "https://agentbox.taile07e4.ts.net:8787";
const KEY = generateKeyPairSync("rsa", { modulusLength: 3072 });
const PUBLIC_PEM = KEY.publicKey.export({ type: "spki", format: "pem" }).toString();

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The join command: fixed text around base64 ciphertext for the VM's tailnet key. */
const JOIN = new RegExp(
  `^printf '%s' '([A-Za-z0-9+/=]+)' \\| base64 -d \\| sudo openssl pkeyutl -decrypt -inkey ${escape(BOOTSTRAP_TAILNET_KEY)} `,
);

type Vm = {
  version: string;
  backend: string;
  /** Whether the decrypted auth key file exists on the VM. */
  authFile: boolean;
  joins: string[];
  upExit: number;
  reachExit: number;
};

/**
 * A fake exe.dev VM that answers the tailnet commands: the probe reports what is installed and
 * whether tailscaled runs, the key command prints a public key, and the join command is played
 * out segment by segment so the test can see whether the auth key file is left behind.
 */
function simulate(state: Partial<Vm> = {}): { exe: FakeExeDev; vm: Vm } {
  const vm: Vm = {
    version: "",
    backend: "",
    authFile: false,
    joins: [],
    upExit: 0,
    reachExit: 0,
    ...state,
  };
  const exe = createFakeExeDev();
  exe.addVm(VM);
  exe.scriptExec(VM, /tailscale version/, () => ({
    stdout: `Version=${vm.version}\n${vm.backend ? JSON.stringify({ BackendState: vm.backend }) : ""}`,
  }));
  exe.scriptExec(VM, /pkgs\.tailscale\.com/, () => {
    vm.version = PINNED_TAILSCALE.amd64.version;
    vm.backend = vm.backend || "NeedsLogin";
    return {};
  });
  exe.scriptExec(VM, new RegExp(`${escape(BOOTSTRAP_TAILNET_KEY)} -pubout$`), (command) => {
    if (command.includes(`rm -f ${BOOTSTRAP_TAILNET_KEY} ${BOOTSTRAP_AUTHKEY_FILE}`))
      vm.authFile = false;
    return { stdout: PUBLIC_PEM };
  });
  exe.scriptExec(VM, JOIN, (command) => {
    const [joined, cleanup] = command.split("; code=$?; ");
    vm.joins.push(decrypt(command));
    if (joined!.includes(`/dev/stdin ${BOOTSTRAP_AUTHKEY_FILE}`)) vm.authFile = true;
    const up = joined!.includes(`--auth-key=file:${BOOTSTRAP_AUTHKEY_FILE}`) ? vm.upExit : 1;
    if (up === 0) vm.backend = "Running";
    // The removal runs after `code=$?`, so it happens whatever `tailscale up` returned.
    if (cleanup?.startsWith(`sudo rm -f ${BOOTSTRAP_AUTHKEY_FILE} `)) vm.authFile = false;
    return up === 0 ? {} : { exitCode: up, stderr: `backend error: invalid key: ${AUTHKEY}\n` };
  });
  exe.scriptExec(VM, /\/health'/, () =>
    vm.reachExit === 0
      ? {}
      : {
          exitCode: vm.reachExit,
          stderr: "cannot resolve agentbox.taile07e4.ts.net\n",
        },
  );
  return { exe, vm };
}

function decrypt(command: string): string {
  const ciphertext = JOIN.exec(command)?.[1];
  if (ciphertext === undefined) throw new Error(`not a join command: ${command}`);
  return privateDecrypt(
    { key: KEY.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(ciphertext, "base64"),
  ).toString("utf8");
}

function options(
  exeDev: FakeExeDev,
  authKey: () => string | null = () => AUTHKEY,
): ExeDevBootstrapOptions {
  return {
    exeDev,
    runnerVersion: "1.4.0",
    installer: "#!/bin/sh\n",
    mise: { version: "2026.10.18", sha256: "0".repeat(64) },
    runnerApiUrl: "https://agentbox.taile07e4.ts.net:8788",
    controlPlaneUrl: PAWS,
    serverCa: null,
    tailnet: { authKey, release: PINNED_TAILSCALE.amd64 },
  };
}

function commands(exe: FakeExeDev): string[] {
  return exe.calls.flatMap((call) => (call.operation === "execVm" ? [call.command] : []));
}

async function bootstrapError(promise: Promise<unknown>): Promise<BootstrapError> {
  const error = await promise.then(
    () => null,
    (value: unknown) => value,
  );
  expect(error).toBeInstanceOf(BootstrapError);
  return error as BootstrapError;
}

test("a fresh VM installs the pinned Tailscale, joins, then checks it reaches Paws", async () => {
  const { exe, vm } = simulate();
  expect(await createExeDevBootstrap(options(exe)).joinTailnet(VM)).toBe("joined");
  const sent = commands(exe);
  expect(sent).toHaveLength(5);
  expect(sent[0]).toContain("tailscale version");
  expect(sent[1]).toContain(
    `https://pkgs.tailscale.com/stable/tailscale_${PINNED_TAILSCALE.amd64.version}_amd64.tgz`,
  );
  expect(sent[1]).toContain(PINNED_TAILSCALE.amd64.sha256);
  expect(sent[1]).toContain("sha256sum --strict --check -");
  expect(sent[1]).not.toMatch(/\| *(sudo )?sh\b/);
  // The checksum is checked before the archive is unpacked.
  expect(sent[1]!.indexOf("sha256sum")).toBeLessThan(sent[1]!.indexOf("tar -xzf"));
  expect(sent[2]).toMatch(/tailnet-key\.pem -pubout$/);
  expect(sent[3]).toMatch(JOIN);
  expect(sent[3]).toContain(`--auth-key=file:${BOOTSTRAP_AUTHKEY_FILE} --hostname='ada-paws'`);
  expect(sent[3]).toContain(`-m 0600 /dev/stdin ${BOOTSTRAP_AUTHKEY_FILE}`);
  expect(sent[4]).toContain("host='agentbox.taile07e4.ts.net'");
  expect(sent[4]).toContain("url='https://agentbox.taile07e4.ts.net:8787/health'");
  expect(vm.backend).toBe("Running");
});

test("the auth key crosses no command line, only its ciphertext for the VM's key", async () => {
  const { exe, vm } = simulate();
  await createExeDevBootstrap(options(exe)).joinTailnet(VM);
  const sent = commands(exe);
  expect(sent.filter((command) => command.includes(AUTHKEY))).toEqual([]);
  expect(sent.filter((command) => command.includes("tskey-"))).toEqual([]);
  const encrypted = sent.filter((command) => JOIN.test(command));
  expect(encrypted).toHaveLength(1);
  expect(vm.joins).toEqual([AUTHKEY]);
});

test("the auth key file is removed after the join, whether it succeeded or failed", async () => {
  const ok = simulate();
  await createExeDevBootstrap(options(ok.exe)).joinTailnet(VM);
  expect(ok.vm.joins).toHaveLength(1);
  expect(ok.vm.authFile).toBe(false);

  const failed = simulate({ upExit: 1 });
  const error = await bootstrapError(createExeDevBootstrap(options(failed.exe)).joinTailnet(VM));
  expect(failed.vm.joins).toHaveLength(1);
  expect(failed.vm.authFile).toBe(false);
  expect(error.step).toBe("tailnet");
  expect(error.message).toContain("tailnet: tailscale up failed (exit 1)");
  // tailscale echoing the key back does not put it in the failure.
  expect(error.message).not.toContain(AUTHKEY);
  expect(error.message).toContain("[redacted]");
});

test("without an auth key the step is skipped and nothing runs on the VM", async () => {
  const { exe } = simulate();
  expect(await createExeDevBootstrap(options(exe, () => null)).joinTailnet(VM)).toBe("skipped");
  const { tailnet: _, ...publicPaws } = options(exe);
  expect(await createExeDevBootstrap(publicPaws).joinTailnet(VM)).toBe("skipped");
  expect(exe.calls).toEqual([]);
});

test("a re-run on a joined VM only checks that it still reaches Paws", async () => {
  const { exe, vm } = simulate();
  const bootstrap = createExeDevBootstrap(options(exe));
  expect(await bootstrap.joinTailnet(VM)).toBe("joined");
  const before = commands(exe).length;
  expect(await bootstrap.joinTailnet(VM)).toBe("member");
  const again = commands(exe).slice(before);
  expect(again).toHaveLength(2);
  expect(again[0]).toContain("tailscale version");
  expect(again[1]).toContain("/health'");
  expect(vm.joins).toHaveLength(1);
});

test("a VM that cannot reach Paws after the join is a clear tailnet failure", async () => {
  const { exe } = simulate({ reachExit: 2 });
  const error = await bootstrapError(createExeDevBootstrap(options(exe)).joinTailnet(VM));
  expect(error.step).toBe("tailnet");
  expect(error.message).toBe(
    "ada-paws: tailnet: the VM cannot reach this Paws (exit 2): cannot resolve agentbox.taile07e4.ts.net",
  );
});

test("an auth key that is not a Tailscale key is refused before any command", async () => {
  for (const key of ["not-a-key", `${AUTHKEY}'; reboot`, `${AUTHKEY}\n`]) {
    const { exe } = simulate();
    const error = await bootstrapError(
      createExeDevBootstrap(options(exe, () => key)).joinTailnet(VM),
    );
    expect(error.step).toBe("tailnet");
    expect(error.message).toContain("~/.paws/secrets/tailscale-authkey");
    expect(error.message).not.toContain(key);
    expect(exe.calls).toEqual([]);
  }
});

test("a private Paws CA is trusted by the reach check rather than skipped", async () => {
  const { exe } = simulate();
  const ca = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
  await createExeDevBootstrap({ ...options(exe), serverCa: ca }).joinTailnet(VM);
  const reach = commands(exe).at(-1)!;
  expect(reach).toContain('--cacert "$ca"');
  expect(reach).not.toContain("--insecure");
});
