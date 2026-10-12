import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "paws-signing-identity-"));
const files = [
  "deploy/linux/check-verifier.py",
  "src/runner-check/index.ts",
  "src/runner-check/schema.ts",
  "src/runner-verifier/index.ts",
  "test/runner-signing-identity.test.ts",
  "test/local/runner-signing-consumer.ts",
  "test/local/runner-signing-proof.py",
  "test/local/runner-signing-identity.ts",
  ".agents/skills/verify-paws/SKILL.md",
  "bun.lock",
];
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const hashes = Object.fromEntries(files.map((file) => [file, digest(join(repository, file))]));
const image = process.env.PAWS_CHECK_PROOF_IMAGE ?? "python:3.14-slim";
const env = {
  PATH: "/usr/bin:/bin",
  HOME: root,
  DOCKER_CONFIG: join(root, "docker-config"),
  DOCKER_HOST:
    process.env.PAWS_CHECK_PROOF_DOCKER_HOST ??
    "unix:///run/user/" + process.getuid!() + "/docker.sock",
};
async function run(command: string[], name: string) {
  const child = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  writeFileSync(join(root, name + ".log"), stdout + stderr);
  if (exit !== 0) throw new Error(name + " failed (" + exit + "); evidence " + root);
  return stdout;
}
console.log("Evidence " + root);
const build = await Bun.build({
  entrypoints: [join(repository, "test/local/runner-signing-consumer.ts")],
  target: "bun",
  outdir: root,
  naming: "consumer.js",
});
if (!build.success) throw new Error("Verifier consumer build failed");
const imageId = (
  await run(["docker", "image", "inspect", "--format", "{{.Id}}", image], "image")
).trim();
const command = [
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
    [join(repository, "deploy/linux/check-verifier.py"), "/proof/check-verifier.py"],
    [join(repository, "test/local/runner-signing-proof.py"), "/proof/proof.py"],
    [join(root, "consumer.js"), "/proof/consumer.js"],
    [process.execPath, "/proof/bun"],
  ].flatMap(([src, dst]) => ["--mount", "type=bind,src=" + src + ",dst=" + dst + ",readonly"]),
  "--entrypoint",
  "/usr/bin/python3",
  image,
  "-I",
  "-B",
  "/proof/proof.py",
];
writeFileSync(join(root, "input.json"), JSON.stringify({ command, env }, null, 2));
const observed = JSON.parse(await run(command, "native"));
for (const file of files)
  if (digest(join(repository, file)) !== hashes[file])
    throw new Error("Source changed during proof");
writeFileSync(
  join(root, "observations.json"),
  JSON.stringify(
    {
      ...observed,
      image: imageId,
      bunVersion: Bun.version,
      bunSha256: digest(process.execPath),
      consumerSha256: digest(join(root, "consumer.js")),
      sourceHashes: hashes,
    },
    null,
    2,
  ),
);
console.log("VERIFIED root verifier identity and actual signatures; evidence " + root);
