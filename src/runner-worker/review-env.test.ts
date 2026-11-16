import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewCommandEnv } from ".";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(token?: string) {
  const dir = mkdtempSync(join(tmpdir(), "review-env-"));
  homes.push(dir);
  if (token) {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(
      join(dir, ".claude/paws-oauth.json"),
      JSON.stringify({ kind: "oauth_token", token, createdAt: 0, expiresAt: 1 }),
    );
  }
  return dir;
}

test("a Claude review command gets the account's pasted setup token", () => {
  const HOME = home("sk-ant-oat01-test_token");
  expect(reviewCommandEnv("claude", { HOME, PATH: "/usr/bin" })).toEqual({
    HOME,
    PATH: "/usr/bin",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test_token",
  });
});

test("a Claude account without a pasted token and a Codex review keep their environment", () => {
  const HOME = home();
  expect(reviewCommandEnv("claude", { HOME })).toEqual({ HOME });
  const withToken = home("sk-ant-oat01-other");
  expect(reviewCommandEnv("codex", { HOME: withToken })).toEqual({ HOME: withToken });
});
