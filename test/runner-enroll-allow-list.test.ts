import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/runner-cli";

const TOKEN = "Q2xvc2VvdXRUb2tlbl9mb3JfdGVzdHNfMDEyMzQ1Njc4OQ";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function host(allowedRepositories: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), "paws-enroll-allow-list-"));
  roots.push(root);
  const config = join(root, "config.json");
  const tokenFile = join(root, "enrollment-token");
  writeFileSync(
    config,
    JSON.stringify({
      controlPlaneUrl: "https://paws.example.com",
      runnerApiUrl: "https://paws.example.com:8788",
      allowedRepositories,
    }),
    { mode: 0o600 },
  );
  // Not root-owned mode 0600, so reading this token fails with its own error.
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o644 });
  return { root, config, tokenFile };
}

async function enroll({ root, config, tokenFile }: ReturnType<typeof host>) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      join(import.meta.dir, "fixtures/runner-cli-root-identity.ts"),
      join(import.meta.dir, "../src/runner-cli/main.ts"),
      "runner",
      "enroll",
      "--config",
      config,
      "--name",
      "fixture",
      "--token-file",
      tokenFile,
    ],
    { env: { PATH: process.env.PATH, HOME: root }, stdout: "pipe", stderr: "pipe" },
  );
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exit, stderr };
}

test("runner enroll refuses an empty allow list before it reads the token", async () => {
  const empty = host([]);
  const { exit, stderr } = await enroll(empty);
  expect(exit).not.toBe(0);
  expect(stderr).toContain(
    `${empty.config} has an empty allowedRepositories list, so this runner would refuse all work. Add at least one owner/repo to it.`,
  );
  expect(stderr).not.toContain("Enrollment token");
  expect(existsSync(empty.tokenFile)).toBe(true);
  expect(readFileSync(empty.tokenFile, "utf8")).toBe(`${TOKEN}\n`);
}, 20_000);

test("runner enroll goes on to the token when the allow list names a repository", async () => {
  const { exit, stderr } = await enroll(host(["owner/repo"]));
  expect(exit).not.toBe(0);
  expect(stderr).toContain("Enrollment token must be a root-owned mode 0600 file.");
  expect(stderr).not.toContain("allowedRepositories");
}, 20_000);

test("the daemon's config load still accepts an empty allow list", () => {
  const { config } = host([]);
  expect(loadConfig(config, process.getuid!()).allowedRepositories).toEqual([]);
});
