import { expect, test } from "bun:test";
import { tempHome } from "./helpers";

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
