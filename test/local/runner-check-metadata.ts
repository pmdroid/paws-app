import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repository = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "paws-check-metadata-verification-"));
const files = [
  "deploy/linux/check-metadata.py",
  "test/local/runner-check-metadata-proof.py",
  "test/local/runner-check-metadata.ts",
  "package.json",
  "bun.lock",
];
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const hashes = Object.fromEntries(files.map((name) => [name, digest(join(repository, name))]));
const image = process.env.PAWS_CHECK_PROOF_IMAGE;
if (!image) throw new Error("Select a preloaded Python and Git image with PAWS_CHECK_PROOF_IMAGE");
const env = {
  PATH: "/usr/bin:/bin",
  HOME: root,
  DOCKER_CONFIG: join(root, "docker-config"),
  DOCKER_HOST:
    process.env.PAWS_CHECK_PROOF_DOCKER_HOST ?? `unix:///run/user/${process.getuid!()}/docker.sock`,
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
const imageId = (
  await run(["docker", "image", "inspect", "--format", "{{.Id}}", image], "image")
).trim();
const observations = [];
for (const large of [false, true]) {
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
      ...["CHOWN", "FOWNER", "DAC_OVERRIDE", "SETUID", "SETGID"].flatMap((cap) => [
        "--cap-add",
        cap,
      ]),
      "--security-opt",
      "no-new-privileges",
      ...[
        [join(repository, "deploy/linux/check-metadata.py"), "/proof/check-metadata.py"],
        [join(repository, "test/local/runner-check-metadata-proof.py"), "/proof/proof.py"],
      ].flatMap(([src, dst]) => ["--mount", `type=bind,src=${src},dst=${dst},readonly`]),
      "--entrypoint",
      "/usr/bin/python3",
      image,
      "-I",
      "-B",
      "/proof/proof.py",
      "/proof/check-metadata.py",
      ...(large ? ["large"] : []),
    ],
    large ? "uid-metadata-large" : "uid-metadata",
  );
  observations.push({ ...JSON.parse(output), largeRepository: large });
}
for (const name of files)
  if (digest(join(repository, name)) !== hashes[name])
    throw new Error("Source changed during proof");
writeFileSync(
  join(root, "observations.json"),
  JSON.stringify(
    {
      verified: true,
      observations,
      image: imageId,
      bunVersion: Bun.version,
      bunSha256: digest(process.execPath),
      sourceHashes: hashes,
    },
    null,
    2,
  ),
);
console.log(`VERIFIED fixed Git inspection under the check UID; evidence ${root}`);
