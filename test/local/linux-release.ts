import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repository = resolve(import.meta.dir, "../..");
const selectedRecovery = process.argv.includes("--selected-recovery");
const providerLogin = process.argv.includes("--provider-login");
const proof = providerLogin
  ? "test/local/linux-provider-login-proof.py"
  : selectedRecovery
    ? "test/local/linux-selected-recovery-proof.py"
    : "test/local/linux-install-proof.py";
const root = mkdtempSync(join(tmpdir(), "paws-release-verification-"));
const source = resolve(process.env.PAWS_RELEASE_PROOF_SOURCE ?? repository);
const node = resolve(process.env.PAWS_RELEASE_PROOF_NODE ?? "/usr/bin/node");
const image = process.env.PAWS_RELEASE_PROOF_IMAGE ?? "gegenlesen/runner-base:benchmark-current";
const env = {
  PATH: "/usr/bin:/bin",
  HOME: root,
  DOCKER_CONFIG: join(root, "docker-config"),
  DOCKER_HOST:
    process.env.PAWS_RELEASE_PROOF_DOCKER_HOST ??
    `unix:///run/user/${process.getuid!()}/docker.sock`,
};
async function run(args: string[], name: string) {
  const command = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
    command.exited,
  ]);
  writeFileSync(join(root, `${name}.log`), stdout + stderr);
  if (code !== 0) throw new Error(`${name} failed (${code}); evidence ${root}`);
  return stdout;
}
console.log(`Evidence ${root}`);
const nodeVersion = (await run([node, "--version"], "node-version")).trim();
if (!/^v(?:2[2-9]|[3-9][0-9])\./.test(nodeVersion))
  throw new Error("Local proof needs Node22 or newer");
const runtime = join(root, "host-runtime");
mkdirSync(runtime, { mode: 0o700 });
for (const name of ["systemd-sysusers", "systemd-tmpfiles", "systemctl"]) {
  const binary = `/usr/bin/${name}`;
  copyFileSync(binary, join(runtime, name));
  chmodSync(join(runtime, name), 0o755);
  const libraries = await run(["ldd", binary], `libraries-${name}`);
  for (const match of libraries.matchAll(/(?:=>\s+)?(\/[^\s()]+)/g)) {
    const path = match[1]!;
    copyFileSync(path, join(runtime, basename(path)));
    chmodSync(join(runtime, basename(path)), 0o755);
  }
}
const artifactRoot = join(root, "package");
await run(
  [
    "/usr/bin/python3",
    "-I",
    "-B",
    join(repository, "deploy/linux/package.py"),
    "--source",
    source,
    "--bun",
    process.execPath,
    "--version",
    "0.1.1",
    "--platform",
    `linux-${process.arch === "arm64" ? "arm64" : "x64"}`,
    "--output",
    artifactRoot,
  ],
  "package",
);
const imageId = (
  await run(["docker", "image", "inspect", "--format", "{{.Id}}", image], "image")
).trim();
const observation = await run(
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
    ...["CHOWN", "FOWNER", "DAC_OVERRIDE", "SETUID", "SETGID", "FSETID"].flatMap((cap) => [
      "--cap-add",
      cap,
    ]),
    "--security-opt",
    "no-new-privileges",
    ...[
      [join(repository, "deploy/linux/install.py"), "/proof/install.py"],
      [join(repository, "deploy/linux/release.py"), "/proof/release.py"],
      [join(repository, proof), "/proof/proof.py"],
      [join(repository, "test/local/linux-install-proof.py"), "/proof/source.py"],
      [runtime, "/proof/host-runtime"],
      [artifactRoot, "/proof/package"],
      [node, "/proof/node"],
    ].flatMap(([src, dst]) => ["--mount", `type=bind,src=${src},dst=${dst},readonly`]),
    "--entrypoint",
    "/usr/bin/python3",
    image,
    "-I",
    "-B",
    "/proof/proof.py",
  ],
  "installation",
);
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
writeFileSync(
  join(root, "observations.json"),
  JSON.stringify(
    {
      ...JSON.parse(observation),
      image: imageId,
      nodeVersion,
      installerSha256: digest(join(repository, "deploy/linux/install.py")),
      verifierSha256: digest(join(repository, "deploy/linux/release.py")),
      packagerSha256: digest(join(repository, "deploy/linux/package.py")),
      proofSha256: digest(join(repository, proof)),
      fixtureSha256: digest(join(repository, "test/local/linux-install-proof.py")),
    },
    null,
    2,
  ),
);
console.log(
  `VERIFIED ${providerLogin ? "bundled provider status and isolated operator login" : "signed Linux installation, dedicated identities, fixed paths and update fencing"}; evidence ${root}`,
);
