import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createTokenStore,
  FILE_TOKEN_STORE_DOCTOR_WARNING,
  githubOAuthPath,
  loginGitHub,
  readSignedInUser,
} from "../src/auth";
import { ensureGitHubSignIn } from "../src/setup/github";

const homes: string[] = [];
const unavailable =
  "secret-tool: The name org.freedesktop.secrets was not provided by any .service files";

function scene(stderr = unavailable) {
  const home = mkdtempSync(join(tmpdir(), "paws-setup-fallback-"));
  homes.push(home);
  const commands: string[] = [];
  const makeStore = () =>
    createTokenStore({
      home,
      platform: "linux",
      which: () => "/injected/secret-tool",
      run: async (_command, args) => {
        commands.push(args[0]!);
        return { code: 1, stdout: "", stderr };
      },
    });
  const store = makeStore();
  const output: string[] = [];
  const requests: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/device/code"))
      return Response.json({
        device_code: "injected-device",
        user_code: "SAFE-CODE",
        verification_uri: "https://github.com/login/device",
        expires_in: 600,
        interval: 1,
      });
    if (url.endsWith("/access_token"))
      return Response.json({
        access_token: "gho_setup_injected",
        token_type: "bearer",
        scope: "repo read:org",
      });
    if (url.endsWith("/user"))
      return Response.json(
        { login: "octocat", id: 7 },
        { headers: { "x-oauth-scopes": "repo, read:org" } },
      );
    throw new Error(`Unexpected request ${url}`);
  };
  const input = {
    yes: false,
    home,
    env: {},
    oauthClientId: "Iv1.injected-real-client",
    secrets: [] as string[],
    io: {
      env: {},
      cwd: home,
      fetch,
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => output.push(line),
      readLine: async () => null,
      github: { store, sleep: async () => undefined, openBrowser: async () => undefined },
    },
  };
  return { home, store, makeStore, commands, output, requests, input };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test("interactive setup recovers unavailable Secret Service through device login and fresh file load", async () => {
  const s = scene();
  const result = await ensureGitHubSignIn(s.input);
  expect(result).toEqual({ login: "octocat", id: 7, token: "gho_setup_injected" });
  expect(s.commands).toEqual(["lookup", "store"]);
  expect(s.requests).toHaveLength(3);
  expect(s.output.some((line) => line.includes("Secret Service is unavailable"))).toBe(true);
  expect(s.output).toContain(FILE_TOKEN_STORE_DOCTOR_WARNING);
  expect(s.output).toContain("Signed in as octocat");
  expect(s.output.join("\n")).not.toContain(result.token);
  expect(s.input.secrets).toContain(result.token);
  const path = githubOAuthPath(s.home);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  const fresh = s.makeStore();
  expect(fresh.backend).toBe("file");
  expect(fresh.warning).toBe(FILE_TOKEN_STORE_DOCTOR_WARNING);
  expect((await fresh.load())?.accessToken).toBe(result.token);
  expect(await readSignedInUser({ store: fresh })).toEqual({ login: "octocat", id: 7 });
  expect(s.commands).toEqual(["lookup", "store"]);
});

test("explicit login saves and reports the chosen fallback", async () => {
  const s = scene();
  const user = await loginGitHub({
    home: s.home,
    store: s.store,
    oauthClientId: s.input.oauthClientId,
    fetch: s.input.io.fetch,
    stdout: s.input.io.stdout,
    sleep: s.input.io.github.sleep,
    openBrowser: s.input.io.github.openBrowser,
  });
  expect(user).toEqual({ login: "octocat", id: 7 });
  expect(s.output).toContain(FILE_TOKEN_STORE_DOCTOR_WARNING);
  expect((await s.makeStore().load())?.accessToken).toBe("gho_setup_injected");
});

test.each([
  "Permission denied",
  "Authentication failed",
  "collection is locked",
  "unknown failure",
])("setup does not convert keyring errors to sign-in: %s", async (stderr) => {
  const s = scene(stderr);
  await expect(ensureGitHubSignIn(s.input)).rejects.toThrow(/Could not load/);
  expect(s.requests).toEqual([]);
  expect(existsSync(githubOAuthPath(s.home))).toBe(false);
});

test("noninteractive setup preserves the unavailable-store failure without requesting a grant", async () => {
  const s = scene();
  await expect(ensureGitHubSignIn({ ...s.input, yes: true })).rejects.toThrow(
    /Secret Service is unavailable/,
  );
  expect(s.requests).toEqual([]);
  expect(existsSync(githubOAuthPath(s.home))).toBe(false);
});
