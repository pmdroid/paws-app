import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultGitExec, gitEnv, withCredential } from "./git";
import { useGitTempDirectory } from "./temp";

const MARKERS = {
  PAWS_SECRET_KEY: "marker-paws-secret",
  PAWS_GITHUB_TOKEN: "marker-paws-token",
  LINEAR_WEBHOOK_SECRET: "marker-webhook",
  GITHUB_CLIENT_SECRET: "marker-client",
  AWS_SECRET_ACCESS_KEY: "marker-s3-secret",
  S3_ENDPOINT: "marker-s3-endpoint",
  GH_TOKEN: "marker-gh",
  SSH_AUTH_SOCK: "marker-ssh",
};
let root: string;
const prior = new Map<string, string | undefined>();

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paws-git-env-"));
  useGitTempDirectory(root);
  for (const [key, value] of Object.entries(MARKERS)) {
    prior.set(key, process.env[key]);
    process.env[key] = value;
  }
});

afterEach(async () => {
  for (const [key, value] of prior) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  useGitTempDirectory(null);
  await rm(root, { recursive: true, force: true });
});

async function capture(env: NodeJS.ProcessEnv): Promise<string> {
  const bin = path.join(root, "git");
  const out = path.join(root, "env.txt");
  await writeFile(bin, `#!/bin/sh\nenv > '${out}'\n`);
  await chmod(bin, 0o700);
  await defaultGitExec(bin)(["patch-id", "--stable"], { cwd: root, env });
  return readFile(out, "utf8");
}

test("a local git child holds none of the service's secret variables", async () => {
  const seen = await capture(gitEnv());
  for (const value of Object.values(MARKERS)) expect(seen).not.toContain(value);
  expect(seen).not.toMatch(/^(PAWS_|S3_|AWS_)/m);
  expect(seen).toContain("GIT_TERMINAL_PROMPT=0");
  expect(seen).toContain(`PATH=${process.env.PATH}`);
});

test("a credentialed git child holds only its own transport credential", async () => {
  const seen = await withCredential("operation-token", defaultGitExec(), ({ env }) => capture(env));
  for (const value of Object.values(MARKERS)) expect(seen).not.toContain(value);
  expect(seen.match(/^PAWS_[A-Z_]*=.*$/gm)).toEqual(["PAWS_GITHUB_TOKEN=operation-token"]);
});

test("gitEnv keeps the git config variables and identity from its base", () => {
  const env = gitEnv(undefined, {
    HOME: "/home/paws",
    GIT_CONFIG_GLOBAL: "/tmp/config",
    GIT_SSL_CAINFO: "/tmp/ca.pem",
    GIT_AUTHOR_NAME: "Paws",
    PAWS_SECRET_KEY: "marker",
  });
  expect(env).toEqual({
    PATH: "/usr/bin:/bin",
    HOME: "/home/paws",
    GIT_CONFIG_GLOBAL: "/tmp/config",
    GIT_SSL_CAINFO: "/tmp/ca.pem",
    GIT_AUTHOR_NAME: "Paws",
    GIT_TERMINAL_PROMPT: "0",
  });
});
