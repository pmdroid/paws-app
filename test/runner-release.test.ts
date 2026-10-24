import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(new URL("../.github/workflows/runner-release.yml", import.meta.url), "utf8"),
);

test("runner package builds run only for published releases, and publication waits for both architectures", () => {
  expect(workflow.on).toEqual({ release: { types: ["published"] } });
  expect(workflow.jobs.build.strategy.matrix.include).toEqual([
    { architecture: "amd64", platform: "linux-x64", runner: "ubuntu-24.04" },
    { architecture: "arm64", platform: "linux-arm64", runner: "ubuntu-24.04-arm" },
  ]);
  expect(workflow.jobs.publish.needs).toBe("build");
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.jobs.publish.permissions).toEqual({ contents: "write" });
});

test("the actual release-version step accepts numeric release tags and rejects executable or unsupported input", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-release-tags-"));
  const step = workflow.jobs.build.steps.find(
    (value: { name?: string }) => value.name === "Validate release version",
  );
  try {
    for (const [index, tag] of [
      "v1.2.3",
      "2.0.0",
      "v1.2.3-rc.1",
      "v01.2.3",
      "v1.2.3\nOTHER=value",
      `v1.2.3$(touch ${join(root, "injected")})`,
    ].entries()) {
      const output = join(root, `${index}.env`);
      const command = Bun.spawn(["/bin/bash", "-e", "-o", "pipefail", "-c", step.run], {
        env: { PATH: "/usr/bin:/bin", RELEASE_TAG: tag, GITHUB_ENV: output },
        stdout: "ignore",
        stderr: "ignore",
      });
      const code = await command.exited;
      if (index < 2) {
        expect(code).toBe(0);
        expect(readFileSync(output, "utf8")).toBe(`RUNNER_VERSION=${tag.replace(/^v/, "")}\n`);
      } else {
        expect(code).not.toBe(0);
        expect(Bun.file(output).size).toBe(0);
      }
    }
    expect(await Bun.file(join(root, "injected")).exists()).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runner package pins mise for both architectures and a wrong checksum fails the build", async () => {
  const release = new URL("../deploy/linux/release.py", import.meta.url).pathname;
  const script = `
import importlib.util, io, json, sys
spec = importlib.util.spec_from_file_location("release", sys.argv[1])
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
class Response(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *_): return False
requested = []
def opener(url, timeout):
    requested.append(url)
    return Response(b"tampered mise")
rejected = {}
for name in ("linux-x64", "linux-arm64"):
    try:
        release.download_mise(name, opener)
        rejected[name] = None
    except ValueError as error:
        rejected[name] = str(error)
print(json.dumps({"version": release.MISE_VERSION, "digests": release.MISE_SHA256, "required": "bin/mise" in release.REQUIRED, "requested": requested, "rejected": rejected}))
`;
  const child = Bun.spawn(["python3", "-I", "-B", "-c", script, release], {
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.version).toMatch(/^\d{4}\.\d{1,2}\.\d{1,4}$/);
  expect(Object.keys(result.digests).sort()).toEqual(["linux-arm64", "linux-x64"]);
  for (const digest of Object.values(result.digests)) expect(digest).toMatch(/^[0-9a-f]{64}$/);
  expect(result.required).toBe(true);
  expect(result.requested).toEqual(
    ["linux-x64", "linux-arm64"].map(
      (name) =>
        `https://github.com/jdx/mise/releases/download/v${result.version}/mise-v${result.version}-${name}`,
    ),
  );
  expect(result.rejected).toEqual({
    "linux-x64": `mise ${result.version} linux-x64 checksum mismatch`,
    "linux-arm64": `mise ${result.version} linux-arm64 checksum mismatch`,
  });
});
