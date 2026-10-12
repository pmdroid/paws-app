import { expect, test } from "bun:test";
import { tempHome } from "./helpers";

test("a verified host gh identity denied repository access reselects without another login", async () => {
  const child = Bun.spawn(
    [process.execPath, "test/fixtures/linear-github-cli-auth.ts", tempHome(), "denied"],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, error }).toEqual({ code: 0, error: "" });
  const result = JSON.parse(output);
  expect(result).toMatchObject({
    verified: true,
    tokenDenied: true,
    bound: null,
    launches: 0,
    statuses: [],
    switched: false,
    missingQuestion: null,
  });
  expect(result.replacement).not.toBe(result.original);
  expect(result.choices).toEqual(["https://github.com/selected/other"]);
  expect(
    result.questionBodies
      .slice(0, 2)
      .every((question: { body: string }) => question.body.includes("repository")),
  ).toBe(true);
  expect(result.missing).toBe("Sign in to GitHub in Paws before connecting this Linear task.");
  expect(result.requests).toContain("https://api.github.com/repos/selected/repository");
  expect(result.outcomes).toEqual({
    "200": false,
    "404": false,
    "401": "GitHub repository access check failed (401)",
    "403": "GitHub repository access check failed (403)",
    "429": "GitHub repository access check failed (429)",
    "500": "GitHub repository access check failed (500)",
  });
});

test("actual host gh recovery retains its verified account across SQLite restart", async () => {
  const child = Bun.spawn(
    [process.execPath, "test/fixtures/linear-github-cli-auth.ts", tempHome()],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, error }).toEqual({ code: 0, error: "" });
  const result = JSON.parse(output);
  expect(result).toMatchObject({
    initial: true,
    blocked: false,
    wrongOwner: false,
    retried: true,
    answered: "answered",
    resumed: 1,
    switched: false,
    account: { account_id: 7 },
    storedOAuth: false,
    gh: { id: 8 },
  });
  expect(result.guidance.body).toContain("gh auth login");
  expect(result.requests).toEqual([
    "https://api.github.com/user",
    "https://api.github.com/user",
    "https://api.github.com/user",
  ]);
});
