import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExeDevBootstrap } from "./index";
import type { ExeDev, MiseRelease } from "./index";

const ORIGIN = "https://paws.example.invalid";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MISE_VERSION = "2026.10.15";
const FAKE_MISE = `#!/bin/sh\necho "${MISE_VERSION} linux-x64 (2026-10-19)"\n`;
const BOOTSTRAP = {
  runnerVersion: "1.2.3",
  installer: '#!/bin/sh\necho installed-runner "$1"\n',
  controlPlaneUrl: ORIGIN,
  runnerApiUrl: "https://paws.example.invalid:8788",
  mise: {
    version: MISE_VERSION,
    sha256: { amd64: createHash("sha256").update(FAKE_MISE).digest("hex") },
  },
};

function guestShell(root: string, state: { active: string; sub: string }) {
  const stubs = join(root, "stubs");
  mkdirSync(stubs, { recursive: true });
  const write = (name: string, body: string) => {
    writeFileSync(join(stubs, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(stubs, name), 0o755);
  };
  write(
    "systemctl",
    `echo "systemctl $*" >> "$STUB_LOG"
if [ "$1" = show ]; then
  case "$3" in ActiveState) echo "$STUB_ACTIVE";; SubState) echo "$STUB_SUB";; *) echo;; esac
fi`,
  );
  write(
    "sudo",
    `echo "sudo $*" >> "$STUB_LOG"
case "$1" in
  tee) mkdir -p "$STUB_FILES"; cat > "$STUB_FILES/$(basename "$2")";;
  systemctl) shift; exec systemctl "$@";;
esac`,
  );
  const run = (command: string) =>
    Bun.spawnSync(["/usr/bin/bash", "-c", command], {
      env: {
        PATH: `${stubs}:/usr/bin:/bin`,
        STUB_LOG: join(root, "log"),
        STUB_FILES: join(root, "files"),
        STUB_ACTIVE: state.active,
        STUB_SUB: state.sub,
      },
    });
  const log = () => {
    try {
      return readFileSync(join(root, "log"), "utf8");
    } catch {
      return "";
    }
  };
  return { run, log, files: join(root, "files") };
}

test("install start never interrupts an active installer and completion requires installer and mise verification", async () => {
  const commands: string[] = [];
  const outputs: { stdout: string; exitCode: number }[] = [];
  const exeDev: ExeDev = {
    listVms: async () => [],
    createVm: () => Promise.reject(new Error("No creation")),
    async execVm(input) {
      commands.push(input.command);
      return { stderr: "", ...(outputs.shift() ?? { stdout: "", exitCode: 0 }) };
    },
  };
  const bootstrap = createExeDevBootstrap({ ...BOOTSTRAP, exeDev });
  await bootstrap.startInstall("paws-vm");
  const start = commands[0]!;
  expect(start.startsWith(": paws-install-start")).toBe(true);
  expect(start).not.toMatch(/Bearer|ghu_|ghs_|token|git clone|mise install|mise trust/i);
  const root = mkdtempSync(join(tmpdir(), "paws-guest-shell-"));
  roots.push(root);
  for (const [active, sub] of [
    ["active", "running"],
    ["activating", "start"],
    ["deactivating", "stop-sigterm"],
  ] as const) {
    const shell = guestShell(join(root, `${active}-${sub}`), { active, sub });
    expect(shell.run(start).exitCode).toBe(0);
    expect(shell.log()).not.toMatch(/systemctl stop|systemd-run|tee/);
  }
  const failed = guestShell(join(root, "failed"), { active: "failed", sub: "failed" });
  expect(failed.run(start).exitCode).toBe(0);
  expect(failed.log()).not.toContain("systemctl stop");
  expect(failed.log()).toContain("sudo systemctl reset-failed paws-provision-install.service");
  expect(failed.log()).toContain(
    "sudo systemd-run --quiet --unit=paws-provision-install.service --remain-after-exit --property=Type=exec /bin/sh /var/lib/paws-provision/provision.sh",
  );
  const finished = guestShell(join(root, "finished"), { active: "active", sub: "exited" });
  expect(finished.run(start).exitCode).toBe(0);
  expect(finished.log()).toContain("sudo systemctl stop paws-provision-install.service");
  expect(JSON.parse(readFileSync(join(failed.files, "config.json"), "utf8"))).toEqual({
    controlPlaneUrl: ORIGIN,
    runnerApiUrl: "https://paws.example.invalid:8788",
    allowedRepositories: [],
    repositoryPolicy: "/etc/paws-runner/repository-policy.json",
  });
  const status = (lines: string[]) => {
    outputs.push({ stdout: `${lines.join("\n")}\n`, exitCode: 0 });
    return bootstrap.installStatus("paws-vm");
  };
  const complete = [
    "active",
    "exited",
    "success",
    "1.2.3",
    "configured",
    MISE_VERSION,
    MISE_VERSION,
  ];
  expect(await status(["active", "running", "", "none", "missing", "", ""])).toBe("running");
  expect(await status(["activating", "start", "", "none", "missing", "", ""])).toBe("running");
  expect(await status(complete)).toBe("succeeded");
  for (const index of [2, 3, 4, 5, 6]) {
    const broken = [...complete];
    broken[index] = index === 5 || index === 6 ? "" : "other";
    expect(await status(broken)).toBe("failed");
  }
  expect(await status(["failed", "failed", "exit-code", "none", "missing", "", ""])).toBe("failed");
  const check = commands.at(-1)!;
  expect(check).toContain(
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C /bin/sh -c 'cd / && command -v mise >/dev/null && mise --version'",
  );
  expect(check).toContain(
    "sudo runuser --user paws-agent -- env -i HOME=/var/lib/paws-agent PATH=/opt/paws-runner/bin:/usr/local/bin:/usr/bin:/bin",
  );
});

test("the guest provisioning script installs only the pinned, checksum-verified mise visible to the runner service and agent tasks", async () => {
  const commands: string[] = [];
  const exeDev: ExeDev = {
    listVms: async () => [],
    createVm: () => Promise.reject(new Error("No creation")),
    async execVm(input) {
      commands.push(input.command);
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
  const root = mkdtempSync(join(tmpdir(), "paws-guest-mise-"));
  roots.push(root);
  const provision = async (name: string, release: string, mise: MiseRelease) => {
    commands.length = 0;
    await createExeDevBootstrap({ ...BOOTSTRAP, mise, exeDev }).startInstall("paws-vm");
    const shell = guestShell(join(root, name), { active: "inactive", sub: "dead" });
    expect(shell.run(commands[0]!).exitCode).toBe(0);
    const base = join(root, name);
    const bin = join(base, "usr-local-bin");
    const etc = join(base, "etc");
    const stubs = join(base, "stubs");
    mkdirSync(bin, { recursive: true });
    mkdirSync(etc, { recursive: true });
    writeFileSync(join(base, "release"), release);
    const stub = (file: string, body: string) => {
      writeFileSync(join(stubs, file), `#!/bin/bash\n${body}\n`);
      chmodSync(join(stubs, file), 0o755);
    };
    stub("dpkg", 'echo "dpkg $*" >> "$STUB_LOG"; echo amd64');
    stub(
      "curl",
      `echo "curl $*" >> "$STUB_LOG"
while [ $# -gt 0 ]; do if [ "$1" = -o ]; then out=$2; fi; shift; done
cp "$STUB_RELEASE" "$out"`,
    );
    stub(
      "install",
      `echo "install $*" >> "$STUB_LOG"
args=(); while [ $# -gt 0 ]; do case "$1" in -o|-g|-m) shift 2;; *) args+=("$1"); shift;; esac; done
cp "\${args[0]}" "\${args[1]}"; chmod 755 "\${args[1]}"`,
    );
    stub(
      "systemd-run",
      `echo "systemd-run $*" >> "$STUB_LOG"
while [ $# -gt 0 ] && [ "$1" != /bin/sh ]; do shift; done
exec env -i PATH="$STUB_SERVICE_PATH" "$@"`,
    );
    stub(
      "runuser",
      `echo "runuser $*" >> "$STUB_LOG"
while [ $# -gt 0 ] && [ "$1" != -- ]; do shift; done; shift
exec "$@"`,
    );
    const script = readFileSync(join(shell.files, "provision.sh"), "utf8")
      .replaceAll("/usr/local/bin", bin)
      .replaceAll("/var/lib/paws-provision", shell.files)
      .replaceAll("/etc/paws-runner", etc);
    writeFileSync(join(base, "provision.sh"), script);
    const result = Bun.spawnSync(["/usr/bin/bash", join(base, "provision.sh")], {
      env: {
        PATH: `${stubs}:/usr/bin:/bin`,
        STUB_LOG: join(base, "provision.log"),
        STUB_RELEASE: join(base, "release"),
        STUB_SERVICE_PATH: `/usr/local/sbin:${bin}:/usr/sbin:/usr/bin:/sbin:/bin`,
      },
    });
    return {
      script: readFileSync(join(shell.files, "provision.sh"), "utf8"),
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
      installed: existsSync(join(bin, "mise")),
      log: readFileSync(join(base, "provision.log"), "utf8"),
    };
  };
  const good = await provision("good", FAKE_MISE, BOOTSTRAP.mise);
  expect(good.stderr).toBe("");
  expect(good.exitCode).toBe(0);
  expect(good.installed).toBe(true);
  expect(good.log).toContain(`curl --proto =https --tlsv1.2 -fsSL --retry 3 --retry-delay 1 -o`);
  expect(good.log).toContain(
    `https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64`,
  );
  expect(good.log).toMatch(
    /systemd-run --quiet --wait --pipe --collect --property=User=paws-runner/,
  );
  expect(good.log).toMatch(/runuser --user paws-agent -- env -i HOME=\/var\/lib\/paws-agent PATH=/);
  expect(good.script.indexOf("install-runner.sh")).toBeLessThan(good.script.indexOf("mise"));
  expect(good.script).not.toMatch(/mise (install|trust|use|exec|activate)/);
  const tampered = await provision("tampered", `${FAKE_MISE}echo tampered\n`, BOOTSTRAP.mise);
  expect(tampered.exitCode).not.toBe(0);
  expect(tampered.installed).toBe(false);
  const wrongVersion = FAKE_MISE.replace(MISE_VERSION, "2026.9.1");
  const mismatched = await provision("version", wrongVersion, {
    version: MISE_VERSION,
    sha256: { amd64: createHash("sha256").update(wrongVersion).digest("hex") },
  });
  expect(mismatched.exitCode).not.toBe(0);
  expect(mismatched.stderr).toContain("Installed mise version does not match the pin");
  const unpinned = await provision("unpinned", FAKE_MISE, {
    version: MISE_VERSION,
    sha256: { arm64: "b".repeat(64) },
  });
  expect(unpinned.exitCode).not.toBe(0);
  expect(unpinned.stderr).toContain("No pinned mise checksum for amd64");
  expect(unpinned.installed).toBe(false);
  for (const mise of [
    { version: "latest", sha256: { amd64: "a".repeat(64) } },
    { version: MISE_VERSION, sha256: {} },
    { version: MISE_VERSION, sha256: { amd64: "not-a-hash" } },
  ])
    expect(() => createExeDevBootstrap({ ...BOOTSTRAP, mise, exeDev })).toThrow();
  expect(() => createExeDevBootstrap({ ...BOOTSTRAP, runnerVersion: "latest", exeDev })).toThrow();
  expect(() =>
    createExeDevBootstrap({ ...BOOTSTRAP, controlPlaneUrl: "http://paws.example.invalid", exeDev }),
  ).toThrow();
});

test("guest pairing completion requires the guest's own persisted paired identity", async () => {
  const outputs: { stdout: string; exitCode: number }[] = [];
  const exeDev: ExeDev = {
    listVms: async () => [],
    createVm: () => Promise.reject(new Error("No creation")),
    async execVm() {
      return { stderr: "", ...(outputs.shift() ?? { stdout: "", exitCode: 0 }) };
    },
  };
  const bootstrap = createExeDevBootstrap({ ...BOOTSTRAP, exeDev });
  const pending = JSON.stringify({
    phase: "pending",
    id: "x",
    code: "0123456789ABCDEF",
    requestFingerprint: "a".repeat(64),
    expiresAt: Date.now() + 60_000,
  });
  const { code, requestFingerprint, expiresAt } = JSON.parse(pending) as {
    code: string;
    requestFingerprint: string;
    expiresAt: number;
  };
  outputs.push({ stdout: `${pending}\n`, exitCode: 124 });
  expect(await bootstrap.completePairing("paws-vm")).toEqual({
    phase: "pending",
    challenge: { code, requestFingerprint, expiresAt },
  });
  outputs.push({ stdout: "", exitCode: 124 });
  expect(await bootstrap.completePairing("paws-vm")).toEqual({ phase: "pending" });
  outputs.push({
    stdout: `${pending}\n${JSON.stringify({ paired: true, runnerId: "01J00000000000000000000000", workspaceId: "workspace" })}\n`,
    exitCode: 0,
  });
  expect(await bootstrap.completePairing("paws-vm")).toEqual({
    phase: "paired",
    runnerId: "01J00000000000000000000000",
  });
  outputs.push({ stdout: `${pending}\n`, exitCode: 0 });
  await expect(bootstrap.completePairing("paws-vm")).rejects.toThrow();
  outputs.push({ stdout: "", exitCode: 1 });
  await expect(bootstrap.completePairing("paws-vm")).rejects.toThrow();
  outputs.push({ stdout: `${pending}\n`, exitCode: 124 });
  expect((await bootstrap.requestPairing("paws-vm")).code).toBe("0123456789ABCDEF");
  outputs.push({ stdout: "not json", exitCode: 0 });
  await expect(bootstrap.requestPairing("paws-vm")).rejects.toThrow();
});
