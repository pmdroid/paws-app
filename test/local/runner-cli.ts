import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "paws-runner-cli-"));
const env = {
  PATH: "/usr/bin:/bin",
  HOME: root,
  DOCKER_CONFIG: join(root, "docker-config"),
  DOCKER_HOST: `unix:///run/user/${process.getuid!()}/docker.sock`,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
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
const baseline = process.argv.includes("--baseline");
const verifierBaseline = process.argv.includes("--verifier-baseline");
for (const [entrypoint, name] of [
  ["src/index.ts", "paws.js"],
  ["test/fixtures/runner-cli-instance.ts", "instance.js"],
  ["src/acp/testing/fake-agent.ts", "fake-agent.js"],
] as const) {
  const built = await Bun.build({
    entrypoints: [join(repository, entrypoint)],
    target: "bun",
    plugins:
      (baseline || verifierBaseline) && entrypoint === "src/index.ts"
        ? [
            {
              name: "published-entrypoint",
              setup(build) {
                build.onLoad(
                  { filter: verifierBaseline ? /\/runner-cli\/index\.ts$/ : /\/src\/index\.ts$/ },
                  () => {
                    const original = Bun.spawnSync(
                      [
                        "git",
                        "show",
                        verifierBaseline
                          ? "21b384f773cbab9559fdb5abaf1c89372c33b57b:src/runner-cli/index.ts"
                          : "758682d519402b44a8218678a78131a0a165e1f8:src/index.ts",
                      ],
                      { cwd: repository, env },
                    );
                    assert.equal(original.exitCode, 0);
                    return { contents: original.stdout.toString(), loader: "ts" };
                  },
                );
              },
            },
          ]
        : [],
  });
  assert(built.success, String(built.logs));
  await Bun.write(join(root, name), built.outputs[0]!);
}
writeFileSync(join(root, "script.json"), JSON.stringify({ steps: [] }));
mkdirSync(join(root, "docker-config"), { mode: 0o700 });
const image = "sha256:dcba6a2a9cd68913cb8f546f226c911f846ff2e8706fb4015e83f7ae1ecabb2b";
const child = Bun.spawn(
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
      [process.execPath, "/proof/bun"],
      [join(repository, "src/closeout-spec/schema"), "/schema"],
      [join(root, "paws.js"), "/proof/paws.js"],
      [join(root, "instance.js"), "/proof/instance.js"],
      [join(root, "fake-agent.js"), "/proof/fake-agent.js"],
      [join(root, "script.json"), "/proof/script.json"],
      [join(repository, "src/process/process-anchor.ts"), "/proof/process-anchor.ts"],
      [join(repository, "deploy/linux/check-verifier.py"), "/proof/check-verifier.py"],
      [join(repository, "test/local/runner-cli-proof.py"), "/proof/proof.py"],
    ].flatMap(([from, to]) => ["--mount", `type=bind,src=${from},dst=${to},readonly`]),
    "--entrypoint",
    "/usr/bin/env",
    image,
    "python3",
    "-I",
    "-B",
    "/proof/proof.py",
    ...(baseline ? ["baseline"] : verifierBaseline ? ["verifier-baseline"] : []),
  ],
  { cwd: repository, env, stdout: "pipe", stderr: "pipe", timeout: 120_000 },
);
const [exit, output, errors] = await Promise.all([
  child.exited,
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
]);
writeFileSync(join(root, "native.log"), output + errors);
writeFileSync(
  join(root, "source.json"),
  JSON.stringify({ source, baseline, verifierBaseline, image, exit }, null, 2),
);
assert.deepEqual(snapshot(), source);
assert.equal(exit, 0, `Native CLI failed; evidence ${root}\n${errors}`);
const observations = JSON.parse(output.trim().split("\n").at(-1)!);
assert.equal(observations.passed, true);
writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
console.log(JSON.stringify(observations));
