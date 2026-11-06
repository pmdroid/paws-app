import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { githubReadExpiryAllowed } from "../src/runner-daemon";
import { isRunnerToken, redactGitHubTokens } from "../src/runner-protocol";
import { openGitHubReadConfig } from "../src/runner-worker/github-read";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const DOTTED = "ghs_ab.cd-ef~gh";
const LONG_NEW = `ghs_${"a1".repeat(12)}.${"b-".repeat(10)}~c:d#e`;

test("a read token of printable ASCII is accepted whatever its prefix or characters", () => {
  for (const token of [DOTTED, LONG_NEW, "acme_token-1.2/3+4=", "x"])
    expect(isRunnerToken(token)).toBe(true);
  for (const token of [
    "",
    "ghs_has space",
    "ghs_tab\there",
    "ghs_new\nline",
    "ghs_é",
    "a".repeat(4097),
  ])
    expect(isRunnerToken(token)).toBe(false);
});

test("hosts.yml reads back the exact token even when it holds YAML-special characters", () => {
  const directory = join(mkdtempSync(join(tmpdir(), "paws-read-format-")), ".gh-run");
  roots.push(directory);
  const token = "ghs_a:b#c-d'e\"f{g}";
  const config = openGitHubReadConfig(directory, (sequence) =>
    sequence === 1 ? { token, expiresAt: Date.now() + 3_600_000 } : null,
  );
  const hosts = parse(readFileSync(join(directory, "hosts.yml"), "utf8")) as {
    "github.com": { oauth_token: string };
  };
  expect(hosts["github.com"].oauth_token).toBe(token);
  config.close();
});

test("a new-format token is redacted in full, with or without the exact list", () => {
  const text = `token=${LONG_NEW} next`;
  for (const exact of [[], [LONG_NEW]]) {
    const redacted = redactGitHubTokens(text, exact);
    expect(redacted).toBe("token=[redacted] next");
  }
  expect(redactGitHubTokens(`"${LONG_NEW}",`)).toBe('"[redacted]",');
});

test("a runner whose clock is a few seconds behind accepts a token that expires an hour after minting", () => {
  const minted = 1_800_000_000_000;
  const runnerNow = minted - 2_000;
  expect(githubReadExpiryAllowed(minted + 3_600_000, runnerNow)).toBe(true);
  expect(githubReadExpiryAllowed(minted + 3_600_000 + 60_000, runnerNow)).toBe(false);
  expect(githubReadExpiryAllowed(runnerNow, runnerNow)).toBe(false);
});
