import { describe, expect, test } from "bun:test";
import {
  DEVICE_ACCESS_DENIED_MESSAGE,
  DEVICE_CODE_EXPIRED_MESSAGE,
  DEVICE_SCOPE,
  loginGitHub,
  logoutGitHub,
  WORKFLOW_SCOPE_NOTE,
} from "../src/auth";
import type { CommandRunner, GitHubTokenStore } from "../src/auth/store";
import { createTokenStore } from "../src/auth/store";
import { tempHome } from "./helpers";

describe("github device flow", () => {
  test("does not request the workflow scope", () => {
    expect(DEVICE_SCOPE.split(/\s+/)).not.toContain("workflow");
    expect(WORKFLOW_SCOPE_NOTE.toLowerCase()).toContain("workflow");
  });

  test("pending twice, slow_down, then success saves the token", async () => {
    const home = tempHome();
    const security = fakeSecurity();
    const store = keychainStore(home, security.run);
    const sleeps: number[] = [];
    const bodies: string[] = [];
    const opened: string[] = [];
    const script = ["authorization_pending", "authorization_pending", "slow_down", "success"];
    const stdout: string[] = [];
    const user = await loginGitHub({
      home,
      oauthClientId: "Iv1.paws-oauth-placeholder",
      store,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      openBrowser: async (url) => {
        opened.push(url);
      },
      stdout: (line) => stdout.push(line),
      fetch: deviceFetch(script, bodies),
    });
    expect(user).toEqual({ login: "octocat", id: 7 });
    expect(opened).toEqual(["https://github.com/login/device"]);
    expect(sleeps).toEqual([5000, 5000, 5000, 10000]);
    expect(stdout).toContain("Signed in as octocat");
    expect(bodies.join("\n")).not.toContain("client_secret");
    expect(bodies.join("\n")).toContain("scope=repo+read%3Aorg");
    const saved = await store.load();
    expect(saved?.login).toBe("octocat");
    expect(saved?.accessToken).toBe("gho_device_success_token");
    expect(security.argv.some((args) => args.includes("gho_device_success_token"))).toBe(false);
    expect(security.stdin.join("")).toContain("gho_device_success_token");
    await logoutGitHub({ home, store });
    expect(await store.load()).toBeNull();
    expect(security.argv.some((args) => args[0] === "delete-generic-password")).toBe(true);
  });

  test("an expired device code restarts once and then stops with one message", async () => {
    const home = tempHome();
    const store = keychainStore(home, fakeSecurity().run);
    let codes = 0;
    const stdout: string[] = [];
    const fetch = deviceFetch(["expired_token", "expired_token"], [], () => {
      codes += 1;
    });
    await expect(
      loginGitHub({
        home,
        store,
        fetch,
        sleep: async () => undefined,
        openBrowser: async () => undefined,
        stdout: (line) => stdout.push(line),
      }),
    ).rejects.toThrow(DEVICE_CODE_EXPIRED_MESSAGE);
    expect(codes).toBe(2);
    expect(stdout.filter((line) => line === DEVICE_CODE_EXPIRED_MESSAGE)).toEqual([]);
    expect(await store.load()).toBeNull();
  });

  test("access_denied stops without restarting", async () => {
    const home = tempHome();
    const store = keychainStore(home, fakeSecurity().run);
    let codes = 0;
    await expect(
      loginGitHub({
        home,
        store,
        fetch: deviceFetch(["access_denied"], [], () => {
          codes += 1;
        }),
        sleep: async () => undefined,
        openBrowser: async () => undefined,
        stdout: () => undefined,
      }),
    ).rejects.toThrow(DEVICE_ACCESS_DENIED_MESSAGE);
    expect(codes).toBe(1);
    expect(await store.load()).toBeNull();
  });
});

function keychainStore(home: string, run: CommandRunner): GitHubTokenStore {
  return createTokenStore({
    home,
    platform: "darwin",
    which: (bin) => (bin === "security" ? "/usr/bin/security" : null),
    run,
  });
}

function fakeSecurity(): { run: CommandRunner; argv: string[][]; stdin: string[] } {
  const items = new Map<string, string>();
  const argv: string[][] = [];
  const stdin: string[] = [];
  const run: CommandRunner = async (_command, args, input) => {
    argv.push([...args]);
    if (input !== undefined) stdin.push(input);
    if (args[0] === "add-generic-password") {
      const account = args[args.indexOf("-a") + 1] ?? "";
      items.set(account, input ?? "");
      expect(args.at(-1)).toBe("-w");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "find-generic-password") {
      const first = items.values().next().value as string | undefined;
      if (first === undefined) return { code: 44, stdout: "", stderr: "not found" };
      return { code: 0, stdout: first, stderr: "" };
    }
    if (args[0] === "delete-generic-password") {
      const account = args[args.indexOf("-a") + 1] ?? "";
      items.delete(account);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 127, stdout: "", stderr: "no" };
  };
  return { run, argv, stdin };
}

function deviceFetch(
  script: string[],
  bodies: string[],
  onCode?: () => void,
): (input: string, init?: RequestInit) => Promise<Response> {
  let polls = 0;
  return async (input, init) => {
    const body =
      init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
    bodies.push(body);
    if (input.includes("/login/device/code")) {
      onCode?.();
      return Response.json({
        device_code: "device",
        user_code: "PAWS-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      });
    }
    if (input.includes("/login/oauth/access_token")) {
      const step = script[polls] ?? "success";
      polls += 1;
      if (step !== "success") return Response.json({ error: step });
      return Response.json({
        access_token: "gho_device_success_token",
        token_type: "bearer",
        scope: "repo read:org",
      });
    }
    if (input.endsWith("/user")) {
      return Response.json(
        { login: "octocat", id: 7 },
        { headers: { "X-OAuth-Scopes": "repo, read:org" } },
      );
    }
    return new Response("missing", { status: 404 });
  };
}
