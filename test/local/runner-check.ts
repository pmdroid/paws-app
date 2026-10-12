import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repository = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "paws-check-verification-"));
const files = [
  "src/runner-check/files.ts",
  "src/runner-check/index.ts",
  "src/runner-check/schema.ts",
  "src/runner-verifier/index.ts",
  "test/runner-verifier.test.ts",
  "test/local/runner-verifier.ts",
  "test/runner-check.test.ts",
  "test/local/runner-check-process.ts",
  "test/local/runner-check-proof.py",
  "test/local/runner-check.ts",
  "test/boundaries.test.ts",
  ".agents/skills/verify-paws/SKILL.md",
  "package.json",
  "bun.lock",
];
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const hashes = Object.fromEntries(files.map((name) => [name, digest(join(repository, name))]));
const image = process.env.PAWS_CHECK_PROOF_IMAGE ?? "python:3.14-slim";
const env = {
  PATH: "/usr/bin:/bin",
  HOME: root,
  DOCKER_CONFIG: join(root, "docker-config"),
  DOCKER_HOST:
    process.env.PAWS_CHECK_PROOF_DOCKER_HOST ?? `unix:///run/user/${process.getuid!()}/docker.sock`,
};
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
const build = await Bun.build({
  entrypoints: [join(repository, "test/local/runner-check-process.ts")],
  target: "bun",
  outdir: root,
  naming: "probe.js",
});
if (!build.success) throw new Error("Check input probe build failed");
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
    ...["CHOWN", "FOWNER", "DAC_OVERRIDE", "SETUID", "SETGID"].flatMap((cap) => ["--cap-add", cap]),
    "--security-opt",
    "no-new-privileges",
    ...[
      [join(repository, "test/local/runner-check-proof.py"), "/proof/proof.py"],
      [join(root, "probe.js"), "/proof/probe.js"],
      [process.execPath, "/proof/bun"],
    ].flatMap(([src, dst]) => ["--mount", `type=bind,src=${src},dst=${dst},readonly`]),
    "--entrypoint",
    "/usr/bin/python3",
    image,
    "-I",
    "-B",
    "/proof/proof.py",
    "/proof/bun",
    "/proof/probe.js",
  ],
  "uid-boundary",
);
for (const name of files)
  if (digest(join(repository, name)) !== hashes[name])
    throw new Error("Source changed during proof");
writeFileSync(
  join(root, "observations.json"),
  JSON.stringify(
    {
      ...JSON.parse(output),
      image: imageId,
      bunVersion: Bun.version,
      bunSha256: digest(process.execPath),
      probeSha256: digest(join(root, "probe.js")),
      sourceHashes: hashes,
      resultBackend: "root-owned fixture",
    },
    null,
    2,
  ),
);
console.log(`VERIFIED immutable check inputs and UID-protected result reads; evidence ${root}`);
