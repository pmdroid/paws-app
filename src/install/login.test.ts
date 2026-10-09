import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { checkDeveloperLogin, checkDeveloperLogins } from "./index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("claude auth status exit 0 is logged in and drops credential fields", async () => {
  const dir = await tempDir();
  await writeExecutable(
    join(dir, "claude"),
    `#!/bin/sh
printf '%s\\n' "$@" > "$HOME/args"
printf '%s\\n' '{"authMethod":"claude.ai","configDirectory":"/secret/claude.json","token":"sk-ant-secret"}'
`,
  );
  const result = await checkDeveloperLogin({
    cli: "claude",
    env: { PATH: dir, HOME: dir },
  });
  expect(await readFile(join(dir, "args"), "utf8")).toBe("auth\nstatus\n");
  expect(result.loggedIn).toBe(true);
  expect(result.credentialsRead).toBe(false);
  expect(result.authMethod).toBe("claude.ai");
  expect(result.args).toEqual(["auth", "status"]);
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(JSON.stringify(result)).not.toContain("configDirectory");
});

test("codex login status exit 1 is not logged in", async () => {
  const dir = await tempDir();
  await writeExecutable(
    join(dir, "codex"),
    `#!/bin/sh
printf '%s\\n' "$@" > "$HOME/args"
echo 'Not logged in'
exit 1
`,
  );
  const result = await checkDeveloperLogin({
    cli: "codex",
    env: { PATH: dir, HOME: dir },
  });
  expect(await readFile(join(dir, "args"), "utf8")).toBe("login\nstatus\n");
  expect(result.loggedIn).toBe(false);
  expect(result.exitCode).toBe(1);
  expect(result.credentialsRead).toBe(false);
  expect(result.summary).toBe("codex is not logged in");
});

test("a missing developer CLI is not logged in", async () => {
  const dir = await tempDir();
  const result = await checkDeveloperLogin({
    cli: "claude",
    env: { PATH: dir, HOME: dir },
  });
  expect(result.loggedIn).toBe(false);
  expect(result.exitCode).toBeNull();
  expect(result.summary).toBe("claude is not installed");
  expect(result.credentialsRead).toBe(false);
});

test("unknown authMethod values are not copied", async () => {
  const dir = await tempDir();
  await writeExecutable(
    join(dir, "claude"),
    `#!/bin/sh
printf '%s\\n' '{"authMethod":"sk-ant-secret"}'
`,
  );
  const result = await checkDeveloperLogin({
    cli: "claude",
    env: { PATH: dir, HOME: dir },
  });
  expect(result.loggedIn).toBe(true);
  expect(result.authMethod).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("sk-");
});

test("a hung status command times out", async () => {
  const dir = await tempDir();
  await writeExecutable(
    join(dir, "codex"),
    `#!/bin/sh
exec /bin/sleep 30
`,
  );
  const result = await checkDeveloperLogin({
    cli: "codex",
    env: { PATH: dir, HOME: dir },
    timeoutMs: 200,
  });
  expect(result.loggedIn).toBe(false);
  expect(result.summary).toBe("codex login status timed out");
});

test("login checks use the fixed CLI commands and do not echo stdout", async () => {
  const calls: string[][] = [];
  const result = await checkDeveloperLogins({
    env: {},
    run: async (command, args) => {
      calls.push([command, ...args]);
      return { exitCode: 0, stdout: "token sk-live", stderr: "" };
    },
  });
  expect(calls).toEqual([
    ["claude", "auth", "status"],
    ["codex", "login", "status"],
  ]);
  expect(result.claude.loggedIn).toBe(true);
  expect(result.codex.loggedIn).toBe(true);
  expect(result.claude.credentialsRead).toBe(false);
  expect(JSON.stringify(result)).not.toContain("sk-live");
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paws-login-"));
  roots.push(dir);
  return dir;
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source);
  await chmod(path, 0o755);
}
