import { expect, test } from "bun:test";

test("the runner installer names the directory it refuses and why", async () => {
  const child = Bun.spawn(
    [
      "python3",
      "-I",
      "-B",
      new URL("local/linux-release-test.py", import.meta.url).pathname,
      new URL("../deploy/linux/release.py", import.meta.url).pathname,
      "RootDirectories",
    ],
    { env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toMatch(/Ran 3 tests[\s\S]*\nOK( \(skipped=1\))?\n?$/);
  expect(code).toBe(0);
});
