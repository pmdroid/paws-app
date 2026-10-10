import { describe, expect, test } from "bun:test";
import { handleStatusRequest } from "../src/web";
import { renderGitHubSignIn } from "../src/web/src/client/github-auth";

describe("dashboard github sign-in", () => {
  test("shows the signed-in login or the device code", () => {
    expect(renderGitHubSignIn({ user: { login: "octocat" }, device: null })).toContain(
      "Signed in as @octocat",
    );
    const signedOut = renderGitHubSignIn({
      user: null,
      device: { userCode: "PAWS-1234", verificationUri: "https://github.com/login/device" },
    });
    expect(signedOut).toContain("Sign in with GitHub");
    expect(signedOut).toContain("PAWS-1234");
    expect(signedOut).toContain("https://github.com/login/device");
  });

  test("GET reports the user and POST starts the device flow on loopback", async () => {
    let completed: Promise<{ login: string; id: number }> = Promise.resolve({
      login: "octocat",
      id: 7,
    });
    const githubAuth = {
      user: async () => null as { login: string; id: number } | null,
      beginDevice: async () => {
        completed = Promise.resolve({ login: "octocat", id: 7 });
        return {
          userCode: "PAWS-1234",
          verificationUri: "https://github.com/login/device",
          completed,
        };
      },
    };
    const none = await handleStatusRequest(new Request("http://127.0.0.1/api/auth/github"), {
      githubAuth,
      csrfToken: "csrf-token",
    });
    expect(await none?.json()).toEqual({ user: null });

    const page = await handleStatusRequest(new Request("http://127.0.0.1/status"), {
      staticDir: null,
      csrfToken: "csrf-token",
    });
    const html = await page?.text();
    expect(html).toContain('name="paws-csrf" content="csrf-token"');

    const started = await handleStatusRequest(
      new Request("http://127.0.0.1/api/auth/github/device", {
        method: "POST",
        headers: { Origin: "http://127.0.0.1:8787", "x-paws-csrf": "csrf-token" },
      }),
      { githubAuth, csrfToken: "csrf-token" },
    );
    expect(started?.status).toBe(200);
    expect(await started?.json()).toEqual({
      userCode: "PAWS-1234",
      verificationUri: "https://github.com/login/device",
    });
    await completed;

    githubAuth.user = async () => ({ login: "octocat", id: 7 });
    const signedIn = await handleStatusRequest(new Request("http://127.0.0.1/api/auth/github"), {
      githubAuth,
      csrfToken: "csrf-token",
    });
    expect(await signedIn?.json()).toEqual({ user: { login: "octocat", id: 7 } });
  });

  test("rejects a non-loopback origin and a missing CSRF token", async () => {
    const githubAuth = {
      user: async () => null,
      beginDevice: async () => {
        throw new Error("should not start");
      },
    };
    const origin = await handleStatusRequest(
      new Request("http://127.0.0.1/api/auth/github/device", {
        method: "POST",
        headers: { Origin: "https://evil.example", "x-paws-csrf": "csrf-token" },
      }),
      { githubAuth, csrfToken: "csrf-token" },
    );
    expect(origin?.status).toBe(403);

    const remote = await handleStatusRequest(new Request("http://evil.example/api/auth/github"), {
      githubAuth,
      csrfToken: "csrf-token",
    });
    expect(remote?.status).toBe(403);

    const csrf = await handleStatusRequest(
      new Request("http://127.0.0.1/api/auth/github/device", {
        method: "POST",
        headers: { Origin: "http://127.0.0.1" },
      }),
      { githubAuth, csrfToken: "csrf-token" },
    );
    expect(csrf?.status).toBe(403);
  });
});
