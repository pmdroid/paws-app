import { expect, test } from "bun:test";
import { createFakeGitHub } from "../src/github";
import type { RunnerCommand } from "../src/runner-protocol";
import { createRunnerRepositoryAccess } from "../src/runner-repository-access";
import type { RunnerWork } from "../src/runner-work";

const commit = "b".repeat(40);

function fixture(
  granted?: (runId: string, repository: string) => Promise<{ commit: string } | null>,
) {
  const now = Date.now();
  const github = createFakeGitHub();
  const original = github.mintInstallationToken;
  const minted: unknown[] = [];
  github.mintInstallationToken = async (input) => {
    minted.push(input);
    return { ...(await original(input)), expiresAt: now + 60 * 60_000 };
  };
  const command = {
    id: "command",
    type: "run",
    addRepositories: true,
    repository: {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
      baseSha: "a".repeat(40),
    },
  } as unknown as RunnerCommand;
  const work = {
    authorizeAsync: async () => ({ command, branch: "paws/fixture" }),
  } as unknown as RunnerWork;
  const endpoint = createRunnerRepositoryAccess({
    github,
    work,
    installationForRepository: async () => "1",
    ...(granted ? { granted } : {}),
    now: () => now,
  });
  const request = (body: Record<string, unknown>) =>
    endpoint(
      new Request("https://paws.invalid/v1/runs/run/repository-credential", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${"t".repeat(43)}`,
        },
        body: JSON.stringify({ generation: 1, access: "read", ...body }),
      }),
      "runner",
    );
  return { minted, request };
}

test("an added repository gets a read token only when granted, at most five per run", async () => {
  const asked: string[] = [];
  const { minted, request } = fixture(async (runId, repository) => {
    asked.push(`${runId} ${repository}`);
    return { commit };
  });
  const response = (await request({ repository: "acme/lib" }))!;
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    remoteUrl: "https://github.com/acme/lib.git",
    branch: null,
    commit,
  });
  expect(asked).toEqual(["run acme/lib"]);
  expect(minted).toEqual([{ access: "read", repository: "acme/lib", installationId: "1" }]);
  for (const name of ["two", "three", "four", "five", "two"])
    expect((await request({ repository: `acme/${name}` }))!.status).toBe(200);
  expect((await request({ repository: "acme/six" }))!.status).toBe(403);
  for (const granted of [undefined, async () => null]) {
    const refused = fixture(granted);
    expect((await refused.request({ repository: "acme/lib" }))!.status).toBe(403);
    expect(refused.minted).toEqual([]);
  }
});

test("a request without repository is served for the run's own repository", async () => {
  const response = (await fixture().request({}))!;
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    remoteUrl: "https://github.com/fixture/repository.git",
    branch: null,
  });
});
