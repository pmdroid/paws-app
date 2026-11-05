import { expect, test } from "bun:test";

test("shared runner directories belong to paws-runner and reach agents through a group", async () => {
  const child = Bun.spawn(
    [
      "python3",
      "-I",
      "-B",
      new URL("local/linux-release-test.py", import.meta.url).pathname,
      new URL("../deploy/linux/release.py", import.meta.url).pathname,
      "StateDirectories",
    ],
    { env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stdout + stderr).not.toContain("skipped");
  expect(stderr).toMatch(/Ran 5 tests[\s\S]*\nOK\n?$/);
  expect(code).toBe(0);
});
