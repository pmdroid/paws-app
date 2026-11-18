import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountAgentEnv } from "../acp";
import { setJournalSink } from "../journal";
import { reviewCommandEnv } from ".";

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
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

function apiKeyHome(agent: string, key: unknown, oauth?: string) {
  const dir = home(oauth);
  mkdirSync(join(dir, ".paws"));
  writeFileSync(join(dir, ".paws/api-key.json"), JSON.stringify({ kind: "api_key", agent, key }));
  return dir;
}

const KEY = "sk-test-0123456789";

test("each agent's API key file sets only that agent's variable", () => {
  for (const [agent, variable] of [
    ["claude", "ANTHROPIC_API_KEY"],
    ["codex", "OPENAI_API_KEY"],
    ["grok", "XAI_API_KEY"],
    ["opencode", "OPENROUTER_API_KEY"],
  ] as const)
    expect(accountAgentEnv(agent, apiKeyHome(agent, KEY))).toEqual({ [variable]: KEY });
});

test("an API key file for another agent is ignored", () => {
  expect(accountAgentEnv("codex", apiKeyHome("claude", KEY))).toEqual({});
  expect(accountAgentEnv("opencode", apiKeyHome("grok", KEY))).toEqual({});
});

test("a malformed API key sets nothing and the journal names the file, not the key", () => {
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    for (const key of ["", `${KEY} trailing`, `${KEY}\n`, "x".repeat(513), 42]) {
      const dir = apiKeyHome("codex", key);
      expect(accountAgentEnv("codex", dir)).toEqual({});
      expect(lines.at(-1)).toContain(join(dir, ".paws/api-key.json"));
    }
    expect(accountAgentEnv("codex", apiKeyHome("codex", "x".repeat(512)))).toEqual({
      OPENAI_API_KEY: "x".repeat(512),
    });
  } finally {
    restore();
  }
  expect(lines.some((line) => line.includes(KEY))).toBe(false);
});

test("a Claude OAuth token wins over an API key", () => {
  expect(accountAgentEnv("claude", apiKeyHome("claude", KEY, "sk-ant-oat01-token"))).toEqual({
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-token",
  });
});

test("a review command gets the account's API key variable", () => {
  const HOME = apiKeyHome("codex", KEY);
  expect(reviewCommandEnv("codex", { HOME })).toEqual({ HOME, OPENAI_API_KEY: KEY });
  const claude = apiKeyHome("claude", KEY);
  expect(reviewCommandEnv("claude", { HOME: claude })).toEqual({
    HOME: claude,
    ANTHROPIC_API_KEY: KEY,
  });
});
