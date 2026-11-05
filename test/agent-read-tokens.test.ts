import { afterEach, beforeEach, expect, test } from "bun:test";
import { setJournalSink } from "../src/journal";
import type { GitHubApp, MintTokenInput } from "../src/github";
import { AGENT_READ_REFRESH_MS, createAgentReadTokens } from "../src/runner-repository-access";

const HOUR = 60 * 60_000;
let lines: string[] = [];
let restore: () => void;
beforeEach(() => {
  lines = [];
  restore = setJournalSink((line) => lines.push(line));
});
afterEach(() => restore());

function fixture(options: { fail?: boolean; revokeFails?: boolean } = {}) {
  let clock = 1_800_000_000_000;
  const minted: MintTokenInput[] = [];
  const revoked: string[] = [];
  const github: GitHubApp = {
    async mintInstallationToken(input) {
      minted.push(input);
      if (options.fail) throw new Error("installation token request failed with status 422");
      return {
        token: `ghs_${String(minted.length).padStart(36, "0")}`,
        expiresAt: clock + HOUR,
        repository: input.repository,
      };
    },
  };
  const tokens = createAgentReadTokens({
    github,
    installationForRepository: (repository) => (repository === "acme/monorepo" ? "7" : null),
    async revoke(token) {
      revoked.push(token);
      if (options.revokeFails) throw new Error("installation token revoke failed with status 500");
    },
    now: () => clock,
  });
  const open = (repository: string | null = "acme/monorepo") =>
    tokens.open({ commandId: "C1", itemId: "I1", runId: "R1", repository });
  return {
    tokens,
    minted,
    revoked,
    open,
    advance(ms: number) {
      clock += ms;
    },
  };
}

test("a turn mints one read token for the item's repository only", async () => {
  const f = fixture();
  expect(await f.open()).toBe(true);
  expect(f.minted).toEqual([
    { access: "agent_read", repository: "acme/monorepo", installationId: "7" },
  ]);
  const first = await f.tokens.credential("C1");
  expect(await f.tokens.credential("C1")).toEqual(first);
  expect(f.minted).toHaveLength(1);
  expect(lines).toEqual([
    expect.stringMatching(/^agent-read item=I1 run=R1 repositories=acme\/monorepo minted expires=/),
  ]);
  expect(lines.join("\n")).not.toContain(first!.token);
});

test("Paws refuses to mint without a repository or an installation, with one journal line", async () => {
  for (const repository of [null, "acme/elsewhere"]) {
    const f = fixture();
    lines = [];
    expect(await f.open(repository)).toBe(false);
    expect(f.minted).toEqual([]);
    expect(await f.tokens.credential("C1")).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("mint failed");
  }
});

test("a mint failure leaves the turn without a token and says so once", async () => {
  const f = fixture({ fail: true });
  expect(await f.open()).toBe(false);
  expect(lines).toEqual([
    "agent-read item=I1 run=R1 repositories=acme/monorepo mint failed: installation token request failed with status 422",
  ]);
  await f.tokens.close("C1");
  expect(f.revoked).toEqual([]);
});

test("near expiry the runner gets a fresh token, and the turn's end revokes every one", async () => {
  const f = fixture();
  await f.open();
  const first = (await f.tokens.credential("C1"))!;
  f.advance(HOUR - AGENT_READ_REFRESH_MS);
  const fresh = (await f.tokens.credential("C1"))!;
  expect(fresh.token).not.toBe(first.token);
  expect(fresh.expiresAt).toBeGreaterThan(first.expiresAt);
  expect(f.minted).toHaveLength(2);
  expect(f.tokens.tokens("C1")).toEqual([first.token, fresh.token]);
  await f.tokens.close("C1");
  expect(f.revoked).toEqual([first.token, fresh.token]);
  expect(await f.tokens.credential("C1")).toBeNull();
  expect(lines.slice(1)).toEqual([
    expect.stringContaining("refreshed refresh=1"),
    "agent-read item=I1 run=R1 repositories=acme/monorepo revoked refreshes=1",
  ]);
});

test("a revoke failure is one journal line for the turn", async () => {
  const f = fixture({ revokeFails: true });
  await f.open();
  f.advance(HOUR - AGENT_READ_REFRESH_MS);
  await f.tokens.credential("C1");
  await f.tokens.close("C1");
  expect(f.revoked).toHaveLength(2);
  expect(lines.filter((line) => line.includes("revoke failed"))).toEqual([
    "agent-read item=I1 run=R1 repositories=acme/monorepo revoke failed: installation token revoke failed with status 500",
  ]);
});
