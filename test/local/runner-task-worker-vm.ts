import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "paws-task-worker-vm-"));
const base = process.env.PAWS_BROKER_VM_BASE;
const expected = process.env.PAWS_BROKER_VM_SHA512;
const hash = (path: string, algorithm = "sha256") =>
  createHash(algorithm).update(readFileSync(path)).digest("hex");
if (!base || !expected || hash(base, "sha512") !== expected)
  throw new Error("Select a standalone trusted PAWS_BROKER_VM_BASE and PAWS_BROKER_VM_SHA512");
const env = { HOME: root, PATH: "/usr/bin:/bin" };
async function run(args: string[], name: string) {
  const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [out, error, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  writeFileSync(join(root, name + ".log"), out + error);
  if (exit !== 0) throw new Error(`${name} failed (${exit}); evidence ${root}`);
  return out;
}
console.log(`Evidence ${root}`);
const info = JSON.parse(await run(["qemu-img", "info", "--output=json", base], "base-info"));
if (info.format !== "qcow2" || info["backing-filename"])
  throw new Error("VM base must be standalone qcow2");
const seed = join(root, "seed");
mkdirSync(seed);
const binaries = [
  ["test/local/runner-task-worker-entry.ts", "entry.js"],
  ["src/acp/testing/fake-agent.ts", "fake-agent.js"],
  ["src/acp/ask-team-mcp.ts", "ask-team-mcp.ts"],
  ["src/process/process-anchor.ts", "process-anchor.ts"],
] as const;
for (const [entry, output] of binaries) {
  const built = await Bun.build({ entrypoints: [join(repository, entry)], target: "bun" });
  if (!built.success) throw new Error(String(built.logs));
  await Bun.write(join(seed, output), built.outputs[0]!);
}
copyFileSync(process.execPath, join(seed, "bun"));
copyFileSync(join(repository, "package.json"), join(seed, "package.json"));
const assets = [
  "runner-broker.py",
  "paws-agent@.service",
  "paws-runner-broker.service",
  "paws-runner-broker.socket",
  "paws-runner.sysusers",
  "paws-runner.tmpfiles",
];
const proof = join(repository, "test/local/runner-task-worker-vm.py");
const cloud = {
  write_files: [
    ...assets.map((name) => ({
      path: `/opt/paws-runner/current/deploy/linux/${name}`,
      permissions: "0644",
      content: readFileSync(join(repository, "deploy/linux", name), "utf8"),
    })),
    { path: "/root/proof.py", permissions: "0600", content: readFileSync(proof, "utf8") },
  ],
  runcmd: [
    [
      "/usr/bin/mkdir",
      "-p",
      "/mnt/paws-proof",
      "/opt/paws-runner/bin",
      "/opt/paws-runner/current/src",
    ],
    ["/usr/bin/mount", "-o", "ro", "-L", "cidata", "/mnt/paws-proof"],
    ...[
      ["bun", "/opt/paws-runner/bin/bun", "0755"],
      ["entry.js", "/opt/paws-runner/current/src/index.ts", "0644"],
      ["fake-agent.js", "/opt/paws-runner/current/fake-agent.js", "0644"],
      ["ask-team-mcp.ts", "/opt/paws-runner/current/src/ask-team-mcp.ts", "0644"],
      ["package.json", "/opt/paws-runner/current/package.json", "0644"],
      ["process-anchor.ts", "/opt/paws-runner/current/src/process-anchor.ts", "0644"],
    ].map(([file, target, mode]) => [
      "/usr/bin/install",
      "-m",
      mode!,
      `/mnt/paws-proof/${file}`,
      target!,
    ]),
    ["/usr/bin/python3", "-I", "-B", "/root/proof.py"],
    ["/usr/bin/systemctl", "poweroff"],
  ],
  output: { all: "| tee -a /var/log/cloud-init-output.log /dev/ttyS0" },
  ssh_deletekeys: true,
};
writeFileSync(join(seed, "user-data"), "#cloud-config\n" + JSON.stringify(cloud));
writeFileSync(
  join(seed, "meta-data"),
  JSON.stringify({
    "instance-id": "paws-task-worker-" + randomUUID(),
    "local-hostname": "paws-task-worker",
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
  "create",
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
    join(seed, "bun"),
    join(seed, "package.json"),
    ...binaries.map(([, output]) => join(seed, output)),
  ],
  "seed",
);
const listed = Bun.spawnSync(
  ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: repository, env },
);
if (listed.exitCode !== 0) throw new Error("Source snapshot failed");
const hashes = Object.fromEntries(
  listed.stdout
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((path) => [path, hash(join(repository, path))]),
);
const args = [
  "timeout",
  "-k",
  "5s",
  "480s",
  "qemu-system-x86_64",
  "-accel",
  "tcg,thread=multi",
  "-cpu",
  "max",
  "-m",
  "1024",
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
];
writeFileSync(
  join(root, "input.json"),
  JSON.stringify(
    {
      base,
      baseSha512: expected,
      command: args,
      hashes,
      bunSha256: hash(process.execPath),
      compiledHashes: Object.fromEntries(
        binaries.map(([, output]) => [output, hash(join(seed, output))]),
      ),
    },
    null,
    2,
  ),
);
await run(args, "qemu");
const marker = "PAWS_TASK_WORKER_VM_PROOF ";
const line = readFileSync(join(root, "serial.log"), "utf8")
  .split("\n")
  .find((entry) => entry.includes(marker));
if (!line) throw new Error(`VM proof did not complete; evidence ${root}`);
const observations = JSON.parse(line.slice(line.indexOf(marker) + marker.length));
for (const [path, digest] of Object.entries(hashes))
  if (hash(join(repository, path)) !== digest) throw new Error(`Source changed: ${path}`);
writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2) + "\n");
console.log(JSON.stringify(observations));
