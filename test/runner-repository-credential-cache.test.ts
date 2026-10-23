import { expect, test } from "bun:test";
import { createFakeGitHub } from "../src/github";
import type { RunnerCommand } from "../src/runner-protocol";
import {
  cacheRepositoryCredentials,
  createRunnerRepositoryAccess,
} from "../src/runner-repository-access";
import type { RunnerWork } from "../src/runner-work";

const bot = { appId: "99", login: "paws-test[bot]", id: 88 };

function fixture() {
  let now = Date.now();
  const github = createFakeGitHub();
  const original = github.mintInstallationToken;
  github.mintInstallationToken = async (input) => ({
    ...(await original(input)),
    expiresAt: now + 60 * 60_000,
  });
  const lookups: string[] = [];
  const command = {
    id: "command",
    type: "run",
    repository: {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
      baseSha: "a".repeat(40),
    },
    checkpointBot: bot,
  } as unknown as RunnerCommand;
  const work = {
    authorize: () => ({ command, branch: "paws/fixture" }),
  } as unknown as RunnerWork;
  const cached = cacheRepositoryCredentials(
    {
      github,
      installationForRepository: () => "1",
      async checkpointBot(repository: string) {
        lookups.push(repository);
        return bot;
      },
    },
    () => now,
  );
  const endpoint = createRunnerRepositoryAccess({ ...cached, work, now: () => now });
  const request = () =>
    endpoint(
      new Request("https://paws.invalid/v1/runs/run/repository-credential", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${"t".repeat(43)}`,
        },
        body: JSON.stringify({ generation: 1, access: "write" }),
      }),
      "runner",
    );
  return { github, lookups, request, advance: (ms: number) => (now += ms) };
}

test("credential requests within the token lifetime mint one token and look the bot up once", async () => {
  const f = fixture();
  for (let index = 0; index < 10; index++) {
    expect((await f.request())!.status).toBe(200);
    f.advance(5 * 60_000);
  }
  expect(f.github.minted).toHaveLength(1);
  expect(f.lookups).toEqual(["fixture/repository"]);
});

test("a token close to expiry is minted again and the bot is not looked up again", async () => {
  const f = fixture();
  expect((await f.request())!.status).toBe(200);
  f.advance(56 * 60_000);
  expect((await f.request())!.status).toBe(200);
  expect(f.github.minted).toHaveLength(2);
  expect(f.lookups).toHaveLength(1);
});
