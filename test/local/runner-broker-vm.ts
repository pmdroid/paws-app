import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repository = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "paws-broker-vm-verification-"));
const base = process.env.PAWS_BROKER_VM_BASE;
const expectedDigest = process.env.PAWS_BROKER_VM_SHA512;
if (!base || !expectedDigest || !/^[a-f0-9]{128}$/.test(expectedDigest))
  throw new Error("Set PAWS_BROKER_VM_BASE and its trusted PAWS_BROKER_VM_SHA512");
const files = ["paws-runner.service", "paws-runner.sysusers", "paws-runner.tmpfiles"];
const digest = (path: string, algorithm = "sha256") =>
  createHash(algorithm).update(readFileSync(path)).digest("hex");
if (digest(base, "sha512") !== expectedDigest) throw new Error("VM base digest mismatch");
const hashes = Object.fromEntries(
  files.map((name) => [name, digest(join(repository, "deploy/linux", name))]),
);
const probe = join(repository, "test/local/runner-daemon-service-vm.py");
const probeHash = digest(probe);
const env = { HOME: root, PATH: "/usr/bin:/bin" };
async function run(args: string[], name: string) {
  const process = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  writeFileSync(join(root, `${name}.log`), stdout + stderr);
  if (exit !== 0) throw new Error(`${name} failed (${exit}); evidence ${root}`);
  return stdout;
}
console.log(`Evidence ${root}`);
const info = JSON.parse(await run(["qemu-img", "info", "--output=json", base], "base-info"));
if (info.format !== "qcow2" || info["backing-filename"])
  throw new Error("Use a standalone qcow2 VM base");
const seed = join(root, "seed");
mkdirSync(seed, { mode: 0o700 });
const cloud = {
  write_files: [
    ...files.map((name) => ({
      path: `/opt/paws-runner/current/deploy/linux/${name}`,
      permissions: "0644",
      content: readFileSync(join(repository, "deploy/linux", name), "utf8"),
    })),
    {
      path: "/root/paws-broker-vm-proof.py",
      permissions: "0600",
      content: readFileSync(probe, "utf8"),
    },
  ],
  runcmd: [
    ["/usr/bin/python3", "-I", "-B", "/root/paws-broker-vm-proof.py"],
    ["/usr/bin/systemctl", "poweroff"],
  ],
  output: { all: "| tee -a /var/log/cloud-init-output.log /dev/ttyS0" },
  ssh_deletekeys: true,
};
const boundary = randomUUID();
writeFileSync(
  join(seed, "user-data"),
  `Content-Type: multipart/mixed; boundary="${boundary}"\nMIME-Version: 1.0\n\n--${boundary}\nContent-Type: text/cloud-config; charset="utf-8"\n\n${JSON.stringify(cloud)}\n--${boundary}--\n`,
);
writeFileSync(
  join(seed, "meta-data"),
  JSON.stringify({
    "instance-id": `paws-broker-${boundary}`,
    "local-hostname": "paws-broker-vm-proof",
  }),
);
await run(
  [
    "qemu-img",
    "create",
    "-f",
    "qcow2",
    "-F",
    "qcow2",
    "-b",
    resolve(base),
    join(root, "disk.qcow2"),
  ],
  "create-disk",
);
await run(
  [
    "genisoimage",
    "-quiet",
    "-output",
    join(root, "seed.iso"),
    "-volid",
    "cidata",
    "-joliet",
    "-rock",
    join(seed, "user-data"),
    join(seed, "meta-data"),
  ],
  "seed-iso",
);
await run(
  [
    "timeout",
    "-k",
    "5s",
    "600s",
    "qemu-system-x86_64",
    "-accel",
    "tcg,thread=multi",
    "-cpu",
    "max",
    "-m",
    "768",
    "-smp",
    "2",
    "-display",
    "none",
    "-serial",
    `file:${join(root, "serial.log")}`,
    "-monitor",
    "none",
    "-nic",
    "none",
    "-no-reboot",
    "-drive",
    `file=${join(root, "disk.qcow2")},if=virtio,format=qcow2`,
    "-drive",
    `file=${join(root, "seed.iso")},media=cdrom,readonly=on`,
  ],
  "qemu",
);
const marker = "PAWS_DAEMON_SERVICE_PROOF ";
const line = readFileSync(join(root, "serial.log"), "utf8")
  .split(/\r?\n/)
  .find((entry) => entry.includes(marker));
if (!line) throw new Error(`No completed runner broker proof; evidence ${root}`);
const observations = JSON.parse(line.slice(line.indexOf(marker) + marker.length));
if (observations.passed !== true || observations.observations.length !== 4)
  throw new Error("Incomplete runner broker proof");
for (const name of files)
  if (
    digest(join(repository, "deploy/linux", name)) !== hashes[name] ||
    observations.sourceHashes[name] !== hashes[name]
  )
    throw new Error("VM source does not match the reviewed asset");
if (digest(probe) !== probeHash) throw new Error("VM proof source changed during execution");
writeFileSync(
  join(root, "observations.json"),
  JSON.stringify(
    {
      ...observations,
      baseSha512: expectedDigest,
      probeSha256: probeHash,
      qemu: (await run(["qemu-system-x86_64", "--version"], "qemu-version")).split("\n")[0],
      network: "none",
    },
    null,
    2,
  ),
);
console.log(`VERIFIED daemon service shutdown, restart and crash exit policy; evidence ${root}`);
