import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createGitHubTokenProvider,
  FILE_TOKEN_STORE_DOCTOR_WARNING,
  GITHUB_REAUTH_MESSAGE,
  githubOAuthPath,
  logoutGitHub,
} from "../src/auth";
import { createTokenStore, type CommandRunner, type StoredGitHubOAuth } from "../src/auth/store";

const TOKEN = "gho_store_secret_token";

describe("github token store", () => {
  test("createGitHubTokenProvider selects oauth, gh, and app", async () => {
    const home = tempHome();
    const oauth = createGitHubTokenProvider({ home, auth: "oauth" });
    expect(oauth.source).toBe("oauth");
    expect(createGitHubTokenProvider({}).source).toBe("oauth");
    const gh = createGitHubTokenProvider({
      auth: "gh",
      repo: "acme/widgets",
      gh: { ghBin: "/nonexistent/gh", env: { PATH: "/nonexistent" } },
    });
    expect(gh.source).toBe("gh");
    await expect(gh.token()).rejects.toThrow(/gh/);
    expect(() => createGitHubTokenProvider({ auth: "app", repo: "acme/widgets" })).toThrow(
      /GitHub App credentials/,
    );
  });

  test("secret-tool keeps the token off argv and logout removes it", async () => {
    const home = tempHome();
    const tool = fakeSecretTool();
    const store = createTokenStore({
      home,
      platform: "linux",
      which: (bin) => (bin === "secret-tool" ? "/usr/bin/secret-tool" : null),
      run: tool.run,
    });
    expect(store.backend).toBe("secret-tool");
    expect(store.warning).toBeNull();
    await store.save(sample());
    expect(tool.argv.some((args) => args.join(" ").includes(TOKEN))).toBe(false);
    expect(tool.stdin.join("")).toContain(TOKEN);
    expect((await store.load())?.login).toBe("octocat");
    await logoutGitHub({ home, store });
    expect(await store.load()).toBeNull();
  });

  test("file fallback is mode 0600 and doctor warns", async () => {
    const home = tempHome();
    const store = createTokenStore({
      home,
      platform: "linux",
      which: () => null,
    });
    expect(store.backend).toBe("file");
    expect(store.warning).toBe(FILE_TOKEN_STORE_DOCTOR_WARNING);
    await store.save(sample());
    const path = githubOAuthPath(home);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "secrets")).mode & 0o777).toBe(0o700);
    await logoutGitHub({ home, store });
    expect(await store.load()).toBeNull();
  });

  test("an expiring token is refreshed once", async () => {
    const home = tempHome();
    const store = createTokenStore({ home, platform: "linux", which: () => null });
    await store.save({ ...sample(), refreshToken: "ghr_old", expiresAtMs: 1_000 });
    let refreshes = 0;
    const provider = createGitHubTokenProvider({
      auth: "oauth",
      home,
      oauthClientId: "Iv1.paws-oauth-placeholder",
      store,
      now: () => 1_000_000,
      fetch: async (input) => {
        refreshes += 1;
        expect(String(input)).toContain("/login/oauth/access_token");
        return Response.json({
          access_token: "gho_refreshed_token",
          refresh_token: "ghr_new",
          expires_in: 3600,
          scope: "repo read:org",
          token_type: "bearer",
        });
      },
    });
    expect(await provider.token()).toBe("gho_refreshed_token");
    expect(await provider.token()).toBe("gho_refreshed_token");
    expect(refreshes).toBe(1);
    expect((await store.load())?.refreshToken).toBe("ghr_new");
  });

  test("a 401 marks the token invalid and does not retry", async () => {
    const home = tempHome();
    const store = createTokenStore({ home, platform: "linux", which: () => null });
    await store.save(sample());
    let calls = 0;
    const provider = createGitHubTokenProvider({
      auth: "oauth",
      home,
      store,
      fetch: async () => {
        calls += 1;
        return new Response("no", { status: 401 });
      },
    });
    await expect(provider.user()).rejects.toThrow(GITHUB_REAUTH_MESSAGE);
    const after = calls;
    await expect(provider.token()).rejects.toThrow(GITHUB_REAUTH_MESSAGE);
    await expect(provider.user()).rejects.toThrow(GITHUB_REAUTH_MESSAGE);
    expect(calls).toBe(after);
    expect((await store.load())?.invalid).toBe(true);
  });
});

function sample(): StoredGitHubOAuth {
  return {
    accessToken: TOKEN,
    refreshToken: null,
    expiresAtMs: null,
    scope: "repo, read:org",
    login: "octocat",
    id: 7,
    invalid: false,
  };
}

function fakeSecretTool(): { run: CommandRunner; argv: string[][]; stdin: string[] } {
  let payload = "";
  const argv: string[][] = [];
  const stdin: string[] = [];
  const run: CommandRunner = async (_command, args, input) => {
    argv.push([...args]);
    if (input !== undefined) stdin.push(input);
    if (args[0] === "store") {
      payload = input ?? "";
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "lookup") {
      if (payload.length === 0) return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: payload, stderr: "" };
    }
    if (args[0] === "clear") {
      payload = "";
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 127, stdout: "", stderr: "no" };
  };
  return { run, argv, stdin };
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "paws-auth-store-"));
}
