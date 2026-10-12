import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import {
  createDashboardGitHubAuth,
  DEVICE_ACCESS_DENIED_MESSAGE,
  DEVICE_CODE_EXPIRED_MESSAGE,
  DEVICE_SCOPE,
  loginGitHub,
  logoutGitHub,
  MISSING_GITHUB_CLIENT_ID_MESSAGE,
  PAWS_GITHUB_OAUTH_CLIENT_ID,
  WORKFLOW_SCOPE_NOTE,
} from "../src/auth";
import type { CommandRunner, GitHubTokenStore } from "../src/auth/store";
import { createTokenStore } from "../src/auth/store";
import { pawsPaths } from "../src/config";
import { tempHome } from "./helpers";

const CLIENT_ID = "Iv1.real-client";

describe("github device flow", () => {
  test.each([
    { name: "saved client", envClient: undefined, explicit: undefined, expected: CLIENT_ID },
    {
      name: "environment override",
      envClient: "Iv1.env",
      explicit: "Iv1.explicit",
      expected: "Iv1.env",
    },
    {
      name: "explicit override",
      envClient: undefined,
      explicit: "Iv1.explicit",
      expected: "Iv1.explicit",
    },
    {
      name: "placeholder environment",
      envClient: PAWS_GITHUB_OAUTH_CLIENT_ID,
      explicit: undefined,
      expected: CLIENT_ID,
    },
  ])(
    "host sign-in uses $name for device request and token exchange",
    async ({ envClient, explicit, expected }) => {
      const home = tempHome();
      writeFileSync(
        pawsPaths(home).configFile,
        `[github]\nauth = "oauth"\noauth_client_id = "${CLIENT_ID}"\n`,
      );
      const seen: Captured[] = [];
      const store = createTokenStore({ home, platform: "linux", which: () => null });
      const flow = await createDashboardGitHubAuth({
        env: { PAWS_HOME: home, PAWS_GITHUB_CLIENT_ID: envClient },
        oauthClientId: explicit,
        store,
        sleep: async () => undefined,
        openBrowser: async () => undefined,
        fetch: deviceFetch(["success"], [], undefined, undefined, seen),
      }).beginDevice();
      expect(flow.userCode).toBe("PAWS-1234");
      expect(await flow.completed).toEqual({ login: "octocat", id: 7 });
      expect(
        seen
          .filter(({ url }) => url.includes("/login/"))
          .map(({ body }) => new URLSearchParams(body).get("client_id")),
      ).toEqual([expected, expected]);
      expect((await store.load())?.id).toBe(7);
    },
  );

  test("does not request the workflow scope", () => {
    expect(DEVICE_SCOPE.split(/\s+/)).not.toContain("workflow");
    expect(WORKFLOW_SCOPE_NOTE.toLowerCase()).toContain("workflow");
  });

  test("a placeholder client id fails before GitHub is called", async () => {
    await expectMissingClient({ oauthClientId: PAWS_GITHUB_OAUTH_CLIENT_ID });
  });

  test("an empty client id fails before GitHub is called", async () => {
    await expectMissingClient({
      oauthClientId: "   ",
      env: { PAWS_GITHUB_CLIENT_ID: " " },
    });
  });

  test("a placeholder env falls through to a real configured client id", async () => {
    const seen: Captured[] = [];
    const user = await loginGitHub({
      home: tempHome(),
      oauthClientId: CLIENT_ID,
      env: { PAWS_GITHUB_CLIENT_ID: PAWS_GITHUB_OAUTH_CLIENT_ID },
      sleep: async () => undefined,
      openBrowser: async () => undefined,
      stdout: () => undefined,
      fetch: deviceFetch(["success"], [], undefined, undefined, seen),
    });
    expect(user).toEqual({ login: "octocat", id: 7 });
    const code = seen.find((item) => item.url.includes("/login/device/code"));
    expect(code?.accept).toBe("application/json");
    expect(code?.body).toContain(`client_id=${encodeURIComponent(CLIENT_ID)}`);
    expect(code?.body).not.toContain(PAWS_GITHUB_OAUTH_CLIENT_ID);
  });

  test("404 Not Found names the client id fix", async () => {
    await expectDeviceCodeError(
      () => new Response("Not Found", { status: 404, statusText: "Not Found" }),
      "GitHub device-code error (404 Not Found). Check the client id.",
    );
  });

  test("a JSON 404 for an unknown client id keeps GitHub's error", async () => {
    await expectDeviceCodeError(
      () =>
        Response.json(
          { error: "not_found", error_description: "Not Found" },
          { status: 404, statusText: "Not Found" },
        ),
      "GitHub device-code error (404 Not Found; not_found: Not Found). Check the client id.",
    );
  });

  test("device_flow_disabled tells you to enable Device Flow", async () => {
    await expectDeviceCodeError(
      () =>
        Response.json(
          {
            error: "device_flow_disabled",
            error_description: "Device flow must be explicitly enabled for this App",
          },
          { status: 400 },
        ),
      "GitHub device-code error (device_flow_disabled: Device flow must be explicitly enabled for this App). Enable Device Flow on the OAuth App.",
    );
  });

  test("unauthorized_client names Device Flow and the client id", async () => {
    await expectDeviceCodeError(
      () =>
        Response.json(
          {
            error: "unauthorized_client",
            error_description:
              "The client is not authorized to request an authorization code using this method.",
          },
          { status: 400 },
        ),
      "GitHub device-code error (unauthorized_client: The client is not authorized to request an authorization code using this method.). Enable Device Flow on the OAuth App and check the client id.",
    );
  });

  test("incorrect_client_credentials from a form body tells you to check the client id", async () => {
    await expectDeviceCodeError(
      () =>
        new Response(
          "error=incorrect_client_credentials&error_description=The+client_id+and%2For+client_secret+passed+are+incorrect.",
          {
            status: 401,
            headers: { "content-type": "application/x-www-form-urlencoded" },
          },
        ),
      "GitHub device-code error (incorrect_client_credentials: The client_id and/or client_secret passed are incorrect.). Check the client id.",
    );
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
    const seen: Captured[] = [];
    const user = await loginGitHub({
      home,
      oauthClientId: CLIENT_ID,
      store,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      openBrowser: async (url) => {
        opened.push(url);
      },
      stdout: (line) => stdout.push(line),
      fetch: deviceFetch(script, bodies, undefined, undefined, seen),
    });
    expect(user).toEqual({ login: "octocat", id: 7 });
    expect(opened).toEqual(["https://github.com/login/device"]);
    expect(sleeps).toEqual([5000, 5000, 5000, 10000]);
    expect(stdout).toContain("Signed in as octocat");
    expect(bodies.join("\n")).not.toContain("client_secret");
    expect(bodies.join("\n")).toContain("scope=repo+read%3Aorg");
    expect(bodies.join("\n")).toContain(`client_id=${encodeURIComponent(CLIENT_ID)}`);
    expect(seen.find((item) => item.url.includes("/login/device/code"))?.accept).toBe(
      "application/json",
    );
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
        oauthClientId: CLIENT_ID,
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
        oauthClientId: CLIENT_ID,
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

type Captured = { url: string; accept: string | null; body: string };

async function expectMissingClient(input: {
  oauthClientId?: string;
  env?: Record<string, string>;
}): Promise<void> {
  let calls = 0;
  let caught: unknown;
  try {
    await loginGitHub({
      home: tempHome(),
      ...(input.oauthClientId !== undefined ? { oauthClientId: input.oauthClientId } : {}),
      ...(input.env ? { env: input.env } : {}),
      fetch: async () => {
        calls += 1;
        return new Response("should not be called", { status: 500 });
      },
      sleep: async () => undefined,
      openBrowser: async () => undefined,
      stdout: () => undefined,
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe(MISSING_GITHUB_CLIENT_ID_MESSAGE);
  expect((caught as Error).message).not.toContain("login github");
  expect(calls).toBe(0);
}

async function expectDeviceCodeError(code: () => Response, message: string): Promise<void> {
  const seen: Captured[] = [];
  let polls = 0;
  let caught: unknown;
  try {
    await loginGitHub({
      home: tempHome(),
      oauthClientId: CLIENT_ID,
      fetch: deviceFetch(
        [],
        [],
        () => undefined,
        () => {
          return code();
        },
        seen,
      ),
      sleep: async () => {
        polls += 1;
      },
      openBrowser: async () => undefined,
      stdout: () => undefined,
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe(message);
  expect((caught as Error).message).not.toContain("login github");
  expect((caught as Error).message).not.toContain("did not return a device code");
  expect(seen.map((item) => item.url).join(" ")).toContain("/login/device/code");
  expect(seen.map((item) => item.url).join(" ")).not.toContain("/login/oauth/access_token");
  expect(seen[0]?.accept).toBe("application/json");
  expect(polls).toBe(0);
}

function deviceFetch(
  script: string[],
  bodies: string[],
  onCode?: () => void,
  codeResponse?: () => Response,
  seen?: Captured[],
): (input: string, init?: RequestInit) => Promise<Response> {
  let polls = 0;
  return async (input, init) => {
    const body =
      init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
    bodies.push(body);
    seen?.push({ url: input, accept: acceptHeader(init), body });
    if (input.includes("/login/device/code")) {
      onCode?.();
      if (codeResponse !== undefined) return codeResponse();
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

function acceptHeader(init: RequestInit | undefined): string | null {
  const headers = init?.headers;
  if (headers === undefined) return null;
  if (headers instanceof Headers) return headers.get("accept");
  if (Array.isArray(headers)) {
    const found = headers.find((entry) => entry[0]?.toLowerCase() === "accept");
    return found?.[1] ?? null;
  }
  const record = headers as Record<string, string>;
  return record.Accept ?? record.accept ?? null;
}
