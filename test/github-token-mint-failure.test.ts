import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "bun:test";
import { isTransientFailure, transientRetryDelayMs } from "../src/core";
import { GitHubTokenError, createFetchGitHubClient, mintInstallationToken } from "../src/github";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

async function mintAgainst(status: number, message: string, headers: Record<string, string> = {}) {
  const client = createFetchGitHubClient(
    async () => new Response(JSON.stringify({ message }), { status, headers }),
  );
  return mintInstallationToken({
    client,
    appId: "1",
    installationId: "2",
    privateKeyPem: privateKey as string,
    owner: "pmdroid",
    repo: "paws-demo",
  }).then(
    () => {
      throw new Error("mint succeeded");
    },
    (error: unknown) => error,
  );
}

test("a 429 token mint is transient and keeps GitHub's retry-after", async () => {
  const error = await mintAgainst(429, "API rate limit exceeded", { "retry-after": "90" });
  expect(error).toBeInstanceOf(GitHubTokenError);
  expect(error).toMatchObject({ status: 429, retryAfterMs: 90_000 });
  expect((error as Error).message).toMatch(/rate limit/);
  expect(isTransientFailure(error)).toBe(true);
  expect(transientRetryDelayMs(0, error, 10)).toBe(90_000);
});

test("a 403 secondary rate limit on the token mint is transient", async () => {
  const error = await mintAgainst(
    403,
    "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
    { "retry-after": "60" },
  );
  expect(error).toMatchObject({ retryAfterMs: 60_000 });
  expect((error as Error).message).toMatch(/rate limit/);
  expect(isTransientFailure(error)).toBe(true);
});

test.each([
  [401, "A JSON web token could not be decoded"],
  [403, "Resource not accessible by integration"],
])("a %d token mint is not transient", async (status, message) => {
  const error = await mintAgainst(status, message);
  expect(error).toBeInstanceOf(GitHubTokenError);
  expect(error).toMatchObject({ status });
  expect(isTransientFailure(error)).toBe(false);
});
