import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "paws-run-review-runtime-"));
const input = join(root, "input");
mkdirSync(input, { mode: 0o700 });
writeFileSync(join(input, "failure-case"), process.env.PAWS_RUNTIME_PROOF_FAILURE ?? "all");
const env = {
  PATH: "/usr/bin:/bin",
  HOME: root,
  DOCKER_CONFIG: join(root, "docker-config"),
  DOCKER_HOST:
    process.env.PAWS_RUNTIME_PROOF_DOCKER_HOST ??
    `unix:///run/user/${process.getuid!()}/docker.sock`,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
};
async function run(args: string[], name: string) {
  const child = Bun.spawn(args, {
    cwd: repository,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 90_000,
  });
  const [exit, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  writeFileSync(join(root, name + ".log"), output + errors);
  assert.equal(exit, 0, `${name} failed; evidence ${root}\n${errors}`);
  return output;
}
function snapshot() {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repository, env },
  );
  assert.equal(listed.exitCode, 0);
  return Object.fromEntries(
    listed.stdout
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((path) => [
        path,
        createHash("sha256")
          .update(readFileSync(join(repository, path)))
          .digest("hex"),
      ]),
  );
}
const source = snapshot();
console.log(`Evidence ${root}`);
await run(
  [process.execPath, "--no-env-file", "test/local/runner-runtime-process.ts", "prepare", input],
  "prepare",
);
for (const [entrypoint, name] of [
  ["test/local/runner-runtime-process.ts", "runtime.js"],
  ["src/acp/testing/fake-agent.ts", "fake-agent.js"],
] as const) {
  const built = await Bun.build({ entrypoints: [join(repository, entrypoint)], target: "bun" });
  assert(built.success, String(built.logs));
  await Bun.write(join(root, name), built.outputs[0]!);
}
const image =
  process.env.PAWS_RUNTIME_PROOF_IMAGE ??
  "sha256:dcba6a2a9cd68913cb8f546f226c911f846ff2e8706fb4015e83f7ae1ecabb2b";
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
    ...["CHOWN", "FOWNER", "DAC_OVERRIDE", "SETUID", "SETGID", "KILL"].flatMap((capability) => [
      "--cap-add",
      capability,
    ]),
    "--security-opt",
    "no-new-privileges",
    ...[
      [input, "/input"],
      [process.execPath, "/proof/bun"],
      [join(root, "runtime.js"), "/proof/runtime.js"],
      [join(root, "fake-agent.js"), "/proof/fake-agent.js"],
      [join(repository, "src/process/process-anchor.ts"), "/proof/process-anchor.ts"],
      [join(repository, "src/acp/ask-team-mcp.ts"), "/proof/ask-team-mcp.ts"],
      [join(repository, "test/local/runner-runtime-proof.py"), "/proof/proof.py"],
      [join(repository, "deploy/linux/runner-broker.py"), "/proof/runner-broker.py"],
      [join(repository, "deploy/linux/paws-agent@.service"), "/proof/paws-agent@.service"],
    ].flatMap(([sourcePath, target]) => [
      "--mount",
      `type=bind,src=${sourcePath},dst=${target},readonly`,
    ]),
    "--entrypoint",
    "/usr/bin/env",
    image,
    "python3",
    "-I",
    "-B",
    "/proof/proof.py",
  ],
  "native",
);
const observations = JSON.parse(output.trim().split("\n").at(-1)!);
assert.equal(observations.passed, true);
assert.deepEqual(snapshot(), source);
writeFileSync(
  join(root, "observations.json"),
  JSON.stringify({ ...observations, imageId, source }, null, 2),
);
console.log(
  JSON.stringify({ ...observations, imageId, frozenSourceFiles: Object.keys(source).length }),
);
