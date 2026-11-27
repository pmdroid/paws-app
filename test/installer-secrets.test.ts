import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLayout, pawsPaths, readExeDevToken } from "../src/config";
import { saveSecret } from "../src/credentials";
import {
  BROWSER_SETUP_LINE,
  defaultEnvFile,
  runSecretsStep,
  SETUP_LINK_HINT,
} from "../src/installer";
import { setupLink } from "../src/onboarding";

let home: string;

beforeEach(() => {
  home = join(mkdtempSync(join(tmpdir(), "paws-installer-")), ".paws");
  ensureLayout(pawsPaths(home));
});

afterEach(() => rmSync(join(home, ".."), { recursive: true, force: true }));

function run(publicUrl: string | null = "https://paws.example.ts.net/"): {
  stdout: string;
} {
  let stdout = "";
  runSecretsStep({ home, prompter: { say: (text) => (stdout += `${text}\n`) }, publicUrl });
  return { stdout };
}

test("no credential is asked and the setup link and browser line are printed", async () => {
  const secrets = pawsPaths(home).secretsDir;
  await saveSecret(join(secrets, "setup-token"), "token-4711");
  const { stdout } = run();
  expect(stdout).toBe(
    [
      "Public URL: https://paws.example.ts.net",
      "https://paws.example.ts.net/setup?token=token-4711",
      BROWSER_SETUP_LINE,
      "",
    ].join("\n"),
  );
  expect(stdout).toContain(setupLink(secrets, "https://paws.example.ts.net"));
  expect(stdout).not.toContain("[not set]");
});

test("without a setup token it says to start Paws and creates none", () => {
  const { stdout } = run(null);
  expect(stdout).toContain("Public URL: not set");
  expect(stdout).toContain(SETUP_LINK_HINT);
  expect(stdout).not.toContain("Setup is complete.");
  expect(readdirSync(pawsPaths(home).secretsDir)).not.toContain("setup-token");
});

test("secrets already on disk stay as they are", async () => {
  const path = join(pawsPaths(home).secretsDir, "exe-dev-token");
  await saveSecret(path, "exe-dev-token-ee4");
  const before = readFileSync(path, "utf8");
  run();
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(readExeDevToken(home)).toBe("exe-dev-token-ee4");
});

test("the default env file is the user unit's EnvironmentFile", () => {
  const user = join(home, "..", "user");
  expect(defaultEnvFile({ HOME: user, PAWS_HOME: home })).toBe(join(home, "https.env"));
  const unitDir = join(user, ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, "paws.service"), "[Service]\nEnvironmentFile=/srv/paws/https.env\n");
  expect(defaultEnvFile({ HOME: user, PAWS_HOME: home })).toBe("/srv/paws/https.env");
});

async function cli(envFile: string): Promise<string> {
  const script = `import { runInstallCli } from ${JSON.stringify(join(import.meta.dir, "../src/installer"))};
    process.exit(await runInstallCli(["secrets", "--env-file", ${JSON.stringify(envFile)}], {}));`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { PATH: process.env.PATH },
    stdin: "ignore",
  });
  expect(await child.exited).toBe(0);
  return new Response(child.stdout).text();
}

test("install secrets with stdin closed reads --env-file and leaves its bytes unchanged", async () => {
  const envFile = join(home, "..", "https.env");
  const text = `PAWS_HOME=${home}\nPAWS_PUBLIC_URL="https://paws.example.ts.net/"\n# kept`;
  writeFileSync(envFile, text);
  const missing = await cli(envFile);
  expect(missing).toBe(
    `Public URL: https://paws.example.ts.net\n${SETUP_LINK_HINT}\n${BROWSER_SETUP_LINE}\n`,
  );
  await saveSecret(join(pawsPaths(home).secretsDir, "setup-token"), "token-4711");
  const link = "https://paws.example.ts.net/setup?token=token-4711";
  expect(await cli(envFile)).toBe(missing.replace(SETUP_LINK_HINT, link));
  expect(readFileSync(envFile, "utf8")).toBe(text);
});
