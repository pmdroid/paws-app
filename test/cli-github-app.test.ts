import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { tempHome } from "./helpers";

async function paws(args: string[]) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "src/index.ts", ...args], {
    cwd: resolve(import.meta.dir, ".."),
    env: { PATH: process.env.PATH, PAWS_HOME: tempHome(), TMPDIR: process.env.TMPDIR },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("--help lists the commands and no GitHub login or logout", async () => {
  const help = await paws(["--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("paws doctor");
  expect(help.stdout).toContain("docs/github-app.md");
  expect(help.stdout).not.toContain("login github");
  expect(help.stdout).not.toContain("logout");
});

test("paws login github and paws logout no longer exist", async () => {
  const login = await paws(["login", "github"]);
  expect(login.code).toBe(1);
  expect(login.stderr).toContain("usage: paws login slack");
  expect(login.stderr).not.toContain("login github");
  const logout = await paws(["logout"]);
  expect(logout.code).toBe(1);
  expect(logout.stderr).toContain("Unknown option logout.");
});
