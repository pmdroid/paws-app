import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repository = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "paws-task-runtime-verification-"));
const base = process.env.PAWS_BROKER_VM_BASE;
const expectedDigest = process.env.PAWS_BROKER_VM_SHA512;
if (!base || !expectedDigest || !/^[a-f0-9]{128}$/.test(expectedDigest))
  throw new Error("Set PAWS_BROKER_VM_BASE and its trusted PAWS_BROKER_VM_SHA512");
const files = [
  "runner-broker.py",
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
const probe = join(repository, "test/local/runner-task-runtime-vm.py");
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
const binaries = [
  ["test/local/runner-task-runtime-entry.ts", "runtime-proof.js"],
  ["src/acp/testing/fake-agent.ts", "fake-agent.js"],
  ["src/acp/ask-team-mcp.ts", "ask-team-mcp.ts"],
  ["src/process/process-anchor.ts", "process-anchor.ts"],
] as const;
for (const [entry, output] of binaries) {
  const built = await Bun.build({ entrypoints: [join(repository, entry)], target: "bun" });
  if (!built.success) throw new Error(String(built.logs));
  await Bun.write(join(seed, output), built.outputs[0]!);
}
writeFileSync(join(seed, "package.json"), readFileSync(join(repository, "package.json")));
writeFileSync(join(seed, "bun"), readFileSync(process.execPath));
const cloud = {
  write_files: [
    ...files.map((name) => ({
      path: `/opt/paws-runner/current/deploy/linux/${name}`,
      permissions: "0644",
      content: readFileSync(join(repository, "deploy/linux", name), "utf8"),
    })),
    {
      path: "/root/paws-task-runtime-proof.py",
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
    ["/usr/bin/ln", "-s", "git", "/usr/bin/git-upload-pack"],
    ["/usr/bin/mkdir", "-p", "/opt/paws-runner/bin"],
    ["/usr/bin/install", "-m", "0755", "/mnt/paws-proof/bun", "/opt/paws-runner/bin/bun"],
    ["/usr/bin/mkdir", "-p", "/opt/paws-runner/current/src"],
    ...[
      ["runtime-proof.js", "/opt/paws-runner/current/src/index.ts"],
      ["fake-agent.js", "/opt/paws-runner/current/fake-agent.js"],
      ["ask-team-mcp.ts", "/opt/paws-runner/current/src/ask-team-mcp.ts"],
      ["process-anchor.ts", "/opt/paws-runner/current/src/process-anchor.ts"],
      ["package.json", "/opt/paws-runner/current/package.json"],
    ].map(([source, destination]) => [
      "/usr/bin/install",
      "-m",
      "0644",
      "/mnt/paws-proof/" + source,
      destination!,
    ]),
    ["/usr/bin/python3", "-I", "-B", "/root/paws-task-runtime-proof.py"],
    ["/usr/bin/systemctl", "poweroff"],
  ],
  output: { all: "| tee -a /var/log/cloud-init-output.log /dev/ttyS0" },
  ssh_deletekeys: true,
};
const boundary = randomUUID();
writeFileSync(join(seed, "user-data"), "#cloud-config\n" + JSON.stringify(cloud));
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
    join(seed, "package.json"),
    ...binaries.map(([, output]) => join(seed, output)),
  ],
  "seed-iso",
);
await run(
  [
    "timeout",
    "-k",
    "5s",
    "600s",
    ..."qemu-system-x86_64 -accel tcg,thread=multi -cpu max -m 1536 -smp 2 -display none".split(
      " ",
    ),
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
const marker = "PAWS_TASK_RUNTIME_VM_PROOF ";
const line = readFileSync(join(root, "serial.log"), "utf8")
  .split(/\r?\n/)
  .find((entry) => entry.includes(marker));
if (!line) throw new Error(`No completed runner broker proof; evidence ${root}`);
const observations = JSON.parse(line.slice(line.indexOf(marker) + marker.length));
if (
  observations.passed !== true ||
  observations.taskResults !== 4 ||
  observations.sealedTranscripts !== 4 ||
  observations.relaunches !== 0
)
  throw new Error("Incomplete task runtime proof");
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
  `VERIFIED task runtime, pinned readonly repositories, mTLS delivery and PID1 workers; evidence ${root}`,
);
