import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runnerVerifierFingerprint, verifyRunnerCheckResult } from "../../src/runner-verifier";

const repository = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "paws-check-runtime-verification-"));
const base = process.env.PAWS_BROKER_VM_BASE;
const expectedDigest = process.env.PAWS_BROKER_VM_SHA512;
if (!base || !expectedDigest || !/^[a-f0-9]{128}$/.test(expectedDigest))
  throw new Error("Set PAWS_BROKER_VM_BASE and its trusted PAWS_BROKER_VM_SHA512");
const files = [
  "check-broker.py",
  "check-child.py",
  "check-status.py",
  "check-metadata.py",
  "check-witness.py",
  "check-verifier.py",
  "paws-check@.service",
  "paws-check-witness@.service",
  "paws-agent@.service",
  "paws-runner-broker.service",
  "paws-runner-broker.socket",
  "paws-runner.sysusers",
  "paws-runner.tmpfiles",
];
const digest = (path: string, algorithm = "sha256") =>
  createHash(algorithm).update(readFileSync(path)).digest("hex");
if (digest(base, "sha512") !== expectedDigest) throw new Error("VM base digest mismatch");
const hashes = Object.fromEntries(
  files.map((name) => [name, digest(join(repository, "deploy/linux", name))]),
);
const probe = join(repository, "test/local/runner-check-runtime-proof.py");
const probeHash = digest(probe);
const sourcePaths = Bun.spawnSync(
  ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: repository },
)
  .stdout.toString()
  .split("\0")
  .filter(Boolean);
const sourceHashes = Object.fromEntries(
  sourcePaths.map((path) => [path, digest(join(repository, path))]),
);
const env = { HOME: root, PATH: process.env.PATH! };
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
const gitArtifacts = process.env.PAWS_CHECK_VM_GIT_ARTIFACTS;
if (!gitArtifacts)
  throw new Error("Select offline Git prerequisite files with PAWS_CHECK_VM_GIT_ARTIFACTS");
const prerequisites = [
  ["git", "/usr/bin/git", "0755"],
  ["libpcre2-8.so.0", "/lib/x86_64-linux-gnu/libpcre2-8.so.0", "0644"],
  ["libz.so.1", "/lib/x86_64-linux-gnu/libz.so.1", "0644"],
];
const prerequisiteHashes = Object.fromEntries(
  prerequisites.map(([name]) => [name!, digest(join(gitArtifacts, name!))]),
);
for (const [name] of prerequisites)
  writeFileSync(join(seed, name!), readFileSync(join(gitArtifacts, name!)));
await run(
  [
    process.execPath,
    "--no-env-file",
    "build",
    "--target=bun",
    join(repository, "test/local/runner-check-runtime-process.ts"),
    "--outfile",
    join(seed, "runtime-proof.js"),
  ],
  "bundle",
);
writeFileSync(
  join(seed, "process-anchor.ts"),
  readFileSync(join(repository, "src/process/process-anchor.ts")),
);
writeFileSync(join(seed, "bun"), readFileSync(process.execPath));
const cloud = {
  write_files: [
    ...files.map((name) => ({
      path: `/opt/paws-runner/current/deploy/linux/${name}`,
      permissions: "0644",
      content: readFileSync(join(repository, "deploy/linux", name), "utf8"),
    })),
    {
      path: "/root/paws-check-runtime-proof.py",
      permissions: "0600",
      content: readFileSync(probe, "utf8"),
    },
  ],
  runcmd: [
    ["/usr/bin/mkdir", "-p", "/mnt/paws-proof"],
    ["/usr/bin/mount", "-o", "ro", "-L", "cidata", "/mnt/paws-proof"],
    ...prerequisites.map(([name, path, mode]) => [
      "/usr/bin/install",
      "-m",
      mode!,
      `/mnt/paws-proof/${name}`,
      path!,
    ]),
    ["/usr/bin/mkdir", "-p", "/opt/paws-runner/bin"],
    ["/usr/bin/install", "-m", "0755", "/mnt/paws-proof/bun", "/opt/paws-runner/bin/bun"],
    [
      "/usr/bin/install",
      "-m",
      "0644",
      "/mnt/paws-proof/runtime-proof.js",
      "/opt/paws-runner/runtime-proof.js",
    ],
    [
      "/usr/bin/install",
      "-m",
      "0644",
      "/mnt/paws-proof/process-anchor.ts",
      "/opt/paws-runner/process-anchor.ts",
    ],
    ["/usr/bin/python3", "-I", "-B", "/root/paws-check-runtime-proof.py"],
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
    ...prerequisites.map(([name]) => join(seed, name!)),
    join(seed, "bun"),
    join(seed, "process-anchor.ts"),
    join(seed, "runtime-proof.js"),
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
    "1536",
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
const marker = "PAWS_CHECK_RUNTIME_PROOF ";
const line = readFileSync(join(root, "serial.log"), "utf8")
  .split(/\r?\n/)
  .find((entry) => entry.includes(marker));
if (!line) throw new Error(`No completed runner broker proof; evidence ${root}`);
const observations = JSON.parse(line.slice(line.indexOf(marker) + marker.length));
if (
  observations.passed !== true ||
  observations.received !== 2 ||
  observations.duplicates !== 1 ||
  observations.commands.length !== 4
)
  throw new Error("Incomplete runner broker proof");
if (
  runnerVerifierFingerprint(observations.identity.verifierPublicKeyPem) !==
  observations.identity.fingerprint
)
  throw new Error("VM signing identity differs from its public fingerprint");
for (const { result, signature } of observations.receipts) {
  if (!verifyRunnerCheckResult(result, signature, observations.identity.verifierPublicKeyPem))
    throw new Error("Invalid root witness signature");
  if (result.candidateSha.length !== 40 || result.inputSha256.length !== 64)
    throw new Error("Incomplete signed result bindings");
}
for (const name of files)
  if (digest(join(repository, "deploy/linux", name)) !== hashes[name])
    throw new Error("VM source changed during proof");
if (digest(probe) !== probeHash) throw new Error("VM proof source changed during execution");
for (const [path, hash] of Object.entries(sourceHashes))
  if (digest(join(repository, path)) !== hash)
    throw new Error("Proof source changed during execution");
writeFileSync(
  join(root, "observations.json"),
  JSON.stringify(
    {
      ...observations,
      sourceHashes,
      baseSha512: expectedDigest,
      probeSha256: probeHash,
      qemu: (await run(["qemu-system-x86_64", "--version"], "qemu-version")).split("\n")[0],
      network: "none",
      prerequisiteHashes,
    },
    null,
    2,
  ),
);
console.log(
  `VERIFIED trusted check runtime, signed mTLS receipts, restart and PID1 lease teardown; evidence ${root}`,
);
