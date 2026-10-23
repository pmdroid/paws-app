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
    { architecture: "arm64", platform: "linux-arm64", runner: ["self-hosted", "Linux", "ARM64"] },
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
