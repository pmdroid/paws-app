import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

test("the runner installer gives runner work Docker access only for the local engine and only on opt-in", async () => {
  const child = Bun.spawn(
    [
      "python3",
      "-I",
      "-B",
      new URL("local/linux-release-test.py", import.meta.url).pathname,
      new URL("../deploy/linux/release.py", import.meta.url).pathname,
      "DockerAccess",
    ],
    { env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stdout + stderr).not.toContain("skipped");
  expect(stderr).toMatch(/Ran 16 tests[\s\S]*\nOK\n?$/);
  expect(code).toBe(0);
});

test("the installer checks Docker with the PATH runner workers get", () => {
  const supervisor = readFileSync(
    new URL("../src/runner-execution/supervisor.ts", import.meta.url),
    "utf8",
  );
  const installer = readFileSync(new URL("../deploy/linux/install.py", import.meta.url), "utf8");
  const workerPath = supervisor.match(/PATH: "([^"]+)"/)?.[1];
  expect(workerPath).toBeDefined();
  expect(installer).toContain(`WORKER_PATH = "${workerPath}"`);
});
