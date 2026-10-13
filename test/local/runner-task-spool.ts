import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "paws-task-spool-verification-"));
const files = [
  "src/runner-execution/jobs.ts",
  "src/runner-execution/spool.ts",
  "src/runner-execution/index.ts",
  "src/runner-protocol/commands.ts",
  "test/local/runner-short-reads.ts",
  "test/local/runner-task-spool.ts",
  "test/local/runner-task-spool-process.ts",
  "test/local/runner-task-spool-proof.py",
  ".agents/skills/verify-paws/SKILL.md",
  "package.json",
  "bun.lock",
];
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sourceHashes = Object.fromEntries(files.map((name) => [name, hash(join(repository, name))]));
const image = process.env.PAWS_TASK_SPOOL_PROOF_IMAGE ?? "python:3.14-slim";
const env = {
  PATH: "/usr/bin:/bin",
  HOME: root,
  DOCKER_CONFIG: join(root, "docker-config"),
  DOCKER_HOST:
    process.env.PAWS_TASK_SPOOL_DOCKER_HOST ?? `unix:///run/user/${process.getuid!()}/docker.sock`,
};
async function run(args: string[], name: string) {
  const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  writeFileSync(join(root, `${name}.log`), stdout + stderr);
  if (exit !== 0) throw new Error(`${name} failed (${exit}); evidence ${root}`);
  return stdout;
}
console.log(`Evidence ${root}`);
const build = await Bun.build({
  entrypoints: [join(repository, "test/local/runner-task-spool-process.ts")],
  target: "bun",
  outdir: root,
  naming: "probe.js",
});
if (!build.success) throw new Error("Task spool proof build failed");
const imageId = (
  await run(["docker", "image", "inspect", "--format", "{{.Id}}", image], "image")
).trim();
const output = await run(
  [
    "docker",
    "run",
    "--pull=never",
    "--rm",
    "--user",
    "0",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    ...["CHOWN", "FOWNER", "DAC_OVERRIDE", "SETUID", "SETGID", "KILL"].flatMap((cap) => [
      "--cap-add",
      cap,
    ]),
    "--security-opt",
    "no-new-privileges",
    ...[
      [join(repository, "test/local/runner-task-spool-proof.py"), "/proof/proof.py"],
      [join(root, "probe.js"), "/proof/probe.js"],
      [process.execPath, "/proof/bun"],
    ].flatMap(([src, dst]) => ["--mount", `type=bind,src=${src},dst=${dst},readonly`]),
    "--entrypoint",
    "/usr/bin/python3",
    image,
    "-I",
    "-B",
    "/proof/proof.py",
  ],
  "uid-boundary",
);
for (const name of files)
  if (hash(join(repository, name)) !== sourceHashes[name])
    throw new Error("Source changed during proof");
writeFileSync(
  join(root, "observations.json"),
  JSON.stringify(
    {
      ...JSON.parse(output),
      image: imageId,
      bunVersion: Bun.version,
      bunSha256: hash(process.execPath),
      sourceHashes,
    },
    null,
    2,
  ),
);
console.log(`VERIFIED immutable task snapshots and distinct UID boundaries; evidence ${root}`);
